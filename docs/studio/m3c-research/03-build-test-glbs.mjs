// Throwaway M3C spike: animated GLBs for Blender (rest-bound, engine inverse binds, sampled original frames).
import { readFileSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
globalThis.FileReader ??= class { readAsArrayBuffer(b) { b.arrayBuffer().then(r => { this.result = r; this.onloadend?.(); }); } readAsDataURL(b) { b.arrayBuffer().then(r => { this.result = 'data:application/octet-stream;base64,' + Buffer.from(r).toString('base64'); this.onloadend?.(); }); } };
const E = '/home/user/BuddyRevival/web/src/engine/';
const { readPackage } = await import(E + 'package.js');
const { IDENTITY } = await import(E + 'math.js');
const { Camera } = await import(E + 'scene-graph.js');
const pack = await readPackage(readFileSync('/home/user/BuddyRevival/web/assets/chick.bin'));
const S = pack.scene, NAMES = S.boneNames, K = 0.01;
const walk = (n, p) => { if (n instanceof Camera) return; n.updateWorld(p); for (const c of n.children) walk(c, n.world); };
const all = []; S.find(n => (all.push(n), false));
const snap = all.map(n => ({ n, p: n.position && [n.position.x, n.position.y, n.position.z], r: n.rotation && [n.rotation.x, n.rotation.y, n.rotation.z, n.rotation.angle] }));
const restore = () => { for (const { n, p, r } of snap) { if (n.position) [n.position.x, n.position.y, n.position.z] = p ?? [0, 0, 0]; if (n.rotation) [n.rotation.x, n.rotation.y, n.rotation.z, n.rotation.angle] = r ?? [0, 1, 0, 0]; } };
const parentOf = new Map(); S.find(n => { for (const c of n.children) parentOf.set(c, n); return false; });
const quat = n => n.rotation && n.rotation.angle !== 0 ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(n.rotation.x, n.rotation.y, n.rotation.z).normalize(), n.rotation.angle) : new THREE.Quaternion();
const pos = n => n.position ? new THREE.Vector3(n.position.x, n.position.y, n.position.z).multiplyScalar(K) : new THREE.Vector3();
walk(S, IDENTITY);
// T-pose quaternions for the arm bones (solved on clean-rotation joints, as the M3B exporter does)
function buildFile(defaultPose, clipsWanted, file, ibm = 'engine') {
  restore(); walk(S, IDENTITY);
  const root = new THREE.Group(); root.name = 'BuddyPoke';
  const bones = new Map();
  for (const name of NAMES) { const n = S.node(name); const b = new THREE.Bone(); b.name = name; b.position.copy(pos(n)); b.quaternion.copy(quat(n)); bones.set(name, b); }
  for (const name of NAMES) { let p = parentOf.get(S.node(name)); while (p && !NAMES.includes(p.name)) p = parentOf.get(p); (p ? bones.get(p.name) : root).add(bones.get(name)); }
  root.updateMatrixWorld(true);
  const Sk = new THREE.Matrix4().makeScale(K, K, K), Ski = new THREE.Matrix4().makeScale(1 / K, 1 / K, 1 / K);
  const skeleton = ibm === 'engine'
    ? new THREE.Skeleton(NAMES.map(n => bones.get(n)), NAMES.map(n => Sk.clone().multiply(new THREE.Matrix4().fromArray(Array.from(S.node(n).inverseBind.e))).multiply(Ski)))
    : new THREE.Skeleton(NAMES.map(n => bones.get(n))); // clean: inverse of the clean-rotation rest joints
  if (ibm !== 'engine') skeleton.calculateInverses();
  // Body (skinned, original bind vertices, normalised weights) + Head (skinned to Bip01_Head)
  const add = (nodeName) => {
    const m = S.node(nodeName).mesh; m.decode(S);
    const g = new THREE.BufferGeometry();
    const world = new THREE.Matrix4().fromArray(Array.from(S.node(nodeName).world.e));
    g.setAttribute('position', new THREE.Float32BufferAttribute(m.vertices.flatMap(v => { const p = new THREE.Vector3(v.x, v.y, v.z); if (!m.skin) p.applyMatrix4(world); return p.multiplyScalar(K).toArray(); }), 3));
    g.setIndex(Array.from(m.faces));
    const idx = [], w = [];
    m.vertices.forEach((_, i) => { const inf = m.skin ? m.skin.influences[i] : { bones: [NAMES.indexOf('Bip01_Head')], weights: [1] }; const s = inf.weights.reduce((a, b) => a + b, 0); for (let k = 0; k < 4; k++) { idx.push(inf.bones[k] ?? 0); w.push((inf.weights[k] ?? 0) / s); } });
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4)); g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(w, 4));
    const mesh = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial({ color: nodeName === 'Head' ? 0xf0c8a0 : 0xffffff, name: nodeName })); mesh.name = nodeName; root.add(mesh); mesh.bind(skeleton, new THREE.Matrix4());
  };
  add('Body'); add('Head');
  // Face expression stand-ins: one child node per face frame used, toggled by scale (STEP)
  const faceFrames = new Set();
  // Sword prop: child node of the hand, rest TRS, toggled by scale
  const swordNode = S.node('Sword'); swordNode.mesh.decode(S);
  const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(swordNode.mesh.vertices.flatMap(v => [v.x * K, v.y * K, v.z * K]), 3)); sg.setIndex(Array.from(swordNode.mesh.faces));
  const sword = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ color: 0xaaaaaa, name: 'Sword' })); sword.name = 'Sword'; sword.position.copy(pos(swordNode)); sword.quaternion.copy(quat(swordNode)); sword.scale.setScalar(1e-6);
  bones.get('Bip01_R_Hand').add(sword);
  // Clips: sample the original engine every frame; key every joint (self-contained clips)
  const expected = {};
  const clips = clipsWanted.map(name => {
    const clip = pack.animations.get(name); clip.decode(); restore();
    const n = clip.frameCount, times = Array.from({ length: n }, (_, f) => f / clip.fps);
    const rot = Object.fromEntries(NAMES.map(b => [b, []])), rootPos = [], swordScale = [], swordRot = [], faces = [];
    expected[name] = { fps: clip.fps, frames: n, samples: {} };
    for (let f = 0; f < n; f++) {
      clip.showFrame(S, f); walk(S, IDENTITY);
      for (const b of NAMES) rot[b].push(...quat(S.node(b)).toArray());
      rootPos.push(...pos(S.node('Bip01')).toArray());
      const visible = S.node('Sword').visible ? 1 : 1e-6; swordScale.push(visible, visible, visible); swordRot.push(...quat(S.node('Sword')).toArray());
      faces.push(S.node('Head').mesh.material?.frame ?? 0);
      if ([0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1].includes(f)) {
        const heads = Object.fromEntries(NAMES.map(b => [b, [S.node(b).world.e[12] * K, S.node(b).world.e[13] * K, S.node(b).world.e[14] * K]]));
        const body = S.node('Body').mesh; body.skin.offsets = null;
        expected[name].samples[f] = { heads, swordVisible: S.node('Sword').visible, body: body.skin.deform(body.vertices).map(v => [v.x * K, v.y * K, v.z * K]) };
      }
    }
    const tracks = NAMES.map(b => new THREE.QuaternionKeyframeTrack(`${b}.quaternion`, times, rot[b], THREE.InterpolateDiscrete));
    tracks.push(new THREE.VectorKeyframeTrack('Bip01.position', times, rootPos, THREE.InterpolateDiscrete));
    tracks.push(new THREE.VectorKeyframeTrack('Sword.scale', times, swordScale, THREE.InterpolateDiscrete));
    tracks.push(new THREE.QuaternionKeyframeTrack('Sword.quaternion', times, swordRot, THREE.InterpolateDiscrete));
    return new THREE.AnimationClip(name, (n - 1) / clip.fps, tracks);
  });
  // Default pose: rest (as bound) or T-pose (arms) -- the bind (IBMs) is always the original rest
  restore(); walk(S, IDENTITY);
  if (defaultPose === 'tpose') for (const [side, dir] of [['L', new THREE.Vector3(1, 0, 0)], ['R', new THREE.Vector3(-1, 0, 0)]]) for (const b of ['UpperArm', 'Forearm', 'Hand']) {
    const bone = bones.get(`Bip01_${side}_${b}`); root.updateMatrixWorld(true);
    const w = bone.getWorldQuaternion(new THREE.Quaternion());
    const t = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0).applyQuaternion(w), dir);
    bone.quaternion.copy(bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(t.multiply(w)));
  }
  root.updateMatrixWorld(true);
  const restHeads = Object.fromEntries(NAMES.map(b => [b, [S.node(b).world.e[12] * K, S.node(b).world.e[13] * K, S.node(b).world.e[14] * K]]));
  const defaultHeads = Object.fromEntries(NAMES.map(b => [b, new THREE.Vector3().setFromMatrixPosition(bones.get(b).matrixWorld).toArray()]));
  return new GLTFExporter().parseAsync(root, { binary: true, trs: true, animations: clips }).then(glb => {
    writeFileSync(file + '.glb', Buffer.from(glb));
    writeFileSync(file + '.expected.json', JSON.stringify({ defaultPose, restHeads, defaultHeads, clips: expected }));
    console.log(file, Math.round(glb.byteLength / 1024), 'KB');
  });
}
await buildFile('rest', ['hug1', 'mood_swordTwirl', 'mood_flying'], 'anim-restdefault');
await buildFile('tpose', ['hug1', 'mood_swordTwirl', 'mood_flying'], 'anim-tposedefault');
await buildFile('tpose', [], 'noanim-tposedefault');
await buildFile('rest', ['hug1', 'mood_swordTwirl', 'mood_flying'], 'anim-clean-ibm', 'clean');
