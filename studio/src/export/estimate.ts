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
  /** FBX: number of keys (incl. hold keys) of the bone rotation tracks, the root, and per prop rotation + visibility. */
  fbx: { bones: number; root: Record<RootMotion, number>; props: Record<string, number> };
}

export interface LookStats {
  lookCode: string;
  clips: Map<string, ClipStats>;
  /** PNG bytes of the face texture per expression frame (frame 1 is the dressed face, already in the base). */
  facePng: Map<number, number>;
  /** Geometry + PNG bytes per prop. */
  propBytes: Record<string, number>;
  /** FBX geometry bytes per prop (+ its PNG) and for the face mesh (`Head`, PNG excluded). */
  fbxMeshBytes: Record<string, number>;
  boneCount: number;
}

const keyBytes = (values: Float32Array, size: number, fps: number) => {
  const { times } = reduceStep(values, size, fps);
  return times.length * (4 + size * 4);
};

/** FBX keys for a STEP track: the reduced keys plus a hold key before each change that follows a gap (fbx/writer.ts). */
export function fbxKeys(values: Float32Array, size: number, fps: number) {
  const frames = reduceStep(values, size, fps).times.map(t => Math.round(t * fps));
  return frames.reduce((n, f, k) => n + 1 + (k > 0 && f - 1 > frames[k - 1] ? 1 : 0), 0);
}

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
    const fbxProps: Record<string, number> = {};
    for (const [prop, data] of Object.entries(s.props)) {
      const visible = new Float32Array(s.frameCount * 3);
      data.visible.forEach((v, f) => visible.fill(v ? 1 : 0, f * 3, f * 3 + 3));
      props[prop] = keyBytes(data.rotations, 4, s.fps) + keyBytes(visible, 3, s.fps);
      fbxProps[prop] = fbxKeys(data.rotations, 4, s.fps) + fbxKeys(visible, 3, s.fps);
    }
    clips.set(name, {
      frames: s.frameCount,
      bones: s.rotations.reduce((sum, r) => sum + keyBytes(r, 4, s.fps), 0),
      root: { keep: keyBytes(s.rootTranslation, 3, s.fps), inPlace: keyBytes(inPlace, 3, s.fps) },
      props,
      shows: Object.entries(s.props).filter(([, d]) => d.visible.some(v => v === 1)).map(([p]) => p),
      faceFrames: s.faceFrames,
      fbx: {
        bones: s.rotations.reduce((sum, r) => sum + fbxKeys(r, 4, s.fps), 0),
        root: { keep: fbxKeys(s.rootTranslation, 3, s.fps), inPlace: fbxKeys(inPlace, 3, s.fps) },
        props: fbxProps,
      },
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
  const fbxMeshBytes: Record<string, number> = {};
  for (const name of scene.propNames) {
    const node = scene.node(name);
    const mesh = node?.mesh;
    if (!mesh?.material) continue;
    if (!mesh.decoded) mesh.decode(scene);
    const index = mesh.vertexCount > 65535 ? 4 : 2;
    const png = await pngSize(mesh.material.bitmap);
    propBytes[name] = mesh.vertexCount * (12 + 12 + 8) + mesh.faces.length * index + png;
    fbxMeshBytes[name] = fbxGeometryBytes(mesh.vertexCount, mesh.faces.length) + png;
  }
  const head = scene.node(FACE_NODE)?.mesh;
  if (head) {
    if (!head.decoded) head.decode(scene);
    fbxMeshBytes[FACE_NODE] = fbxGeometryBytes(head.vertexCount, head.faces.length);
  }
  return { lookCode, clips, facePng, propBytes, fbxMeshBytes, boneCount: scene.boneNames.length };
}

export interface SizeEstimate {
  bytes: number;
  /** FBX only: animated channels and keys (diagnostics). */
  channels?: number;
  keys?: number;
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

// ------------------------------------------------------------------------------------------------ FBX

/** FBX geometry: doubles for vertices, per-corner normals and UVs, int indices (fbx/writer.ts layout). */
function fbxGeometryBytes(vertices: number, corners: number) {
  return vertices * 24 + corners * (4 + 24 + 4) + vertices * 16;
}
/** Measured FBX overheads: one animated channel (curve node + 3 curves + connections), one key, extra mesh objects. */
const FBX_CHANNEL = 1500;
const FBX_KEY = 3 * 12;
const FBX_STACK = 600;
/** Helper bone + mesh model + material + texture/video + skin/cluster + bind pose entries (measured). */
const FBX_EXTRA_MESH = 4200;

/** Estimated FBX size: `baseBytes` (same FBX with no clips) plus the selected clips, their props and face nodes. */
export function estimateFbx(stats: LookStats, baseBytes: number, selected: string[], rootMotion: RootMotion): SizeEstimate {
  const clips = selected.map(n => stats.clips.get(n)).filter((c): c is ClipStats => !!c);
  if (!clips.length) return { bytes: baseBytes, clips: 0, props: [], faces: 1 };
  const props = Object.keys(stats.fbxMeshBytes).filter(p => p !== FACE_NODE && clips.some(c => c.shows.includes(p)));
  const faces = [...new Set(clips.flatMap(c => [...c.faceFrames]))].filter(f => f !== 1);
  const faceNodes = [1, ...faces];
  let bytes = baseBytes;
  let totalChannels = 0, totalKeys = 0;
  for (const c of clips) {
    const channels = stats.boneCount + 1 + props.length * 2 + faceNodes.length;
    totalChannels += channels;
    let keys = c.fbx.bones + c.fbx.root[rootMotion];
    for (const p of props) keys += c.fbx.props[p] ?? 4;
    for (const frame of faceNodes) {
      let last = -1;
      for (let f = 0; f < c.frames; f++) {
        const changed = f === 0 || f === c.frames - 1 || (c.faceFrames[f] === frame) !== (c.faceFrames[f - 1] === frame);
        if (!changed) continue;
        keys += 1 + (last >= 0 && f - 1 > last ? 1 : 0);
        last = f;
      }
    }
    bytes += FBX_STACK + channels * FBX_CHANNEL + keys * FBX_KEY;
    totalKeys += keys;
  }
  // Once clips exist the face (`Head`) becomes helper-driven (its geometry is replaced, not added); each extra
  // expression adds a copy of the face geometry with its own texture.
  bytes += FBX_EXTRA_MESH + faces.length * (FBX_EXTRA_MESH + (stats.fbxMeshBytes[FACE_NODE] ?? 0));
  for (const frame of faces) bytes += stats.facePng.get(frame) ?? 0;
  for (const p of props) bytes += FBX_EXTRA_MESH + stats.fbxMeshBytes[p];
  return { bytes: Math.round(bytes), clips: clips.length, props, faces: faceNodes.length, channels: totalChannels, keys: totalKeys };
}
