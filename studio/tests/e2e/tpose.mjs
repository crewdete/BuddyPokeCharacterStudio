// M3A-3: Rest / T-pose / Animation modes, the computed T-pose and the skeleton overlay, through the UI.
// Screenshots: test-results/tpose/.
import assert from 'node:assert/strict';
import { devices } from 'playwright';
import { checklist, launch, nextFrames, resultPath, serve, studioDist, studioReady, watch } from './lib.mjs';

const studio = await serve(studioDist);
const browser = await launch();
const { check, finish } = checklist();
const problems = [];

const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
problems.push(watch(page));
await page.goto(studio.url);
await studioReady(page);

const anim = (fn, arg, p = page) => p.evaluate(([fn, arg]) => window.__studio.debug.anim[fn](arg), [fn, arg]);
const dbg = (fn, arg, p = page) => p.evaluate(([fn, arg]) => window.__studio.debug[fn](arg), [fn, arg]);
const state = (p = page) => anim('state', undefined, p);
const mode = (name, p = page) => p.getByRole('radio', { name, exact: true }).click();
const button = (name, p = page) => p.getByRole('button', { name, exact: true });
const view = (p = page) => dbg('view', undefined, p);
const settle = (p = page) => nextFrames(p, 30);
const shot = async name => {
  await nextFrames(page, 4);
  await page.locator('.viewport-stage').screenshot({ path: resultPath('tpose', `${name}.png`) });
};
const ARMS = ['UpperArm', 'Forearm', 'Hand'];
const REST = await anim('localMatrices');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Reference poses
await mode('T-pose');
const TPOSE = await anim('localMatrices');
await mode('Rest');

// ----------------------------------------------------------------------------------- poses
await check('Rest is the exact original rest pose (bit-for-bit), also after T-pose and animation', async () => {
  assert.equal((await state()).mode, 'rest');
  assert.ok(same(await anim('localMatrices'), REST));
  await mode('T-pose');
  await anim('select', 'hug1');
  await anim('seek', 70);
  await mode('Rest');
  assert.ok(same(await anim('localMatrices'), REST), 'rest after T-pose + animation');
  assert.deepEqual((await anim('props')).three, []);
  await shot('rest');
});

await check('T-pose: every arm bone axis exactly along world ±X (horizontal, straight)', async () => {
  await mode('T-pose');
  const axes = await anim('boneAxes');
  let worst = 0;
  for (const [side, sign] of [['L', 1], ['R', -1]]) {
    for (const bone of ARMS) {
      const [x, y, z] = axes[`Bip01_${side}_${bone}`];
      worst = Math.max(worst, (Math.acos(Math.min(1, x * sign)) * 180) / Math.PI);
      assert.ok(Math.abs(y) < 1e-9 && Math.abs(z) < 1e-9, `${side} ${bone}: ${[x, y, z]}`);
    }
  }
  return `worst deviation ${worst.toExponential(1)}°`;
});

await check('T-pose: joints on the shoulder line, mirror-symmetric (only the original 0.047 shoulder offset)', async () => {
  const w = await anim('boneWorld');
  const mirror = (a, b) => Math.hypot(a[0] + b[0], a[1] - b[1], a[2] - b[2]);
  for (const side of ['L', 'R']) {
    const s = w[`Bip01_${side}_UpperArm`];
    for (const bone of ['Forearm', 'Hand']) {
      const j = w[`Bip01_${side}_${bone}`];
      assert.ok(Math.abs(j[1] - s[1]) < 1e-9 && Math.abs(j[2] - s[2]) < 1e-9, `${side} ${bone} on the shoulder line`);
    }
  }
  const offsets = ARMS.map(b => mirror(w[`Bip01_L_${b}`], w[`Bip01_R_${b}`]));
  assert.ok(offsets.every(o => o < 0.05 && Math.abs(o - offsets[0]) < 1e-5), `mirror offsets ${offsets.map(o => o.toFixed(4))}`);
  const span = Math.abs(w.Bip01_L_Hand[0] - w.Bip01_R_Hand[0]);
  return `mirror offset ${offsets[0].toFixed(4)} (from the original shoulders), wrist span ${span.toFixed(2)}`;
});

await check('T-pose: only the six arm bones differ from rest; deterministic from any entry path', async () => {
  const now = await anim('localMatrices');
  const changed = Object.keys(REST).filter(k => !same(REST[k], now[k])).sort();
  assert.deepEqual(changed, ['Bip01_L_Forearm', 'Bip01_L_Hand', 'Bip01_L_UpperArm', 'Bip01_R_Forearm', 'Bip01_R_Hand', 'Bip01_R_UpperArm']);
  for (const [clip, frame] of [['mood_flying', 50], ['jamA1', 30], ['kick1', 40]]) {
    await anim('select', clip);
    await anim('seek', frame);
    await mode('T-pose');
    assert.ok(same(await anim('localMatrices'), TPOSE), `from ${clip}@${frame}`);
  }
  await dbg('wearLook', { hrt: 0, ski: 1 });
  assert.ok(same(await anim('localMatrices'), TPOSE), 'after customization');
  await dbg('wearCode', null);
});

await check('T-pose mesh: only arm-influenced vertices move, no NaN; shoulder stretch measured', async () => {
  await mode('Rest');
  const rest = await anim('skinnedPositions', 'Body');
  await mode('T-pose');
  const t = await anim('skinnedPositions', 'Body');
  const armBones = new Set(['L', 'R'].flatMap(s => [...ARMS, 'Finger0'].map(b => `Bip01_${s}_${b}`)));
  let movedNonArm = 0;
  let worstStatic = 0;
  for (let i = 0; i < rest.influences.length; i++) {
    const d = Math.hypot(...[0, 1, 2].map(k => t.positions[i * 3 + k] - rest.positions[i * 3 + k]));
    assert.ok(t.positions.slice(i * 3, i * 3 + 3).every(Number.isFinite), 'finite');
    if (!rest.influences[i].some(b => armBones.has(b))) {
      worstStatic = Math.max(worstStatic, d);
      if (d > 1e-4) movedNonArm++;
    }
  }
  assert.equal(movedNonArm, 0, `${movedNonArm} non-arm vertices moved (worst ${worstStatic})`);
  // Shoulder stretch: worst edge-length ratio of triangles touching a vertex weighted to an arm bone and a torso bone.
  const edge = (p, a, b) => Math.hypot(...[0, 1, 2].map(k => p[a * 3 + k] - p[b * 3 + k]));
  let worstStretch = 1;
  let worstCompress = 1;
  const ratios = [];
  for (let f = 0; f < rest.index.length; f += 3) {
    const tri = rest.index.slice(f, f + 3);
    if (!tri.some(v => rest.influences[v].some(b => armBones.has(b)))) continue;
    for (const [a, b] of [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]]) {
      const r = edge(t.positions, a, b) / Math.max(1e-9, edge(rest.positions, a, b));
      worstStretch = Math.max(worstStretch, r);
      ratios.push(r);
      worstCompress = Math.min(worstCompress, r);
    }
  }
  ratios.sort((a, b) => a - b);
  const p = q => ratios[Math.floor(q * (ratios.length - 1))];
  return `non-arm vertices unchanged (worst ${worstStatic.toExponential(1)}); ${ratios.length} arm-region edges: median ${p(0.5).toFixed(2)}×, 5–95% ${p(0.05).toFixed(2)}×–${p(0.95).toFixed(2)}×, extremes ${worstCompress.toFixed(2)}×–${worstStretch.toFixed(2)}× (armpit folds of the arms-down rest pose)`;
});

await check('Three bones and rigid parts match the engine in every mode', async () => {
  for (const m of ['Rest', 'T-pose']) {
    await mode(m);
    const r = await dbg('rigErrors');
    assert.ok(r.bones < 1e-9 && r.rigid < 1e-9, `${m}: ${JSON.stringify(r)}`);
  }
  await anim('select', 'mood_swordTwirl');
  await anim('seek', 40);
  const r = await dbg('rigErrors');
  assert.ok(r.bones < 1e-9 && r.rigid < 1e-9);
});

// ----------------------------------------------------------------------------------- modes
await check('mode switching in every direction shows the right pose and keeps clip, frame, speed and loop', async () => {
  await anim('select', 'mood_swordTwirl');
  await anim('seek', 40);
  await page.selectOption('#speed', '1.5');
  await button('Loop').click(); // loop off
  const ANIM = await anim('localMatrices');
  const expect = { Rest: REST, 'T-pose': TPOSE, Animation: ANIM };
  const order = ['T-pose', 'Animation', 'Rest', 'Animation', 'T-pose', 'Rest', 'T-pose', 'Animation'];
  for (const m of order) {
    await mode(m);
    assert.ok(same(await anim('localMatrices'), expect[m]), `pose after switching to ${m}`);
    const s = await state();
    assert.deepEqual([s.clip, s.frame, s.speed, s.loop, s.state], ['mood_swordTwirl', 40, 1.5, false, 'paused'], `kept after ${m}`);
    assert.equal(await page.getByRole('radio', { name: m, exact: true }).getAttribute('aria-checked'), 'true');
    assert.deepEqual((await anim('props')).three, m === 'Animation' ? ['Sword'] : [], `props in ${m}`);
  }
  await button('Loop').click();
  await page.selectOption('#speed', '1');
  return `${order.length} switches`;
});

await check('switching during playback: clock freezes in Rest/T-pose, resumes from the exact frame, still playing', async () => {
  await anim('select', 'idle:pose_joinNow'.split(':')[1]);
  await button('Play').click();
  await page.waitForTimeout(600);
  await mode('T-pose');
  const left = await state();
  await page.waitForTimeout(700);
  const frozen = await state();
  assert.equal(left.state, 'playing', 'still playing');
  assert.equal(frozen.frame, left.frame, 'frame frozen while away');
  assert.ok(same(await anim('localMatrices'), TPOSE));
  await mode('Rest');
  await page.waitForTimeout(300);
  assert.equal((await state()).frame, left.frame);
  await mode('Animation');
  const back = await state();
  assert.equal(back.state, 'playing');
  assert.ok(back.frame - left.frame <= 2, `resumes at the frame it left (${left.frame} -> ${back.frame})`);
  await page.waitForTimeout(500);
  assert.ok((await state()).frame > back.frame + 8, 'continues advancing');
  await button('Pause').click();
});

await check('Stop from T-pose restores the exact rest pose', async () => {
  await mode('T-pose');
  await button('Stop').click();
  const s = await state();
  assert.deepEqual([s.state, s.mode, s.frame], ['rest', 'rest', 0]);
  assert.ok(same(await anim('localMatrices'), REST));
});

await check('T-pose and Rest work with no animation selected; Animation disabled until one is', async () => {
  const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await p.goto(studio.url);
  await studioReady(p);
  assert.equal(await p.getByRole('radio', { name: 'Animation', exact: true }).isDisabled(), true);
  await p.getByRole('radio', { name: 'T-pose', exact: true }).click();
  assert.equal((await state(p)).mode, 'tpose');
  await p.getByRole('radio', { name: 'Rest', exact: true }).click();
  assert.equal((await state(p)).mode, 'rest');
  await p.close();
});

// ----------------------------------------------------------------------------------- skeleton
await check('skeleton overlay: 29 bones (21 real + 6 helper connections), joints follow the posed bones in every mode', async () => {
  await button('Skeleton').click();
  for (const m of ['Rest', 'T-pose', 'Animation']) {
    if (m === 'Animation') {
      await anim('select', 'kick1');
      await anim('seek', 40);
    } else await mode(m);
    await nextFrames(page, 3);
    const sk = await anim('skeleton');
    assert.equal(sk.visible, true);
    assert.equal(sk.names.length, 29);
    assert.deepEqual(sk.counts, { real: 21, helper: 6 });
    const bones = await anim('boneWorld');
    const helperNames = sk.names.filter(n => n.startsWith('IG_') || n === 'Bip01_Footsteps');
    const realNames = sk.names.filter(n => !helperNames.includes(n));
    let worst = 0;
    realNames.forEach((n, i) => (worst = Math.max(worst, ...bones[n].map((v, k) => Math.abs(v - sk.joints.real[i * 3 + k])))));
    helperNames.forEach((n, i) => (worst = Math.max(worst, ...bones[n].map((v, k) => Math.abs(v - sk.joints.helper[i * 3 + k])))));
    assert.ok(worst < 1e-3, `${m}: drawn joints off the bones by ${worst}`);
    await shot(`skeleton-${m.toLowerCase()}`);
  }
});

await check('X-ray: bones drawn through the character when on, hidden inside it when off', async () => {
  await mode('T-pose');
  const dark = async () => {
    await nextFrames(page, 3);
    const png = await page.locator('.viewport-stage canvas').screenshot();
    return page.evaluate(async b64 => {
      const img = new Image();
      await new Promise(ok => { img.onload = ok; img.src = `data:image/png;base64,${b64}`; });
      const c = new OffscreenCanvas(img.width, img.height);
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, img.width, img.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 43) < 14 && Math.abs(d[i + 1] - 43) < 14 && Math.abs(d[i + 2] - 43) < 14) n++;
      return n;
    }, png.toString('base64'));
  };
  assert.equal((await anim('skeleton')).xray, true, 'X-ray on by default with the skeleton');
  const on = await dark();
  await shot('xray-on');
  await button('X-ray').click();
  assert.equal((await anim('skeleton')).xray, false);
  const off = await dark();
  await shot('xray-off');
  await button('Skeleton').click();
  const none = await dark();
  await button('Skeleton').click();
  await button('X-ray').click();
  // Dark outfit pixels are always present: compare with the no-skeleton baseline.
  assert.ok(on - none > 300, `X-ray adds visible bones (${on} vs ${none})`);
  assert.ok(off - none < 0.25 * (on - none), `without X-ray the bones are hidden inside the mesh (${off} vs ${none})`);
  return `charcoal pixels: X-ray ${on}, X-ray off ${off}, no skeleton ${none}`;
});

await check('keyboard: B toggles the skeleton, X toggles X-ray; not in editable fields or with modifiers', async () => {
  const sk = async () => {
    const s = await anim('skeleton');
    return [s.visible, s.xray];
  };
  await page.evaluate(() => document.activeElement?.blur());
  const start = await sk();
  await page.keyboard.press('b');
  assert.deepEqual(await sk(), [!start[0], start[1]]);
  await page.keyboard.press('B');
  assert.deepEqual(await sk(), start);
  await page.keyboard.press('x');
  assert.deepEqual(await sk(), [start[0], !start[1]]);
  await page.keyboard.press('x');
  await page.keyboard.press('Control+b');
  assert.deepEqual(await sk(), start, 'Ctrl+B ignored');
  await page.getByRole('tab', { name: 'Animate' }).click();
  await page.click('#animation-search');
  await page.keyboard.type('box');
  assert.equal(await page.inputValue('#animation-search'), 'box');
  assert.deepEqual(await sk(), start, 'typing b/x in search does nothing');
  await page.fill('#animation-search', '');
  await page.getByRole('tab', { name: 'Presets' }).click();
  await page.click('#preset-name');
  await page.keyboard.type('bx');
  assert.equal(await page.inputValue('#preset-name'), 'bx');
  await page.fill('#preset-name', '');
  await page.getByRole('tab', { name: 'Code' }).click();
  await page.click('#paste-code');
  await page.keyboard.type('xb');
  assert.equal(await page.inputValue('#paste-code'), 'xb');
  await page.fill('#paste-code', '');
  assert.deepEqual(await sk(), start);
  // Existing shortcuts still work alongside.
  await page.evaluate(() => document.activeElement?.blur());
  await anim('select', 'mood_happy');
  await page.keyboard.press(' ');
  assert.equal((await state()).state, 'playing');
  await page.keyboard.press(' ');
  await page.getByRole('tab', { name: 'Customize' }).click();
});

// ----------------------------------------------------------------------------------- camera
await check('camera position, target and zoom are preserved across mode and skeleton switches', async () => {
  for (const projection of ['Persp', 'Ortho']) {
    await button(projection).click();
    await settle();
    const before = await view();
    for (const m of ['T-pose', 'Animation', 'Rest', 'T-pose']) {
      await mode(m);
      await page.keyboard.press('b');
      await settle();
      const after = await view();
      assert.deepEqual([after.type, ...after.position.map(v => v.toFixed(6)), ...after.target.map(v => v.toFixed(6)), after.zoom.toFixed(6)], [before.type, ...before.position.map(v => v.toFixed(6)), ...before.target.map(v => v.toFixed(6)), before.zoom.toFixed(6)], `${projection} ${m}`);
    }
  }
  await button('Persp').click();
  await page.keyboard.press('Home');
  await settle();
});

await check('with the skeleton on, orbit and zoom still work', async () => {
  const sk = await anim('skeleton');
  if (!sk.visible) await button('Skeleton').click();
  const box = await page.locator('.viewport-stage canvas').boundingBox();
  const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const before = await view();
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 200, c.y, { steps: 10 });
  await page.mouse.up();
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -200);
  await settle();
  const after = await view();
  const az = v => Math.atan2(v.position[0] - v.target[0], v.position[2] - v.target[2]);
  assert.ok(Math.abs(az(after) - az(before)) > 0.3, 'orbited');
  assert.ok(after.distance < before.distance * 0.9, 'zoomed');
  await page.keyboard.press('Home');
  await settle();
});

await check('T-pose fits the default framing (desktop): character fully visible and centred', async () => {
  await mode('T-pose');
  await settle();
  const v = await view();
  assert.ok(v.ndc.minX > -0.98 && v.ndc.maxX < 0.98 && v.ndc.minY > -0.98 && v.ndc.maxY < 0.98, JSON.stringify(v.ndc));
  assert.ok(Math.abs((v.ndc.minX + v.ndc.maxX) / 2) < 0.05, 'centred');
  await page.screenshot({ path: resultPath('tpose', 'desktop.png') });
});

for (const [name, options] of [['tablet', { viewport: { width: 820, height: 1180 } }], ['phone', devices['iPhone 13']]]) {
  await check(`${name}: T-pose visible, three mode buttons and skeleton usable, no horizontal scroll`, async () => {
    const ctx = await browser.newContext(options);
    const p = await ctx.newPage();
    problems.push(watch(p));
    await p.goto(studio.url);
    await studioReady(p);
    await p.getByRole('radio', { name: 'T-pose', exact: true }).click();
    await p.getByRole('button', { name: 'Skeleton', exact: true }).click();
    await nextFrames(p, 20);
    const v = await view(p);
    assert.ok(v.ndc.minX > -1 && v.ndc.maxX < 1 && v.ndc.minY > -1 && v.ndc.maxY < 1, `T-pose in view ${JSON.stringify(v.ndc)}`);
    assert.equal((await anim('skeleton', undefined, p)).visible, true);
    for (const m of ['Rest', 'T-pose', 'Animation']) assert.ok(await p.getByRole('radio', { name: m, exact: true }).isVisible(), `${m} visible`);
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(overflow <= 0, `overflow ${overflow}px`);
    await p.screenshot({ path: resultPath('tpose', `${name}.png`) });
    await ctx.close();
  });
}

await check('no console or network errors', async () => assert.deepEqual(problems.flat(), []));

await browser.close();
studio.server.close();
finish();
