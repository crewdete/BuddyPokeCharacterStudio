// Test support exposed as window.__studio.debug. Only uses the original Wardrobe/Buddy API plus the rig.
import * as THREE from 'three';
import type { Look } from '@original/domain/wardrobe.js';
import type { SceneNode } from '@original/engine/scene-graph.js';
import type { CharacterController } from './character/controller';
import { toThreeMatrix } from './scene/CharacterRig';

/** Small deterministic PRNG so random looks are reproducible across pages and runs. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createDebug(controller: CharacterController) {
  const { wardrobe, buddy, rig } = controller;
  return {
    async wearCode(code: string | null) {
      await controller.wearCode(code);
      return controller.code();
    },
    async wearLook(look: Look) {
      await controller.wearLook(look);
      return controller.code();
    },
    /** Like the original Random button, but seeded. */
    async randomLook(seed: number) {
      const random = mulberry32(seed);
      await controller.edit(async () => {
        for (const s of wardrobe.selectors(buddy)) s.set(Math.floor(random() * (s.kind === 'color' ? s.colors : s.icons).length));
        await buddy.dress();
      });
      return controller.code();
    },
    look: () => controller.look(),
    /** Every original wardrobe option (visible or not) with its selectors. */
    options: () =>
      wardrobe.options(buddy).map(o => ({
        name: o.name,
        selectors: o.selectors.map(s => ({ id: s.id, kind: s.kind, size: (s.kind === 'color' ? s.colors : s.icons).length })),
      })),
    code: () => controller.code(),
    version: () => controller.version,
    /** Number of choices per selector id (to enumerate every hairstyle, skirt, ...). */
    selectorSizes() {
      return Object.fromEntries(wardrobe.selectors(buddy).map(s => [s.id, (s.kind === 'color' ? s.colors : s.icons).length]));
    },
    /** Max distance between engine world transforms and their Three counterparts (bones and rigid meshes). */
    rigErrors() {
      rig.root.updateMatrixWorld(true);
      const engine = new THREE.Vector3();
      const three = new THREE.Vector3();
      let bones = 0;
      let rigid = 0;
      const m = new THREE.Matrix4();
      const probe = new THREE.Vector3(10, 10, 10);
      rig.scene.find((node: SceneNode) => {
        const object = node.name ? rig.objectOf(node.name) : undefined;
        if (!object) return false;
        toThreeMatrix(node.world, m);
        engine.copy(probe).applyMatrix4(m);
        three.copy(probe).applyMatrix4(object.matrixWorld);
        const error = engine.distanceTo(three);
        if (rig.scene.boneNames.includes(node.name!)) bones = Math.max(bones, error);
        if (node.mesh && !node.mesh.encodedSkin) rigid = Math.max(rigid, error);
        return false;
      });
      return { bones, rigid };
    },
    /** Every mesh part including ground meshes, with visibility (diagnostics). */
    allParts() {
      const out: { name: string; visible: boolean; triangles: number; texture: number[] | null; transparent: boolean; renderOrder: number; frontFacingUp?: number }[] = [];
      rig.root.traverse(o => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const material = mesh.material as THREE.MeshBasicMaterial;
        const image = material.map?.image as { width: number; height: number } | undefined;
        out.push({ name: mesh.name, visible: mesh.visible, triangles: (mesh.geometry.index?.count ?? 0) / 3, texture: image ? [image.width, image.height] : null, transparent: material.transparent, renderOrder: mesh.renderOrder });
      });
      return out;
    },
    /** Character bounds projected with the live viewport camera (NDC, -1..1) plus camera state. */
    view() {
      const viewport = window.__studioViewport;
      if (!viewport) return null;
      const camera = viewport.camera as THREE.PerspectiveCamera | THREE.OrthographicCamera;
      camera.updateMatrixWorld();
      const box = new THREE.Box3();
      for (const mesh of rig.visibleParts()) box.expandByObject(mesh, true);
      const ndc = new THREE.Box3();
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
        ndc.expandByPoint(new THREE.Vector3(x, y, z).project(camera));
      }
      const target = viewport.controls?.target ?? new THREE.Vector3();
      return {
        type: (camera as THREE.OrthographicCamera).isOrthographicCamera ? 'orthographic' : 'perspective',
        ndc: { minX: ndc.min.x, maxX: ndc.max.x, minY: ndc.min.y, maxY: ndc.max.y },
        position: camera.position.toArray(),
        target: target.toArray(),
        distance: camera.position.distanceTo(target),
        zoom: camera.zoom,
      };
    },
    parts() {
      return rig.visibleParts().map(mesh => {
        const material = mesh.material as THREE.MeshBasicMaterial;
        const image = material.map?.image as { width: number; height: number } | undefined;
        return {
          name: mesh.name,
          skinned: (mesh as THREE.SkinnedMesh).isSkinnedMesh === true,
          parent: mesh.parent?.name ?? null,
          triangles: (mesh.geometry.index?.count ?? 0) / 3,
          texture: image ? [image.width, image.height] : null,
          transparent: material.transparent,
        };
      });
    },
  };
}

export type StudioDebug = ReturnType<typeof createDebug>;
