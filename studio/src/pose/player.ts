// Animation playback on top of the ORIGINAL BuddyRevival animation system.
//
// Every frame is produced by the original `Animation.showFrame(scene, frame)` (web/src/engine/animation.js):
// the original decoded tracks write the original node transforms, prop visibility and face material
// frames. Nothing is converted or interpolated. The player only adds what the original `step()` cannot
// do: its own clock (for speed and pause), seeking, a loop switch, and returning to the exact bind pose.
//
// Frame timing reproduces Animation.step(): frame = trunc(seconds * fps + 0.499) counted from the clip
// start; when looping and past the last frame it wraps with `% (end - start)` (the last frame of a
// looping clip equals its first), and without looping it holds the last frame.
import type { Animation } from '@original/engine/animation.js';
import type { Scene } from '@original/engine/scene-graph.js';
import { BindSnapshot } from './bind';

/** What the player drives after the original engine has applied a frame (the 3D rig in the app). */
export interface PoseSink {
  /** Copy engine transforms to the renderer. */
  syncPose(): void;
  /** Copy engine node visibility (props) to the renderer. */
  syncVisibility(): void;
  /** Swap textures whose original material changed frame (face expressions). */
  refreshTextures(): void;
}

export type PlayerState = 'rest' | 'playing' | 'paused' | 'ended';

export interface PlayerSnapshot {
  state: PlayerState;
  clip: string | null;
  frame: number;
  frameCount: number;
  fps: number;
  speed: number;
  loop: boolean;
}

export const MIN_SPEED = 0.1;
export const MAX_SPEED = 4;
/** The original material frame shown when a buddy is dressed (TextureLibrary.compose default). */
const DRESSED_FRAME = 1;

/**
 * Frame index (from the clip start) at `seconds` of playback, exactly as the original Animation.step()
 * computes it. Returns `ended: true` when a non-looping clip has run past its last frame.
 */
export function frameAt(seconds: number, fps: number, frameCount: number, loop: boolean): { frame: number; ended: boolean } {
  const last = frameCount - 1; // original: end - start
  let frame = Math.trunc(seconds * fps + 0.499);
  if (frame > last) {
    if (!loop) return { frame: last, ended: true };
    frame = last > 0 ? frame % last : 0;
  }
  return { frame: Math.max(0, frame), ended: false };
}

export class AnimationPlayer {
  private readonly bind: BindSnapshot;
  private readonly listeners = new Set<() => void>();
  private clip: Animation | null = null;
  private state: PlayerState = 'rest';
  private frame = 0;
  /** Playback time in clip seconds (already scaled by speed). */
  private time = 0;
  /** Wall-clock reference for tick(); null right after play/seek so a resume never jumps. */
  private lastNow: number | null = null;
  private speed = 1;
  private loop = true;
  private snapshotCache: PlayerSnapshot | null = null;

  constructor(
    private readonly scene: Scene,
    private readonly animations: Map<string, Animation>,
    private readonly sink: PoseSink,
  ) {
    this.bind = new BindSnapshot(scene);
  }

  /** Names of every original clip, in package order. */
  clipNames(): string[] {
    return [...this.animations.keys()];
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit() {
    this.snapshotCache = null;
    for (const listener of this.listeners) listener();
  }

  /** Immutable view for UIs (stable between changes, for useSyncExternalStore). */
  snapshot(): PlayerSnapshot {
    return (this.snapshotCache ??= {
      state: this.state,
      clip: this.clip?.name ?? null,
      frame: this.frame,
      frameCount: this.clip?.frameCount ?? 0,
      fps: this.clip?.fps ?? 0,
      speed: this.speed,
      loop: this.loop,
    });
  }

  get playing() {
    return this.state === 'playing';
  }

  /**
   * Select a clip and show its first frame (paused). Always starts from the exact bind pose, so bones
   * this clip does not animate never keep the previous clip's pose (the original app lets them bleed).
   */
  select(name: string) {
    const clip = this.animations.get(name);
    if (!clip) throw new Error(`Unknown animation "${name}"`);
    clip.decode();
    this.clip = clip;
    this.time = 0;
    this.lastNow = null;
    this.resetToBind();
    this.prewarm();
    this.applyFrame(0);
    this.state = 'paused';
    this.emit();
  }

  play(name?: string) {
    if (name && name !== this.clip?.name) this.select(name);
    if (!this.clip) return;
    if (this.state === 'ended' || this.state === 'rest') {
      this.time = 0;
      if (this.state === 'rest') this.applyFrame(0);
    }
    this.state = 'playing';
    this.lastNow = null;
    this.emit();
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.emit();
  }

  /** Stop and return to the exact original rest pose: bind transforms, props hidden, dressed face. */
  stop() {
    this.time = 0;
    this.frame = 0;
    this.lastNow = null;
    this.resetToBind();
    this.sink.syncPose();
    this.sink.syncVisibility();
    this.sink.refreshTextures();
    this.state = 'rest';
    this.emit();
  }

  /** Show frame `frame` (from the clip start) and pause there. */
  seek(frame: number) {
    if (!this.clip) return;
    const last = this.clip.frameCount - 1;
    const target = Math.min(Math.max(0, Math.round(frame)), last);
    this.time = target / this.clip.fps;
    this.lastNow = null;
    this.applyFrame(target);
    if (this.state !== 'playing') this.state = 'paused';
    this.emit();
  }

  setSpeed(speed: number) {
    const clamped = Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
    if (clamped === this.speed) return;
    this.speed = clamped;
    this.emit();
  }

  setLoop(loop: boolean) {
    if (loop === this.loop) return;
    this.loop = loop;
    this.emit();
  }

  /** Advance with the wall clock (ms, e.g. performance.now()). Call once per rendered frame while playing. */
  tick(now: number) {
    if (this.state !== 'playing' || !this.clip) return;
    if (this.lastNow !== null) this.time += ((now - this.lastNow) / 1000) * this.speed;
    this.lastNow = now;
    const { frame, ended } = frameAt(this.time, this.clip.fps, this.clip.frameCount, this.loop);
    if (frame !== this.frame) this.applyFrame(frame);
    if (ended) {
      this.state = 'ended';
      this.emit();
    } else if (frame !== this.snapshotCache?.frame) {
      this.emit();
    }
  }

  /**
   * Re-apply the current frame. Needed after the character is re-dressed: the original dress() hides
   * props and builds new materials (resetting the face frame), and the frame must show again even when paused.
   */
  reapply() {
    if (!this.clip || this.state === 'rest') return;
    this.prewarm();
    this.applyFrame(this.frame);
  }

  private resetToBind() {
    this.bind.restore();
    this.scene.hideProps();
    // Back to the face composed at dress time.
    this.scene.find(node => {
      if (node.mesh?.material && node.mesh.material.frame !== -1) node.mesh.material.showFrame(DRESSED_FRAME);
      return false;
    });
  }

  private applyFrame(frame: number) {
    if (!this.clip) return;
    this.frame = frame;
    this.clip.showFrame(this.scene, frame); // original: hideProps + every track (transforms, visibility, face)
    this.sink.syncPose();
    this.sink.syncVisibility();
    this.sink.refreshTextures();
  }

  /** Compose the clip's face frames up front so the first loop does not stall on SVG stamping. */
  private prewarm() {
    for (const track of this.clip?.tracks ?? []) {
      if (!track.materialFrames) continue;
      const material = this.scene.node(track.target)?.mesh?.material;
      if (!material) continue;
      const shown = material.frame;
      for (const value of new Set(track.materialFrames)) material.showFrame(value);
      if (shown !== -1) material.showFrame(shown);
      else material.showFrame(DRESSED_FRAME);
    }
  }
}
