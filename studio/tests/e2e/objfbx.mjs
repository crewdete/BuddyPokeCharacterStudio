// OBJ and FBX export — driven through the real Export tab. Format area (5 options), OBJ (ZIP with .obj/.mtl/PNG) and FBX
// (binary 7.4, rig + animations + props + facial expressions) downloads, sizes, customized looks, the three GLB modes
// unchanged, exporting while the Studio plays. Every downloaded file is byte-identical to the same export through the
// debug API and is checked against the static GLB (OBJ geometry) or the ORIGINAL engine (FBX animation).
// Blender validation (official OBJ and FBX importers) when BLENDER_PYTHON is set.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checklist, launch, resultPath, serve, studioDist, studioReady, watch } from './lib.mjs';

const TOL = { bone_m: 1e-5, mesh_weighted_m: 1.5e-3, mesh_all_m: 8e-3 }; // same as the animated GLB
const CUSTOM_LOOK = { hrt: 25, ski: 1, glt: 2 }; // pigtails, skirt, glasses

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
const groupClips = g => CLIPS.filter(c => catalog.some(e => e.group === g && e.clip === c));
const panel = () => page.getByRole('region', { name: 'Export' });
const radio = name => panel().getByRole('radio', { name, exact: true });
const restHeads = Object.fromEntries((await dbg('exportGlb', { pose: 'rest', skeleton: true, rigidParts: 'skin', material: 'unlit', animations: [] })).manifest.bones.map(b => [b.name, b.head]));
const blender = { obj: [], fbx: [] };

async function waitSize() {
  await page.waitForFunction(() => /(Estimated size: ≈|Size:) [\d.]+ (KB|MB)/.test(document.querySelector('#export-estimate')?.textContent ?? ''), null, { timeout: 180_000 });
  const text = await page.locator('#export-estimate').textContent();
  const [, n, unit] = text.match(/([\d.]+) (KB|MB)/);
  return { text, exact: text.startsWith('Size:'), bytes: Number(n) * (unit === 'MB' ? 1048576 : 1024) };
}
async function exportFromUi() {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 600_000 }), panel().getByRole('button', { name: /^Export (GLB|OBJ|FBX)$/ }).click()]);
  const name = download.suggestedFilename();
  const path = resultPath('objfbx', name);
  await download.saveAs(path);
  await page.waitForSelector('#export-detail');
  return { name, path, bytes: readFileSync(path), status: await page.locator('#export-status').textContent(), detail: await page.locator('#export-detail').textContent() };
}
/** The same export through the debug API (same code path): must give identical bytes. */
const sameExport = (format, options, baseName) => page.evaluate(a => window.__studio.debug.exportFile(a), { format, options, baseName });
const glbPositions = b64 => {
  const glb = Buffer.from(b64, 'base64');
  const jl = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jl));
  const bin = glb.subarray(28 + jl);
  return name => {
    const n = json.nodes.find(x => x.name === name);
    const a = json.accessors[json.meshes[n.mesh].primitives[0].attributes.POSITION];
    const v = json.bufferViews[a.bufferView];
    const start = bin.byteOffset + (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
    return Array.from(new Float32Array(bin.buffer.slice(start, start + a.count * 12)));
  };
};
/** OBJ vertex list of each object, from the downloaded ZIP (Python's zipfile checks the archive and CRCs). */
function objContents(path) {
  const out = execFileSync('python3', ['-c', `
import zipfile, json, sys
z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
names = z.namelist(); obj = next(n for n in names if n.endswith('.obj')); mtl = next(n for n in names if n.endswith('.mtl'))
print(json.dumps({'names': names, 'obj': z.read(obj).decode(), 'mtl': z.read(mtl).decode()}))`, path], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const { names, obj, mtl } = JSON.parse(out);
  const objects = {};
  let current = null;
  for (const line of obj.split('\n')) {
    if (line.startsWith('o ')) objects[(current = line.slice(2))] = [];
    else if (line.startsWith('v ')) objects[current].push(...line.slice(2).split(' ').map(Number));
  }
  return { names, obj, mtl, objects };
}
const mm = m => `${(m * 1000).toFixed(5)} mm`;

// ------------------------------------------------------------------------------------------- interface
await check('Format: the three GLB options unchanged on the first row, OBJ and FBX below them, one radio group', async () => {
  await page.getByRole('tab', { name: 'Export' }).click();
  const group = panel().getByRole('radiogroup', { name: 'Format' });
  const labels = await group.getByRole('radio').allTextContents();
  assert.deepEqual(labels, ['GLB · static mesh', 'GLB · rigged', 'GLB · animated', 'OBJ', 'FBX']);
  assert.equal(await radio('GLB · rigged').getAttribute('aria-checked'), 'true', 'default unchanged');
  const box = async n => radio(n).boundingBox();
  const [s, r, a, o, f] = await Promise.all(['GLB · static mesh', 'GLB · rigged', 'GLB · animated', 'OBJ', 'FBX'].map(box));
  assert.ok(Math.abs(s.y - r.y) < 1 && Math.abs(r.y - a.y) < 1, 'GLB options on one row');
  assert.ok(Math.abs(o.y - f.y) < 1 && o.y > s.y + s.height - 2, 'OBJ and FBX on the row below');
  assert.ok(Math.abs(o.x - s.x) < 1 && Math.abs(f.x + f.width - (a.x + a.width)) < 1, 'same width as the GLB row');
  await radio('OBJ').click();
  assert.equal(await panel().getByRole('button', { name: 'Export OBJ' }).count(), 1, 'button names the format');
  await page.screenshot({ path: resultPath('objfbx', 'export-formats-obj.png') });
  return `${labels.join(' | ')}`;
});

await check('OBJ options: pose only (no skeleton, material or animation choices), with the reason stated', async () => {
  for (const label of ['Rest', 'T-pose']) assert.equal(await radio(label).count(), 1, label);
  for (const absent of ['Skin to bone', 'Unlit (original look)', 'Keep root motion']) assert.equal(await radio(absent).count(), 0, absent);
  assert.equal(await panel().locator('.clip-picker').count(), 0);
  assert.match(await panel().locator('.hint').first().textContent(), /OBJ cannot store a skeleton, skin weights or animation/);
});

// ------------------------------------------------------------------------------------------- OBJ
async function objExport(label, pose, look) {
  if (look) await dbg('wearLook', look); else await dbg('wearCode', null);
  await radio('OBJ').click();
  await radio(pose === 'tpose' ? 'T-pose' : 'Rest').click();
  const size = await waitSize();
  const file = await exportFromUi();
  assert.match(file.name, new RegExp(`^buddypoke-obj-${pose}-[0-9a-f]{8}\\.zip$`));
  assert.match(file.status, /^Saved buddypoke-obj-/);
  assert.match(file.detail, /objects · \d+ triangles · \d+ PNG textures .* verified/);
  assert.ok(size.exact && Math.abs(size.bytes / file.bytes.length - 1) < 0.01, `size ${size.text} vs ${file.bytes.length}`);
  const same = await sameExport('obj', { pose, skeleton: false, rigidParts: 'skin', material: 'unlit' }, file.name);
  assert.ok(same.check.ok, same.check.problems.join('; '));
  assert.equal(same.base64, file.bytes.toString('base64'), 'identical to the debug-API export');
  const glb = await dbg('exportGlb', { pose, skeleton: false, rigidParts: 'skin', material: 'unlit' });
  const positions = glbPositions(glb.base64);
  const contents = objContents(file.path);
  let worst = 0;
  for (const m of same.manifest.meshes) {
    const a = contents.objects[m.name], b = positions(m.name);
    assert.equal(a.length, b.length, `${m.name}: vertex count`);
    for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
  }
  assert.ok(worst < 1e-6, `OBJ vs static GLB: ${worst}`);
  writeFileSync(file.path.replace(/\.zip$/, '.expected.json'), JSON.stringify({ pose, meshes: same.manifest.meshes.map(m => ({ name: m.name, triangles: m.triangles, transparent: m.transparent, texture: m.texture, positions: positions(m.name) })) }));
  blender.obj.push(file.path);
  return `${file.name}: ${contents.names.length} files (${contents.names.join(', ')}), ${(file.bytes.length / 1024).toFixed(0)} KB (size shown exactly); vertices = static GLB within ${(worst * 1000).toFixed(5)} mm`;
}
await check('OBJ download, default look, Rest: valid ZIP; geometry = the static GLB; textures and MTL complete', () => objExport('obj-rest', 'rest'));
await check('OBJ download, customized look (pigtails, skirt, glasses), T-pose: the customized character', async () => {
  const r = await objExport('obj-custom', 'tpose', CUSTOM_LOOK);
  const contents = objContents(blender.obj.at(-1));
  for (const part of ['Skrt', 'Hair_Tied_MainPig']) assert.ok(part in contents.objects, `${part} exported`);
  assert.match(contents.mtl, /^map_d /m, 'transparent part keeps its alpha map');
  return r;
});

// ------------------------------------------------------------------------------------------- FBX
await check('FBX options: initial pose, root motion, clip picker (optional), head/short hair; Blender note', async () => {
  await dbg('wearCode', null);
  await radio('FBX').click();
  for (const label of ['Rest', 'T-pose', 'Keep root motion', 'In place', 'Skin to bone', 'Keep parented']) assert.equal(await radio(label).count(), 1, label);
  assert.equal(await radio('Unlit (original look)').count(), 0, 'no GLB material choice');
  assert.equal(await panel().locator('.clip-picker').count(), 1);
  assert.match(await page.locator('#export-blender-note').textContent(), /30 fps from the file.*BuddyPoke\|.*frame 1.*Ctrl_/s);
  await panel().getByRole('button', { name: 'Deselect all', exact: true }).click();
  assert.ok(await panel().getByRole('button', { name: 'Export FBX' }).isEnabled(), 'FBX can be exported without animations');
});

async function fbxExpectations(file, options, { frames = 'n => [0, Math.floor(n / 3), Math.floor(2 * n / 3), n - 1]', meshClips = [], meshes = ['Body'], render = [] } = {}) {
  const same = await sameExport('fbx', options);
  assert.ok(same.check.ok, same.check.problems.join('; '));
  assert.equal(same.base64, file.bytes.toString('base64'), 'identical to the debug-API export');
  const expected = options.animations.length
    ? await page.evaluate(a => window.__studio.debug.animationExpectations({ ...a, frames: new Function(`return ${a.frames}`)(), timeline: true }), { clips: options.animations, frames, meshClips, meshes, inPlace: options.rootMotion === 'inPlace' })
    : {};
  const m = same.manifest;
  writeFileSync(file.path.replace(/\.fbx$/, '.expected.json'), JSON.stringify({
    clips: expected, restHeads, displayHeads: Object.fromEntries(m.bones.map(b => [b.name, b.head])), display: m.pose,
    bones: m.bones.map(b => ({ name: b.name, parent: b.parent })), meshes: m.meshes.map(x => x.name), meshSkinned: Object.fromEntries(m.meshes.map(x => [x.name, x.skinned])),
    tolerances: TOL, render,
  }));
  blender.fbx.push(file.path);
  return same;
}

await check('FBX download, no animations (rigged), T-pose: valid binary FBX, exact size, rig + skin + textures', async () => {
  await radio('T-pose').click();
  const size = await waitSize();
  const file = await exportFromUi();
  assert.match(file.name, /^buddypoke-fbx-rigged-tpose-[0-9a-f]{8}\.fbx$/);
  assert.equal(file.bytes.subarray(0, 20).toString('latin1'), 'Kaydara FBX Binary  ');
  assert.ok(size.exact && Math.abs(size.bytes / file.bytes.length - 1) < 0.01, `size ${size.text} vs ${file.bytes.length}`);
  const same = await fbxExpectations(file, { pose: 'tpose', skeleton: true, rigidParts: 'skin', material: 'unlit', animations: [], rootMotion: 'keep' });
  assert.match(file.detail, /29 bones · 0 animations/);
  return `${file.name} ${(file.bytes.length / 1024).toFixed(0)} KB; ${JSON.stringify(same.check.summary)}`;
});

await check('FBX download with animations (all prop clips + 3 more), Rest, root motion: verified vs the engine; estimate within 3%', async () => {
  await radio('Rest').click();
  await radio('Keep root motion').click();
  const clips = ['mood_happy', 'mood_lookingForLove', 'rose1', 'rose2', 'mood_swordTwirl', 'swordA1', 'swordA2', 'jamA1', 'jamB1', 'jamB2', 'jamA2', 'hug1', 'kick1'];
  for (const c of clips) await panel().locator(`.clip-row[data-clip="${c}"] input`).first().check();
  const size = await waitSize();
  const file = await exportFromUi();
  const order = CLIPS.filter(c => clips.includes(c));
  assert.match(file.name, new RegExp(`^buddypoke-fbx-animated-${order.length}clips-rest-[0-9a-f]{8}\\.fbx$`));
  assert.ok(!size.exact && Math.abs(size.bytes / file.bytes.length - 1) < 0.03, `estimate ${size.text} vs ${file.bytes.length}`);
  assert.match(file.detail, /13 animations \(30 fps, root motion kept\) · props: .*Sword.* · \d+ facial expressions/);
  const same = await fbxExpectations(file, { pose: 'rest', skeleton: true, rigidParts: 'skin', material: 'unlit', animations: order, rootMotion: 'keep' }, { meshClips: ['hug1', 'swordA1', 'jamA1'], render: ['swordA2', 'jamA1', 'rose1', 'jamA2', 'mood_happy'] });
  assert.equal(same.check.summary.animations, 13);
  assert.ok(same.check.summary.maxEulerErrorDeg < 1e-4, `Euler storage error ${same.check.summary.maxEulerErrorDeg}°`);
  return `${(file.bytes.length / 1048576).toFixed(2)} MB (estimate ${(Math.abs(size.bytes / file.bytes.length - 1) * 100).toFixed(1)}% off); ${JSON.stringify(same.check.summary)}`;
});

await check('FBX download, customized look, Idle category, T-pose, IN PLACE: verified vs the engine held in place', async () => {
  await dbg('wearLook', CUSTOM_LOOK);
  await panel().getByRole('button', { name: 'Deselect all', exact: true }).click();
  await page.getByTestId('export-group-idle').check();
  await radio('T-pose').click();
  await radio('In place').click();
  await page.fill('#export-name', 'idle in-place');
  await waitSize();
  const file = await exportFromUi();
  assert.equal(file.name, 'idle in-place.fbx', 'typed name, .fbx added');
  await page.fill('#export-name', '');
  const clips = groupClips('idle');
  const same = await fbxExpectations(file, { pose: 'tpose', skeleton: true, rigidParts: 'skin', material: 'unlit', animations: clips, rootMotion: 'inPlace' }, { meshClips: clips.slice(0, 3), meshes: ['Body', 'Skrt', 'Hair_Tied_MainPig'], render: clips.slice(0, 3) });
  assert.ok(['Skrt', 'Hair_Tied_MainPig'].every(n => same.manifest.meshes.some(m => m.name === n)));
  await dbg('wearCode', null);
  return `${clips.length} idle clips, ${(file.bytes.length / 1048576).toFixed(2)} MB; ${JSON.stringify(same.check.summary)}`;
});

// ------------------------------------------------------------------------------------------- GLB unchanged
await check('the three GLB options still work and give the same files as before (byte-identical to the GLB export path)', async () => {
  const out = [];
  for (const [label, options] of [
    ['GLB · static mesh', { pose: 'rest', skeleton: false, rigidParts: 'skin', material: 'unlit' }],
    ['GLB · rigged', { pose: 'rest', skeleton: true, rigidParts: 'skin', material: 'unlit' }],
    ['GLB · animated', { pose: 'rest', skeleton: true, rigidParts: 'skin', material: 'unlit', animations: ['swordA1', 'hug1'].sort((a, b) => CLIPS.indexOf(a) - CLIPS.indexOf(b)), rootMotion: 'keep' }],
  ]) {
    await radio(label).click();
    await radio('Rest').click();
    if (label === 'GLB · animated') {
      await radio('Keep root motion').click();
      await panel().getByRole('button', { name: 'Deselect all', exact: true }).click();
      assert.ok(await panel().getByRole('button', { name: 'Export GLB' }).isDisabled(), 'animated GLB still needs a clip');
      for (const c of ['swordA1', 'hug1']) await panel().locator(`.clip-row[data-clip="${c}"] input`).first().check();
    }
    await waitSize();
    const file = await exportFromUi();
    assert.match(file.name, /\.glb$/);
    const ref = await dbg('exportGlb', options);
    assert.ok(ref.check.ok);
    assert.equal(ref.base64, file.bytes.toString('base64'), `${label}: identical`);
    out.push(`${file.name} ${(file.bytes.length / 1024).toFixed(0)} KB`);
  }
  return out.join(', ');
});

await check('exporting OBJ and FBX while a clip plays: playback continues; live character, look and history untouched', async () => {
  await anim('select', 'mood_swordTwirl');
  await anim('seek', 30);
  const snap = async () => ({ locals: await anim('localMatrices'), code: await dbg('code'), history: await dbg('history'), state: await anim('state'), props: await anim('props'), face: await anim('headFrame') });
  const before = await snap();
  await radio('OBJ').click();
  await exportFromUi();
  await radio('FBX').click();
  await exportFromUi();
  assert.deepEqual(await snap(), before);
  await anim('play');
  const f0 = (await anim('state')).frame;
  await exportFromUi();
  const s = await anim('state');
  assert.deepEqual([s.clip, s.state], ['mood_swordTwirl', 'playing']);
  assert.notEqual(s.frame, f0);
  await anim('stop');
});

await check('phone layout: five formats fit, no horizontal overflow', async () => {
  const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  problems.push(watch(p));
  await p.goto(studio.url);
  await studioReady(p);
  await p.getByRole('tab', { name: 'Export' }).click();
  await p.getByRole('region', { name: 'Export' }).getByRole('radio', { name: 'FBX', exact: true }).click();
  const overflow = await p.evaluate(() => [...document.querySelectorAll('.export *')].filter(e => e.getClientRects().length && e.getBoundingClientRect().right > window.innerWidth + 1).map(e => e.className || e.tagName).slice(0, 3));
  assert.deepEqual(overflow, []);
  await p.screenshot({ path: resultPath('objfbx', 'export-formats-phone.png') });
  await p.close();
});

await check('desktop screenshots of the FBX options', async () => {
  await radio('FBX').click();
  await page.getByRole('tab', { name: 'Export' }).click();
  await panel().evaluate(e => e.closest('[role=tabpanel]')?.scrollTo?.(0, 0));
  await page.screenshot({ path: resultPath('objfbx', 'export-formats-fbx.png') });
});

await check('no console or network errors', async () => assert.deepEqual(problems.flat(), []));
await browser.close();
studio.server.close();

// ------------------------------------------------------------------------------------------- Blender
const python = process.env.BLENDER_PYTHON;
if (!python) {
  console.log('SKIPPED Blender validation: set BLENDER_PYTHON to a Python with Blender\'s bpy module. Not counted as passed.');
} else {
  const run = (script, path, expected) => {
    try {
      return execFileSync(python, [fileURLToPath(new URL(`../blender/${script}`, import.meta.url)), path, expected, resultPath('objfbx', 'blender')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 3_600_000 });
    } catch (error) {
      return String(error.stdout ?? '') + String(error.stderr ?? '');
    }
  };
  for (const [kind, script] of [['obj', 'validate_obj.py'], ['fbx', 'validate_fbx.py']]) {
    for (const path of blender[kind]) {
      await check(`Blender: ${path.split('/').pop()}`, async () => {
        const out = run(script, path, path.replace(/\.(zip|fbx)$/, '.expected.json'));
        const lines = out.split('\n').filter(l => /^(PASS|FAIL)/.test(l));
        const failed = lines.filter(l => l.startsWith('FAIL'));
        assert.ok(/RESULT OK/.test(out) && !failed.length, failed.join(' | ') || out.slice(-600));
        return lines.map(l => l.replace(/^PASS /, '')).filter(l => /positions|bone positions|root motion|timing|rest pose|display|texture|sync|carry-over/.test(l)).join(' · ');
      });
    }
  }
}
finish();
