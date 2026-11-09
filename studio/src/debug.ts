// Test support exposed as window.__studio.debug. Only uses the original Wardrobe/Buddy API plus the rig.
import * as THREE from 'three';
import type { Look } from '@original/domain/wardrobe.js';
import type { SceneNode } from '@original/engine/scene-graph.js';
import type { CharacterController } from './character/controller';
import { exportCharacter, type ExportOptions } from './export';
import { EXPORT_SCALE } from './export/prepare';
import { FACE_NODE, faceNodeName } from './export/animation/sample';
import { estimateAnimated, estimateFbx, lookStats } from './export/estimate';
import { exportFbx, exportObj, type FileFormat } from './export/formats';
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
   * M3C-2: at every sampled frame also the engine's prop visibility, the world vertices of every visible
   * prop and of the face (rigid meshes: node world matrix x local vertices), and the face frame shown.
   */
  const animationExpectations = async ({ clips, frames, meshClips = [], meshes = ['Body'], timeline = false, inPlace = false }: { clips: string[]; frames: (n: number) => number[]; meshClips?: string[]; meshes?: string[]; timeline?: boolean; inPlace?: boolean }) => {
    const fresh = await createBuddy(controller.assets, controller.currentCode);
    const bind = new BindSnapshot(fresh.scene);
    type Sample = {
      heads: Record<string, number[]>;
      meshes?: Record<string, { positions: number[]; weightSums: number[] }>;
      props: Record<string, boolean>;
      propPoints: Record<string, number[]>;
      face: number;
      faceNode: string;
      facePoints: number[];
    };
    /** Every frame: face frame shown, and per prop a '0'/'1' string of the engine's visibility. */
    type Timeline = { face: number[]; props: Record<string, string> };
    const out: Record<string, { frames: number; fps: number; samples: Record<number, Sample>; timeline?: Timeline }> = {};
    const faceFrame = () => {
      const frame = S.node(FACE_NODE)?.mesh?.material?.frame ?? -1;
      return frame === -1 ? 1 : frame; // compose() defaults to frame 1: -1 (as dressed) is the same bitmap
    };
    const S = fresh.scene;
    // M3C-3 in place: the original engine with Bip01's horizontal translation held at its rest value.
    const root = S.node('Bip01')!;
    const restRoot = root.position ? { x: root.position.x, z: root.position.z } : null;
    const rigidWorld = (name: string) => {
      const node = S.node(name)!;
      if (!node.mesh!.decoded) node.mesh!.decode(S);
      const e = node.world.e;
      return node.mesh!.vertices.flatMap(v => [0, 1, 2].map(k => (e[k] * v.x + e[4 + k] * v.y + e[8 + k] * v.z + e[12 + k]) * EXPORT_SCALE));
    };
    for (const name of clips) {
      const clip = fresh.animations.get(name)!;
      clip.decode();
      bind.restore();
      out[name] = { frames: clip.frameCount, fps: clip.fps, samples: {} };
      for (const f of frames(clip.frameCount)) {
        clip.showFrame(S, f);
        if (inPlace && restRoot && root.position) {
          root.position.x = restRoot.x;
          root.position.z = restRoot.z;
        }
        updateWorlds(S);
        const props = Object.fromEntries(S.propNames.filter(p => S.node(p)).map(p => [p, S.node(p)!.visible]));
        const face = faceFrame();
        const sample: Sample = {
          heads: Object.fromEntries(S.boneNames.map(b => { const e = S.node(b)!.world.e; return [b, [e[12] * EXPORT_SCALE, e[13] * EXPORT_SCALE, e[14] * EXPORT_SCALE]]; })),
          props,
          propPoints: Object.fromEntries(Object.entries(props).filter(([, shown]) => shown).map(([p]) => [p, rigidWorld(p)])),
          face,
          faceNode: faceNodeName(face),
          facePoints: rigidWorld(FACE_NODE),
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
      if (timeline) {
        const t: Timeline = { face: [], props: Object.fromEntries(S.propNames.filter(p => S.node(p)).map(p => [p, ''])) };
        for (let f = 0; f < clip.frameCount; f++) {
          clip.showFrame(S, f);
          t.face.push(faceFrame());
          for (const p of Object.keys(t.props)) t.props[p] += S.node(p)!.visible ? '1' : '0';
        }
        out[name].timeline = t;
      }
      bind.restore();
      S.hideProps();
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
    type ClipResult = {
      bone: number; root: number; worstBone?: string; mesh?: number; meshWeighted?: number;
      /** M3C-2: sampled frames whose prop visibility / visible face node differ from the engine, and positions. */
      propMismatches: string[]; faceMismatches: string[]; prop: number; face: number; propFrames: number; timelineFrames?: number;
    };
    const result: Record<string, ClipResult> = {};
    const shown = (o: THREE.Object3D) => new THREE.Vector3().setFromMatrixScale(o.matrixWorld).x > 0.5;
    const faceObjects = [...bones.values()].filter(o => (o as THREE.Mesh).isMesh && (o.name === FACE_NODE || o.name.startsWith(`${FACE_NODE}_F`)));
    const worldPoints = (o: THREE.Mesh) => {
      const pos = o.geometry.getAttribute('position');
      return Array.from({ length: pos.count }, (_, i) => v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).toArray());
    };
    const maxDistance = (points: number[][], flat: number[]) => {
      let d = 0;
      points.forEach((p, i) => (d = Math.max(d, Math.hypot(p[0] - flat[i * 3], p[1] - flat[i * 3 + 1], p[2] - flat[i * 3 + 2]))));
      return d;
    };
    const v = new THREE.Vector3();
    for (const [name, clip] of Object.entries(expected)) {
      const animation = gltf.animations.find(a => a.name === name);
      if (!animation) { result[name] = { bone: Infinity, root: Infinity, propMismatches: ['missing'], faceMismatches: ['missing'], prop: Infinity, face: Infinity, propFrames: 0 }; continue; }
      const propMismatches: string[] = [], faceMismatches: string[] = [];
      let prop = 0, face = 0, propFrames = 0;
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
        for (const [p, visible] of Object.entries(s.props)) {
          const object = bones.get(p);
          const isShown = object ? shown(object) : false;
          if (isShown !== visible) propMismatches.push(`${p}@${f}: ${isShown ? 'shown' : 'hidden'}`);
          if (visible && object) { prop = Math.max(prop, maxDistance(worldPoints(object as THREE.Mesh), s.propPoints[p])); propFrames++; }
        }
        const visibleFaces = faceObjects.filter(shown);
        if (visibleFaces.map(o => o.name).join() !== s.faceNode) faceMismatches.push(`@${f}: ${visibleFaces.map(o => o.name).join('+') || 'none'} (engine ${s.faceNode})`);
        if (visibleFaces.length === 1) face = Math.max(face, maxDistance(worldPoints(visibleFaces[0] as THREE.Mesh), s.facePoints));
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
      let timelineFrames = 0;
      if (clip.timeline) {
        action.reset().play(); // a LoopOnce action that reached its end is paused (clampWhenFinished)
        for (let f = 0; f < clip.frames; f++) {
          mixer.setTime(f / clip.fps);
          gltf.scene.updateMatrixWorld(true);
          const node = faceNodeName(clip.timeline.face[f]);
          const visibleFaces = faceObjects.filter(shown).map(o => o.name).join('+');
          if (visibleFaces !== node) faceMismatches.push(`@${f}: ${visibleFaces || 'none'} (engine ${node})`);
          for (const [p, seq] of Object.entries(clip.timeline.props)) {
            const object = bones.get(p);
            if ((object ? shown(object) : false) !== (seq[f] === '1')) propMismatches.push(`${p}@${f}`);
          }
          timelineFrames++;
        }
      }
      action.stop();
      const extras = { propMismatches, faceMismatches, prop, face, propFrames, timelineFrames };
      result[name] = hasMesh ? { bone, root, worstBone, mesh, meshWeighted, ...extras } : { bone, root, worstBone, ...extras };
    }
    return result;
  };

  /**
   * M3C-2: compare every exported face node texture with what the ORIGINAL engine composes for that frame
   * (fresh buddy with the current look, Material.showFrame(frame) -> TextureLibrary.compose), pixel by pixel.
   */
  const checkFaceTextures = async (buffer: ArrayBuffer) => {
    const gltf = await new GLTFLoader().parseAsync(buffer, '');
    const fresh = await createBuddy(controller.assets, controller.currentCode);
    const material = fresh.scene.node(FACE_NODE)!.mesh!.material!;
    const dressed = material.bitmap!;
    const pixels = (image: CanvasImageSource & { width: number; height: number }, flip: boolean) => {
      const c = new OffscreenCanvas(image.width, image.height);
      const g = c.getContext('2d')!;
      if (flip) { g.translate(0, image.height); g.scale(1, -1); } // glTF images are stored flipped for flipY=false
      g.drawImage(image, 0, 0);
      return g.getImageData(0, 0, image.width, image.height).data;
    };
    const meanDifference = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
      if (a.length !== b.length) return Infinity;
      let d = 0;
      for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
      return d / a.length;
    };
    const out: { node: string; frame: number; meanDifference: number; differsFromDressed: number }[] = [];
    const nodes: THREE.Mesh[] = [];
    gltf.scene.traverse(o => (o as THREE.Mesh).isMesh && (o.name === FACE_NODE || o.name.startsWith(`${FACE_NODE}_F`)) && nodes.push(o as THREE.Mesh));
    const dressedPixels = pixels(dressed, false);
    for (const node of nodes) {
      const frame = node.name === FACE_NODE ? 1 : Number(node.name.slice(FACE_NODE.length + 2));
      material.showFrame(frame);
      const exported = pixels((node.material as THREE.MeshBasicMaterial).map!.image as ImageBitmap, true);
      out.push({ node: node.name, frame, meanDifference: meanDifference(exported, pixels(material.bitmap!, false)), differsFromDressed: meanDifference(exported, dressedPixels) });
    }
    return out.sort((a, b) => a.frame - b.frame);
  };

  /** M3C-2: nodes of an animated GLB as loaded (no Action applied: the initial display) and every stored scale key value. */
  const describeAnimatedGlb = async (buffer: ArrayBuffer) => {
    const gltf = await new GLTFLoader().parseAsync(buffer, '');
    gltf.scene.updateMatrixWorld(true);
    const nodes: Record<string, { mesh: boolean; skinned: boolean; parent: string | null; worldScale: number }> = {};
    gltf.scene.traverse(o => {
      if (o.name) nodes[o.name] = { mesh: (o as THREE.Mesh).isMesh === true, skinned: (o as THREE.SkinnedMesh).isSkinnedMesh === true, parent: o.parent?.name ?? null, worldScale: new THREE.Vector3().setFromMatrixScale(o.matrixWorld).x };
    });
    const scaleValues = [...new Set(gltf.animations.flatMap(a => a.tracks.filter(t => t.name.endsWith('.scale')).flatMap(t => Array.from(t.values))))];
    return { nodes, scaleValues };
  };

  /** M3C-3: the Export tab's size estimate for these options (same functions the panel uses). */
  const exportEstimate = async (options: ExportOptions) => {
    const base = await exportCharacter(controller.assets, controller.currentCode, { ...options, animations: options.animations ? [] : undefined, rootMotion: undefined });
    if (!options.animations) return { bytes: base.glb.byteLength, base: base.glb.byteLength };
    const stats = await lookStats(controller.assets, controller.currentCode);
    return { ...estimateAnimated(stats, base.glb.byteLength, options.animations, options.rootMotion ?? 'keep'), base: base.glb.byteLength, facePng: Object.fromEntries(stats.facePng), propBytes: stats.propBytes };
  };

  /** OBJ (zipped with MTL + textures) or FBX export, same code path as the Export tab; returns base64. */
  const exportFile = async ({ format, options, baseName = 'buddypoke' }: { format: FileFormat; options: ExportOptions; baseName?: string }) => {
    const result = format === 'obj'
      ? await exportObj(controller.assets, controller.currentCode, options, baseName)
      : await exportFbx(controller.assets, controller.currentCode, options);
    const bytes = new Uint8Array(result.data);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { base64: btoa(binary), extension: result.extension, manifest: result.manifest, check: result.check };
  };

  /** M3C-4: the Export tab's FBX size estimate (same functions the panel uses). */
  const fbxEstimate = async (options: ExportOptions) => {
    const base = await exportFbx(controller.assets, controller.currentCode, { ...options, animations: [] });
    const stats = await lookStats(controller.assets, controller.currentCode);
    return { ...estimateFbx(stats, base.data.byteLength, options.animations ?? [], options.rootMotion ?? 'keep'), base: base.data.byteLength };
  };

  return {
    fbxEstimate,
    exportFile,
    exportEstimate,
    describeAnimatedGlb,
    checkFaceTextures,
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
