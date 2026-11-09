import { readFileSync } from 'node:fs';
const { readPackage } = await import('/home/user/BuddyRevival/web/src/engine/package.js');
const pack = await readPackage(readFileSync('/home/user/BuddyRevival/web/assets/chick.bin'));
const S = pack.scene, bones = new Set(S.boneNames);
const kinds = new Map(); let frames = 0, keys = { rot: 0, pos: 0, vis: 0, mat: 0 }; const faces = new Set(); const faceByClip = [];
let constRot = 0, waveRot = 0;
for (const a of pack.animations.values()) {
  a.decode(); frames += a.frameCount;
  const fset = new Set();
  for (const t of a.tracks) {
    const k = kinds.get(t.target) ?? { rot: 0, pos: 0, vis: 0, mat: 0, clips: 0 };
    k.clips++;
    if (t.rotations) { k.rot++; keys.rot += a.frameCount; if (t.rotations.length === 4) constRot++; else waveRot++; }
    if (t.positions) { k.pos++; keys.pos += a.frameCount; }
    if (t.visibility) { k.vis++; keys.vis += a.frameCount; }
    if (t.materialFrames) { k.mat++; keys.mat += a.frameCount; for (const f of t.materialFrames) { faces.add(f); fset.add(f); } }
    kinds.set(t.target, k);
  }
  faceByClip.push(fset.size);
}
for (const [t, k] of kinds) console.log(t.padEnd(18), bones.has(t) ? 'BONE ' : 'node ', JSON.stringify(k));
console.log('clips', pack.animations.size, 'total frames', frames, 'seconds', (frames / 30).toFixed(1));
console.log('track-frames', JSON.stringify(keys), 'constant rot tracks', constRot, 'wavelet rot tracks', waveRot);
console.log('distinct face frames', faces.size, [...faces].sort((a, b) => a - b).join(','), 'max per clip', Math.max(...faceByClip));
const head = S.node('Head'); console.log('Head parent chain: child of Bip01_Head?', S.node('Bip01_Head').children.includes(head));
// rough glTF size: rotations 16B/key, positions 12B/key, times shared per clip
const est = keys.rot * 16 + keys.pos * 12 + frames * 4;
console.log('estimated keyframe data', (est / 1024 / 1024).toFixed(2), 'MB (uncompressed, STEP per-frame keys)');
// symbol frames available for the Head face sheet
const sym = JSON.parse(readFileSync('/home/user/BuddyRevival/web/assets/chick/symbols.json', 'utf8'));
const multi = Object.entries(sym).filter(([, f]) => f.length > 1).map(([n, f]) => `${n}:${f.length}`);
console.log('multi-frame symbols', multi.join(' '));
