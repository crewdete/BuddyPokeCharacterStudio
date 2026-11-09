// Samples ORIGINAL animation clips frame by frame for export.
//
// For each clip: exact bind restore (no carry-over from the previous clip), then the original
// `Animation.showFrame(scene, f)` for every frame 0..frameCount-1, reading each bone's position/rotation as
// the original engine left it. Rotations are converted exactly like the exported skeleton (unit-axis
// axis-angle -> quaternion), so the keys reproduce what the Studio plays (verified on 470 frames in M3A-1).
// Bones a clip does not animate are sampled too (their rest values), so every clip keys every bone.
import * as THREE from 'three';
import type { Animation } from '@original/engine/animation.js';
import { Matrix4 as EngineMatrix4 } from '@original/engine/math.js';
import type { Scene, SceneNode } from '@original/engine/scene-graph.js';
import type { BindSnapshot } from '../../pose/bind';

export interface SampledClip {
  name: string;
  fps: number;
  frameCount: number;
  /** Per bone (original bone order): frameCount quaternions, x y z w, sign-continuous. */
  rotations: Float32Array[];
  /** Bip01 translation per frame (metres), x y z. */
  rootTranslation: Float32Array;
}

export const ROOT_BONE = 'Bip01';

/**
 * Quaternion of a node's axis-angle rotation, as the original engine applies it.
 * - Unit axes (all animated rotations) and the slightly non-unit stored rest axes (|axis| 0.9987–1, see
 *   M3A-1): the unit-axis rotation, consistent with the exported skeleton.
 * - Degenerate axes (6 of 213,803 animated samples: near-zero constant tracks, where the original decoder
 *   keeps a tiny non-normalised axis): the rotation the ORIGINAL `Matrix4.rotate()` actually produces
 *   (≈ identity), not the nominal angle about the normalised axis.
 */
export function nodeQuaternion(node: SceneNode, target = new THREE.Quaternion()) {
  const r = node.rotation;
  if (!r || r.angle === 0) return target.identity();
  const length = Math.hypot(r.x, r.y, r.z);
  if (length > 0.9) return target.setFromAxisAngle(new THREE.Vector3(r.x, r.y, r.z).divideScalar(length), r.angle);
  const m = new THREE.Matrix4().fromArray(Array.from(new EngineMatrix4().rotate(r.angle, r.x, r.y, r.z).e));
  const x = new THREE.Vector3().setFromMatrixColumn(m, 0).normalize();
  const y = new THREE.Vector3().setFromMatrixColumn(m, 1).normalize();
  const z = new THREE.Vector3().crossVectors(x, y).normalize();
  y.crossVectors(z, x);
  return target.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

export function sampleClip(scene: Scene, clip: Animation, bind: BindSnapshot, boneNames: string[], scale: number): SampledClip {
  clip.decode();
  bind.restore();
  const nodes = boneNames.map(name => scene.node(name)!);
  const root = scene.node(ROOT_BONE)!;
  const n = clip.frameCount;
  const rotations = nodes.map(() => new Float32Array(n * 4));
  const rootTranslation = new Float32Array(n * 3);
  const q = new THREE.Quaternion();
  for (let f = 0; f < n; f++) {
    clip.showFrame(scene, f);
    nodes.forEach((node, b) => {
      nodeQuaternion(node, q);
      const out = rotations[b];
      // q and -q are the same rotation; keep consecutive keys on the same hemisphere.
      if (f > 0 && q.x * out[f * 4 - 4] + q.y * out[f * 4 - 3] + q.z * out[f * 4 - 2] + q.w * out[f * 4 - 1] < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      q.toArray(out, f * 4);
    });
    const p = root.position;
    rootTranslation.set(p ? [p.x * scale, p.y * scale, p.z * scale] : [0, 0, 0], f * 3);
  }
  bind.restore();
  return { name: clip.name, fps: clip.fps, frameCount: n, rotations, rootTranslation };
}

/**
 * Key time for frame `f`, stored as the largest float32 not greater than f / fps. glTF key times are float32;
 * the nearest float32 to f/30 is often slightly *larger* than f/30, and a STEP player asked for exactly
 * f/30 (Three.js, Blender, engines) would then still show frame f-1. Rounding down avoids that off-by-one;
 * the timing changes by < 1e-8 s.
 */
export function keyTime(f: number, fps: number): number {
  const exact = f / fps;
  const stored = Math.fround(exact);
  if (stored <= exact) return stored;
  const bits = new Float32Array([stored]);
  const ints = new Uint32Array(bits.buffer);
  ints[0] -= 1; // positive float32: previous representable value
  return bits[0];
}

/**
 * Lossless key reduction for STEP interpolation: keep a key where the value changes, plus the first and
 * last frame (so the clip length and final pose are explicit).
 */
export function reduceStep(values: Float32Array, size: number, fps: number): { times: number[]; values: number[] } {
  const n = values.length / size;
  const times: number[] = [];
  const out: number[] = [];
  for (let f = 0; f < n; f++) {
    let changed = f === 0 || f === n - 1;
    for (let k = 0; !changed && k < size; k++) changed = values[f * size + k] !== values[(f - 1) * size + k];
    if (!changed) continue;
    times.push(keyTime(f, fps));
    for (let k = 0; k < size; k++) out.push(values[f * size + k]);
  }
  return { times, values: out };
}

/** glTF animation clip: STEP (no interpolation), every bone's rotation + root translation. */
export function toAnimationClip(sample: SampledClip, boneNames: string[]): THREE.AnimationClip {
  const tracks: THREE.KeyframeTrack[] = boneNames.map((name, b) => {
    const { times, values } = reduceStep(sample.rotations[b], 4, sample.fps);
    return new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, times, values, THREE.InterpolateDiscrete);
  });
  const root = reduceStep(sample.rootTranslation, 3, sample.fps);
  tracks.push(new THREE.VectorKeyframeTrack(`${ROOT_BONE}.position`, root.times, root.values, THREE.InterpolateDiscrete));
  return new THREE.AnimationClip(sample.name, (sample.frameCount - 1) / sample.fps, tracks);
}
