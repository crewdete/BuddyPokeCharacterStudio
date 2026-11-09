// M3B export: Export tab, GLB structure, exact pose, skeleton, weights, textures, transparency, materials,
// exports after customization / presets / look codes / during animation, and no side effects on the
// Studio. Every exported file is written to test-results/export/ with its manifest. If BLENDER_PYTHON
// points at a Python with Blender's `bpy` module, each file is also validated in Blender
// (tests/blender/validate_glb.py); otherwise that step is reported as SKIPPED, never as passed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { devices } from 'playwright';
import { checklist, launch, nextFrames, resultPath, serve, studioDist, studioReady, watch } from './lib.mjs';

const studio = await serve(studioDist);
const browser = await launch();
const { check, finish } = checklist();
const problems = [];
const exported = [];

const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
const page = await context.newPage();
problems.push(watch(page));
await page.goto(studio.url);
await studioReady(page);

const dbg = (fn, arg, p = page) => p.evaluate(([fn, arg]) => window.__studio.debug[fn](arg), [fn, arg]);
const anim = (fn, arg, p = page) => p.evaluate(([fn, arg]) => window.__studio.debug.anim[fn](arg), [fn, arg]);
const RIGGED_T = { pose: 'tpose', skeleton: true, rigidParts: 'skin', material: 'unlit' };
const RIGGED_REST = { ...RIGGED_T, pose: 'rest' };

/** Export through the app's export path; save GLB + manifest; return them. */
async function exportAs(name, options) {
  const r = await page.evaluate(o => window.__studio.debug.exportGlb(o), options);
  const glbPath = resultPath('export', `${name}.glb`);
  writeFileSync(glbPath, Buffer.from(r.base64, 'base64'));
  writeFileSync(resultPath('export', `${name}.manifest.json`), JSON.stringify(r.manifest, null, 2));
  exported.push(name);
  assert.ok(r.check.ok, `${name}: self-check ${r.check.problems.join('; ')}`);
  return r;
}

/** Inspect a GLB in the browser: JSON chunk and the file as loaded by GLTFLoader. */
const inspect = (base64, extra = {}) =>
  page.evaluate(async ([b64, extra]) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + view.getUint32(12, true))));
    const loaded = await window.__studioExportInspect(bytes.buffer, extra);
    return { magic: view.getUint32(0, true), version: view.getUint32(4, true), json, loaded };
  }, [base64, extra]);

// The page has GLTFLoader inside the bundle only; expose a small inspector via the debug hook module.
await page.evaluate(() => {
  window.__studioExportInspect = async (buffer, { compareTo } = {}) => {
    const { loadGlbForInspection } = window.__studio.debug;
    return loadGlbForInspection(buffer, compareTo);
  };
});

// ----------------------------------------------------------------------------------- formats / structure
let tRigged;
await check('rigged T-pose GLB: valid binary glTF 2.0, TRS nodes, embedded PNG textures, unlit materials', async () => {
  tRigged = await exportAs('tpose-rigged', RIGGED_T);
  const { magic, version, json } = await inspect(tRigged.base64);
  assert.equal(magic, 0x46546c67, 'glTF magic');
  assert.equal(version, 2);
  assert.equal(json.asset.version, '2.0');
  assert.ok(json.images.length === 3 && json.images.every(i => i.bufferView !== undefined && !i.uri && i.mimeType === 'image/png'), 'images embedded as PNG buffer views');
  assert.ok(json.nodes.every(n => !n.matrix), 'TRS nodes only');
  assert.ok(json.extensionsUsed?.includes('KHR_materials_unlit'), 'unlit');
  assert.ok(json.materials.every(m => m.extensions?.KHR_materials_unlit), 'every material unlit');
  return `${Math.round(Buffer.from(tRigged.base64, 'base64').length / 1024)} KB, ${json.meshes.length} meshes, ${json.images.length} textures`;
});

await check('skeleton: one joint set of the 29 original bones, original names and parents, inverse bind matrices', async () => {
  const { json, loaded } = await inspect(tRigged.base64);
  const joints = json.skins[0].joints.map(i => json.nodes[i].name);
  assert.ok(json.skins.every(s => s.joints.join() === json.skins[0].joints.join() && s.inverseBindMatrices !== undefined));
  const original = (await anim('clips')) && (await page.evaluate(() => window.__studio.info.boneNames));
  assert.deepEqual(joints, original, 'joints = original bones in original order');
  for (const b of tRigged.manifest.bones) assert.equal(loaded.parents[b.name], b.parent, `${b.name} parent`);
  return `29 joints, roots: ${tRigged.manifest.bones.filter(b => !b.parent).map(b => b.name).join(', ')}`;
});

await check('skin weights: every vertex weighted, weights sum to 1, ≤3 influences as in the original', async () => {
  const { loaded } = await inspect(tRigged.base64);
  for (const m of loaded.meshes) {
    assert.ok(m.skinned, `${m.name} skinned`);
    assert.ok(m.unweighted === 0, `${m.name}: ${m.unweighted} unweighted vertices`);
    assert.ok(Math.abs(m.weightSum.min - 1) < 1e-5 && Math.abs(m.weightSum.max - 1) < 1e-5, `${m.name}: weight sums ${m.weightSum.min}–${m.weightSum.max}`);
    assert.ok(m.maxInfluences <= 3, `${m.name}: ${m.maxInfluences} influences`);
  }
});

await check('pose: exported T-pose mesh = the Studio T-pose mesh exactly (×0.01 m); arms horizontal', async () => {
  await anim('showTPose');
  const { loaded } = await inspect(tRigged.base64, { compareTo: true });
  assert.ok(loaded.maxVertexError < 1e-6, `max vertex difference ${loaded.maxVertexError} m`);
  const heads = Object.fromEntries(tRigged.manifest.bones.map(b => [b.name, b.head]));
  for (const side of ['L', 'R']) for (const b of ['Forearm', 'Hand']) assert.ok(Math.abs(heads[`Bip01_${side}_${b}`][1] - heads[`Bip01_${side}_UpperArm`][1]) < 1e-6, `${side} ${b} height`);
  await anim('showRest');
  return `max vertex difference ${loaded.maxVertexError.toExponential(1)} m over ${loaded.vertexCount} vertices`;
});

await check('rest-pose export: mesh = the exact original rest pose; joints within the documented shift', async () => {
  const r = await exportAs('rest-rigged', RIGGED_REST);
  await anim('showRest');
  const { loaded } = await inspect(r.base64, { compareTo: true });
  assert.ok(loaded.maxVertexError < 1e-6, `max vertex difference ${loaded.maxVertexError} m`);
  assert.ok(r.manifest.maxJointShift < 0.0015, `joint shift ${r.manifest.maxJointShift} m`);
  return `vertex difference ${loaded.maxVertexError.toExponential(1)} m; largest joint shift from unit rotations ${(r.manifest.maxJointShift * 1000).toFixed(2)} mm`;
});

await check('static export: meshes and textures, no skin, no joints', async () => {
  const r = await exportAs('tpose-static', { ...RIGGED_T, skeleton: false });
  const { json } = await inspect(r.base64);
  assert.ok(!json.skins && json.meshes.length === 3 && json.images.length === 3);
  assert.ok(!json.nodes.some(n => /^Bip01|^IG_/.test(n.name ?? '')), 'no bone nodes');
});

await check('"Keep parented" option: head and short hair parented to Bip01_Head, body skinned', async () => {
  const r = await exportAs('tpose-rigged-parented', { ...RIGGED_T, rigidParts: 'parent' });
  const { loaded } = await inspect(r.base64);
  const byName = Object.fromEntries(loaded.meshes.map(m => [m.name, m]));
  assert.equal(byName.Body.skinned, true);
  assert.deepEqual([byName.Head.skinned, byName.Head.parent], [false, 'Bip01_Head']);
  assert.deepEqual([byName.Hair_Simple_ScruffySide.skinned, byName.Hair_Simple_ScruffySide.parent], [false, 'Bip01_Head']);
});

await check('"Lit (PBR)" option: standard metallic-roughness materials with the same textures', async () => {
  const r = await exportAs('tpose-rigged-lit', { ...RIGGED_T, material: 'lit' });
  const { json } = await inspect(r.base64);
  assert.ok(!json.extensionsUsed?.includes('KHR_materials_unlit'));
  assert.ok(json.materials.every(m => m.pbrMetallicRoughness?.baseColorTexture && m.pbrMetallicRoughness.metallicFactor === 0));
});

await check('textures: identical pixels to the Studio materials; transparency preserved (hair = BLEND with alpha)', async () => {
  const { json, loaded } = await inspect(tRigged.base64, { compareTo: true });
  const hair = json.materials.find(m => m.name.startsWith('Hair_'));
  assert.equal(hair.alphaMode, 'BLEND');
  assert.ok(json.materials.filter(m => !m.name.startsWith('Hair_')).every(m => !m.alphaMode || m.alphaMode === 'OPAQUE'), 'opaque materials stay opaque');
  for (const t of loaded.textures) assert.ok(t.meanDifference < 1, `${t.name}: mean pixel difference ${t.meanDifference}`);
  // Most original hair/cap sheets are fully painted (opaque despite hasAlpha). The shaved-hair overlay is
  // genuinely transparent: export it and check its alpha survives pixel for pixel.
  await dbg('wearLook', { hrt: 31 });
  await anim('showTPose');
  const shaved = await exportAs('shaved-alpha-tpose', RIGGED_T);
  const s = await inspect(shaved.base64, { compareTo: true });
  await anim('showRest');
  await dbg('wearCode', null);
  const overlay = s.loaded.textures.find(t => t.name === 'Hair_Shave');
  assert.equal(s.json.materials.find(m => m.name === 'Hair_Shave').alphaMode, 'BLEND');
  assert.ok(overlay.transparentPixels > 10000 && overlay.meanDifference === 0, `Hair_Shave: ${overlay.transparentPixels} transparent pixels, Δ${overlay.meanDifference}`);
  return `${loaded.textures.map(t => `${t.name} ${t.size} Δ${t.meanDifference.toFixed(2)}`).join(', ')}; Hair_Shave alpha overlay: ${overlay.transparentPixels} transparent pixels identical (Δ0)`;
});

// ----------------------------------------------------------------------------------- after edits
await check('export after customization (cap, skirt, glasses): exported meshes follow the look, cap transparent', async () => {
  await dbg('wearLook', { hrt: 0, ski: 1, glt: 2 });
  const code = await dbg('code');
  const parts = (await dbg('parts')).map(p => p.name).sort();
  const r = await exportAs('custom-cap-skirt-tpose', RIGGED_T);
  assert.equal(r.manifest.lookCode, code);
  assert.deepEqual(r.manifest.meshes.map(m => m.name).sort(), parts.filter(n => n !== 'Shadow'));
  assert.ok(r.manifest.meshes.find(m => m.name === 'BCap').transparent, 'cap material transparent');
  assert.ok(r.manifest.meshes.some(m => m.name === 'Skrt'), 'skirt exported');
  return r.manifest.meshes.map(m => m.name).join(', ');
});

await check('export after loading a preset and after applying a look code', async () => {
  await page.getByRole('tab', { name: 'Presets' }).click();
  await page.fill('#preset-name', 'Pigtails');
  await dbg('wearLook', { hrt: 25, hrc: 60 });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Default', exact: true }).click();
  await page.getByRole('button', { name: 'Load Pigtails', exact: true }).click();
  await dbg('idle');
  const presetCode = await dbg('code');
  const a = await exportAs('preset-pigtails-tpose', RIGGED_T);
  assert.equal(a.manifest.lookCode, presetCode);
  assert.ok(a.manifest.meshes.some(m => m.name === 'Hair_Tied_MainPig'), 'pigtail hair (skinned to the pigtail bones)');
  await page.getByRole('tab', { name: 'Code' }).click();
  const random = await dbg('randomLook', 7);
  await dbg('wearCode', null);
  await page.fill('#paste-code', random);
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await dbg('idle');
  const b = await exportAs('lookcode-random7-rest', RIGGED_REST);
  assert.equal(b.manifest.lookCode, random);
  return `preset: ${a.manifest.meshes.length} meshes; look code: ${b.manifest.meshes.length} meshes`;
});

// ----------------------------------------------------------------------------------- isolation
await check('export while an animation is playing: file is in the chosen pose; playback undisturbed', async () => {
  await anim('select', 'mood_swordTwirl');
  await anim('play');
  await page.waitForTimeout(400);
  const r = await exportAs('during-animation-rest', RIGGED_REST);
  const s = await anim('state');
  assert.deepEqual([s.clip, s.state, s.mode], ['mood_swordTwirl', 'playing', 'animation']);
  assert.ok(!r.manifest.meshes.some(m => m.name === 'Sword'), 'animation-only prop not exported');
  await anim('pause');
  await anim('showRest');
  const { loaded } = await inspect(r.base64, { compareTo: true });
  assert.ok(loaded.maxVertexError < 1e-6, `rest pose exported (Δ ${loaded.maxVertexError})`);
  await anim('showAnimation');
});

await check('no changes to the character in the Studio after exporting (pose, look, history, render)', async () => {
  await anim('seek', 40);
  await nextFrames(page, 4);
  const before = {
    locals: await anim('localMatrices'),
    code: await dbg('code'),
    history: await dbg('history'),
    parts: await dbg('parts'),
    state: await anim('state'),
    props: await anim('props'),
    png: (await page.locator('.viewport-stage canvas').screenshot()).toString('base64'),
  };
  await exportAs('isolation-check-tpose', RIGGED_T);
  await exportAs('isolation-check-rest', RIGGED_REST);
  await nextFrames(page, 4);
  const after = {
    locals: await anim('localMatrices'),
    code: await dbg('code'),
    history: await dbg('history'),
    parts: await dbg('parts'),
    state: await anim('state'),
    props: await anim('props'),
    png: (await page.locator('.viewport-stage canvas').screenshot()).toString('base64'),
  };
  for (const key of ['locals', 'code', 'history', 'parts', 'state', 'props']) assert.deepEqual(after[key], before[key], key);
  assert.equal(after.png, before.png, 'viewport pixels identical');
  await anim('stop');
});

// ----------------------------------------------------------------------------------- UI
await check('Export tab: options, explanation, filename, progress, download and success summary', async () => {
  await dbg('wearCode', null);
  await page.getByRole('tab', { name: 'Export' }).click();
  assert.match(await page.locator('.export').textContent(), /29-bone skeleton/);
  await page.getByRole('radio', { name: 'GLB · static mesh' }).click();
  assert.match(await page.locator('.export').textContent(), /no skeleton/);
  assert.equal(await page.getByRole('radio', { name: 'Skin to bone' }).count(), 0, 'rigid-part option hidden for static');
  await page.getByRole('radio', { name: 'GLB · rigged' }).click();
  await page.getByRole('radio', { name: 'Rest' }).last().click();
  const placeholder = await page.getAttribute('#export-name', 'placeholder');
  assert.match(placeholder, /^buddypoke-rest-rigged-[0-9a-f]{8}\.glb$/);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export GLB' }).click()]);
  assert.equal(download.suggestedFilename(), placeholder);
  await page.waitForSelector('#export-detail');
  assert.match(await page.locator('#export-status').textContent(), /^Saved buddypoke-rest-rigged/);
  assert.match(await page.locator('#export-detail').textContent(), /3 meshes · 29 bones · 3 embedded textures · 1 transparent materials · verified/);
  const file = readFileSync(await download.path());
  assert.equal(file.readUInt32LE(0), 0x46546c67);
  writeFileSync(resultPath('export', 'ui-download.glb'), file);
  // Custom name, unsafe characters cleaned, extension added.
  await page.fill('#export-name', 'my:buddy/final');
  const [second] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export GLB' }).click()]);
  assert.equal(second.suggestedFilename(), 'my-buddy-final.glb');
  await page.screenshot({ path: resultPath('export', 'export-tab.png') });
  return `${placeholder}, ${Math.round(file.length / 1024)} KB`;
});

await check('phone: Export tab usable, no horizontal scroll', async () => {
  const ctx = await browser.newContext({ ...devices['iPhone 13'], acceptDownloads: true });
  const p = await ctx.newPage();
  problems.push(watch(p));
  await p.goto(studio.url);
  await studioReady(p);
  await p.getByRole('tab', { name: 'Export' }).click();
  const [download] = await Promise.all([p.waitForEvent('download'), p.getByRole('button', { name: 'Export GLB' }).click()]);
  assert.match(download.suggestedFilename(), /^buddypoke-tpose-rigged-/);
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(overflow <= 0, `overflow ${overflow}px`);
  await p.waitForSelector('#export-detail');
  await p.screenshot({ path: resultPath('export', 'export-phone.png') });
  await ctx.close();
});

await check('no console or network errors', async () => assert.deepEqual(problems.flat(), []));

await browser.close();
studio.server.close();

// ----------------------------------------------------------------------------------- Blender
const blender = process.env.BLENDER_PYTHON;
const script = fileURLToPath(new URL('../blender/validate_glb.py', import.meta.url));
const toValidate = ['shaved-alpha-tpose', 'tpose-rigged', 'rest-rigged', 'tpose-static', 'tpose-rigged-parented', 'tpose-rigged-lit', 'custom-cap-skirt-tpose', 'preset-pigtails-tpose', 'lookcode-random7-rest'];
if (!blender) {
  console.log('SKIPPED Blender validation: set BLENDER_PYTHON to a Python with Blender\'s bpy module (see studio/README.md). Not counted as passed.');
} else {
  for (const name of toValidate) {
    await check(`Blender: ${name}.glb`, async () => {
      const out = execFileSync(blender, [script, resultPath('export', `${name}.glb`), resultPath('export', `${name}.manifest.json`), resultPath('export', 'blender')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000 });
      const lines = out.split('\n').filter(l => /^(PASS|FAIL)/.test(l));
      const failed = lines.filter(l => l.startsWith('FAIL'));
      assert.ok(/RESULT OK/.test(out) && failed.length === 0, failed.join(' | ') || 'no RESULT OK');
      const report = JSON.parse(readFileSync(resultPath('export', 'blender', `${name}.blender.json`), 'utf8'));
      return `${lines.length} checks passed in Blender ${report.blender}`;
    });
  }
}
finish();
