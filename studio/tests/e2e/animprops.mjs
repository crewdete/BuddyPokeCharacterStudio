// M3C-2: animation-dependent props (Sword, Rose, Guitar/Strat, Mic) and facial expressions in animated GLB files —
// structure, every-frame timing vs the ORIGINAL engine, positions, original face textures, customized looks,
// unchanged skeletal animation (byte comparison with the M3C-1 sample); Blender validation when BLENDER_PYTHON is set.
// Files: test-results/animprops/<name>.glb + <name>.expected.json (engine ground truth incl. every-frame timeline).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checklist, launch, repoRoot, resultPath, serve, studioDist, studioReady, watch } from './lib.mjs';

const TOL = { bone_m: 1e-5, mesh_weighted_m: 1.5e-3, mesh_all_m: 8e-3 }; // same as M3C-1 (animexport.mjs)
const PROP_CLIPS = ['mood_lookingForLove', 'rose1', 'rose2', 'mood_swordTwirl', 'swordA1', 'swordA2', 'jamA1', 'jamB1', 'jamB2', 'jamA2'];
const PROPS = { Rose: 'Bip01_R_Hand', Sword: 'Bip01_R_Hand', Mic: 'Bip01_R_Hand', Strat: 'Bip01_Pelvis' };
const ANIMATED = { skeleton: true, rigidParts: 'skin', material: 'unlit' };
const CUSTOM_LOOK = { hrt: 25, ski: 1, glt: 2 }; // pigtails, skirt, glasses (the M3C-1 custom look)

const studio = await serve(studioDist);
const browser = await launch();
const { check, finish } = checklist();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const problems = [watch(page)];
await page.goto(studio.url);
await studioReady(page);
const dbg = (fn, arg) => page.evaluate(([fn, arg]) => window.__studio.debug[fn](arg), [fn, arg]);
const anim = (fn, arg) => page.evaluate(([fn, arg]) => window.__studio.debug.anim[fn](arg), [fn, arg]);
const CLIPS = (await anim('clips')).map(c => c.name);
const files = {};
let restHeads = null; // rest bind joint positions, from the first (rest display) export

/** Export; verify with Three.js against the engine at EVERY frame (timeline) and at sampled frames; save GLB + expectations. */
async function exportAnimated(name, options, { meshClips = [], meshes = ['Body'], frames = 'n => [0, Math.floor(n / 4), Math.floor(n / 2), Math.floor(3 * n / 4), n - 1]', render = {} } = {}) {
  const r = await page.evaluate(async ([options, meshClips, meshes, frames]) => {
    const d = window.__studio.debug;
    const t0 = performance.now();
    const e = await d.exportGlb(options);
    const ms = performance.now() - t0;
    const bytes = Uint8Array.from(atob(e.base64), c => c.charCodeAt(0));
    const expected = await d.animationExpectations({ clips: options.animations, frames: new Function(`return ${frames}`)(), meshClips, meshes, timeline: true });
    const playback = await d.checkAnimatedGlb(bytes.buffer, expected);
    const textures = await d.checkFaceTextures(bytes.buffer);
    const { nodes, scaleValues } = await d.describeAnimatedGlb(bytes.buffer);
    const view = new DataView(bytes.buffer);
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + view.getUint32(12, true))));
    return { ms, base64: e.base64, manifest: e.manifest, check: e.check, expected, playback, textures, nodes, scaleValues, json };
  }, [options, meshClips, meshes, frames]);
  writeFileSync(resultPath('animprops', `${name}.glb`), Buffer.from(r.base64, 'base64'));
  files[name] = r;
  writeFileSync(resultPath('animprops', `${name}.expected.json`), JSON.stringify({
    clips: r.expected, restHeads: restHeads ??= Object.fromEntries(r.manifest.bones.map(b => [b.name, b.head])), displayHeads: Object.fromEntries(r.manifest.bones.map(b => [b.name, b.head])), display: r.manifest.pose, tolerances: TOL,
    render: render.clips ?? [], renderProps: render.props ?? [], renderFaces: render.faces ?? false,
  }));
  return r;
}

const summarize = playback => {
  const v = Object.values(playback);
  const mesh = v.filter(x => x.mesh !== undefined);
  return {
    bone: Math.max(...v.map(x => x.bone)), root: Math.max(...v.map(x => x.root)),
    prop: Math.max(...v.map(x => x.prop)), face: Math.max(...v.map(x => x.face)), propFrames: v.reduce((a, x) => a + x.propFrames, 0),
    timelineFrames: v.reduce((a, x) => a + x.timelineFrames, 0),
    propMismatches: v.flatMap(x => x.propMismatches), faceMismatches: v.flatMap(x => x.faceMismatches),
    mesh: mesh.length ? Math.max(...mesh.map(x => x.mesh)) : 0, meshWeighted: mesh.length ? Math.max(...mesh.map(x => x.meshWeighted)) : 0,
  };
};
const mm = (m, digits = 5) => `${(m * 1000).toFixed(digits)} mm`;
function assertPlayback(r) {
  const s = summarize(r.playback);
  assert.deepEqual(s.propMismatches.slice(0, 5), [], 'prop visibility differs from the engine');
  assert.deepEqual(s.faceMismatches.slice(0, 5), [], 'visible face differs from the engine');
  assert.ok(s.bone < TOL.bone_m && s.root < TOL.bone_m, `bones ${s.bone}, root ${s.root}`);
  assert.ok(s.prop < TOL.bone_m, `prop vertices ${s.prop}`);
  assert.ok(s.face < TOL.bone_m, `face vertices ${s.face}`);
  assert.ok(s.meshWeighted < TOL.mesh_weighted_m && s.mesh < TOL.mesh_all_m, `mesh ${s.meshWeighted} / ${s.mesh}`);
  return s;
}

// ------------------------------------------------------------------------------------------- props + faces
let pf;
await check('export with all 10 prop clips (+4 without props): self-check passes; 4 props and the used face frames', async () => {
  pf = await exportAnimated('props-faces', { ...ANIMATED, pose: 'rest', animations: [...PROP_CLIPS, 'hug1', 'mood_happy', 'mood_cry', 'kick1'] }, { meshClips: ['swordA1', 'jamA1', 'rose1', 'hug1'], render: { props: PROP_CLIPS } });
  assert.ok(pf.check.ok, pf.check.problems.join('; '));
  assert.deepEqual(Object.fromEntries(pf.manifest.props.map(p => [p.name, p.parent])), PROPS);
  const used = new Set([1, ...Object.values(pf.expected).flatMap(c => c.timeline.face)]);
  assert.deepEqual(pf.manifest.faces.map(f => f.frame).sort((a, b) => a - b), [...used].sort((a, b) => a - b));
  return `${Math.round(Buffer.from(pf.base64, 'base64').length / 1024)} KB; props ${pf.manifest.props.map(p => `${p.name}→${p.parent}`).join(', ')}; ${pf.manifest.faces.length} face nodes (frames ${pf.manifest.faces.map(f => f.frame).join(',')})`;
});

await check('props and faces are plain rigid nodes under their original bone; skin (29 joints) unchanged', async () => {
  for (const [p, bone] of Object.entries(PROPS)) assert.deepEqual([pf.nodes[p].mesh, pf.nodes[p].skinned, pf.nodes[p].parent], [true, false, bone], p);
  for (const f of pf.manifest.faces) assert.deepEqual([pf.nodes[f.name].mesh, pf.nodes[f.name].skinned, pf.nodes[f.name].parent], [true, false, 'Bip01_Head'], f.name);
  assert.ok(pf.json.skins.every(s => s.joints.length === 29));
  const jointNames = new Set(pf.json.skins[0].joints.map(j => pf.json.nodes[j].name));
  assert.ok([...Object.keys(PROPS), ...pf.manifest.faces.map(f => f.name)].every(n => !jointNames.has(n)), 'props/faces are not joints');
});

await check('every clip keys every prop (rotation + visibility) and every face node; scale used only for visibility (1 / 1e-6), STEP', async () => {
  const extras = new Set([...Object.keys(PROPS), ...pf.manifest.faces.map(f => f.name)]);
  for (const a of pf.json.animations) {
    const by = path => a.channels.filter(c => c.target.path === path).map(c => pf.json.nodes[c.target.node].name);
    assert.deepEqual(new Set(by('scale')), extras, `${a.name}: scale channels`);
    for (const p of Object.keys(PROPS)) assert.ok(by('rotation').includes(p), `${a.name}: ${p} rotation`);
    assert.ok(a.samplers.every(s => s.interpolation === 'STEP'));
  }
  assert.deepEqual(pf.scaleValues.sort(), [Math.fround(1e-6), 1].sort());
  return `${pf.json.animations.length} clips × (${Object.keys(PROPS).length} props × 2 + ${pf.manifest.faces.length} faces) extra channels`;
});

await check('initial display (no Action): dressed face (`Head`) shown, other expressions and all props hidden', async () => {
  assert.ok(pf.nodes.Head.worldScale > 0.5);
  for (const f of pf.manifest.faces.filter(f => f.name !== 'Head')) assert.ok(pf.nodes[f.name].worldScale < 1e-3, f.name);
  for (const p of Object.keys(PROPS)) assert.ok(pf.nodes[p].worldScale < 1e-3, p);
});

await check('Three.js playback, EVERY frame: prop visibility and the one visible face = the engine; positions exact; bones unchanged', async () => {
  const s = assertPlayback(pf);
  return `${s.timelineFrames} frames: 0 prop / 0 face mismatches; prop vertices ≤ ${mm(s.prop)} (${s.propFrames} visible-prop samples), face ≤ ${mm(s.face)}, bones ≤ ${mm(s.bone)}, mesh weighted ≤ ${mm(s.meshWeighted, 3)}`;
});

await check('prop visibility: on/off frames per clip equal the original tracks (incl. a mid-clip appearance)', async () => {
  const ranges = {};
  for (const name of PROP_CLIPS) {
    const t = pf.expected[name].timeline;
    for (const [p, seq] of Object.entries(t.props)) if (seq.includes('1')) ranges[`${name}:${p}`] = `${seq.indexOf('1')}–${seq.lastIndexOf('1')}/${seq.length - 1}`;
  }
  assert.equal(Object.keys(ranges).length, 10);
  assert.ok(Object.values(ranges).some(r => !r.startsWith('0–')), 'a clip where the prop appears mid-clip');
  return Object.entries(ranges).map(([k, v]) => `${k} ${v}`).join(', ');
});

await check('face textures = the ORIGINAL composition for each expression frame (pixel-exact), distinct expressions', async () => {
  assert.equal(pf.textures.length, pf.manifest.faces.length);
  for (const t of pf.textures) assert.equal(t.meanDifference, 0, `${t.node}`);
  const differ = pf.textures.filter(t => t.frame !== 1 && t.differsFromDressed > 0).length;
  assert.ok(differ >= pf.textures.length - 2, `${differ} differ from the dressed face`);
  return `${pf.textures.length} textures, mean pixel difference 0; ${differ} differ from the dressed face`;
});

let all;
await check('all 94 clips: every frame (11,609) of prop visibility and face timing matches the engine', async () => {
  all = await exportAnimated('all94-props-faces', { ...ANIMATED, pose: 'rest', animations: CLIPS }, { frames: 'n => [0, Math.floor(n / 2), n - 1]', render: { faces: true } });
  assert.ok(all.check.ok, all.check.problems.join('; '));
  const s = assertPlayback(all);
  assert.equal(s.timelineFrames, 11609);
  assert.equal(all.manifest.faces.length, 32);
  for (const t of all.textures) assert.equal(t.meanDifference, 0, t.node);
  return `${Math.round(Buffer.from(all.base64, 'base64').length / 1024)} KB; ${all.manifest.faces.length} face nodes, ${all.manifest.props.length} props; ${s.timelineFrames} frames, 0 mismatches; bones ≤ ${mm(s.bone)}`;
});

await check('skeletal animation unchanged: bone/root channels byte-identical to the M3C-1 sample (all 94 clips); skinned meshes identical', async () => {
  const parse = buf => {
    const json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString());
    const binStart = 20 + buf.readUInt32LE(12) + 8;
    const bytes = i => { const a = json.accessors[i]; const v = json.bufferViews[a.bufferView]; const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[a.type] * 4; return buf.subarray(binStart + (v.byteOffset ?? 0) + (a.byteOffset ?? 0), binStart + (v.byteOffset ?? 0) + (a.byteOffset ?? 0) + a.count * size); };
    return { json, bytes };
  };
  const now = parse(Buffer.from(all.base64, 'base64'));
  const before = parse(readFileSync(`${repoRoot}/docs/studio/m3c1/samples/all94-rest.glb`));
  const bones = new Set(all.manifest.bones.map(b => b.name));
  let channels = 0;
  for (const a of before.json.animations) {
    const b = now.json.animations.find(x => x.name === a.name);
    for (const c of a.channels) {
      const node = before.json.nodes[c.target.node].name;
      const d = b.channels.find(x => now.json.nodes[x.target.node].name === node && x.target.path === c.target.path);
      assert.ok(d, `${a.name} ${node} ${c.target.path}`);
      for (const k of ['input', 'output']) assert.ok(before.bytes(a.samplers[c.sampler][k]).equals(now.bytes(b.samplers[d.sampler][k])), `${a.name} ${node} ${c.target.path} ${k}`);
      assert.ok(bones.has(node));
      channels++;
    }
  }
  const ibm = j => j.bytes(j.json.skins[0].inverseBindMatrices);
  assert.ok(ibm(before).equals(ibm(now)), 'inverse bind matrices');
  const meshPositions = (j, name) => { const n = j.json.nodes.find(x => x.name === name); return j.bytes(j.json.meshes[n.mesh].primitives[0].attributes.POSITION); };
  const skinnedNames = before.json.nodes.filter(n => n.skin !== undefined).map(n => n.name).filter(n => n !== 'Head');
  for (const n of skinnedNames) assert.ok(meshPositions(before, n).equals(meshPositions(now, n)), n);
  return `${channels} skeletal channels and ${skinnedNames.length} skinned meshes (${skinnedNames.join(', ')}) byte-identical; only the face (now parented, see README) differs`;
});

let custom;
await check('customized look (pigtails, skirt, glasses), T-pose display: props, faces and clothes match the engine', async () => {
  await dbg('wearLook', CUSTOM_LOOK);
  custom = await exportAnimated('custom-props-faces', { ...ANIMATED, pose: 'tpose', animations: ['swordA1', 'rose1', 'jamA1', 'jamA2', 'mood_cry', 'hug1'] }, { meshClips: ['swordA1', 'rose1', 'jamA1', 'hug1'], meshes: ['Body', 'Skrt', 'Hair_Tied_MainPig'], render: { props: ['swordA1', 'rose1', 'jamA1', 'jamA2'], faces: true } });
  assert.ok(custom.check.ok, custom.check.problems.join('; '));
  const s = assertPlayback(custom);
  for (const t of custom.textures) assert.equal(t.meanDifference, 0, t.node);
  assert.ok(['Skrt', 'Hair_Tied_MainPig'].every(n => custom.manifest.meshes.some(m => m.name === n)));
  await dbg('wearCode', null);
  return `${custom.manifest.meshes.length} meshes; ${s.timelineFrames} frames 0 mismatches; props ≤ ${mm(s.prop)}, face ≤ ${mm(s.face)}, clothes weighted ≤ ${mm(s.meshWeighted, 3)}, all ≤ ${mm(s.mesh, 2)}; face textures exact for this look`;
});

await check('clips without props: no prop in the file; only the face frames those clips use', async () => {
  const r = await exportAnimated('no-props', { ...ANIMATED, pose: 'rest', animations: ['hug1', 'mood_happy'] });
  assert.ok(r.check.ok);
  assert.deepEqual(r.manifest.props, []);
  const used = new Set([1, ...Object.values(r.expected).flatMap(c => c.timeline.face)]); // `Head` (frame 1) is the dressed face, always present
  assert.deepEqual(new Set(r.manifest.faces.map(f => f.frame)), used);
  assertPlayback(r);
  return `faces ${r.manifest.faces.map(f => f.name).join(', ')}`;
});

await check('"Keep parented" rigid parts: props and faces behave the same', async () => {
  const r = await exportAnimated('parented-props', { ...ANIMATED, rigidParts: 'parent', pose: 'rest', animations: ['swordA1', 'jamA1'] });
  assert.ok(r.check.ok);
  assertPlayback(r);
});

await check('deterministic: the same export twice gives identical bytes', async () => {
  const [a, b] = await page.evaluate(async () => {
    const d = window.__studio.debug;
    const o = { pose: 'rest', skeleton: true, rigidParts: 'skin', material: 'unlit', animations: ['swordA1', 'rose1'] };
    return [(await d.exportGlb(o)).base64, (await d.exportGlb(o)).base64];
  });
  assert.equal(a, b);
});

await check('exporting props and faces leaves the Studio untouched (while a prop clip plays)', async () => {
  await anim('select', 'mood_swordTwirl');
  await anim('seek', 40);
  const snap = async () => ({ locals: await anim('localMatrices'), code: await dbg('code'), state: await anim('state'), props: await anim('props'), face: await anim('headFrame') });
  const before = await snap();
  await page.evaluate(() => window.__studio.debug.exportGlb({ pose: 'tpose', skeleton: true, rigidParts: 'skin', material: 'unlit', animations: ['rose1', 'jamA1', 'mood_swordTwirl'] }));
  assert.deepEqual(await snap(), before);
  assert.deepEqual(before.props.three, ['Sword']);
  await anim('stop');
});

await check('no console or network errors', async () => assert.deepEqual(problems.flat(), []));
await browser.close();
studio.server.close();

// ------------------------------------------------------------------------------------------- Blender
const blender = process.env.BLENDER_PYTHON;
const script = fileURLToPath(new URL('../blender/validate_anim.py', import.meta.url));
if (!blender) {
  console.log('SKIPPED Blender validation: set BLENDER_PYTHON to a Python with Blender\'s bpy module. Not counted as passed.');
} else {
  for (const name of ['props-faces', 'all94-props-faces', 'custom-props-faces']) {
    await check(`Blender: ${name}.glb`, async () => {
      let out;
      try {
        out = execFileSync(blender, [script, resultPath('animprops', `${name}.glb`), resultPath('animprops', `${name}.expected.json`), resultPath('animprops', 'blender')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 3_600_000 });
      } catch (error) {
        out = String(error.stdout ?? '') + String(error.stderr ?? '');
      }
      const lines = out.split('\n').filter(l => /^(PASS|FAIL)/.test(l));
      const failed = lines.filter(l => l.startsWith('FAIL'));
      assert.ok(/RESULT OK/.test(out) && !failed.length, failed.join(' | ') || out.slice(-600));
      return lines.map(l => l.replace(/^PASS /, '')).filter(l => /bone positions|prop|face|expression|sync|carry-over/.test(l)).join(' · ');
    });
  }
}
finish();
