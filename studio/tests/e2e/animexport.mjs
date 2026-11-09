// M3C-1: skeletal animation export (all 94 original clips) — structure, accuracy vs the ORIGINAL engine,
// initial display pose, isolation, customization; Blender validation when BLENDER_PYTHON is set.
// Files: test-results/animexport/<name>.glb + <name>.expected.json (engine ground truth for Blender).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checklist, launch, resultPath, serve, studioDist, studioReady, watch } from './lib.mjs';

// Tolerances (M3C plan): bones 0.01 mm. Properly weighted vertices 1.5 mm: a clip that does not animate a bone
// keeps its clean rest rotation instead of the original's slightly scaled one (≤0.13% of the distance to that
// bone; measured 0.23 mm on pigtails). All vertices 8 mm: glTF requires weights summing to 1, the original's
// quantised weights sum to 0.996–1 (measured up to 7.0 mm on long hair).
const TOL = { bone_m: 1e-5, mesh_weighted_m: 1.5e-3, mesh_all_m: 8e-3 };
const REPRESENTATIVE = ['mood_happy', 'mood_flying', 'mood_cry', 'hug1', 'hug2', 'kick1', 'holdHands2', 'pose_stand_stretch', 'pose_contra_canCan', 'standBreathe', 'mood_applause'];
const RENDER = ['mood_happy', 'mood_flying', 'hug1', 'kick1', 'pose_stand_stretch', 'pose_contra_canCan', 'standBreathe', 'mood_applause'];
const ANIMATED = { skeleton: true, rigidParts: 'skin', material: 'unlit' };

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

/** Export, verify in Three.js against the engine, save GLB + expectations. */
async function exportAnimated(name, options, { meshClips = REPRESENTATIVE, meshes = ['Body'], frames = 'n => [0, Math.floor(n / 2), n - 1]', render = [] } = {}) {
  const r = await page.evaluate(async ([options, meshClips, meshes, frames]) => {
    const d = window.__studio.debug;
    const t0 = performance.now();
    const e = await d.exportGlb(options);
    const ms = performance.now() - t0;
    const bytes = Uint8Array.from(atob(e.base64), c => c.charCodeAt(0));
    const expected = await d.animationExpectations({ clips: options.animations, frames: new Function(`return ${frames}`)(), meshClips, meshes });
    const playback = options.animations.length ? await d.checkAnimatedGlb(bytes.buffer, expected) : {};
    const view = new DataView(bytes.buffer);
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + view.getUint32(12, true))));
    return { ms, base64: e.base64, manifest: e.manifest, check: e.check, expected, playback, json };
  }, [options, meshClips, meshes, frames]);
  writeFileSync(resultPath('animexport', `${name}.glb`), Buffer.from(r.base64, 'base64'));
  files[name] = { ...r, render };
  return r;
}

function writeExpected(name, restHeads) {
  const r = files[name];
  writeFileSync(resultPath('animexport', `${name}.expected.json`), JSON.stringify({
    clips: r.expected, restHeads, displayHeads: Object.fromEntries(r.manifest.bones.map(b => [b.name, b.head])), display: r.manifest.pose, tolerances: TOL, render: r.render,
  }));
}

const summarize = playback => {
  const v = Object.values(playback);
  const mesh = v.filter(x => x.mesh !== undefined);
  return {
    bone: Math.max(...v.map(x => x.bone)), root: Math.max(...v.map(x => x.root)),
    mesh: mesh.length ? Math.max(...mesh.map(x => x.mesh)) : 0, meshWeighted: mesh.length ? Math.max(...mesh.map(x => x.meshWeighted)) : 0, meshClips: mesh.length,
  };
};

// ------------------------------------------------------------------------------------------- export
let all;
await check('all 94 clips exported in one GLB (rest bind, rest display): self-check passes', async () => {
  all = await exportAnimated('all94-rest', { ...ANIMATED, pose: 'rest', animations: CLIPS }, { render: RENDER });
  assert.ok(all.check.ok, all.check.problems.join('; '));
  assert.equal(all.manifest.bind, 'rest');
  assert.equal(all.manifest.animations.length, 94);
  return `${Math.round(Buffer.from(all.base64, 'base64').length / 1024)} KB, exported in ${Math.round(all.ms)} ms`;
});

await check('clip names, frame counts and 30 fps durations preserved', async () => {
  const anims = all.json.animations;
  assert.deepEqual(anims.map(a => a.name), CLIPS, 'original ids, original order');
  const clips = await anim('clips');
  for (const c of clips) {
    const a = anims.find(x => x.name === c.name);
    const end = Math.max(...a.samplers.map(s => all.json.accessors[s.input].max[0]));
    assert.ok(Math.abs(end - (c.frameCount - 1) / 30) < 1e-6, `${c.name}: ends at ${end}`);
    assert.ok(c.fps === 30);
  }
  return `${anims.length} animations, durations 1.0 s – ${(Math.max(...clips.map(c => c.frameCount)) - 1) / 30} s`;
});

await check('every bone keyed in every clip (29 rotations + root translation), STEP only, key times ≤ f/30', async () => {
  const bones = all.manifest.bones.map(b => b.name);
  for (const a of all.json.animations) {
    const rotated = new Set(a.channels.filter(c => c.target.path === 'rotation').map(c => all.json.nodes[c.target.node].name));
    assert.deepEqual([...rotated].sort(), [...bones].sort(), `${a.name}: rotation channels`);
    const translated = a.channels.filter(c => c.target.path === 'translation').map(c => all.json.nodes[c.target.node].name);
    assert.deepEqual(translated, ['Bip01'], `${a.name}: translation channels`);
    // M3C-2: scale is used only as the visibility of props and face nodes, never on a bone.
    const faces = new Set(all.manifest.faces.map(f => f.name)), props = new Set(all.manifest.props.map(p => p.name));
    assert.ok(a.channels.filter(c => c.target.path === 'scale').every(c => faces.has(all.json.nodes[c.target.node].name) || props.has(all.json.nodes[c.target.node].name)), `${a.name}: scale only on props/faces`);
    assert.ok(a.samplers.every(s => s.interpolation === 'STEP'), `${a.name}: STEP`);
  }
  // Float32 key times are rounded down so a player asked for exactly f/30 shows frame f.
  const t = all.json.animations[0].samplers[0];
  return `${all.json.animations.length * 30} skeletal channels; first key times end at ${all.json.accessors[t.input].max[0]}`;
});

await check('Three.js playback of all 94 clips matches the original engine (bones, root motion, deformation)', async () => {
  const s = summarize(all.playback);
  assert.equal(Object.keys(all.playback).length, 94);
  assert.ok(s.bone < TOL.bone_m, `bones ${s.bone * 1000} mm`);
  assert.ok(s.root < TOL.bone_m, `root ${s.root * 1000} mm`);
  assert.ok(s.meshWeighted < TOL.mesh_weighted_m, `properly weighted vertices ${s.meshWeighted * 1000} mm`);
  assert.ok(s.mesh < TOL.mesh_all_m, `all vertices ${s.mesh * 1000} mm`);
  writeFileSync(resultPath('animexport', 'all94-playback.json'), JSON.stringify(all.playback, null, 2));
  return `bones ≤ ${(s.bone * 1000).toFixed(5)} mm, root ≤ ${(s.root * 1000).toFixed(5)} mm (94 clips × 3 frames); mesh (${s.meshClips} clips): weighted ≤ ${(s.meshWeighted * 1000).toFixed(3)} mm, all ≤ ${(s.mesh * 1000).toFixed(2)} mm`;
});

await check('T-pose initial display: file opens in T-pose, bind stays the original rest, animations unchanged', async () => {
  const t = await exportAnimated('all94-tpose-display', { ...ANIMATED, pose: 'tpose', animations: CLIPS }, { meshClips: ['hug1', 'kick1', 'mood_flying'] });
  assert.ok(t.check.ok, t.check.problems.join('; '));
  assert.equal(t.manifest.bind, 'rest');
  const heads = Object.fromEntries(t.manifest.bones.map(b => [b.name, b.head]));
  for (const side of ['L', 'R']) for (const b of ['Forearm', 'Hand']) assert.ok(Math.abs(heads[`Bip01_${side}_${b}`][1] - heads[`Bip01_${side}_UpperArm`][1]) < 1e-6, `${side} ${b} horizontal`);
  // Same skin binding and identical animation data as the rest-display file.
  assert.deepEqual(t.json.skins.map(s => s.inverseBindMatrices).length, all.json.skins.map(s => s.inverseBindMatrices).length);
  const s = summarize(t.playback);
  assert.ok(s.bone < TOL.bone_m && s.meshWeighted < TOL.mesh_weighted_m, `bones ${s.bone}, mesh ${s.meshWeighted}`);
  return `T-pose display; playback bones ≤ ${(s.bone * 1000).toFixed(5)} mm`;
});

await check('display-only files (no clips) for the Rest and T-pose display checks', async () => {
  for (const pose of ['rest', 'tpose']) {
    const r = await exportAnimated(`display-${pose}`, { ...ANIMATED, pose, animations: [] }, { meshClips: [] });
    assert.ok(r.check.ok && r.manifest.bind === 'rest' && r.json.animations === undefined);
  }
  const restHeads = Object.fromEntries(files['display-rest'].manifest.bones.map(b => [b.name, b.head]));
  for (const name of Object.keys(files)) writeExpected(name, restHeads);
});

await check('animated export of a customized look (cap, skirt, pigtails, glasses): skinned clothes deform like the engine', async () => {
  await dbg('wearLook', { hrt: 25, ski: 1, glt: 2 });
  const r = await exportAnimated('custom-pigtails-skirt', { ...ANIMATED, pose: 'tpose', animations: ['hug1', 'mood_flying', 'kick1', 'jamA2'] }, { meshClips: ['hug1', 'mood_flying', 'kick1', 'jamA2'], meshes: ['Body', 'Skrt', 'Hair_Tied_MainPig'] });
  assert.ok(r.check.ok, r.check.problems.join('; '));
  const s = summarize(r.playback);
  assert.ok(s.bone < TOL.bone_m && s.meshWeighted < TOL.mesh_weighted_m && s.mesh < TOL.mesh_all_m, JSON.stringify(s));
  const restHeads = Object.fromEntries(files['display-rest'].manifest.bones.map(b => [b.name, b.head]));
  files['custom-pigtails-skirt'].render = ['hug1', 'kick1'];
  writeExpected('custom-pigtails-skirt', restHeads);
  await dbg('wearCode', null);
  return `${r.manifest.meshes.map(m => m.name).join(', ')}; weighted ≤ ${(s.meshWeighted * 1000).toFixed(3)} mm, all ≤ ${(s.mesh * 1000).toFixed(2)} mm`;
});

await check('"Keep parented" rigid parts with animation: bones still exact', async () => {
  const r = await exportAnimated('parented-subset', { ...ANIMATED, rigidParts: 'parent', pose: 'rest', animations: ['mood_happy', 'hug1'] }, { meshClips: [] });
  assert.ok(r.check.ok);
  assert.ok(summarize(r.playback).bone < TOL.bone_m);
});

await check('animation needs the skeleton; unknown clips rejected', async () => {
  const errors = await page.evaluate(async () => {
    const d = window.__studio.debug;
    const out = [];
    for (const o of [{ pose: 'rest', skeleton: false, rigidParts: 'skin', material: 'unlit', animations: ['hug1'] }, { pose: 'rest', skeleton: true, rigidParts: 'skin', material: 'unlit', animations: ['nope'] }]) {
      try { await d.exportGlb(o); out.push('no error'); } catch (e) { out.push(String(e.message)); }
    }
    return out;
  });
  assert.match(errors[0], /needs the skeleton/);
  assert.match(errors[1], /Unknown animation "nope"/);
});

await check('M3B exports unchanged (static/rigged: bind = exported pose, no animations)', async () => {
  const r = await page.evaluate(() => window.__studio.debug.exportGlb({ pose: 'tpose', skeleton: true, rigidParts: 'skin', material: 'unlit' }));
  assert.ok(r.check.ok && r.manifest.bind === 'pose' && r.manifest.animations.length === 0);
});

await check('deterministic: the same export twice gives identical bytes', async () => {
  const [a, b] = await page.evaluate(async () => {
    const d = window.__studio.debug;
    const o = { pose: 'rest', skeleton: true, rigidParts: 'skin', material: 'unlit', animations: ['hug1', 'mood_happy'] };
    return [(await d.exportGlb(o)).base64, (await d.exportGlb(o)).base64];
  });
  assert.equal(a, b);
});

await check('exporting animations leaves the Studio untouched (while a clip plays)', async () => {
  await anim('select', 'mood_swordTwirl');
  await anim('seek', 40);
  const before = { locals: await anim('localMatrices'), code: await dbg('code'), history: await dbg('history'), state: await anim('state'), props: await anim('props') };
  await page.evaluate(() => window.__studio.debug.exportGlb({ pose: 'tpose', skeleton: true, rigidParts: 'skin', material: 'unlit', animations: ['hug1', 'mood_swordTwirl'] }));
  const after = { locals: await anim('localMatrices'), code: await dbg('code'), history: await dbg('history'), state: await anim('state'), props: await anim('props') };
  assert.deepEqual(after, before);
  await anim('play');
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__studio.debug.exportGlb({ pose: 'rest', skeleton: true, rigidParts: 'skin', material: 'unlit', animations: ['mood_happy'] }));
  const s = await anim('state');
  assert.deepEqual([s.clip, s.state], ['mood_swordTwirl', 'playing']);
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
  for (const name of ['all94-rest', 'all94-tpose-display', 'display-rest', 'display-tpose', 'custom-pigtails-skirt']) {
    await check(`Blender: ${name}.glb`, async () => {
      let out;
      try {
        out = execFileSync(blender, [script, resultPath('animexport', `${name}.glb`), resultPath('animexport', `${name}.expected.json`), resultPath('animexport', 'blender')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 1_800_000 });
      } catch (error) {
        out = String(error.stdout ?? '') + String(error.stderr ?? '');
      }
      const lines = out.split('\n').filter(l => /^(PASS|FAIL)/.test(l));
      const failed = lines.filter(l => l.startsWith('FAIL'));
      assert.ok(/RESULT OK/.test(out) && !failed.length, failed.join(' | ') || out.slice(-400));
      return lines.map(l => l.replace(/^PASS /, '')).filter(l => /bone positions|root motion|mesh deformation|Actions|display|carry-over|rest pose/.test(l)).join(' · ');
    });
  }
}
finish();
