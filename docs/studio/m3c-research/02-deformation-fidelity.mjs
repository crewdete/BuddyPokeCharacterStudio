// Deformation fidelity of glTF skinning vs the ORIGINAL engine, rest-bound vs T-pose-bound.
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
const E = '/home/user/BuddyRevival/web/src/engine/';
const { readPackage } = await import(E + 'package.js');
const { IDENTITY } = await import(E + 'math.js');
const { Camera } = await import(E + 'scene-graph.js');
const pack = await readPackage(readFileSync('/home/user/BuddyRevival/web/assets/chick.bin'));
const S = pack.scene, names = S.boneNames;
const walk = (n, p) => { if (n instanceof Camera) return; n.updateWorld(p); for (const c of n.children) walk(c, n.world); };
const nodes = []; S.find(n => (nodes.push(n), false));
const snap = nodes.map(n => ({ n, p: n.position && [n.position.x, n.position.y, n.position.z], r: n.rotation && [n.rotation.x, n.rotation.y, n.rotation.z, n.rotation.angle] }));
const restore = () => { for (const { n, p, r } of snap) { if (n.position) [n.position.x, n.position.y, n.position.z] = p ?? [0, 0, 0]; if (n.rotation) [n.rotation.x, n.rotation.y, n.rotation.z, n.rotation.angle] = r ?? [0, 1, 0, 0]; } };
const parentOf = new Map(); S.find(n => { for (const c of n.children) parentOf.set(c, n); return false; });
// T-pose (same rule as studio/src/pose/tpose.ts)
const tpose = [];
walk(S, IDENTITY);
for (const [side, dir] of [['L', new THREE.Vector3(1, 0, 0)], ['R', new THREE.Vector3(-1, 0, 0)]]) for (const b of ['UpperArm', 'Forearm', 'Hand']) {
  const node = S.node(`Bip01_${side}_${b}`), P = new THREE.Matrix4().fromArray(Array.from(parentOf.get(node).world.e));
  const want = dir.clone().applyMatrix3(new THREE.Matrix3().setFromMatrix4(P).invert()).normalize();
  const r = node.rotation, rest = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(r.x, r.y, r.z).normalize(), r.angle);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0).applyQuaternion(rest), want).multiply(rest).normalize();
  if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w); const s = Math.sqrt(1 - q.w * q.w);
  [r.x, r.y, r.z, r.angle] = [q.x / s, q.y / s, q.z / s, 2 * Math.acos(q.w)]; tpose.push([node, [r.x, r.y, r.z, r.angle]]); walk(S, IDENTITY);
}
const applyT = () => { restore(); for (const [n, v] of tpose) [n.rotation.x, n.rotation.y, n.rotation.z, n.rotation.angle] = v; };
// glTF-style joint world matrices from engine TRS with unit-axis rotations (as the M3B exporter writes them)
const jointWorlds = () => {
  const W = new Map();
  const rec = (n, parent) => {
    if (n instanceof Camera) return;
    const m = new THREE.Matrix4();
    const p = n.position ? new THREE.Vector3(n.position.x, n.position.y, n.position.z) : new THREE.Vector3();
    const q = n.rotation && n.rotation.angle !== 0 ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(n.rotation.x, n.rotation.y, n.rotation.z).normalize(), n.rotation.angle) : new THREE.Quaternion();
    m.compose(p, q, new THREE.Vector3(1, 1, 1)).premultiply(parent);
    W.set(n, m); for (const c of n.children) rec(c, m);
  };
  rec(S, new THREE.Matrix4()); return names.map(b => W.get(S.node(b)));
};
const meshes = []; S.find(n => { if (n.mesh?.encodedSkin) { n.mesh.decode(S); meshes.push(n.mesh); } return false; });
const engineDeform = m => { walk(S, IDENTITY); m.skin.offsets = null; return m.skin.deform(m.vertices).map(v => new THREE.Vector3(v.x, v.y, v.z)); };
let RAW = false;
const gltfDeform = (m, J, IBM, shape) => shape.map((v, i) => {
  const { bones, weights } = m.skin.influences[i]; const sum = RAW ? 1 : weights.reduce((a, b) => a + b, 0);
  const out = new THREE.Vector3(), t = new THREE.Vector3();
  bones.forEach((b, k) => out.addScaledVector(t.copy(v).applyMatrix4(new THREE.Matrix4().multiplyMatrices(J[b], IBM[b])), weights[k] / sum));
  return out;
});
// Bind data
restore(); walk(S, IDENTITY);
const IBM_rest = jointWorlds().map(m => m.clone().invert());
const shapeRest = meshes.map(m => m.vertices.map(v => new THREE.Vector3(v.x, v.y, v.z)));
const engineRestShape = meshes.map(m => engineDeform(m)); // original rest appearance (weights as-is)
applyT(); walk(S, IDENTITY);
const IBM_T = jointWorlds().map(m => m.clone().invert());
const shapeT = meshes.map(m => engineDeform(m)); // exact studio T-pose mesh (= M3B T-pose export)
const IBM_engine = names.map(b => new THREE.Matrix4().fromArray(Array.from(S.node(b).inverseBind.e)));
const stats = { rest: [], restBaked: [], tpose: [], engineIbm: [], engineIbmRestDisplay: [] };
// What the file shows at rest with engine IBMs (joints at unit-axis rest TRS): distance from the original rest appearance
restore(); walk(S, IDENTITY);
{ const J = jointWorlds(); meshes.forEach((m, mi) => { const a = gltfDeform(m, J, IBM_engine, shapeRest[mi]); engineRestShape[mi].forEach((r, i) => stats.engineIbmRestDisplay.push(r.distanceTo(a[i]))); }); }
for (const clip of pack.animations.values()) {
  clip.decode();
  for (const f of [0, Math.floor(clip.frameCount / 4), Math.floor(clip.frameCount / 2), Math.floor(3 * clip.frameCount / 4), clip.frameCount - 1]) {
    restore(); clip.showFrame(S, f); walk(S, IDENTITY);
    const J = jointWorlds();
    meshes.forEach((m, mi) => {
      const ref = engineDeform(m);
      const a = gltfDeform(m, J, IBM_rest, shapeRest[mi]);      // rest bind, original bind vertices
      const c = gltfDeform(m, J, IBM_rest, engineRestShape[mi]); // rest bind, vertices baked at the original rest appearance (M3B rest export)
      const b = gltfDeform(m, J, IBM_T, shapeT[mi]);             // T-pose bind (M3B T-pose export)
      const d = gltfDeform(m, J, IBM_engine, shapeRest[mi]);     // rest bind with the ENGINE's inverse binds (non-TRS matrices allowed for IBMs)
      ref.forEach((r, i) => stats.engineIbm.push(r.distanceTo(d[i])));
      RAW = true; const e = gltfDeform(m, J, IBM_engine, shapeRest[mi]); RAW = false;
      ref.forEach((r, i) => (stats.engineIbmRaw ??= []).push(r.distanceTo(e[i])));
      ref.forEach((r, i) => { stats.rest.push(r.distanceTo(a[i])); stats.restBaked.push(r.distanceTo(c[i])); stats.tpose.push(r.distanceTo(b[i])); });
    });
  }
}
const report = (k) => { const s = stats[k].sort((x, y) => x - y); const p = q => s[Math.floor(q * (s.length - 1))]; return `median ${p(0.5).toFixed(4)}  p95 ${p(0.95).toFixed(4)}  p99 ${p(0.99).toFixed(4)}  max ${s.at(-1).toFixed(4)}  (>0.5 units: ${(s.filter(x => x > 0.5).length / s.length * 100).toFixed(2)}%)`; };
console.log(`samples: ${stats.rest.length} vertex positions (${meshes.length} skinned meshes x 94 clips x 5 frames); units: original (~cm), character ~140 tall`);
console.log('rest bind, original bind vertices :', report('rest'));
console.log('rest bind, baked rest appearance  :', report('restBaked'));
console.log('T-pose bind (M3B T-pose export)    :', report('tpose'));
console.log('rest bind, ENGINE inverse binds    :', report('engineIbm'));
console.log('  ...same file shown at rest       :', report('engineIbmRestDisplay'));
console.log('ENGINE IBMs + RAW (unnormalised) w :', report('engineIbmRaw'));
