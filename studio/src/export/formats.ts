// OBJ and FBX export workflows (the GLB workflow in index.ts is unchanged). Both start from the same preparation as
// the GLB export (fresh original buddy with the current look; see prepare.ts), write the file, then verify it by
// reading it back before it is offered for download.
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import type { OriginalAssets } from '../original';
import { parseFbx, type ParsedNode } from './fbx/binary';
import { writeFbx } from './fbx/writer';
import { writeObjZip } from './obj';
import { prepareExport, type ExportManifest, type ExportOptions } from './prepare';
import { readZip } from './zip';

export type FileFormat = 'obj' | 'fbx';
export type FormatStep = 'preparing' | 'sampling' | 'writing' | 'verifying';

export interface FileCheck {
  ok: boolean;
  problems: string[];
  summary: Record<string, number | string>;
}

export interface FileExportResult {
  data: ArrayBuffer;
  /** File name extension and MIME type of the download. */
  extension: 'zip' | 'fbx';
  type: string;
  manifest: ExportManifest;
  check: FileCheck;
}

const toArrayBuffer = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

// ------------------------------------------------------------------------------------------------ OBJ

/** OBJ (+ MTL + PNG textures, zipped): static customized character in Rest or T-pose. */
export async function exportObj(assets: OriginalAssets, lookCode: string, options: Pick<ExportOptions, 'pose' | 'material'>, baseName: string, onStep: (step: FormatStep) => void = () => {}): Promise<FileExportResult> {
  onStep('preparing');
  const prepared = await prepareExport(assets, lookCode, { pose: options.pose, skeleton: false, rigidParts: 'skin', material: options.material });
  try {
    onStep('writing');
    const { zip } = await writeObjZip(prepared, baseName);
    onStep('verifying');
    const check = await checkObjZip(zip, prepared.manifest);
    return { data: toArrayBuffer(zip), extension: 'zip', type: 'application/zip', manifest: prepared.manifest, check };
  } finally {
    prepared.dispose();
  }
}

export async function checkObjZip(zip: Uint8Array, manifest: ExportManifest): Promise<FileCheck> {
  const problems: string[] = [];
  const entries = readZip(zip);
  const objEntry = entries.find(e => e.name.endsWith('.obj'));
  const mtlEntry = entries.find(e => e.name.endsWith('.mtl'));
  if (!objEntry || !mtlEntry) return { ok: false, problems: ['ZIP must contain an .obj and an .mtl file'], summary: {} };
  const dec = new TextDecoder();
  const objText = dec.decode(objEntry.data);
  const mtlText = dec.decode(mtlEntry.data);
  if (!objText.includes(`mtllib ${mtlEntry.name}`)) problems.push('OBJ does not reference its MTL file');
  const group = new OBJLoader().parse(objText);
  const meshes: THREE.Mesh[] = [];
  group.traverse(o => (o as THREE.Mesh).isMesh && meshes.push(o as THREE.Mesh));
  if (meshes.length !== manifest.meshes.length) problems.push(`${meshes.length} objects, expected ${manifest.meshes.length}`);
  let triangles = 0;
  for (const expected of manifest.meshes) {
    const m = meshes.find(x => x.name === expected.name.replace(/[^A-Za-z0-9_.-]+/g, '_'));
    if (!m) { problems.push(`object ${expected.name} missing`); continue; }
    const count = m.geometry.getAttribute('position').count / 3;
    triangles += count;
    if (count !== expected.triangles) problems.push(`${expected.name}: ${count} triangles, expected ${expected.triangles}`);
    if (!m.geometry.getAttribute('uv')) problems.push(`${expected.name}: no texture coordinates`);
    if (!m.geometry.getAttribute('normal')) problems.push(`${expected.name}: no normals`);
  }
  const materials = new MTLLoader().parse(mtlText, '');
  const used = [...objText.matchAll(/^usemtl (.+)$/gm)].map(m => m[1]);
  for (const name of used) if (!materials.materialsInfo[name]) problems.push(`material ${name} not defined in the MTL`);
  let textures = 0;
  const maps = [...mtlText.matchAll(/^map_(Kd|d) (.+)$/gm)].map(m => m[2]);
  for (const file of new Set(maps)) {
    const entry = entries.find(e => e.name === file);
    if (!entry) { problems.push(`texture ${file} missing from the ZIP`); continue; }
    try {
      const bitmap = await createImageBitmap(new Blob([toArrayBuffer(entry.data)], { type: 'image/png' }));
      if (!bitmap.width || !bitmap.height) problems.push(`texture ${file} is empty`);
      bitmap.close();
      textures++;
    } catch {
      problems.push(`texture ${file} is not a valid PNG`);
    }
  }
  for (const expected of manifest.meshes) if (!new RegExp(`^newmtl ${expected.name.replace(/[^A-Za-z0-9_.-]+/g, '_')}$`, 'm').test(mtlText)) problems.push(`${expected.name}: no material`);
  const transparent = manifest.meshes.filter(m => m.transparent).length;
  if ((mtlText.match(/^map_d /gm) ?? []).length !== transparent) problems.push('transparency maps do not match the transparent materials');
  return { ok: problems.length === 0, problems, summary: { bytes: zip.length, objects: meshes.length, triangles, textures, transparent, files: entries.length } };
}

// ------------------------------------------------------------------------------------------------ FBX

/** Binary FBX 7.4: rigged customized character (original skeleton and skin), with the selected clips. */
export async function exportFbx(assets: OriginalAssets, lookCode: string, options: ExportOptions, onStep: (step: FormatStep, done?: number, total?: number) => void = () => {}): Promise<FileExportResult> {
  onStep('preparing');
  // Always rest-bound like the animated GLB (bind = original rest pose); `pose` sets the initial display.
  const prepared = await prepareExport(assets, lookCode, { ...options, skeleton: true, animations: options.animations ?? [] }, (done, total) => onStep('sampling', done, total));
  try {
    onStep('writing');
    const { fbx, summary } = await writeFbx(prepared);
    onStep('verifying');
    const check = checkFbx(fbx, prepared.manifest);
    check.summary.maxEulerErrorDeg = Number(THREE.MathUtils.radToDeg(summary.maxEulerError ?? 0).toExponential(2));
    check.summary.maxEulerErrorNode = summary.maxEulerErrorNode ?? '';
    return { data: toArrayBuffer(fbx), extension: 'fbx', type: 'application/octet-stream', manifest: prepared.manifest, check };
  } finally {
    prepared.dispose();
  }
}

const child = (n: ParsedNode, name: string) => n.children.find(c => c.name === name);
const objName = (n: ParsedNode) => String(n.props[1]).split('\u0000')[0];

export function checkFbx(fbx: Uint8Array, manifest: ExportManifest): FileCheck {
  const problems: string[] = [];
  let parsed;
  try {
    parsed = parseFbx(fbx);
  } catch (error) {
    return { ok: false, problems: [`not a valid binary FBX: ${error instanceof Error ? error.message : error}`], summary: {} };
  }
  if (parsed.version !== 7400) problems.push(`FBX version ${parsed.version}`);
  const top = (name: string) => parsed.nodes.find(n => n.name === name);
  for (const required of ['FBXHeaderExtension', 'GlobalSettings', 'Documents', 'Definitions', 'Objects', 'Connections']) if (!top(required)) problems.push(`missing ${required}`);
  const objects = top('Objects')?.children ?? [];
  const ids = new Map(objects.map(o => [o.props[0] as bigint, o]));
  const connections = (top('Connections')?.children ?? []).map(c => ({ child: c.props[1] as bigint, parent: c.props[2] as bigint, property: c.props[3] as string | undefined }));
  for (const c of connections) if (!ids.has(c.child) || (c.parent !== 0n && !ids.has(c.parent))) problems.push('connection to an unknown object');
  const models = objects.filter(o => o.name === 'Model');
  const bones = models.filter(m => m.props[2] === 'LimbNode');
  const meshes = models.filter(m => m.props[2] === 'Mesh');
  if (meshes.length !== manifest.meshes.length) problems.push(`${meshes.length} meshes, expected ${manifest.meshes.length}`);
  const parentOf = (id: bigint) => connections.find(c => c.child === id && !c.property)?.parent;
  for (const b of manifest.bones) {
    const model = bones.find(m => objName(m) === b.name);
    if (!model) { problems.push(`bone ${b.name} missing`); continue; }
    const parent = ids.get(parentOf(model.props[0] as bigint) ?? 0n);
    const parentName = parent && parent.props[2] === 'LimbNode' ? objName(parent) : null;
    if (parentName !== b.parent) problems.push(`${b.name}: parent ${parentName}, expected ${b.parent}`);
  }
  const geometries = objects.filter(o => o.name === 'Geometry');
  for (const g of geometries) {
    const vertices = child(g, 'Vertices')?.props[0] as number[] | undefined;
    const polygons = child(g, 'PolygonVertexIndex')?.props[0] as number[] | undefined;
    if (!vertices || !polygons || polygons.length % 3) { problems.push(`${objName(g)}: bad geometry`); continue; }
    const n = vertices.length / 3;
    if (polygons.some(i => (i < 0 ? ~i : i) >= n)) problems.push(`${objName(g)}: index out of range`);
  }
  const clusters = objects.filter(o => o.name === 'Deformer' && o.props[2] === 'Cluster');
  const helpers = bones.filter(b => objName(b).startsWith('Ctrl_'));
  const skinnedExpected = manifest.meshes.filter(m => m.skinned).length + helpers.length; // helper-driven props / faces are skinned in FBX
  if (bones.length !== manifest.bones.length + helpers.length) problems.push(`${bones.length} bones, expected ${manifest.bones.length} + ${helpers.length} helpers`);
  for (const h of helpers) if (!meshes.some(m => `Ctrl_${objName(m)}` === objName(h))) problems.push(`${objName(h)} drives no mesh`);
  const skins = objects.filter(o => o.name === 'Deformer' && o.props[2] === 'Skin');
  if (skins.length !== skinnedExpected) problems.push(`${skins.length} skins, expected ${skinnedExpected}`);
  for (const c of clusters) {
    const idx = child(c, 'Indexes')?.props[0] as number[];
    const w = child(c, 'Weights')?.props[0] as number[];
    if (!idx || !w || idx.length !== w.length) problems.push(`${objName(c)}: bad cluster`);
  }
  const videos = objects.filter(o => o.name === 'Video');
  for (const v of videos) {
    const content = child(v, 'Content')?.props[0] as Uint8Array | undefined;
    if (!content || content[0] !== 0x89 || content[1] !== 0x50) problems.push(`${objName(v)}: embedded texture is not a PNG`);
  }
  const stacks = objects.filter(o => o.name === 'AnimationStack');
  if (stacks.length !== manifest.animations.length) problems.push(`${stacks.length} animation stacks, expected ${manifest.animations.length}`);
  for (const a of manifest.animations) if (!stacks.some(s => objName(s) === a.name)) problems.push(`animation ${a.name} missing`);
  const curves = objects.filter(o => o.name === 'AnimationCurve');
  for (const c of curves) {
    const t = child(c, 'KeyTime')?.props[0] as bigint[];
    const v = child(c, 'KeyValueFloat')?.props[0] as number[];
    if (!t || !v || t.length !== v.length || t.some((x, i) => i > 0 && x <= t[i - 1])) { problems.push('bad animation curve'); break; }
  }
  // Three's FBXLoader reads the same file (a second, independent reader).
  try {
    const scene = new FBXLoader().parse(toArrayBuffer(fbx), '');
    let loaded = 0;
    scene.traverse(o => (o as THREE.Mesh).isMesh && loaded++);
    if (loaded !== manifest.meshes.length) problems.push(`FBXLoader: ${loaded} meshes`);
    if (scene.animations.length !== manifest.animations.length) problems.push(`FBXLoader: ${scene.animations.length} animations`);
  } catch (error) {
    problems.push(`FBXLoader cannot read the file: ${error instanceof Error ? error.message : error}`);
  }
  return {
    ok: problems.length === 0,
    problems,
    summary: { bytes: fbx.length, meshes: meshes.length, skinnedMeshes: skins.length, bones: bones.length - helpers.length, helperBones: helpers.length, clusters: clusters.length, textures: videos.length, animations: stacks.length },
  };
}
