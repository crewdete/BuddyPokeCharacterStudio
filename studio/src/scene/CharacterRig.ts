// Builds a Three.js view of an original BuddyRevival buddy.
//
// The original engine stays authoritative: its scene graph owns every transform, its catalog owns the
// look, and its TextureLibrary composes every bitmap. This class only mirrors that state into Three:
//   - every scene node becomes an Object3D (bones become THREE.Bone) with the node's local matrix;
//   - the 29 bones form a THREE.Skeleton whose inverse binds are the engine's own `inverseBind`;
//   - skinned meshes become SkinnedMesh (model-space bind vertices, original weights, ≤3 influences);
//   - rigid meshes (head, short hair, props) become Mesh children of their node, as in the original;
//   - after every `buddy.dress()`, `update()` re-reads visibility, cull regions and materials.
import * as THREE from 'three';
import type { Buddy } from '@original/domain/buddy.js';
import type { Material as OriginalMaterial } from '@original/engine/material.js';
import { IDENTITY, type Matrix4 as OriginalMatrix } from '@original/engine/math.js';
import { Camera, type Scene, type SceneNode } from '@original/engine/scene-graph.js';
import { applyDepthOffset } from './depthOffset';
import { TextureCache } from './textures';

/** Meshes that are not part of the character's body (excluded from framing and bounds). */
export const GROUND_MESHES = new Set(['Shadow']);

interface Part {
  node: SceneNode;
  object: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  /** Original material currently shown, and the bitmap uploaded for it. */
  source: OriginalMaterial | null;
  bitmap: OffscreenCanvas | null;
  cullKey: string;
}

export const toThreeMatrix = (m: OriginalMatrix, target = new THREE.Matrix4()) => target.fromArray(Array.from(m.e));

export class CharacterRig {
  readonly root = new THREE.Group();
  private readonly listeners = new Set<() => void>();
  readonly skeleton: THREE.Skeleton;
  readonly scene: Scene;
  private readonly objects = new Map<SceneNode, THREE.Object3D>();
  private readonly parts = new Map<SceneNode, Part>();
  private readonly textures = new TextureCache();

  constructor(readonly buddy: Buddy) {
    this.scene = buddy.scene;
    this.root.name = 'BuddyPoke';
    this.mirror(this.scene, this.root);
    const bones = this.scene.boneNames.map(name => this.objectOf(name) as THREE.Bone);
    const inverses = this.scene.boneNames.map(name => toThreeMatrix(this.scene.node(name)!.inverseBind));
    this.skeleton = new THREE.Skeleton(bones, inverses);
    this.syncPose();
    this.update();
  }

  objectOf(name: string): THREE.Object3D | undefined {
    const node = this.scene.node(name);
    return node ? this.objects.get(node) : undefined;
  }

  /** Bone objects in original bone-index order. */
  get bones(): THREE.Bone[] {
    return this.skeleton.bones;
  }

  /** Visible character meshes (excluding the ground shadow). */
  visibleParts(): THREE.Mesh[] {
    return [...this.parts.values()].filter(p => p.object.visible && !GROUND_MESHES.has(p.node.name ?? '')).map(p => p.object);
  }

  private mirror(node: SceneNode, parent: THREE.Object3D) {
    if (node instanceof Camera) return;
    const isBone = node.name !== null && this.scene.boneNames.includes(node.name);
    const object = isBone ? new THREE.Bone() : new THREE.Object3D();
    object.name = node.name ?? 'SceneRoot';
    object.matrixAutoUpdate = false;
    parent.add(object);
    this.objects.set(node, object);
    for (const child of node.children) this.mirror(child, object);
  }

  /** Copy the engine's current local transforms (bind pose until an animation runs) into Three. */
  syncPose() {
    // Same traversal as the original SceneNode.draw(): updateWorld() rebuilds `local` from position/rotation.
    const walk = (node: SceneNode, parentWorld: OriginalMatrix) => {
      node.updateWorld(parentWorld);
      const object = this.objects.get(node);
      if (object) toThreeMatrix(node.local, object.matrix);
      for (const child of node.children) walk(child, node.world);
    };
    walk(this.scene, IDENTITY);
    this.root.updateMatrixWorld(true);
  }

  /** Re-read the dressed state from the engine: visibility, materials, culled regions. Call after buddy.dress(). */
  update() {
    const live = new Set<OffscreenCanvas>();
    this.scene.find(node => {
      const mesh = node.mesh;
      if (!mesh) return false;
      const shown = node.visible && mesh.material !== null;
      let part = this.parts.get(node);
      if (!shown) {
        if (part) part.object.visible = false;
        return false;
      }
      if (!mesh.decoded) mesh.decode(this.scene);
      part ??= this.createPart(node);
      const wholeMeshCulled = !mesh.faceRegions && mesh.meshRegion >= 0 && this.scene.isCulled(mesh.meshRegion);
      part.object.visible = !wholeMeshCulled;
      this.updateIndex(part);
      this.updateMaterial(part);
      if (part.bitmap) live.add(part.bitmap);
      return false;
    });
    this.textures.retain(live);
    for (const listener of this.listeners) listener();
  }

  /** Called after every update(); the viewport uses it to request a frame (on-demand rendering). */
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Swap textures whose original material changed frame (expressions, blinks). Cheap; call per frame. */
  refreshTextures() {
    for (const part of this.parts.values()) {
      if (part.object.visible && part.source && part.source.bitmap !== part.bitmap) this.updateMaterial(part);
    }
  }

  private createPart(node: SceneNode): Part {
    const mesh = node.mesh!;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(mesh.vertices.flatMap(v => [v.x, v.y, v.z]), 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(Array.from(mesh.uvs), 2));
    const material = new THREE.MeshBasicMaterial({ side: THREE.FrontSide });
    applyDepthOffset(material, mesh.depthOffset);
    let object: THREE.Mesh;
    if (mesh.skin) {
      const indices: number[] = [];
      const weights: number[] = [];
      for (const { bones, weights: w } of mesh.skin.influences) {
        for (let k = 0; k < 4; k++) {
          indices.push(bones[k] ?? 0);
          weights.push(w[k] ?? 0);
        }
      }
      geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4));
      geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
      const skinned = new THREE.SkinnedMesh(geometry, material);
      // Skinned vertices are stored in model space at the bind pose: the mesh sits at the rig root.
      this.root.add(skinned);
      skinned.bind(this.skeleton, new THREE.Matrix4());
      object = skinned;
    } else {
      // Rigid vertices are in their node's local space: attach to the node, exactly like the original.
      object = new THREE.Mesh(geometry, material);
      this.objects.get(node)!.add(object);
    }
    object.name = node.name ?? 'mesh';
    object.frustumCulled = false;
    object.userData.original = node.name;
    if (GROUND_MESHES.has(node.name ?? '')) object.renderOrder = -1;
    const part: Part = { node, object, material, source: null, bitmap: null, cullKey: '' };
    this.parts.set(node, part);
    return part;
  }

  private updateIndex(part: Part) {
    const mesh = part.node.mesh!;
    const regions = mesh.faceRegions;
    const key = regions ? [...new Set(regions)].filter(r => this.scene.isCulled(r)).join(',') : 'all';
    if (key === part.cullKey && part.object.geometry.index) return;
    part.cullKey = key;
    const index: number[] = [];
    for (let i = 0; i < mesh.faces.length; i += 3) {
      if (regions && this.scene.isCulled(regions[i / 3])) continue;
      index.push(mesh.faces[i], mesh.faces[i + 1], mesh.faces[i + 2]);
    }
    part.object.geometry.setIndex(index);
  }

  private updateMaterial(part: Part) {
    const source = part.node.mesh!.material!;
    const bitmap = source.bitmap;
    part.source = source;
    if (bitmap === part.bitmap) return;
    part.bitmap = bitmap;
    const material = part.material;
    const hasAlpha = source.description.getAttribute('hasAlpha') === 'true';
    const ground = GROUND_MESHES.has(part.node.name ?? '');
    material.map = bitmap ? this.textures.get(bitmap) : null;
    material.transparent = hasAlpha;
    material.alphaTest = hasAlpha && !ground ? 0.02 : 0;
    material.depthWrite = !ground;
    material.needsUpdate = true;
    part.object.visible &&= bitmap !== null;
  }

  dispose() {
    for (const part of this.parts.values()) {
      part.object.geometry.dispose();
      part.material.dispose();
    }
    this.textures.retain(new Set());
    this.skeleton.dispose();
  }
}
