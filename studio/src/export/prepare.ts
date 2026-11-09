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
// about 1.4 m tall. Props (hidden unless an animation shows them) and the ground shadow are not exported.
import * as THREE from 'three';
import type { Buddy } from '@original/domain/buddy.js';
import type { SceneNode } from '@original/engine/scene-graph.js';
import { createBuddy, type OriginalAssets } from '../original';
import { BindSnapshot } from '../pose/bind';
import { ARM_CHAIN, SIDES, TPose } from '../pose/tpose';
import { CharacterRig, GROUND_MESHES } from '../scene/CharacterRig';

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
}

export interface PreparedExport {
  root: THREE.Group;
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

export async function prepareExport(assets: OriginalAssets, lookCode: string, options: ExportOptions): Promise<PreparedExport> {
  const buddy = await createBuddy(assets, lookCode);
  const bind = new BindSnapshot(buddy.scene);
  if (options.pose === 'tpose') new TPose(buddy.scene, bind).apply();
  const rig = new CharacterRig(buddy); // syncPose(): engine pose (rest or T-pose) -> Three bones; update(): parts, culling, materials
  rig.root.updateMatrixWorld(true);
  const scene = buddy.scene;
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
    if (options.pose === 'tpose') {
      // Same T-pose rule, solved in the export skeleton itself (its rotations are unit-axis), so the
      // exported joints are exactly horizontal too, not only the mesh.
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
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (const name of scene.boneNames) {
      a.setFromMatrixPosition(exportBones.get(name)!.matrixWorld);
      b.setFromMatrixPosition(rig.objectOf(name)!.matrixWorld).multiplyScalar(EXPORT_SCALE);
      maxJointShift = Math.max(maxJointShift, a.distanceTo(b));
    }
  }
  const skeleton = options.skeleton ? new THREE.Skeleton(scene.boneNames.map(n => exportBones.get(n)!)) : null;
  if (skeleton) skeleton.calculateInverses(); // the exported pose is the file's rest pose

  // ---- meshes: exact posed geometry
  const meshes: ExportManifest['meshes'] = [];
  const disposables: { dispose(): void }[] = [];
  const v = new THREE.Vector3();
  for (const part of rig.visibleParts()) {
    if (GROUND_MESHES.has(part.name)) continue;
    const source = part.geometry;
    const position = source.getAttribute('position');
    const world = new Float32Array(position.count * 3);
    const skinnedSource = (part as THREE.SkinnedMesh).isSkinnedMesh ? (part as THREE.SkinnedMesh) : null;
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i);
      if (skinnedSource) skinnedSource.applyBoneTransform(i, v);
      else v.applyMatrix4(part.matrixWorld);
      v.multiplyScalar(EXPORT_SCALE).toArray(world, i * 3);
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
    if (skeleton && (skinnedSource || options.rigidParts === 'skin')) {
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
  }
  root.updateMatrixWorld(true);

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
  };
  root.userData = { buddypoke: { ...manifest, bones: undefined, meshes: undefined } };

  return {
    root,
    manifest,
    dispose() {
      for (const d of disposables) d.dispose();
      rig.dispose();
    },
  };
}
