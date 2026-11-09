// GLB writer + self-check. The file is written with Three's GLTFExporter (binary, TRS nodes, embedded
// PNG textures in buffer views: no external files, no browser URLs), then re-read with GLTFLoader and
// checked against the export manifest before it is offered for download.
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { ExportManifest, PreparedExport } from './prepare';

export interface GlbCheck {
  ok: boolean;
  problems: string[];
  summary: { bytes: number; meshes: number; skinnedMeshes: number; joints: number; textures: number; materials: number; transparent: number };
}

interface GltfJson {
  asset: { generator?: string; version: string };
  images?: { uri?: string; bufferView?: number; mimeType?: string }[];
  textures?: unknown[];
  materials?: { name?: string; alphaMode?: string; extensions?: Record<string, unknown>; pbrMetallicRoughness?: { baseColorTexture?: unknown } }[];
  skins?: { joints: number[]; inverseBindMatrices?: number }[];
  nodes?: { name?: string; children?: number[]; matrix?: number[] }[];
  meshes?: unknown[];
  extensionsUsed?: string[];
  animations?: { name?: string; channels: { sampler: number; target: { node: number; path: string } }[]; samplers: { input: number; output: number; interpolation?: string }[] }[];
  accessors?: { max?: number[]; min?: number[]; count: number }[];
}

export async function writeGlb(prepared: PreparedExport): Promise<ArrayBuffer> {
  return (await new GLTFExporter().parseAsync(prepared.root, { binary: true, trs: true, onlyVisible: true, animations: prepared.animations })) as ArrayBuffer;
}

/** Read the JSON chunk of a GLB (for structural checks). */
export function glbJson(glb: ArrayBuffer): GltfJson {
  const view = new DataView(glb);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error('Not a GLB file');
  const length = view.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, length)));
}

export async function checkGlb(glb: ArrayBuffer, manifest: ExportManifest): Promise<GlbCheck> {
  const problems: string[] = [];
  const json = glbJson(glb);
  if (json.asset.version !== '2.0') problems.push(`glTF version ${json.asset.version}`);
  for (const image of json.images ?? []) {
    if (image.uri) problems.push(`image stored as external/URI reference (${image.uri.slice(0, 30)})`);
    if (image.bufferView === undefined) problems.push('image not embedded');
  }
  if ((json.nodes ?? []).some(n => n.matrix)) problems.push('node stored as matrix instead of TRS');
  const gltf = await new GLTFLoader().parseAsync(glb, '');
  const meshes: THREE.Mesh[] = [];
  gltf.scene.traverse(o => (o as THREE.Mesh).isMesh && meshes.push(o as THREE.Mesh));
  const skinned = meshes.filter(m => (m as THREE.SkinnedMesh).isSkinnedMesh) as THREE.SkinnedMesh[];
  if (meshes.length !== manifest.meshes.length) problems.push(`${meshes.length} meshes, expected ${manifest.meshes.length}`);
  for (const expected of manifest.meshes) {
    const mesh = meshes.find(m => m.name === expected.name);
    if (!mesh) {
      problems.push(`mesh ${expected.name} missing`);
      continue;
    }
    const material = mesh.material as THREE.MeshBasicMaterial;
    const image = material.map?.image as { width: number; height: number } | undefined;
    if (!image?.width) problems.push(`${expected.name}: texture missing`);
    else if (image.width !== expected.texture[0] || image.height !== expected.texture[1]) problems.push(`${expected.name}: texture ${image.width}x${image.height}`);
    if (material.transparent !== expected.transparent) problems.push(`${expected.name}: transparency lost`);
    if (mesh.geometry.getAttribute('position').count !== expected.vertices) problems.push(`${expected.name}: vertex count`);
    if (expected.skinned !== ((mesh as THREE.SkinnedMesh).isSkinnedMesh === true)) problems.push(`${expected.name}: skinning`);
  }
  let joints = 0;
  if (manifest.skeleton) {
    // GLTFExporter writes one skin per skinned mesh; all must share the same joints (Blender then builds
    // a single armature, verified in tests/blender/validate_glb.py).
    const skins = json.skins ?? [];
    if (!skins.length) problems.push('no skin');
    if (skins.some(s => s.joints.join() !== skins[0].joints.join())) problems.push('skins do not share the same joints');
    if (skins.some(s => s.inverseBindMatrices === undefined)) problems.push('skin without inverse bind matrices');
    const bones = skinned[0]?.skeleton.bones ?? [];
    joints = bones.length;
    if (manifest.meshes.some(m => m.skinned)) {
      if (bones.map(b => b.name).join() !== manifest.bones.map(b => b.name).join()) problems.push('joint names/order differ from the original bones');
      for (const b of manifest.bones) {
        const bone = bones.find(x => x.name === b.name);
        const parent = bone?.parent && (bone.parent as THREE.Bone).isBone ? bone.parent.name : null;
        if (parent !== b.parent) problems.push(`${b.name}: parent ${parent}, expected ${b.parent}`);
      }
    }
  } else if (json.skins?.length) problems.push('static export contains a skin');
  // Animations (M3C): every clip present by name, original duration, every bone rotated + root translated, STEP only.
  const anims = json.animations ?? [];
  if (anims.length !== manifest.animations.length) problems.push(`${anims.length} animations, expected ${manifest.animations.length}`);
  for (const expected of manifest.animations) {
    const a = anims.find(x => x.name === expected.name);
    if (!a) {
      problems.push(`animation ${expected.name} missing`);
      continue;
    }
    const rotated = new Set(a.channels.filter(c => c.target.path === 'rotation').map(c => json.nodes?.[c.target.node]?.name));
    const missing = manifest.bones.filter(b => !rotated.has(b.name)).map(b => b.name);
    if (missing.length) problems.push(`${expected.name}: bones not keyed: ${missing.join(', ')}`);
    if (!a.channels.some(c => c.target.path === 'translation' && json.nodes?.[c.target.node]?.name === 'Bip01')) problems.push(`${expected.name}: no root translation`);
    if (a.samplers.some(s => s.interpolation !== 'STEP')) problems.push(`${expected.name}: non-STEP interpolation`);
    // M3C-2: props (rotation + visibility) and face nodes (visibility) keyed in every clip: no state carry-over.
    const channelsOf = (path: string) => new Set(a.channels.filter(c => c.target.path === path).map(c => json.nodes?.[c.target.node]?.name));
    const scaled = channelsOf('scale');
    const unkeyedProps = manifest.props.filter(p => !rotated.has(p.name) || !scaled.has(p.name)).map(p => p.name);
    if (unkeyedProps.length) problems.push(`${expected.name}: props not keyed: ${unkeyedProps.join(', ')}`);
    const unkeyedFaces = manifest.faces.filter(f => !scaled.has(f.name)).map(f => f.name);
    if (unkeyedFaces.length) problems.push(`${expected.name}: face nodes not keyed: ${unkeyedFaces.join(', ')}`);
    const end = Math.max(...a.samplers.map(s => json.accessors?.[s.input]?.max?.[0] ?? 0));
    if (Math.abs(end - expected.duration) > 1e-4) problems.push(`${expected.name}: duration ${end}, expected ${expected.duration}`);
  }
  return {
    ok: problems.length === 0,
    problems,
    summary: {
      bytes: glb.byteLength,
      meshes: meshes.length,
      skinnedMeshes: skinned.length,
      joints,
      textures: json.images?.length ?? 0,
      materials: json.materials?.length ?? 0,
      transparent: (json.materials ?? []).filter(m => m.alphaMode === 'BLEND' || m.alphaMode === 'MASK').length,
    },
  };
}

export function downloadFile(name: string, data: ArrayBuffer, type = 'model/gltf-binary') {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
