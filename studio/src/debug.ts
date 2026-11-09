// Test support exposed as window.__studio.debug. Only uses the original Wardrobe/Buddy API plus the rig.
import * as THREE from 'three';
import type { Look } from '@original/domain/wardrobe.js';
import type { SceneNode } from '@original/engine/scene-graph.js';
import type { CharacterController } from './character/controller';
import { exportCharacter, type ExportOptions } from './export';
import { EXPORT_SCALE } from './export/prepare';
import { createBuddy } from './original';
import { BindSnapshot } from './pose/bind';
import { updateWorlds } from './pose/tpose';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { AnimationEntry } from './pose/catalog';
import type { AnimationPlayer } from './pose/player';
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

export function createDebug(controller: CharacterController, player: AnimationPlayer, catalog: AnimationEntry[] = []) {
  const { wardrobe, buddy, rig } = controller;
  const named = () => {
    const nodes: SceneNode[] = [];
    rig.scene.find(node => {
      if (node.name) nodes.push(node);
      return false;
    });
    return nodes;
  };
  const anim = {
    clips: () => player.clipNames().map(name => ({ name, frameCount: buddy.animations.get(name)!.frameCount, fps: buddy.animations.get(name)!.fps })),
    select: (name: string) => player.select(name),
    play: (name?: string) => player.play(name),
    pause: () => player.pause(),
    stop: () => player.stop(),
    seek: (frame: number) => player.seek(frame),
    setSpeed: (speed: number) => player.setSpeed(speed),
    setLoop: (loop: boolean) => player.setLoop(loop),
    state: () => player.snapshot(),
    showRest: () => player.showRest(),
    showTPose: () => player.showTPose(),
    showAnimation: () => player.showAnimation(),
    /** World positions of the Three bones (what the skeleton overlay must show). */
    boneWorld: () => {
      rig.root.updateMatrixWorld(true);
      return Object.fromEntries(rig.bones.map(b => [b.name, new THREE.Vector3().setFromMatrixPosition(b.matrixWorld).toArray()]));
    },
    /** Normalised world direction of each bone's local +X axis (arm alignment checks). */
    boneAxes: () => {
      rig.root.updateMatrixWorld(true);
      return Object.fromEntries(rig.bones.map(b => [b.name, new THREE.Vector3().setFromMatrixColumn(b.matrixWorld, 0).normalize().toArray()]));
    },
    /** Skinned vertex positions of a mesh in the current pose (CPU skinning, same maths as the GPU). */
    skinnedPositions: (name: string) => {
      rig.root.updateMatrixWorld(true);
      const mesh = rig.allMeshes().find(m => m.name === name) as THREE.SkinnedMesh | undefined;
      if (!mesh?.isSkinnedMesh) return null;
      const position = mesh.geometry.getAttribute('position');
      const out: number[] = [];
      const v = new THREE.Vector3();
      for (let i = 0; i < position.count; i++) out.push(...mesh.applyBoneTransform(i, v.fromBufferAttribute(position, i)).toArray());
      const skinIndex = mesh.geometry.getAttribute('skinIndex');
      const skinWeight = mesh.geometry.getAttribute('skinWeight');
      const influences = Array.from({ length: position.count }, (_, i) =>
        [0, 1, 2, 3].filter(k => skinWeight.getComponent(i, k) > 0).map(k => rig.bones[skinIndex.getComponent(i, k)].name),
      );
      return { positions: out, influences, index: Array.from(mesh.geometry.index?.array ?? []) };
    },
    /** The skeleton overlay as drawn. */
    skeleton: () => {
      const view = window.__studioSkeleton;
      if (!view) return null;
      return { visible: view.group.visible, xray: view.xrayOn, counts: view.counts, joints: view.drawnJoints(), names: view.bones.map(b => b.name) };
    },
    catalog: () => catalog,
    /** Engine world position of every named scene node (original transforms). */
    worldPositions: () => Object.fromEntries(named().map(n => [n.name!, [n.world.e[12], n.world.e[13], n.world.e[14]]])),
    /** Engine local matrix of every named node (exact rest-pose comparisons). */
    localMatrices: () => Object.fromEntries(named().map(n => [n.name!, Array.from(n.local.e)])),
    /** Distance from each Three bone to its parent bone (world space). */
    boneLengths: () => {
      rig.root.updateMatrixWorld(true);
      const a = new THREE.Vector3();
      const b = new THREE.Vector3();
      return Object.fromEntries(
        rig.bones.filter(bone => (bone.parent as THREE.Bone)?.isBone).map(bone => [bone.name, a.setFromMatrixPosition(bone.matrixWorld).distanceTo(b.setFromMatrixPosition(bone.parent!.matrixWorld))]),
      );
    },
    /** Original material frame of the face (Head mesh): -1 = as dressed. */
    headFrame: () => rig.scene.node('Head')?.mesh?.material?.frame ?? null,
    /** Visible prop meshes in the Three scene, and the engine's own prop visibility. */
    props: () => ({
      three: rig.allMeshes().filter(m => m.visible && rig.scene.propNames.includes(m.name)).map(m => m.name).sort(),
      engine: rig.scene.propNames.filter(name => rig.scene.node(name)?.visible).sort(),
    }),
  };
  /** Run an export (same code path as the Export tab) and return the GLB as base64 with its manifest and check. */
  const exportGlb = async (options: ExportOptions) => {
    const result = await exportCharacter(controller.assets, controller.currentCode, options);
    const bytes = new Uint8Array(result.glb);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { base64: btoa(binary), manifest: result.manifest, check: result.check };
  };
  /**
   * Load an exported GLB and describe it; with `compareTo`, also compare its vertices and textures with the
   * live Studio character in its current pose (vertices in metres, textures pixel by pixel).
   */
  const loadGlbForInspection = async (buffer: ArrayBuffer, compareTo?: boolean) => {
    const gltf = await new GLTFLoader().parseAsync(buffer, '');
    gltf.scene.updateMatrixWorld(true);
    const meshes: THREE.Mesh[] = [];
    gltf.scene.traverse(o => (o as THREE.Mesh).isMesh && meshes.push(o as THREE.Mesh));
    const parents: Record<string, string | null> = {};
    const skinnedOne = meshes.find(m => (m as THREE.SkinnedMesh).isSkinnedMesh) as THREE.SkinnedMesh | undefined;
    for (const b of skinnedOne?.skeleton.bones ?? []) parents[b.name] = (b.parent as THREE.Bone)?.isBone ? b.parent!.name : null;
    const described = meshes.map(m => {
      const w = m.geometry.getAttribute('skinWeight');
      let unweighted = 0, min = Infinity, max = -Infinity, maxInfluences = 0;
      if (w) for (let i = 0; i < w.count; i++) {
        const values = [0, 1, 2, 3].map(k => w.getComponent(i, k));
        const sum = values.reduce((a, b) => a + b, 0);
        if (sum === 0) unweighted++;
        min = Math.min(min, sum); max = Math.max(max, sum);
        maxInfluences = Math.max(maxInfluences, values.filter(v => v > 0).length);
      }
      return { name: m.name, skinned: (m as THREE.SkinnedMesh).isSkinnedMesh === true, parent: (m.parent as THREE.Bone)?.isBone ? m.parent!.name : null, unweighted, weightSum: { min, max }, maxInfluences };
    });
    if (!compareTo) return { meshes: described, parents };
    rig.root.updateMatrixWorld(true);
    let maxVertexError = 0;
    let vertexCount = 0;
    const textures: { name: string; size: string; meanDifference: number; transparentPixels: number }[] = [];
    const v = new THREE.Vector3();
    const u = new THREE.Vector3();
    for (const m of meshes) {
      const live = rig.visibleParts().find(p => p.name === m.name);
      if (!live) throw new Error(`live part ${m.name} not found`);
      const exported = m.geometry.getAttribute('position');
      const source = live.geometry.getAttribute('position');
      for (let i = 0; i < exported.count; i++) {
        v.fromBufferAttribute(exported, i).applyMatrix4(m.matrixWorld);
        u.fromBufferAttribute(source, i);
        if ((live as THREE.SkinnedMesh).isSkinnedMesh) (live as THREE.SkinnedMesh).applyBoneTransform(i, u);
        else u.applyMatrix4(live.matrixWorld);
        maxVertexError = Math.max(maxVertexError, v.distanceTo(u.multiplyScalar(EXPORT_SCALE)));
        vertexCount++;
      }
      const exportedImage = (m.material as THREE.MeshBasicMaterial).map!.image as CanvasImageSource & { width: number; height: number };
      const liveImage = (live.material as THREE.MeshBasicMaterial).map!.image as OffscreenCanvas;
      const pixels = (image: CanvasImageSource, w: number, h: number, flip: boolean) => {
        const c = new OffscreenCanvas(w, h);
        const g = c.getContext('2d')!;
        if (flip) { g.translate(0, h); g.scale(1, -1); } // glTF images are stored flipped for flipY=false
        g.drawImage(image, 0, 0);
        return g.getImageData(0, 0, w, h).data;
      };
      const a = pixels(exportedImage, exportedImage.width, exportedImage.height, true);
      const b = pixels(liveImage, liveImage.width, liveImage.height, false);
      let diff = 0, transparent = 0;
      for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
      for (let i = 3; i < a.length; i += 4) if (a[i] < 128) transparent++;
      textures.push({ name: m.name, size: `${exportedImage.width}x${exportedImage.height}`, meanDifference: diff / a.length, transparentPixels: transparent });
    }
    return { meshes: described, parents, maxVertexError, vertexCount, textures };
  };
  /**
   * Ground truth from the ORIGINAL engine on a fresh, never-animated buddy with the current look:
   * world bone positions (metres) and, for `meshClips`, deformed skinned vertices (original Skin.deform,
   * raw weights) of the given meshes at the given frames.
   */
  const animationExpectations = async ({ clips, frames, meshClips = [], meshes = ['Body'] }: { clips: string[]; frames: (n: number) => number[]; meshClips?: string[]; meshes?: string[] }) => {
    const fresh = await createBuddy(controller.assets, controller.currentCode);
    const bind = new BindSnapshot(fresh.scene);
    const out: Record<string, { frames: number; fps: number; samples: Record<number, { heads: Record<string, number[]>; meshes?: Record<string, { positions: number[]; weightSums: number[] }> }> }> = {};
    const S = fresh.scene;
    for (const name of clips) {
      const clip = fresh.animations.get(name)!;
      clip.decode();
      bind.restore();
      out[name] = { frames: clip.frameCount, fps: clip.fps, samples: {} };
      for (const f of frames(clip.frameCount)) {
        clip.showFrame(S, f);
        updateWorlds(S);
        const sample: (typeof out)[string]['samples'][number] = {
          heads: Object.fromEntries(S.boneNames.map(b => { const e = S.node(b)!.world.e; return [b, [e[12] * EXPORT_SCALE, e[13] * EXPORT_SCALE, e[14] * EXPORT_SCALE]]; })),
        };
        if (meshClips.includes(name)) {
          sample.meshes = {};
          for (const m of meshes) {
            const mesh = S.node(m)?.mesh;
            if (!mesh?.material || !S.node(m)!.visible) continue;
            if (!mesh.decoded) mesh.decode(S);
            if (!mesh.skin) continue; // rigid parts follow their bone (covered by the bone check)
            const skin = mesh.skin as unknown as { offsets: unknown; deform(v: unknown): { x: number; y: number; z: number }[]; influences: { weights: number[] }[] };
            skin.offsets = null;
            sample.meshes[m] = {
              positions: skin.deform(mesh.vertices).flatMap(v => [v.x * EXPORT_SCALE, v.y * EXPORT_SCALE, v.z * EXPORT_SCALE]),
              weightSums: skin.influences.map(i => i.weights.reduce((a, b) => a + b, 0)),
            };
          }
        }
        out[name].samples[f] = sample;
      }
      bind.restore();
    }
    return out;
  };

  /** Play an animated GLB with THREE.AnimationMixer and compare with engine expectations. */
  const checkAnimatedGlb = async (buffer: ArrayBuffer, expected: Awaited<ReturnType<typeof animationExpectations>>) => {
    const gltf = await new GLTFLoader().parseAsync(buffer, '');
    const mixer = new THREE.AnimationMixer(gltf.scene);
    const bones = new Map<string, THREE.Object3D>();
    gltf.scene.traverse(o => o.name && bones.set(o.name, o));
    const skinned = new Map<string, THREE.SkinnedMesh>();
    gltf.scene.traverse(o => (o as THREE.SkinnedMesh).isSkinnedMesh && skinned.set(o.name, o as THREE.SkinnedMesh));
    const result: Record<string, { bone: number; root: number; worstBone?: string; mesh?: number; meshWeighted?: number }> = {};
    const v = new THREE.Vector3();
    for (const [name, clip] of Object.entries(expected)) {
      const animation = gltf.animations.find(a => a.name === name);
      if (!animation) { result[name] = { bone: Infinity, root: Infinity }; continue; }
      mixer.stopAllAction();
      const action = mixer.clipAction(animation);
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true; // hold the last frame instead of wrapping
      action.reset().play();
      let bone = 0, root = 0, mesh = 0, meshWeighted = 0, hasMesh = false, worstBone = '';
      for (const [f, s] of Object.entries(clip.samples)) {
        mixer.setTime(Number(f) / clip.fps);
        gltf.scene.updateMatrixWorld(true);
        for (const [b, p] of Object.entries(s.heads)) {
          const d = v.setFromMatrixPosition(bones.get(b)!.matrixWorld).distanceTo(new THREE.Vector3(...p));
          if (d > bone) { bone = d; worstBone = `${b}@${f}`; }
          if (b === 'Bip01') root = Math.max(root, d);
        }
        for (const [m, data] of Object.entries(s.meshes ?? {})) {
          const sm = skinned.get(m);
          if (!sm) continue;
          hasMesh = true;
          const pos = sm.geometry.getAttribute('position');
          for (let i = 0; i < pos.count; i++) {
            sm.applyBoneTransform(i, v.fromBufferAttribute(pos, i));
            const d = Math.hypot(v.x - data.positions[i * 3], v.y - data.positions[i * 3 + 1], v.z - data.positions[i * 3 + 2]);
            mesh = Math.max(mesh, d);
            if (Math.abs(data.weightSums[i] - 1) < 1e-6) meshWeighted = Math.max(meshWeighted, d);
          }
        }
      }
      action.stop();
      result[name] = hasMesh ? { bone, root, worstBone, mesh, meshWeighted } : { bone, root, worstBone };
    }
    return result;
  };

  return {
    animationExpectations,
    checkAnimatedGlb,
    loadGlbForInspection,
    exportGlb,
    anim,
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
    historyCodes: () => controller.historyCodes(),
    history: () => ({ ...controller.historyState(), canUndo: controller.canUndo, canRedo: controller.canRedo }),
    /** Resolves when every queued edit has been applied. */
    idle: () => controller.edit(async () => undefined, { record: false }).then(() => controller.code()),
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
