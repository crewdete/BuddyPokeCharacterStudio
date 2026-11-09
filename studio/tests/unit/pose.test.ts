// M3A-1 playback core against the ORIGINAL engine (Node, no renderer).
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDENTITY, type Matrix4 } from '@original/engine/math.js';
import { readPackage, type Package } from '@original/engine/package.js';
import type { SceneNode } from '@original/engine/scene-graph.js';
import { BindSnapshot } from '../../src/pose/bind';
import { AnimationPlayer, frameAt, type PoseSink } from '../../src/pose/player';

const CHICK = new URL('../../../web/assets/chick.bin', import.meta.url);
const load = async () => readPackage(new Uint8Array(readFileSync(CHICK)));

/** Same traversal the original renderer does before drawing: rebuild every local and world matrix. */
function updateWorld(pack: Package) {
  const walk = (node: SceneNode, parent: Matrix4) => {
    node.updateWorld(parent);
    for (const child of node.children) walk(child, node.world);
  };
  walk(pack.scene, IDENTITY);
}

const named = (pack: Package) => {
  const nodes: SceneNode[] = [];
  pack.scene.find(n => {
    if (n.name) nodes.push(n);
    return false;
  });
  return nodes;
};
const locals = (pack: Package) => Object.fromEntries(named(pack).map(n => [n.name, Array.from(n.local.e)]));
const worlds = (pack: Package) => Object.fromEntries(named(pack).map(n => [n.name, Array.from(n.world.e)]));
const noopSink: PoseSink = { syncPose() {}, syncVisibility() {}, refreshTextures() {} };

afterEach(() => vi.restoreAllMocks());

describe('frame timing matches the original Animation.step()', () => {
  it.each([true, false])('loop=%s, every 1/120 s over 3 loops of several clips', async loop => {
    const pack = await load();
    for (const name of ['celebrate1', 'mood_angry', 'pose_contra_toStand', 'hug1', 'pose_joinNow']) {
      const clip = pack.animations.get(name)!;
      clip.decode();
      clip.loop = loop;
      let now = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => now);
      clip.reset();
      const duration = (3 * clip.frameCount) / clip.fps;
      for (let t = 0; t <= duration; t += 1 / 120) {
        now = t * 1000;
        const running = clip.step(pack.scene);
        const ours = frameAt(t, clip.fps, clip.frameCount, loop);
        if (!running) {
          // Original stops (returns false) once a non-looping clip passes its end; it keeps the last frame applied.
          expect(ours.ended, `${name} t=${t}`).toBe(true);
          break;
        }
        expect(ours.ended).toBe(false);
        expect(ours.frame, `${name} t=${t.toFixed(4)}`).toBe(clip.current - clip.start);
      }
      vi.restoreAllMocks();
    }
  });
});

describe('bind snapshot', () => {
  it('restores the exact original rest pose after any clip (bit-for-bit local matrices)', async () => {
    const pack = await load();
    updateWorld(pack);
    const rest = locals(pack);
    const bind = new BindSnapshot(pack.scene);
    for (const name of pack.animations.keys()) {
      const clip = pack.animations.get(name)!;
      clip.decode();
      clip.showFrame(pack.scene, Math.floor(clip.frameCount / 2));
    }
    updateWorld(pack);
    expect(locals(pack)).not.toEqual(rest);
    bind.restore();
    updateWorld(pack);
    expect(locals(pack)).toEqual(rest);
  });
});

describe('pose bleed', () => {
  it('the original engine bleeds untracked bones between clips; the bind restore prevents it exactly', async () => {
    const fresh = await load();
    fresh.animations.get('holdHands1')!.showFrame(fresh.scene, 0);
    updateWorld(fresh);
    const expected = worlds(fresh);

    const bleed = await load();
    bleed.animations.get('hug1')!.showFrame(bleed.scene, 50);
    bleed.animations.get('holdHands1')!.showFrame(bleed.scene, 0);
    updateWorld(bleed);
    expect(worlds(bleed)).not.toEqual(expected); // original behaviour: 6 untracked targets keep hug1's pose

    const studio = await load();
    const bind = new BindSnapshot(studio.scene);
    studio.animations.get('hug1')!.showFrame(studio.scene, 50);
    bind.restore();
    studio.animations.get('holdHands1')!.showFrame(studio.scene, 0);
    updateWorld(studio);
    expect(worlds(studio)).toEqual(expected);
  });
});

describe('bone integrity', () => {
  it('bone lengths never change from frame to frame within any clip (bones only rotate)', async () => {
    const pack = await load();
    const bones = pack.scene.boneNames.map(n => pack.scene.node(n)!);
    const parentOf = new Map<SceneNode, SceneNode>();
    const walk = (node: SceneNode, parentBone: SceneNode | null) => {
      const isBone = bones.includes(node);
      if (isBone && parentBone) parentOf.set(node, parentBone);
      for (const child of node.children) walk(child, isBone ? node : parentBone);
    };
    walk(pack.scene, null);
    const lengths = () => [...parentOf].map(([b, p]) => Math.hypot(b.world.e[12] - p.world.e[12], b.world.e[13] - p.world.e[13], b.world.e[14] - p.world.e[14]));
    updateWorld(pack);
    const rest = lengths();
    const bind = new BindSnapshot(pack.scene);
    let worstWithinClip = 0;
    let worstVsRest = 0;
    let samples = 0;
    for (const clip of pack.animations.values()) {
      clip.decode();
      bind.restore();
      let reference: number[] | null = null;
      for (const f of [0, Math.floor(clip.frameCount / 3), Math.floor((2 * clip.frameCount) / 3), clip.frameCount - 1]) {
        clip.showFrame(pack.scene, f);
        updateWorld(pack);
        const now = lengths();
        reference ??= now;
        now.forEach((l, i) => {
          worstWithinClip = Math.max(worstWithinClip, Math.abs(l - reference![i]));
          if (rest[i] > 1e-6) worstVsRest = Math.max(worstVsRest, Math.abs(l - rest[i]) / rest[i]); // Pelvis sits on Bip01 (length 0)
        });
        samples++;
      }
    }
    expect(samples).toBe(94 * 4);
    expect(worstWithinClip).toBeLessThan(1e-6);
    // ORIGINAL DATA: bind rotation axes are stored slightly non-unit (|axis| 0.9987–0.9999), so each original
    // bind matrix is scaled by up to ~0.13%, compounding down a chain (pelvis x thigh x foot) to ~0.26%.
    // Animated (unit-quaternion) rotations give the true lengths. Reproduced exactly, not normalised.
    expect(worstVsRest).toBeLessThan(0.004);
  });

  it('documents the original non-unit bind rotation axes (cause of the rest-pose length difference)', async () => {
    const pack = await load();
    const off: number[] = [];
    pack.scene.find(n => {
      if (n.rotation) off.push(Math.abs(Math.hypot(n.rotation.x, n.rotation.y, n.rotation.z) - 1));
      return false;
    });
    expect(Math.max(...off)).toBeGreaterThan(1e-3);
    expect(Math.max(...off)).toBeLessThan(2e-3);
  });

  it('only Bip01 and Shadow carry position tracks', async () => {
    const pack = await load();
    const translated = new Set<string>();
    for (const clip of pack.animations.values()) {
      clip.decode();
      for (const t of clip.tracks!) if (t.positions) translated.add(t.target);
    }
    expect([...translated].sort()).toEqual(['Bip01', 'Shadow']);
  });
});

describe('AnimationPlayer', () => {
  const setup = async () => {
    const pack = await load();
    updateWorld(pack);
    const rest = locals(pack);
    const calls = { pose: 0, visibility: 0, textures: 0 };
    const sink: PoseSink = { syncPose: () => (calls.pose++, updateWorld(pack)), syncVisibility: () => calls.visibility++, refreshTextures: () => calls.textures++ };
    return { pack, rest, calls, player: new AnimationPlayer(pack.scene, pack.animations, sink) };
  };

  it('lists all 94 original clips', async () => {
    const { player } = await setup();
    expect(player.clipNames()).toHaveLength(94);
  });

  it('select shows frame 0 paused; seek clamps; stop restores the exact rest pose', async () => {
    const { pack, rest, player, calls } = await setup();
    player.select('mood_happy');
    expect(player.snapshot()).toMatchObject({ state: 'paused', clip: 'mood_happy', frame: 0, frameCount: 81, fps: 30 });
    player.seek(500);
    expect(player.snapshot().frame).toBe(80);
    player.seek(-3);
    expect(player.snapshot().frame).toBe(0);
    player.seek(40);
    expect(locals(pack)).not.toEqual(rest);
    player.stop();
    expect(player.snapshot().state).toBe('rest');
    expect(locals(pack)).toEqual(rest);
    expect(calls.pose).toBeGreaterThan(0);
    expect(calls.visibility).toBe(calls.pose);
  });

  it('play advances with the wall clock at the chosen speed; pause holds; loop wraps; no loop ends', async () => {
    const { player } = await setup();
    player.select('celebrate1'); // 31 frames
    player.play();
    player.tick(1000); // first tick only sets the clock
    player.tick(1500);
    expect(player.snapshot().frame).toBe(frameAt(0.5, 30, 31, true).frame);
    player.setSpeed(2);
    player.tick(1750); // +0.25 s * 2
    expect(player.snapshot().frame).toBe(frameAt(1.0, 30, 31, true).frame);
    player.pause();
    player.tick(5000);
    expect(player.snapshot().frame).toBe(frameAt(1.0, 30, 31, true).frame);
    player.play();
    player.tick(9000); // resume: clock restarts, no jump
    expect(player.snapshot().frame).toBe(frameAt(1.0, 30, 31, true).frame);
    player.setLoop(false);
    player.tick(10000); // +2 s at 2x: past the end
    expect(player.snapshot()).toMatchObject({ state: 'ended', frame: 30 });
    player.play(); // restart from the beginning
    expect(player.snapshot()).toMatchObject({ state: 'playing' });
    player.tick(11000);
    expect(player.snapshot().frame).toBe(0);
  });

  it('speed is clamped to the supported range', async () => {
    const { player } = await setup();
    player.setSpeed(0);
    expect(player.snapshot().speed).toBe(0.1);
    player.setSpeed(99);
    expect(player.snapshot().speed).toBe(4);
  });

  it('switching clips through the player never bleeds', async () => {
    const fresh = await load();
    fresh.animations.get('handshake1')!.showFrame(fresh.scene, 10);
    updateWorld(fresh);
    const { pack, player } = await setup();
    player.select('bearHug1');
    player.seek(120);
    player.select('handshake1');
    player.seek(10);
    expect(worlds(pack)).toEqual(worlds(fresh));
  });

  it('unknown clips are rejected', async () => {
    const { player } = await setup();
    expect(() => player.select('nope')).toThrow('Unknown animation');
    void noopSink;
  });
});
