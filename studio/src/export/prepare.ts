// Export preparation: builds a detached, export-ready Three.js scene of the character.
//
// Isolation: every export decodes a FRESH original buddy from the original package and dresses it with
// the current look code. It has never been animated, so its pose is the exact original rest pose; the
// live Studio character, its animation state and its rig are never touched.
//
// Geometry: vertex positions are the exact posed positions (original skin weights, original rest matrices,
// or the M3A-3 T-pose on the fresh copy), so the exported mesh matches the viewport.
//
// Skeleton (rigged export): the 29 original bones with their original names and parent relationships,
// as clean TRS nodes. Documented adjustment: the original rest rotations have slightly non-unit stored axes
// (M3A-1), which glTF cannot represent (node transforms must be pure translation/rotation/scale), so each
// bone uses the unit-axis version of its own rotation. Joints move by at most ~0.07 original units; the
// mesh does not move (inverse bind matrices are computed from this skeleton in the exported pose).
//
// Units: glTF uses metres. One original unit is treated as one centimetre (scale 0.01), so the buddy is
// about 1.4 m tall. The ground shadow is not exported. Props (hidden unless an animation shows them) are
// exported only in animated files, when an exported clip shows them (M3C-2).
//
// Animated files (M3C-2): props and facial expressions are separate rigid nodes parented to their original
// bone (never skinned: glTF ignores the transform of a skinned mesh node, and visibility is node scale):
//   - each prop used by an exported clip: its original local transform, its rotation track and its
//     visibility track (scale 1 shown / 1e-6 hidden), hidden in the initial display and in other clips;
//   - the face: `Head` shows frame 1 (= the dressed face) and one copy `Head_F<nn>` per other expression
//     frame used, each with the face texture the ORIGINAL TextureLibrary composes for that frame and look.
//     Exactly one face node is visible at every frame of every clip.
import * as THREE from 'three';
import type { Buddy } from '@original/domain/buddy.js';
import type { SceneNode } from '@original/engine/scene-graph.js';
import { createBuddy, type OriginalAssets } from '../original';
import { BindSnapshot } from '../pose/bind';
import { ARM_CHAIN, SIDES, TPose } from '../pose/tpose';
import { CharacterRig, GROUND_MESHES } from '../scene/CharacterRig';
import { TextureCache } from '../scene/textures';
import { FACE_NODE, faceNodeName, HIDDEN_SCALE, nodeQuaternion, sampleClip, toAnimationClip, type SampledClip } from './animation/sample';

export type ExportPose = 'rest' | 'tpose';
export type RigidParts = 'skin' | 'parent';
export type MaterialMode = 'unlit' | 'lit';

export interface ExportOptions {
  pose: ExportPose;
  /** Include the armature and skin weights. */
  skeleton: boolean;
  /** Rigid parts (head, short hair): skinned to their bone with weight 1, or parented to it. */
  rigidParts: RigidParts;
  material: MaterialMode;
  /**
   * Animated export (M3C): original clip names to include. When set (even empty), the skeleton is bound to
   * the ORIGINAL REST POSE (clean inverse binds) and `pose` only chooses the file's initial display pose.
   */
  animations?: string[];
}

export const EXPORT_SCALE = 0.01;

export interface ExportManifest {
  generator: string;
  lookCode: string;
  pose: ExportPose;
  skeleton: boolean;
  rigidParts: RigidParts;
  material: MaterialMode;
  scale: number;
  units: string;
  bones: { name: string; parent: string | null; head: [number, number, number] }[];
  meshes: { name: string; vertices: number; triangles: number; skinned: boolean; parent: string | null; transparent: boolean; texture: [number, number] }[];
  /** Largest joint shift caused by using unit rotation axes (metres). */
  maxJointShift: number;
  /** What the skin is bound to: the exported pose (M3B), or always the original rest pose (animated export). */
  bind: 'pose' | 'rest';
  animations: { name: string; frames: number; fps: number; duration: number }[];
  /** Animated export: props shown by at least one exported clip (rigid nodes with rotation + visibility tracks). */
  props: { name: string; parent: string }[];
  /** Animated export: face nodes, one per original expression frame used (frame 1 = `Head`, the dressed face). */
  faces: { name: string; frame: number }[];
}

export interface PreparedExport {
  root: THREE.Group;
  animations: THREE.AnimationClip[];
  manifest: ExportManifest;
  dispose(): void;
}

/** Parent bone of every bone, and nearest ancestor bone of every node, from the original hierarchy. */
function hierarchy(buddy: Buddy) {
  const bones = new Set(buddy.scene.boneNames);
  const parentBone = new Map<SceneNode, SceneNode | null>();
  const walk = (node: SceneNode, nearest: SceneNode | null) => {
    parentBone.set(node, nearest);
    const next = node.name && bones.has(node.name) ? node : nearest;
    for (const child of node.children) walk(child, next);
  };
  walk(buddy.scene, null);
  return parentBone;
}

/** Same T-pose rule as M3A-3, solved in the export skeleton (unit-axis rotations): exactly horizontal joints. */
function solveExportTPose(exportBones: Map<string, THREE.Bone>, root: THREE.Object3D) {
  const xAxis = new THREE.Vector3(1, 0, 0);
  for (const { side, direction } of SIDES) {
    for (const name of ARM_CHAIN) {
      const bone = exportBones.get(`Bip01_${side}_${name}`)!;
      const world = bone.getWorldQuaternion(new THREE.Quaternion());
      const turn = new THREE.Quaternion().setFromUnitVectors(xAxis.clone().applyQuaternion(world), direction);
      const parentWorld = bone.parent!.getWorldQuaternion(new THREE.Quaternion());
      bone.quaternion.copy(parentWorld.invert().multiply(turn.multiply(world))).normalize();
      root.updateMatrixWorld(true);
    }
  }
}

export async function prepareExport(assets: OriginalAssets, lookCode: string, options: ExportOptions): Promise<PreparedExport> {
  const buddy = await createBuddy(assets, lookCode);
  const bind = new BindSnapshot(buddy.scene);
  const animated = options.animations !== undefined;
  if (animated && !options.skeleton) throw new Error('Animated export needs the skeleton');
  // Static/rigged (M3B): the engine itself is posed. Animated (M3C): the engine stays at rest (the bind pose).
  if (options.pose === 'tpose' && !animated) new TPose(buddy.scene, bind).apply();
  const rig = new CharacterRig(buddy); // syncPose(): engine pose (rest or T-pose) -> Three bones; update(): parts, culling, materials
  const scene = buddy.scene;
  // Animated: sample every clip on the fresh buddy first (exact rest restore before and after each clip),
  // to know which props and face frames the exported clips use.
  const samples: SampledClip[] = animated ? options.animations!.map(name => {
    const clip = buddy.animations.get(name);
    if (!clip) throw new Error(`Unknown animation "${name}"`);
    return sampleClip(scene, clip, bind, scene.boneNames, EXPORT_SCALE);
  }) : [];
  const usedProps = scene.propNames.filter(name => samples.some(s => s.props[name]?.visible.some(v => v === 1)));
  const faceFrames = [...new Set(samples.flatMap(s => Array.from(s.faceFrames)))].filter(f => f !== 1).sort((a, b) => a - b);
  const faceMaterial = scene.node(FACE_NODE)?.mesh?.material ?? null;
  const faceBitmaps = new Map<number, OffscreenCanvas>();
  for (const frame of faceFrames) {
    faceMaterial!.showFrame(frame); // original composition of this expression frame for this look
    faceBitmaps.set(frame, faceMaterial!.bitmap!);
  }
  if (usedProps.length) {
    // Props are hidden by the original hideProps() when dressed: build their parts (geometry, material, culling).
    for (const name of usedProps) scene.node(name)!.visible = true;
    rig.syncVisibility();
    scene.hideProps();
  }
  rig.syncPose(); // engine back at the exact rest pose (sampling restored it): refresh every world matrix
  rig.root.updateMatrixWorld(true);
  const parentBone = hierarchy(buddy);
  const root = new THREE.Group();
  root.name = 'BuddyPoke';

  // ---- skeleton: original names and hierarchy, unit-axis rotations, metres
  const exportBones = new Map<string, THREE.Bone>();
  let maxJointShift = 0;
  if (options.skeleton) {
    for (const name of scene.boneNames) {
      const node = scene.node(name)!;
      const bone = new THREE.Bone();
      bone.name = name;
      const p = node.position;
      if (p) bone.position.set(p.x, p.y, p.z).multiplyScalar(EXPORT_SCALE);
      const r = node.rotation;
      if (r && r.angle !== 0) bone.quaternion.setFromAxisAngle(new THREE.Vector3(r.x, r.y, r.z).normalize(), r.angle);
      exportBones.set(name, bone);
    }
    for (const name of scene.boneNames) {
      const parent = parentBone.get(scene.node(name)!);
      (parent ? exportBones.get(parent.name!)! : root).add(exportBones.get(name)!);
    }
    root.updateMatrixWorld(true);
    if (options.pose === 'tpose' && !animated) solveExportTPose(exportBones, root);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (const name of scene.boneNames) {
      a.setFromMatrixPosition(exportBones.get(name)!.matrixWorld);
      b.setFromMatrixPosition(rig.objectOf(name)!.matrixWorld).multiplyScalar(EXPORT_SCALE);
      maxJointShift = Math.max(maxJointShift, a.distanceTo(b));
    }
  }
  const skeleton = options.skeleton ? new THREE.Skeleton(scene.boneNames.map(n => exportBones.get(n)!)) : null;
  if (skeleton) skeleton.calculateInverses(); // M3B: the exported pose is the bind pose; M3C: the original rest pose
  // Clean rest joint matrices (metres) and the engine's own inverse binds, for the animated bind shape.
  const restJoint = skeleton ? skeleton.boneInverses.map(m => m.clone().invert()) : [];
  const engineInverseBind = scene.boneNames.map(n => new THREE.Matrix4().fromArray(Array.from(scene.node(n)!.inverseBind.e)));
  const boneIndex = new Map(scene.boneNames.map((n, i) => [n, i]));
  /**
   * Animated bind shape (M3C plan, option c): s = Σ wₖ · Jrest_clean(bₖ) · (scale · engineInverseBind(bₖ) · v).
   * glTF skinning then reproduces the original engine exactly for every vertex whose original weights
   * sum to 1 (the engine binds with its own, slightly scaled, rest matrices; the file uses clean ones).
   */
  const bindShape = (v: THREE.Vector3, bones: number[], weights: number[], out: THREE.Vector3) => {
    const sum = weights.reduce((a, b) => a + b, 0);
    out.set(0, 0, 0);
    const t = new THREE.Vector3();
    bones.forEach((b, k) => {
      if (!weights[k]) return;
      t.copy(v).applyMatrix4(engineInverseBind[b]).multiplyScalar(EXPORT_SCALE).applyMatrix4(restJoint[b]);
      out.addScaledVector(t, weights[k] / sum);
    });
    return out;
  };

  // ---- meshes: exact posed geometry
  const meshes: ExportManifest['meshes'] = [];
  const disposables: { dispose(): void }[] = [];
  const faceTextures = new TextureCache();
  const props: ExportManifest['props'] = [];
  const faces: ExportManifest['faces'] = [];
  const faceNodes = new Map<number, string>([[1, FACE_NODE]]);
  const v = new THREE.Vector3();
  const parts = [...rig.visibleParts(), ...rig.allMeshes().filter(m => usedProps.includes(m.name) && !rig.visibleParts().includes(m))];
  for (const part of parts) {
    if (GROUND_MESHES.has(part.name)) continue;
    const isProp = animated && usedProps.includes(part.name);
    const isFace = animated && part.name === FACE_NODE;
    const source = part.geometry;
    const position = source.getAttribute('position');
    const world = new Float32Array(position.count * 3);
    const skinnedSource = (part as THREE.SkinnedMesh).isSkinnedMesh ? (part as THREE.SkinnedMesh) : null;
    const node0 = scene.node(part.name)!;
    const owner0 = skinnedSource ? null : parentBone.get(node0) ?? null;
    const skinIndex = source.getAttribute('skinIndex');
    const skinWeight = source.getAttribute('skinWeight');
    const nodeWorld = new THREE.Matrix4().fromArray(Array.from(node0.world.e));
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i);
      if (animated && skinnedSource) {
        const bones = [0, 1, 2, 3].map(k => skinIndex.getComponent(i, k));
        const weights = [0, 1, 2, 3].map(k => skinWeight.getComponent(i, k));
        bindShape(v.clone(), bones, weights, v);
      } else if (isProp) {
        v.multiplyScalar(EXPORT_SCALE); // prop local space; the node carries the original local transform
      } else if (animated && owner0 && !isFace && (options.rigidParts === 'skin' || !options.skeleton)) {
        bindShape(v.clone().applyMatrix4(nodeWorld), [boneIndex.get(owner0.name!)!], [1], v);
      } else if (animated && owner0) {
        v.applyMatrix4(nodeWorld).applyMatrix4(engineInverseBind[boneIndex.get(owner0.name!)!]).multiplyScalar(EXPORT_SCALE).applyMatrix4(restJoint[boneIndex.get(owner0.name!)!]);
      } else {
        if (skinnedSource) skinnedSource.applyBoneTransform(i, v);
        else v.applyMatrix4(part.matrixWorld);
        v.multiplyScalar(EXPORT_SCALE);
      }
      v.toArray(world, i * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(world, 3));
    geometry.setAttribute('uv', source.getAttribute('uv').clone());
    geometry.setIndex(Array.from(source.index!.array));
    geometry.computeVertexNormals();
    disposables.push(geometry);

    const sourceMaterial = part.material as THREE.MeshBasicMaterial;
    const map = sourceMaterial.map!;
    map.name = part.name;
    const common = { name: part.name, map, transparent: sourceMaterial.transparent, alphaTest: sourceMaterial.alphaTest, side: THREE.FrontSide };
    const material = options.material === 'lit' ? new THREE.MeshStandardMaterial({ ...common, roughness: 1, metalness: 0 }) : new THREE.MeshBasicMaterial(common);
    disposables.push(material);

    const node = scene.node(part.name)!;
    const ownerBone = skinnedSource ? null : parentBone.get(node) ?? null; // rigid part: nearest ancestor bone
    let mesh: THREE.Mesh;
    let parentName: string | null = null;
    if (isProp) {
      const node = scene.node(part.name)!;
      const bone = exportBones.get(ownerBone!.name!)!;
      mesh = new THREE.Mesh(geometry, material);
      const p = node.position;
      if (p) mesh.position.set(p.x, p.y, p.z).multiplyScalar(EXPORT_SCALE);
      nodeQuaternion(node, mesh.quaternion);
      mesh.scale.setScalar(HIDDEN_SCALE); // hidden unless a clip shows it, as in the original
      bone.add(mesh);
      parentName = bone.name;
      props.push({ name: part.name, parent: bone.name });
    } else if (skeleton && (skinnedSource || (options.rigidParts === 'skin' && !isFace))) {
      const indices = new Uint16Array(position.count * 4);
      const weights = new Float32Array(position.count * 4);
      if (skinnedSource) {
        indices.set(source.getAttribute('skinIndex').array as ArrayLike<number>);
        weights.set(source.getAttribute('skinWeight').array as ArrayLike<number>);
      } else {
        const boneIndex = scene.boneNames.indexOf(ownerBone!.name!);
        for (let i = 0; i < position.count; i++) {
          indices[i * 4] = boneIndex;
          weights[i * 4] = 1;
        }
      }
      // glTF requires weights summing to 1; the original quantised weights sum to 0.996–1. The vertices are
      // already baked in the exact pose, so normalising does not move the exported mesh.
      for (let i = 0; i < position.count; i++) {
        const sum = weights[i * 4] + weights[i * 4 + 1] + weights[i * 4 + 2] + weights[i * 4 + 3];
        if (sum > 0) for (let k = 0; k < 4; k++) weights[i * 4 + k] /= sum;
      }
      geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4));
      geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
      const skinned = new THREE.SkinnedMesh(geometry, material);
      root.add(skinned);
      skinned.bind(skeleton, new THREE.Matrix4());
      mesh = skinned;
    } else if (skeleton && ownerBone) {
      // Keep parented: vertices in the bone's local space.
      const bone = exportBones.get(ownerBone.name!)!;
      geometry.applyMatrix4(bone.matrixWorld.clone().invert());
      mesh = new THREE.Mesh(geometry, material);
      bone.add(mesh);
      parentName = bone.name;
    } else {
      mesh = new THREE.Mesh(geometry, material);
      root.add(mesh);
    }
    mesh.name = part.name;
    const image = map.image as { width: number; height: number };
    meshes.push({
      name: part.name,
      vertices: position.count,
      triangles: (source.index?.count ?? 0) / 3,
      skinned: (mesh as THREE.SkinnedMesh).isSkinnedMesh === true,
      parent: parentName,
      transparent: material.transparent,
      texture: [image.width, image.height],
    });
    if (isFace) {
      // One copy per other expression frame: same geometry and node, the original texture of that frame.
      faces.push({ name: FACE_NODE, frame: 1 });
      for (const frame of faceFrames) {
        const name = faceNodeName(frame);
        const map = faceTextures.get(faceBitmaps.get(frame)!);
        map.name = name;
        const faceMaterial = material.clone();
        faceMaterial.name = name;
        (faceMaterial as THREE.MeshBasicMaterial).map = map;
        disposables.push(faceMaterial);
        const copy = new THREE.Mesh(geometry, faceMaterial);
        copy.name = name;
        copy.position.copy(mesh.position);
        copy.quaternion.copy(mesh.quaternion);
        copy.scale.setScalar(HIDDEN_SCALE);
        mesh.parent!.add(copy);
        faceNodes.set(frame, name);
        faces.push({ name, frame });
        meshes.push({ ...meshes[meshes.length - 1], name });
      }
    }
  }
  disposables.push({ dispose: () => faceTextures.retain(new Set()) });
  root.updateMatrixWorld(true);

  // Animated: the file may *display* the T-pose; the inverse binds (above) stay the original rest pose.
  if (animated && options.pose === 'tpose') solveExportTPose(exportBones, root);
  const animations = samples.map(sample => toAnimationClip(sample, scene.boneNames, { props: props.map(p => p.name), faceNodes }));

  const manifest: ExportManifest = {
    generator: 'BuddyPoke Studio (original BuddyRevival data)',
    lookCode,
    pose: options.pose,
    skeleton: options.skeleton,
    rigidParts: options.rigidParts,
    material: options.material,
    scale: EXPORT_SCALE,
    units: 'metres (1 original BuddyPoke unit = 1 cm)',
    bones: options.skeleton
      ? scene.boneNames.map(name => ({
          name,
          parent: parentBone.get(scene.node(name)!)?.name ?? null,
          head: new THREE.Vector3().setFromMatrixPosition(exportBones.get(name)!.matrixWorld).toArray() as [number, number, number],
        }))
      : [],
    meshes,
    maxJointShift,
    bind: animated ? 'rest' : 'pose',
    animations: animations.map(a => {
      const clip = buddy.animations.get(a.name)!;
      return { name: a.name, frames: clip.frameCount, fps: clip.fps, duration: a.duration };
    }),
    props,
    faces: animated ? faces : [],
  };
  root.userData = { buddypoke: { ...manifest, bones: undefined, meshes: undefined } };

  return {
    root,
    animations,
    manifest,
    dispose() {
      for (const d of disposables) d.dispose();
      rig.dispose();
    },
  };
}
