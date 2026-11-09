// File-size estimate for the Export tab (M3C-3), shown before exporting.
//
// A full export of all 94 clips takes over a second, too slow to repeat on every click, so the estimate is
// assembled from exact parts:
//   base     the real byte size of an export with the same look and options and no clips (one real export,
//            redone only when the look or an option other than the clip selection changes);
//   clips    per selected clip, the exact number of STEP keys every channel will store (same sampling and
//            same lossless reduction as the exporter, sample.ts), plus a fixed JSON cost per channel;
//   faces    per extra expression frame, the PNG size of the face texture the original engine composes for it;
//   props    per prop shown by a selected clip, its geometry, its PNG texture and JSON.
// The tests compare the estimate with real exports.
import type { OriginalAssets } from '../original';
import { createBuddy } from '../original';
import { BindSnapshot } from '../pose/bind';
import { FACE_NODE, reduceStep, sampleClip, ROOT_BONE } from './animation/sample';
import { EXPORT_SCALE, type RootMotion } from './prepare';

/** glTF JSON for one channel: channel + sampler + 2 accessors (with min/max) + 2 buffer views (measured: ~515 bytes in a 94-clip file). */
const CHANNEL_JSON = 505;
/** glTF JSON for one animation (name, arrays). */
const ANIMATION_JSON = 60;
/** glTF JSON for an extra mesh node (node, mesh, material, texture, image, sampler references). */
const NODE_JSON = 700;

interface ClipStats {
  frames: number;
  /** Bytes of key data (times + values) for the 29 bone rotations. */
  bones: number;
  root: Record<RootMotion, number>;
  /** Per prop: bytes of its rotation and visibility keys in this clip. */
  props: Record<string, number>;
  /** Props this clip shows on at least one frame. */
  shows: string[];
  faceFrames: Int16Array;
}

export interface LookStats {
  lookCode: string;
  clips: Map<string, ClipStats>;
  /** PNG bytes of the face texture per expression frame (frame 1 is the dressed face, already in the base). */
  facePng: Map<number, number>;
  /** Geometry + PNG bytes per prop. */
  propBytes: Record<string, number>;
  boneCount: number;
}

const keyBytes = (values: Float32Array, size: number, fps: number) => {
  const { times } = reduceStep(values, size, fps);
  return times.length * (4 + size * 4);
};

const pngSize = async (bitmap: OffscreenCanvas | null) => (bitmap ? (await bitmap.convertToBlob({ type: 'image/png' })).size : 0);

/** Sample every clip once on a fresh buddy with this look (same code as the exporter). */
export async function lookStats(assets: OriginalAssets, lookCode: string): Promise<LookStats> {
  const buddy = await createBuddy(assets, lookCode);
  const scene = buddy.scene;
  const bind = new BindSnapshot(scene);
  const rest = scene.node(ROOT_BONE)!.position;
  const clips = new Map<string, ClipStats>();
  let i = 0;
  for (const [name, clip] of buddy.animations) {
    const s = sampleClip(scene, clip, bind, scene.boneNames, EXPORT_SCALE);
    const inPlace = s.rootTranslation.slice();
    for (let f = 0; f < s.frameCount; f++) {
      inPlace[f * 3] = (rest?.x ?? 0) * EXPORT_SCALE;
      inPlace[f * 3 + 2] = (rest?.z ?? 0) * EXPORT_SCALE;
    }
    const props: Record<string, number> = {};
    for (const [prop, data] of Object.entries(s.props)) {
      const visible = new Float32Array(s.frameCount * 3);
      data.visible.forEach((v, f) => visible.fill(v ? 1 : 0, f * 3, f * 3 + 3));
      props[prop] = keyBytes(data.rotations, 4, s.fps) + keyBytes(visible, 3, s.fps);
    }
    clips.set(name, {
      frames: s.frameCount,
      bones: s.rotations.reduce((sum, r) => sum + keyBytes(r, 4, s.fps), 0),
      root: { keep: keyBytes(s.rootTranslation, 3, s.fps), inPlace: keyBytes(inPlace, 3, s.fps) },
      props,
      shows: Object.entries(s.props).filter(([, d]) => d.visible.some(v => v === 1)).map(([p]) => p),
      faceFrames: s.faceFrames,
    });
    if (++i % 8 === 0) await new Promise(r => setTimeout(r, 0));
  }
  const facePng = new Map<number, number>();
  const material = scene.node(FACE_NODE)?.mesh?.material ?? null;
  const frames = new Set([...clips.values()].flatMap(c => [...c.faceFrames]));
  for (const frame of frames) {
    if (frame === 1 || !material) continue;
    material.showFrame(frame);
    facePng.set(frame, await pngSize(material.bitmap));
  }
  const propBytes: Record<string, number> = {};
  for (const name of scene.propNames) {
    const node = scene.node(name);
    const mesh = node?.mesh;
    if (!mesh?.material) continue;
    if (!mesh.decoded) mesh.decode(scene);
    const index = mesh.vertexCount > 65535 ? 4 : 2;
    propBytes[name] = mesh.vertexCount * (12 + 12 + 8) + mesh.faces.length * index + (await pngSize(mesh.material.bitmap));
  }
  return { lookCode, clips, facePng, propBytes, boneCount: scene.boneNames.length };
}

export interface SizeEstimate {
  bytes: number;
  clips: number;
  props: string[];
  faces: number;
}

/** Estimated GLB size for `baseBytes` (same export with no clips) plus the selected clips. */
export function estimateAnimated(stats: LookStats, baseBytes: number, selected: string[], rootMotion: RootMotion): SizeEstimate {
  const clips = selected.map(n => stats.clips.get(n)).filter((c): c is ClipStats => !!c);
  const props = Object.keys(stats.propBytes).filter(p => clips.some(c => c.shows.includes(p)));
  const faces = [...new Set(clips.flatMap(c => [...c.faceFrames]))].filter(f => f !== 1);
  const faceNodes = [1, ...faces];
  let bytes = baseBytes;
  for (const c of clips) {
    const channels = stats.boneCount + 1 + props.length * 2 + faceNodes.length;
    bytes += ANIMATION_JSON + channels * CHANNEL_JSON + c.bones + c.root[rootMotion];
    for (const p of props) bytes += c.props[p];
    for (const frame of faceNodes) {
      let keys = 0;
      for (let f = 0; f < c.frames; f++) if (f === 0 || f === c.frames - 1 || (c.faceFrames[f] === frame) !== (c.faceFrames[f - 1] === frame)) keys++;
      bytes += keys * 16;
    }
  }
  for (const frame of faces) bytes += (stats.facePng.get(frame) ?? 0) + NODE_JSON;
  for (const p of props) bytes += stats.propBytes[p] + NODE_JSON;
  return { bytes: Math.round(bytes), clips: clips.length, props, faces: faceNodes.length };
}
