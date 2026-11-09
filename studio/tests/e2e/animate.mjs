// M3A-2 animation interface, through the real UI: Animate tab (groups, search, selection, all 94 clips),
// transport (play/pause/stop, frame display, slider seeking, loop, speed, rest/animation), keyboard,
// switching clips, customization / presets / codes / undo during playback, tabs, responsive layouts.
// Screenshots: test-results/animate/.
import assert from 'node:assert/strict';
import { devices } from 'playwright';
import { checklist, launch, nextFrames, resultPath, serve, studioDist, studioReady, watch } from './lib.mjs';

const studio = await serve(studioDist);
const browser = await launch();
const { check, finish } = checklist();
const problems = [];

const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
problems.push(watch(page));
await page.goto(studio.url);
await studioReady(page);
const REST = await page.evaluate(() => window.__studio.debug.anim.localMatrices());

const state = (p = page) => p.evaluate(() => window.__studio.debug.anim.state());
const dbg = (fn, arg, p = page) => p.evaluate(([fn, arg]) => window.__studio.debug[fn](arg), [fn, arg]);
const anim = (fn, arg, p = page) => p.evaluate(([fn, arg]) => window.__studio.debug.anim[fn](arg), [fn, arg]);
const tab = (name, p = page) => p.getByRole('tab', { name }).click();
const button = (name, p = page) => p.getByRole('button', { name, exact: true });
const entry = (id, p = page) => p.locator(`.animation-list [data-entry="${id}"]`);
const pick = async (id, p = page) => {
  await entry(id, p).scrollIntoViewIfNeeded();
  await entry(id, p).click();
};
const group = (label, p = page) => p.getByRole('radio', { name: new RegExp(`^${label}\\b`) }).click();
const search = (text, p = page) => p.fill('#animation-search', text);
const frameText = () => page.locator('.transport-frame').textContent();
const waitState = (fn, arg) => page.waitForFunction(([fn, arg]) => new Function('s', 'a', `return (${fn})(s, a)`)(window.__studio.debug.anim.state(), arg), [fn.toString(), arg]);

await tab('Animate');

// ------------------------------------------------------------------------------- browser
await check('all 94 original clips are listed, 110 entries across groups', async () => {
  await group('All');
  await search('');
  const rows = await page.locator('.animation-list [role=option]').evaluateAll(els => els.map(e => ({ entry: e.dataset.entry, clip: e.dataset.clip })));
  assert.equal(rows.length, 110);
  assert.equal(new Set(rows.map(r => r.clip)).size, 94);
  const clips = (await anim('clips')).map(c => c.name).sort();
  assert.deepEqual([...new Set(rows.map(r => r.clip))].sort(), clips);
  return '110 entries, 94 distinct clips (all package clips)';
});

await check('group filters: Moods 39, Pokes 56 (28 you/friend pairs), Idle 13, Other 2', async () => {
  const count = () => page.locator('.animation-list [role=option]').count();
  await group('Moods');
  assert.equal(await count(), 39);
  assert.equal(await page.getByRole('radio', { name: /^Moods/ }).getAttribute('aria-checked'), 'true');
  await group('Pokes');
  assert.equal(await count(), 56);
  const sides = await page.locator('.animation-list .side').allTextContents();
  assert.equal(sides.filter(s => s === 'you').length, 28);
  assert.equal(sides.filter(s => s === 'friend').length, 28);
  const first = await page.locator('.animation-list [role=option]').first().textContent();
  assert.match(first, /Bear hug\s*you/);
  await group('Idle');
  assert.equal(await count(), 13);
  await group('Other');
  assert.deepEqual(await page.locator('.animation-list .anim-name').allTextContents(), ['Stand breathe', 'Applause']);
  await group('All');
});

await check('original readable names (moods.xml / pokes.xml) and clip ids shown', async () => {
  await search('kung fu');
  assert.deepEqual(await page.locator('.animation-list .anim-name').allTextContents(), ['Kung Fu Kid']);
  assert.match(await page.locator('.animation-list .anim-meta').first().textContent(), /kick1 · 2\.7 s/);
  await search('');
});

await check('search: names, poke sides, clip ids, several terms, no match', async () => {
  const names = async () => page.locator('.animation-list [role=option]').evaluateAll(els => els.map(e => e.querySelector('.anim-name').textContent));
  await search('hug');
  assert.deepEqual(await names(), ['Bear hugyou', 'Bear hugfriend', 'Hugyou', 'Hugfriend', 'Handshake hugyou', 'Handshake hugfriend']);
  await search('rose friend');
  assert.deepEqual(await names(), ['Give a rosefriend']);
  await search('jamA1');
  assert.deepEqual(await names(), ['Rock Star', 'Rock outyou']);
  await group('Moods');
  assert.deepEqual(await names(), ['Rock Star'], 'group and search combine');
  await group('All');
  await search('xyzzy');
  assert.equal(await page.locator('.animation-list [role=option]').count(), 0);
  assert.match(await page.locator('.animate').textContent(), /No animations match/);
  await search('');
});

await check('selecting an animation starts it from frame 0 and marks it selected', async () => {
  await pick('mood:mood_happy:happy');
  const s = await state();
  assert.equal(s.clip, 'mood_happy');
  assert.equal(s.state, 'playing');
  assert.ok(s.frame < 10, `starts at the beginning (frame ${s.frame})`);
  assert.equal(await entry('mood:mood_happy:happy').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('.animation-list [aria-selected=true]').count(), 1);
  assert.equal(await page.locator('.transport-name').textContent(), 'Happy');
  // Re-selecting restarts from 0.
  await page.waitForTimeout(600);
  await pick('mood:mood_happy:happy');
  assert.ok((await state()).frame < 10);
});

await check('shared clips: the clicked entry is the one marked (celebrate1 = "Excited" and "Celebrate — you")', async () => {
  await search('celebrate1');
  await pick('poke:celebrate1:celebrate');
  assert.equal(await entry('poke:celebrate1:celebrate').getAttribute('aria-selected'), 'true');
  assert.equal(await entry('mood:celebrate1:excited').getAttribute('aria-selected'), 'false');
  assert.equal(await page.locator('.transport-name').textContent(), 'Celebrate — you');
  await pick('mood:celebrate1:excited');
  assert.equal(await page.locator('.transport-name').textContent(), 'Excited');
  await search('');
});

// ------------------------------------------------------------------------------- transport
await check('Play / Pause / Stop buttons, frame display', async () => {
  await pick('mood:mood_tired:tired'); // 261 frames
  await page.waitForTimeout(500);
  await button('Pause').click();
  const paused = await state();
  assert.equal(paused.state, 'paused');
  assert.equal(await frameText(), `${String(paused.frame).padStart(3, '0')} / 260`);
  await page.waitForTimeout(400);
  assert.equal((await state()).frame, paused.frame, 'holds while paused');
  await button('Play').click();
  await page.waitForTimeout(400);
  assert.ok((await state()).frame > paused.frame, 'resumes');
  await button('Stop').click();
  const stopped = await state();
  assert.deepEqual([stopped.state, stopped.mode, stopped.frame], ['rest', 'rest', 0]);
  assert.deepEqual(await anim('localMatrices'), REST, 'exact rest pose');
  assert.equal(await button('Stop').isDisabled(), true);
  assert.equal(await page.getByRole('radio', { name: 'Rest', exact: true }).getAttribute('aria-checked'), 'true');
});

await check('frame slider seeks directly (paused and while playing)', async () => {
  await pick('mood:mood_tired:tired');
  await button('Pause').click();
  await page.locator('#frame-slider').fill('150');
  let s = await state();
  assert.deepEqual([s.frame, s.state], [150, 'paused']);
  assert.equal(await frameText(), '150 / 260');
  assert.equal(await page.locator('#frame-slider').inputValue(), '150');
  await button('Play').click();
  await page.locator('#frame-slider').fill('20');
  s = await state();
  assert.ok(s.state === 'playing' && s.frame >= 20 && s.frame < 40, `continues from 20 (${s.frame})`);
  await page.locator('#frame-slider').fill('260');
  await button('Pause').click();
});

await check('loop toggle and speed selector take effect immediately', async () => {
  await pick('poke:celebrate2:celebrate'); // 31 frames
  assert.equal(await button('Loop').getAttribute('aria-pressed'), 'true');
  await button('Loop').click();
  assert.equal((await state()).loop, false);
  assert.equal(await button('Loop').getAttribute('aria-pressed'), 'false');
  await waitState(s => s.state === 'ended');
  assert.equal((await state()).frame, 30, 'stops on the last frame');
  await button('Loop').click();
  await button('Play').click();
  await page.waitForTimeout(1500);
  assert.equal((await state()).state, 'playing', 'loops again');
  // Speed: measure the frame rate at 2x and 0.5x after changing it mid-playback.
  await pick('idle:pose_joinNow'); // 341 frames
  const rate = async () => {
    const a = await page.evaluate(() => ({ f: window.__studio.debug.anim.state().frame, t: performance.now() }));
    await page.waitForTimeout(1500);
    const b = await page.evaluate(() => ({ f: window.__studio.debug.anim.state().frame, t: performance.now() }));
    return (b.f - a.f) / ((b.t - a.t) / 1000);
  };
  await page.selectOption('#speed', '2');
  assert.equal((await state()).speed, 2);
  const fast = await rate();
  await page.selectOption('#speed', '0.5');
  const slow = await rate();
  await page.selectOption('#speed', '1');
  assert.deepEqual(await page.locator('#speed option').allTextContents(), ['0.25×', '0.5×', '0.75×', '1×', '1.25×', '1.5×', '2×']);
  assert.ok(Math.abs(fast - 60) < 7 && Math.abs(slow - 15) < 3, `2x ${fast.toFixed(1)} f/s, 0.5x ${slow.toFixed(1)} f/s`);
  return `2× ${fast.toFixed(1)} f/s, 0.5× ${slow.toFixed(1)} f/s`;
});

await check('Rest / Animation mode keeps the clip and frame; Rest shows the exact rest pose', async () => {
  await pick('mood:mood_swordTwirl:Sword Master');
  await button('Pause').click();
  await page.locator('#frame-slider').fill('40');
  const posed = await anim('localMatrices');
  await page.getByRole('radio', { name: 'Rest', exact: true }).click();
  assert.deepEqual(await anim('localMatrices'), REST);
  assert.deepEqual((await anim('props')).three, [], 'sword hidden in rest pose');
  assert.deepEqual([(await state()).frame, (await state()).clip], [40, 'mood_swordTwirl']);
  await page.getByRole('radio', { name: 'Animation', exact: true }).click();
  assert.deepEqual(await anim('localMatrices'), posed);
  assert.deepEqual((await anim('props')).three, ['Sword']);
});

// ------------------------------------------------------------------------------- keyboard
await check('keyboard: Space play/pause, comma/period step while paused (ignored while playing)', async () => {
  await pick('mood:mood_tired:tired');
  await page.evaluate(() => document.activeElement?.blur()); // focus on the page body, not the list
  await page.keyboard.press(' ');
  assert.equal((await state()).state, 'paused');
  const f = (await state()).frame;
  await page.keyboard.press('.');
  await page.keyboard.press('.');
  assert.equal((await state()).frame, f + 2);
  await page.keyboard.press(',');
  assert.equal((await state()).frame, f + 1);
  await page.keyboard.press(' ');
  assert.equal((await state()).state, 'playing');
  const before = (await state()).frame;
  await page.keyboard.press(',');
  assert.ok((await state()).frame >= before, 'comma ignored while playing');
  await page.keyboard.press(' ');
});

await check('Space on a focused list item or button toggles playback instead of clicking it', async () => {
  await pick('mood:mood_tired:tired'); // the entry keeps focus
  await page.waitForTimeout(500);
  await page.keyboard.press(' ');
  const s = await state();
  assert.equal(s.state, 'paused');
  assert.ok(s.frame > 5, 'not restarted by the focused entry');
  await button('Loop').focus();
  await page.keyboard.press(' ');
  assert.equal((await state()).state, 'playing');
  assert.equal((await state()).loop, true, 'Loop button not toggled by Space');
  await page.keyboard.press(' ');
});

await check('shortcuts never fire inside editable fields (search, preset name, look code)', async () => {
  const paused = await state();
  await page.click('#animation-search');
  await page.keyboard.type('a b.,');
  assert.equal(await page.inputValue('#animation-search'), 'a b.,');
  assert.deepEqual([(await state()).state, (await state()).frame], [paused.state, paused.frame]);
  await search('');
  await tab('Presets');
  await page.click('#preset-name');
  await page.keyboard.type('My look .,');
  assert.equal(await page.inputValue('#preset-name'), 'My look .,');
  await page.fill('#preset-name', '');
  await tab('Code');
  await page.click('#paste-code');
  await page.keyboard.type('x y.');
  assert.equal(await page.inputValue('#paste-code'), 'x y.');
  await page.fill('#paste-code', '');
  await page.locator('#speed').focus();
  await page.keyboard.press(' ');
  assert.deepEqual([(await state()).state, (await state()).frame], [paused.state, paused.frame], 'select keeps its own keys');
  await tab('Animate');
});

// ------------------------------------------------------------------------------- integration
await check('switching animations from the list never bleeds (equals a fresh load)', async () => {
  const fresh = await browser.newPage();
  await fresh.goto(studio.url);
  await studioReady(fresh);
  await anim('select', 'holdHands1', fresh);
  const expected = await anim('worldPositions', undefined, fresh);
  await fresh.close();
  await search('hug');
  await pick('poke:hug1:hug');
  await page.waitForTimeout(800);
  await search('hold hands');
  await pick('poke:holdHands1:hold hands');
  await button('Pause').click();
  await page.locator('#frame-slider').fill('0');
  const got = await anim('worldPositions');
  let worst = 0;
  for (const [k, v] of Object.entries(expected)) worst = Math.max(worst, ...v.map((x, i) => Math.abs(x - got[k][i])));
  assert.equal(worst, 0);
  await search('');
});

await check('customization, presets, look codes and undo/redo keep the selected animation and paused frame', async () => {
  await search('sword master');
  await pick('mood:mood_swordTwirl:Sword Master');
  await button('Pause').click();
  await page.locator('#frame-slider').fill('40');
  const keep = async label => {
    const s = await state();
    assert.deepEqual([s.clip, s.frame, s.state, s.mode], ['mood_swordTwirl', 40, 'paused', 'animation'], label);
    assert.deepEqual((await anim('props')).three, ['Sword'], `${label}: prop still shown`);
    assert.equal(await page.locator('.transport-name').textContent(), 'Sword Master');
  };
  await tab('Customize');
  await page.locator('.option[data-option="Hair"] .picker').click();
  await page.locator('.choices[data-selector="hrt"] [role=option]').nth(0).click();
  await dbg('idle');
  await keep('after changing hair');
  await tab('Presets');
  await page.fill('#preset-name', 'Capped');
  await button('Save').click();
  await button('Default').click();
  await dbg('idle');
  await keep('after Default');
  await button('Load Capped').click();
  await dbg('idle');
  await keep('after loading a preset');
  await tab('Code');
  await page.fill('#paste-code', await dbg('code'));
  await button('Apply').click();
  await dbg('idle');
  await keep('after applying a look code');
  await button('Undo').click();
  await dbg('idle');
  await keep('after Undo');
  await button('Redo').click();
  await dbg('idle');
  await keep('after Redo');
  await button('Random').click();
  await dbg('idle');
  await keep('after Random');
  await page.screenshot({ path: resultPath('animate', 'customized-while-paused.png') });
  await tab('Animate');
  await search('');
});

await check('customizing while playing keeps playing the same clip', async () => {
  await pick('mood:mood_tired:tired');
  await tab('Customize');
  await page.locator('.option[data-option="Hair"] .picker').click();
  await page.locator('.choices[data-selector="hrt"] [role=option]').nth(25).click();
  await dbg('idle');
  const s = await state();
  assert.deepEqual([s.clip, s.state, s.mode], ['mood_tired', 'playing', 'animation']);
  await tab('Animate');
});

await check('playback continues while switching tabs', async () => {
  await pick('idle:pose_joinNow');
  const start = (await state()).frame;
  for (const name of ['Customize', 'Presets', 'Code', 'Animate']) {
    await tab(name);
    await page.waitForTimeout(250);
  }
  const s = await state();
  assert.equal(s.state, 'playing');
  assert.ok(s.frame > start + 15, `advanced ${s.frame - start} frames`);
  assert.equal(await entry('idle:pose_joinNow').getAttribute('aria-selected'), 'true', 'selection kept after returning');
});

await check('desktop screenshots', async () => {
  await group('Pokes');
  await pick('poke:rose1:give a rose');
  await page.waitForTimeout(400);
  await button('Pause').click();
  await page.locator('#frame-slider').fill('70');
  await nextFrames(page, 4);
  await page.screenshot({ path: resultPath('animate', 'desktop.png') });
  await page.locator('.transport').screenshot({ path: resultPath('animate', 'transport.png') });
  await group('All');
  await search('rock');
  await page.screenshot({ path: resultPath('animate', 'search.png') });
  await search('');
});

// ------------------------------------------------------------------------------- responsive
for (const [name, options] of [['phone', devices['iPhone 13']], ['tablet', { viewport: { width: 820, height: 1180 } }]]) {
  await check(`${name}: Animate tab and transport usable, no horizontal scroll`, async () => {
    const ctx = await browser.newContext(options);
    const p = await ctx.newPage();
    problems.push(watch(p));
    await p.goto(studio.url);
    await studioReady(p);
    await tab('Animate', p);
    await p.getByRole('radio', { name: /^Moods/ }).click();
    await p.locator('.animation-list [data-entry="mood:mood_flying:flying high"]').scrollIntoViewIfNeeded();
    await p.locator('.animation-list [data-entry="mood:mood_flying:flying high"]').click();
    await p.waitForTimeout(500);
    await p.getByRole('button', { name: 'Pause', exact: true }).click();
    await p.locator('#frame-slider').fill('50');
    const s = await state(p);
    assert.deepEqual([s.clip, s.frame], ['mood_flying', 50]);
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(overflow <= 0, `overflow ${overflow}px`);
    const canvas = await p.locator('.viewport canvas').boundingBox();
    const bar = await p.locator('.transport').boundingBox();
    assert.ok(canvas.height > 150 && bar.y >= canvas.y + canvas.height - 1, 'transport under the 3D view, not covering it');
    const slider = await p.locator('#frame-slider').boundingBox();
    if (name === 'phone') {
      assert.ok(slider.width > 250, `slider gets its own row (${slider.width}px)`);
      for (const label of ['Play', 'Stop', 'Loop']) assert.ok((await p.getByRole('button', { name: label, exact: true }).boundingBox()).height >= 30, `${label} touch target`);
    }
    await nextFrames(p, 6);
    await p.screenshot({ path: resultPath('animate', `${name}.png`) });
    await ctx.close();
  });
}

await check('no console or network errors', async () => assert.deepEqual(problems.flat(), []));

await browser.close();
studio.server.close();
finish();
