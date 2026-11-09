// M3C-3: the animated GLB export interface — driven through the real Export tab. Format, clip selection (all / none /
// individual / category / search), initial pose, root motion vs in place, customized looks, props and facial
// expressions, size estimate vs the real file, progress / success / error messages, file name, exporting while the
// Studio plays, the live character left untouched. Every downloaded file is checked against the ORIGINAL engine and is
// byte-identical to the same export through the debug API; Blender validation when BLENDER_PYTHON is set.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checklist, launch, resultPath, serve, studioDist, studioReady, watch } from './lib.mjs';

const TOL = { bone_m: 1e-5, mesh_weighted_m: 1.5e-3, mesh_all_m: 8e-3 }; // same as M3C-1/M3C-2
const ESTIMATE_TOLERANCE = 0.03; // the size estimate must be within 3% of the real file

const studio = await serve(studioDist);
const browser = await launch();
const { check, finish } = checklist();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const problems = [watch(page)];
await page.goto(studio.url);
await studioReady(page);
const dbg = (fn, arg) => page.evaluate(([fn, arg]) => window.__studio.debug[fn](arg), [fn, arg]);
const anim = (fn, arg) => page.evaluate(([fn, arg]) => window.__studio.debug.anim[fn](arg), [fn, arg]);
const CLIPS = (await anim('clips')).map(c => c.name);
const catalog = await anim('catalog');
const groupClips = g => [...new Set(catalog.filter(e => e.group === g).map(e => e.clip))];
const radio = name => page.getByRole('region', { name: 'Export' }).getByRole('radio', { name, exact: true });
const clipCount = async () => (await page.locator('#export-clip-count').textContent()).trim();
const restHeads = Object.fromEntries((await dbg('exportGlb', { pose: 'rest', skeleton: true, rigidParts: 'skin', material: 'unlit', animations: [] })).manifest.bones.map(b => [b.name, b.head]));

async function waitEstimate() {
  await page.waitForFunction(() => /(Estimated size: ≈|Size:) [\d.]+ (KB|MB)/.test(document.querySelector('#export-estimate')?.textContent ?? ''), null, { timeout: 120_000 });
  const text = await page.locator('#export-estimate').textContent();
  const [, n, unit] = text.match(/([\d.]+) (KB|MB)/);
  return { text, bytes: Number(n) * (unit === 'MB' ? 1024 * 1024 : 1024) };
}

/** Click Export, save the download, return its bytes and the panel messages. */
async function exportFromUi(label) {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 300_000 }), page.getByRole('button', { name: 'Export GLB' }).click()]);
  const name = download.suggestedFilename();
  const path = resultPath('exportui', name);
  await download.saveAs(path);
  await page.waitForSelector('#export-detail');
  return { name, path, label, bytes: readFileSync(path), status: await page.locator('#export-status').textContent(), detail: await page.locator('#export-detail').textContent() };
}

/** Verify a downloaded file in the page: self-check of the same export via the debug API (byte identity), engine playback. */
async function verify(file, options, { meshClips = [], meshes = ['Body'], frames = 'n => [0, Math.floor(n / 2), n - 1]', render = {} } = {}) {
  const r = await page.evaluate(async ([b64, options, meshClips, meshes, frames]) => {
    const d = window.__studio.debug;
    const same = await d.exportGlb(options);
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    if (same.base64 !== b64) return { identical: false, same: same.base64, check: same.check, manifest: same.manifest };
    if (!options.animations) return { identical: true, check: same.check, manifest: same.manifest };
    const expected = await d.animationExpectations({ clips: options.animations, frames: new Function(`return ${frames}`)(), meshClips, meshes, timeline: true, inPlace: options.rootMotion === 'inPlace' });
    const playback = await d.checkAnimatedGlb(bytes.buffer, expected);
    const textures = await d.checkFaceTextures(bytes.buffer);
    return { identical: same.base64 === b64, check: same.check, manifest: same.manifest, expected, playback, textures };
  }, [file.bytes.toString('base64'), options, meshClips, meshes, frames]);
  if (!r.identical) writeFileSync(file.path.replace(/\.glb$/, '.debug-api.glb'), Buffer.from(r.same, 'base64'));
  assert.ok(r.identical, `${file.name}: the downloaded file differs from the same export through the debug API (saved as .debug-api.glb)`);
  assert.ok(r.check.ok, r.check.problems.join('; '));
  if (r.expected) {
    const v = Object.values(r.playback);
    const s = {
      bone: Math.max(...v.map(x => x.bone)), prop: Math.max(...v.map(x => x.prop)), face: Math.max(...v.map(x => x.face)),
      mismatches: v.flatMap(x => [...x.propMismatches, ...x.faceMismatches]), frames: v.reduce((a, x) => a + x.timelineFrames, 0),
      meshWeighted: Math.max(0, ...v.filter(x => x.mesh !== undefined).map(x => x.meshWeighted)), mesh: Math.max(0, ...v.filter(x => x.mesh !== undefined).map(x => x.mesh)),
    };
    assert.deepEqual(s.mismatches.slice(0, 5), [], 'prop/face timing');
    assert.ok(s.bone < TOL.bone_m && s.prop < TOL.bone_m && s.face < TOL.bone_m, JSON.stringify(s));
    assert.ok(s.meshWeighted < TOL.mesh_weighted_m && s.mesh < TOL.mesh_all_m, JSON.stringify(s));
    for (const t of r.textures) assert.equal(t.meanDifference, 0, `${t.node} texture`);
    writeFileSync(file.path.replace(/\.glb$/, '.expected.json'), JSON.stringify({
      clips: r.expected, restHeads, displayHeads: Object.fromEntries(r.manifest.bones.map(b => [b.name, b.head])), display: r.manifest.pose, tolerances: TOL,
      render: render.clips ?? [], renderProps: render.props ?? [], renderFaces: render.faces ?? false,
    }));
    r.summary = s;
  }
  return r;
}
const mm = m => `${(m * 1000).toFixed(5)} mm`;
const blenderFiles = [];

// ------------------------------------------------------------------------------------------- interface
await check('Export tab: static / rigged / animated; animated shows initial pose, root motion, clip picker and the 30 fps Blender note', async () => {
  await page.getByRole('tab', { name: 'Export' }).click();
  for (const f of ['GLB · static mesh', 'GLB · rigged', 'GLB · animated']) assert.equal(await radio(f).count(), 1, f);
  assert.equal(await radio('GLB · rigged').getAttribute('aria-checked'), 'true', 'default format unchanged (M3B)');
  assert.equal(await page.locator('.clip-picker').count(), 0);
  await radio('GLB · animated').click();
  assert.equal(await page.locator('.clip-picker').count(), 1);
  assert.equal(await page.getByText('Initial pose', { exact: true }).count(), 1);
  for (const r of ['Keep root motion', 'In place', 'Rest', 'T-pose']) assert.equal(await radio(r).count(), 1, r);
  assert.match(await page.locator('#export-blender-note').textContent(), /30 fps.*before.*Import/);
  assert.equal(await page.locator('.clip-row').count(), catalog.length, 'every catalog entry listed');
  const clipped = await page.evaluate(() => {
    const panel = document.querySelector('.export').getBoundingClientRect();
    return [...document.querySelectorAll('.export *')].filter(e => e.getClientRects().length && e.getBoundingClientRect().right > panel.right + 1).map(e => e.className || e.tagName).slice(0, 3);
  });
  assert.deepEqual(clipped, [], 'nothing overflows the panel (desktop)');
  await page.screenshot({ path: resultPath('exportui', 'export-animated-empty.png') });
  return `${catalog.length} entries (${CLIPS.length} clips) in ${await page.locator('.clip-group-head').count()} categories`;
});

await check('nothing selected: export disabled with a clear message', async () => {
  assert.equal(await clipCount(), `0 of ${CLIPS.length} clips selected`);
  assert.ok(await page.getByRole('button', { name: 'Export GLB' }).isDisabled());
  assert.match(await page.locator('#export-estimate').textContent(), /Select at least one animation/);
});

await check('Select all / Deselect all', async () => {
  await page.getByRole('button', { name: 'Select all', exact: true }).click();
  assert.equal(await clipCount(), `${CLIPS.length} of ${CLIPS.length} clips selected`);
  for (const g of ['mood', 'poke', 'idle', 'other']) assert.ok(await page.getByTestId(`export-group-${g}`).isChecked(), g);
  await page.getByRole('button', { name: 'Deselect all', exact: true }).click();
  assert.equal(await clipCount(), `0 of ${CLIPS.length} clips selected`);
  assert.equal(await page.locator('.clip-row input:checked').count(), 0);
});

await check('category selection (Moods, Pokes, Idle, Other) and the partial state', async () => {
  const counts = {};
  for (const g of ['mood', 'poke', 'idle', 'other']) {
    await page.getByTestId(`export-group-${g}`).check();
    counts[g] = groupClips(g).length;
    assert.equal(await clipCount(), `${counts[g]} of ${CLIPS.length} clips selected`, g);
    await page.getByTestId(`export-group-${g}`).uncheck();
  }
  await page.getByTestId('export-group-mood').check();
  await page.locator(`.clip-row[data-clip="${groupClips('mood')[0]}"] input`).first().uncheck();
  assert.ok(await page.getByTestId('export-group-mood').evaluate(e => e.indeterminate && !e.checked), 'partial state');
  await page.getByRole('button', { name: 'Deselect all', exact: true }).click();
  return Object.entries(counts).map(([g, n]) => `${g} ${n}`).join(', ');
});

await check('individual clips; a clip listed under several names stays in sync (selected once)', async () => {
  const shared = catalog.find(e => catalog.filter(x => x.clip === e.clip).length > 1).clip;
  const rows = page.locator(`.clip-row[data-clip="${shared}"] input`);
  assert.ok((await rows.count()) > 1);
  await rows.first().check();
  for (let i = 0; i < (await rows.count()); i++) assert.ok(await rows.nth(i).isChecked(), `${shared} row ${i}`);
  assert.equal(await clipCount(), `1 of ${CLIPS.length} clips selected`);
  await rows.last().uncheck();
  assert.equal(await clipCount(), `0 of ${CLIPS.length} clips selected`);
  return `${shared} is listed ${await rows.count()} times`;
});

await check('search filters the list; selection by search', async () => {
  await page.fill('#export-clip-search', 'sword');
  const n = await page.locator('.clip-row').count();
  assert.ok(n >= 3 && n < 10, `${n} rows`);
  await page.fill('#export-clip-search', '');
  assert.equal(await page.locator('.clip-row').count(), catalog.length);
});

await check('props marked on the clips that show them (Sword, Rose, Guitar, Mic)', async () => {
  await page.waitForFunction(() => document.querySelectorAll('.prop-tag').length > 0, null, { timeout: 60_000 });
  const tags = await page.locator('.clip-row').evaluateAll(rows => rows.filter(r => r.querySelector('.prop-tag')).map(r => `${r.dataset.clip}:${[...r.querySelectorAll('.prop-tag')].map(t => t.textContent).join('+')}`));
  const clips = new Set(tags.map(t => t.split(':')[0]));
  assert.deepEqual([...clips].sort(), ['jamA1', 'jamA2', 'jamB1', 'jamB2', 'mood_lookingForLove', 'mood_swordTwirl', 'rose1', 'rose2', 'swordA1', 'swordA2']);
  return [...new Set(tags)].join(', ');
});

// ------------------------------------------------------------------------------------------- exports
let all94;
await check('UI export: all 94 clips, T-pose display, root motion kept; progress shown; estimate within 3%; file verified vs the engine', async () => {
  await radio('T-pose').click();
  await radio('Keep root motion').click();
  await page.getByRole('button', { name: 'Select all', exact: true }).click();
  const estimate = await waitEstimate();
  await page.screenshot({ path: resultPath('exportui', 'export-animated-all.png') });
  const progress = page.waitForSelector('.export-progress', { timeout: 60_000 }).then(async () => page.locator('#export-status').textContent());
  all94 = await exportFromUi('all94');
  const progressText = await progress;
  assert.match(progressText, /Sampling animations from the original engine: \d+ of 94/);
  assert.match(all94.name, /^buddypoke-animated-94clips-tpose-[0-9a-f]{8}\.glb$/);
  assert.match(all94.status, /^Saved buddypoke-animated-94clips/);
  assert.match(all94.detail, /94 animations \(30 fps, root motion kept\) · props: Sword, Mic, Rose, Strat · 32 facial expressions/);
  const error = Math.abs(estimate.bytes / all94.bytes.length - 1);
  assert.ok(error < ESTIMATE_TOLERANCE, `estimate ${estimate.bytes} vs ${all94.bytes.length}`);
  await page.screenshot({ path: resultPath('exportui', 'export-animated-done.png') });
  const r = await verify(all94, { pose: 'tpose', skeleton: true, rigidParts: 'skin', material: 'unlit', animations: CLIPS, rootMotion: 'keep' }, { render: { clips: ['mood_happy', 'hug1', 'kick1'], props: ['swordA2', 'jamA1'] } });
  assert.equal(r.manifest.bind, 'rest', 'bind stays the original Rest pose');
  assert.equal(r.manifest.pose, 'tpose');
  blenderFiles.push(all94.path);
  return `${all94.name} ${(all94.bytes.length / 1048576).toFixed(2)} MB (estimate ${estimate.text.match(/≈ [\d.]+ \w+/)[0]}, ${(error * 100).toFixed(2)}% off); "${progressText.trim()}"; ${r.summary.frames} frames 0 mismatches, bones ≤ ${mm(r.summary.bone)}, props ≤ ${mm(r.summary.prop)}, face ≤ ${mm(r.summary.face)}`;
});

let custom;
await check('UI export: customized look, Pokes category, Rest, IN PLACE, custom file name; verified vs the engine held in place', async () => {
  await dbg('wearLook', { hrt: 25, ski: 1, glt: 2 }); // pigtails, skirt, glasses
  await page.getByRole('button', { name: 'Deselect all', exact: true }).click();
  await page.getByTestId('export-group-poke').check();
  await radio('Rest').click();
  await radio('In place').click();
  await page.fill('#export-name', 'pokes:in/place');
  const estimate = await waitEstimate();
  custom = await exportFromUi('custom-pokes-inplace');
  await page.fill('#export-name', ''); // back to the suggested name for the next exports
  assert.equal(custom.name, 'pokes-in-place.glb', 'file name sanitised, .glb added');
  assert.match(custom.detail, /\(30 fps, in place\)/);
  const clips = CLIPS.filter(c => groupClips('poke').includes(c));
  const error = Math.abs(estimate.bytes / custom.bytes.length - 1);
  assert.ok(error < ESTIMATE_TOLERANCE, `estimate ${estimate.bytes} vs ${custom.bytes.length}`);
  const r = await verify(custom, { pose: 'rest', skeleton: true, rigidParts: 'skin', material: 'unlit', animations: clips, rootMotion: 'inPlace' }, { meshClips: ['hug1', 'kick1', 'holdHands2'], meshes: ['Body', 'Skrt', 'Hair_Tied_MainPig'], render: { clips: ['hug1', 'kick1'] } });
  assert.equal(r.manifest.rootMotion, 'inPlace');
  assert.ok(['Skrt', 'Hair_Tied_MainPig'].every(n => r.manifest.meshes.some(m => m.name === n)), 'clothes and hair exported');
  blenderFiles.push(custom.path);
  return `${clips.length} poke clips, ${(custom.bytes.length / 1048576).toFixed(2)} MB (estimate ${(error * 100).toFixed(2)}% off); ${r.summary.frames} frames 0 mismatches; bones ≤ ${mm(r.summary.bone)} vs the engine held in place; clothes weighted ≤ ${(r.summary.meshWeighted * 1000).toFixed(3)} mm`;
});

await check('in place vs root motion: only Bip01 horizontal translation differs (rotations, vertical motion, props, faces identical)', async () => {
  const r = await page.evaluate(async () => {
    const d = window.__studio.debug;
    const o = { pose: 'rest', skeleton: true, rigidParts: 'skin', material: 'unlit', animations: ['mood_flying', 'hug1', 'swordA1'] };
    const parse = async b64 => {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const dv = new DataView(bytes.buffer); const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + dv.getUint32(12, true))));
      const bin = bytes.subarray(20 + dv.getUint32(12, true) + 8);
      const acc = i => { const a = json.accessors[i]; const v = json.bufferViews[a.bufferView]; return new Float32Array(bin.slice((v.byteOffset ?? 0) + (a.byteOffset ?? 0), (v.byteOffset ?? 0) + (a.byteOffset ?? 0) + v.byteLength).buffer); };
      return Object.fromEntries(json.animations.flatMap(a => a.channels.map(c => [`${a.name}/${json.nodes[c.target.node].name}/${c.target.path}`, Array.from(acc(a.samplers[c.sampler].output))])));
    };
    const keep = await parse((await d.exportGlb({ ...o, rootMotion: 'keep' })).base64);
    const inPlace = await parse((await d.exportGlb({ ...o, rootMotion: 'inPlace' })).base64);
    const differ = Object.keys(keep).filter(k => keep[k].join() !== (inPlace[k] ?? []).join());
    const root = inPlace['mood_flying/Bip01/translation'];
    const xs = new Set(root.filter((_, i) => i % 3 === 0)), zs = new Set(root.filter((_, i) => i % 3 === 2)), ys = new Set(root.filter((_, i) => i % 3 === 1));
    return { differ, channels: Object.keys(keep).length, xs: xs.size, zs: zs.size, ys: ys.size };
  });
  assert.ok(r.differ.length > 0 && r.differ.every(k => k.endsWith('/Bip01/translation')), r.differ.join(', '));
  assert.equal(r.xs, 1); assert.equal(r.zs, 1); assert.ok(r.ys > 10, 'flying keeps rising');
  return `${r.differ.length} of ${r.channels} channels differ (Bip01 translation only); mood_flying in place: 1 X, 1 Z, ${r.ys} Y values`;
});

let picked;
await check('UI export: individual clips (swordA1, rose2, jamA2): only their props (Sword, Rose, Mic) and their expressions', async () => {
  await dbg('wearCode', null);
  await page.getByRole('button', { name: 'Deselect all', exact: true }).click();
  for (const c of ['swordA1', 'rose2', 'jamA2']) await page.locator(`.clip-row[data-clip="${c}"] input`).first().check();
  await radio('Keep root motion').click();
  const estimate = await waitEstimate();
  assert.match(estimate.text, /3 clips · props: (Rose|Mic|Sword), (Rose|Mic|Sword), (Rose|Mic|Sword) ·/);
  picked = await exportFromUi('picked');
  const r = await verify(picked, { pose: 'rest', skeleton: true, rigidParts: 'skin', material: 'unlit', animations: ['rose2', 'swordA1', 'jamA2'].sort((a, b) => CLIPS.indexOf(a) - CLIPS.indexOf(b)), rootMotion: 'keep' }, { frames: 'n => [0, Math.floor(n / 3), Math.floor(2 * n / 3), n - 1]', render: { props: ['swordA1', 'rose2', 'jamA2'], faces: true } });
  assert.deepEqual(r.manifest.props.map(p => p.name).sort(), ['Mic', 'Rose', 'Sword']);
  assert.deepEqual(r.manifest.animations.map(a => a.name), ['swordA1', 'rose2', 'jamA2'].sort((a, b) => CLIPS.indexOf(a) - CLIPS.indexOf(b)), 'original package order');
  blenderFiles.push(picked.path);
  return `${picked.name}: props ${r.manifest.props.map(p => p.name).join(', ')}, ${r.manifest.faces.length} expressions; ${r.summary.frames} frames 0 mismatches`;
});

await check('UI export: static GLB (and rigged) unchanged: byte-identical to the M3B export path', async () => {
  await radio('GLB · static mesh').click();
  assert.equal(await page.locator('.clip-picker').count(), 0);
  const est = await waitEstimate();
  const file = await exportFromUi('static');
  assert.match(file.name, /^buddypoke-rest-static-/);
  assert.equal(est.bytes > 0 && Math.abs(est.bytes / file.bytes.length - 1) < 0.01, true, 'static size shown exactly');
  await verify(file, { pose: 'rest', skeleton: false, rigidParts: 'skin', material: 'unlit' });
  await radio('GLB · rigged').click();
  const rigged = await exportFromUi('rigged');
  await verify(rigged, { pose: 'rest', skeleton: true, rigidParts: 'skin', material: 'unlit' });
  return `${file.name} ${Math.round(file.bytes.length / 1024)} KB, ${rigged.name}`;
});

await check('selection and settings survive switching tabs', async () => {
  await radio('GLB · animated').click();
  await page.getByRole('tab', { name: 'Customize' }).click();
  await page.getByRole('tab', { name: 'Export' }).click();
  assert.equal(await radio('GLB · animated').getAttribute('aria-checked'), 'true');
  assert.equal(await clipCount(), `3 of ${CLIPS.length} clips selected`);
});

await check('exporting while the Studio plays an animation: playback continues, live character, look and history untouched', async () => {
  await anim('select', 'mood_swordTwirl');
  await anim('seek', 30);
  const snap = async () => ({ locals: await anim('localMatrices'), code: await dbg('code'), history: await dbg('history'), state: await anim('state'), props: await anim('props'), face: await anim('headFrame') });
  const before = await snap();
  await exportFromUi('while-paused');
  assert.deepEqual(await snap(), before, 'paused frame unchanged');
  await anim('play');
  const t0 = (await anim('state')).frame;
  await exportFromUi('while-playing');
  const s = await anim('state');
  assert.equal(s.clip, 'mood_swordTwirl');
  assert.equal(s.state, 'playing');
  assert.notEqual(s.frame, t0, 'clock kept running');
  assert.deepEqual((await anim('props')).engine, (await anim('props')).three);
  assert.equal(await dbg('code'), before.code);
  assert.deepEqual(await dbg('history'), before.history);
  await anim('stop');
  return `played on from frame ${t0} to ${s.frame} during the export`;
});

await check('useful error message when an export fails (simulated failure)', async () => {
  await page.evaluate(() => {
    HTMLCanvasElement.prototype.__toBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function () { throw new Error('simulated: out of memory while encoding a texture'); };
  });
  await page.getByRole('button', { name: 'Export GLB' }).click();
  await page.waitForFunction(() => /Export failed/.test(document.querySelector('#export-status')?.textContent ?? ''), null, { timeout: 60_000 });
  const text = await page.locator('#export-status').textContent();
  assert.ok(await page.locator('#export-status.feedback-error').count());
  await page.evaluate(() => { HTMLCanvasElement.prototype.toBlob = HTMLCanvasElement.prototype.__toBlob; });
  assert.ok(await page.getByRole('button', { name: 'Export GLB' }).isEnabled(), 'can retry');
  return text.trim();
});

await check('phone layout: picker usable, no horizontal overflow', async () => {
  const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  problems.push(watch(p));
  await p.goto(studio.url);
  await studioReady(p);
  await p.getByRole('tab', { name: 'Export' }).click();
  await p.getByRole('radio', { name: 'GLB · animated', exact: true }).click();
  await p.getByTestId('export-group-mood').check();
  await p.waitForFunction(() => /Estimated size: ≈/.test(document.querySelector('#export-estimate')?.textContent ?? ''), null, { timeout: 120_000 });
  const overflow = await p.evaluate(() => [...document.querySelectorAll('.export *')].filter(e => e.getBoundingClientRect().right > window.innerWidth + 1).map(e => e.className).slice(0, 3));
  assert.deepEqual(overflow, []);
  await p.screenshot({ path: resultPath('exportui', 'export-phone.png') });
  await p.close();
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
  for (const path of blenderFiles) {
    const name = path.split('/').pop();
    await check(`Blender: ${name} (downloaded from the Export tab)`, async () => {
      let out;
      try {
        out = execFileSync(blender, [script, path, path.replace(/\.glb$/, '.expected.json'), resultPath('exportui', 'blender')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 3_600_000 });
      } catch (error) {
        out = String(error.stdout ?? '') + String(error.stderr ?? '');
      }
      const lines = out.split('\n').filter(l => /^(PASS|FAIL)/.test(l));
      const failed = lines.filter(l => l.startsWith('FAIL'));
      assert.ok(/RESULT OK/.test(out) && !failed.length, failed.join(' | ') || out.slice(-600));
      return lines.map(l => l.replace(/^PASS /, '')).filter(l => /bone positions|root motion|expression timing|prop visibility timing|rest pose|display/.test(l)).join(' · ');
    });
  }
}
finish();
