// M2B: look codes, Default/Random, presets (+ persistence), preset files, undo/redo — through the real UI.
// Codes are checked against the ORIGINAL BuddyRevival app and renderer. Screenshots: test-results/presets/.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { devices } from 'playwright';
import { checklist, compareImages, launch, nextFrames, repoRoot, resultPath, serve, studioDist, studioReady, watch } from './lib.mjs';

const studio = await serve(studioDist);
const root = await serve(repoRoot);
const browser = await launch();
const { check, finish } = checklist();
const allProblems = [];

const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'], acceptDownloads: true });
const page = await context.newPage();
allProblems.push(watch(page));
await page.goto(studio.url);
await studioReady(page);

const debug = (fn, arg, p = page) => p.evaluate(([fn, arg]) => window.__studio.debug[fn](arg), [fn, arg]);
const idle = (p = page) => debug('idle', undefined, p);
const tab = async name => page.getByRole('tab', { name }).click();
const button = name => page.getByRole('button', { name, exact: true });
const feedback = id => page.locator(`#${id}`).textContent();
const DEFAULT_CODE = await debug('code');

async function choose(optionName, selectorId, index, p = page) {
  const picker = p.locator(`.option[data-option="${optionName}"] .picker[data-selector="${selectorId}"]`);
  if ((await picker.getAttribute('aria-expanded')) !== 'true') await picker.click();
  await p.locator(`.choices[data-selector="${selectorId}"] [role=option]`).nth(index).click();
}

/** Open a code in a fresh original BuddyRevival app and return the code it shows. */
async function codeInOriginalApp(code) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  allProblems.push(watch(p));
  await p.goto(`${root.url}web/?buddy=${encodeURIComponent(code)}`);
  await p.waitForSelector('#wardrobe button', { timeout: 60_000 });
  await p.waitForFunction(() => document.getElementById('code').value.length > 20);
  const shown = await p.inputValue('#code');
  await ctx.close();
  return shown;
}

// Reference renderer + compare page, to check that history/preset/random states render like the original.
const compare = await browser.newPage({ viewport: { width: 692, height: 520 } });
const original = await browser.newPage({ viewport: { width: 692, height: 520 } });
allProblems.push(watch(compare), watch(original));
await compare.goto(`${studio.url}?compare=1`);
await studioReady(compare);
await original.goto(`${root.url}studio/tests/e2e/fixtures/original-bind.html`);
await original.waitForFunction(() => window.__original?.ready, null, { timeout: 60_000 });
async function rendersLikeOriginal(code) {
  await debug('wearCode', code, compare);
  await original.evaluate(code => window.__original.render(code), code);
  await nextFrames(compare, 3);
  const [a, b] = await Promise.all([original.locator('canvas').screenshot({ omitBackground: true }), compare.locator('canvas').screenshot({ omitBackground: true })]);
  const m = await compareImages(compare, a.toString('base64'), b.toString('base64'));
  assert.ok(m.iou >= 0.95 && m.colorDiff <= 14, `render vs original: IoU ${m.iou.toFixed(4)}, colour Δ ${m.colorDiff.toFixed(2)}`);
  return m;
}

// ---------------------------------------------------------------------------------------------- look codes
await check('look code: shown, updates live, copy puts it on the clipboard', async () => {
  await tab('Code');
  assert.equal(await page.inputValue('#current-code'), DEFAULT_CODE);
  await tab('Customize');
  await choose('Hair', 'hrt', 20);
  await idle();
  await tab('Code');
  const code = await debug('code');
  assert.notEqual(code, DEFAULT_CODE);
  assert.equal(await page.inputValue('#current-code'), code, 'field shows the new code');
  await button('Copy').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), code);
  assert.match(await feedback('code-feedback'), /copied/);
});

let originalRandomCode = '';
await check('look code: a code from the original app applies exactly', async () => {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(`${root.url}web/`);
  await p.waitForSelector('#wardrobe button', { timeout: 60_000 });
  const before = await p.inputValue('#code');
  await p.click('#randomize');
  await p.waitForFunction(b => document.getElementById('code').value !== b, before);
  originalRandomCode = await p.inputValue('#code');
  await ctx.close();
  const history = await debug('history');
  await page.fill('#paste-code', originalRandomCode);
  await button('Apply').click();
  await idle();
  assert.equal(await debug('code'), originalRandomCode, 'studio wears the original code unchanged');
  assert.match(await feedback('code-feedback'), /applied/);
  assert.equal(await page.inputValue('#paste-code'), '', 'input cleared');
  assert.equal((await debug('history')).length, history.length + 1, 'one undo step');
  await rendersLikeOriginal(originalRandomCode);
});

await check('look code: the original DEFAULT_LOOK_CODE (original BuddyPoke encoding, line-wrapped) applies', async () => {
  const literal = readFileSync(`${repoRoot}/web/src/domain/wardrobe.js`, 'utf8').match(/DEFAULT_LOOK_CODE = '([^']+)'/)[1];
  assert.notEqual(literal, DEFAULT_CODE, 'original literal differs byte-wise from the re-encoded code');
  await page.fill('#paste-code', literal.replace(/(.{40})/g, '$1\n'));
  await button('Apply').click();
  await idle();
  assert.equal(await debug('code'), DEFAULT_CODE, 'same look as the original default');
});

await check('look code: invalid input gives clear feedback and changes nothing', async () => {
  const cases = [
    ['', /Paste a look code first/],
    ['hello world!', /characters/],
    ['AAAAAAAAAAAA', /could not be decoded/],
    [DEFAULT_CODE.slice(0, 50), /could not be decoded/],
    ['A'.repeat(5000), /too long/],
  ];
  const code = await debug('code');
  const history = await debug('history');
  for (const [input, message] of cases) {
    await page.fill('#paste-code', input);
    await button('Apply').click();
    await idle(); // the apply (validation included) runs in the edit queue
    await page.waitForFunction(m => new RegExp(m).test(document.getElementById('code-feedback').textContent), message.source);
    assert.match(await feedback('code-feedback'), message, `"${input.slice(0, 20)}"`);
    assert.equal(await page.getAttribute('#code-feedback', 'class'), 'feedback feedback-error');
    assert.equal(await page.getAttribute('#paste-code', 'aria-describedby'), 'code-feedback');
  }
  await idle();
  assert.equal(await debug('code'), code, 'look unchanged');
  assert.deepEqual(await debug('history'), history, 'history unchanged');
  await page.screenshot({ path: resultPath('presets', 'code-invalid.png') });
  return `${cases.length} invalid inputs rejected`;
});

// ---------------------------------------------------------------------------------------------- default / random
await check('Default restores the original default character', async () => {
  await button('Default').click();
  await idle();
  assert.equal(await debug('code'), DEFAULT_CODE);
});

const randomCodes = [];
await check('Random: original Wardrobe.randomize, valid looks that render like the original', async () => {
  for (let i = 0; i < 6; i++) {
    await button('Random').click();
    randomCodes.push(await idle());
  }
  assert.equal(new Set(randomCodes).size, randomCodes.length, 'each click gives a new look');
  for (const code of randomCodes.slice(0, 3)) await rendersLikeOriginal(code);
  return `${randomCodes.length} random looks, 3 compared with the original renderer`;
});

await check('random and pasted codes are reproduced exactly by the original BuddyRevival app', async () => {
  for (const code of [...randomCodes.slice(0, 3), originalRandomCode, DEFAULT_CODE]) assert.equal(await codeInOriginalApp(code), code);
  return '5 codes identical';
});

// ---------------------------------------------------------------------------------------------- presets
let streetCode = '';
await check('presets: save, list, load, update by name, delete (with confirmation)', async () => {
  await tab('Presets');
  assert.equal(await page.locator('.preset').count(), 0);
  streetCode = await debug('code');
  await page.fill('#preset-name', 'Street look');
  await button('Save').click();
  assert.match(await feedback('preset-feedback'), /Saved "Street look"/);
  await button('Default').click();
  await idle();
  await page.fill('#preset-name', 'Plain');
  await page.press('#preset-name', 'Enter');
  assert.deepEqual(await page.locator('.preset-name').allTextContents(), ['Street look', 'Plain']);
  await button('Load Street look').click();
  await idle();
  assert.equal(await debug('code'), streetCode, 'preset restores its look');
  assert.match(await feedback('preset-feedback'), /Loaded "Street look"/);
  // Saving under an existing name updates that preset.
  await tab('Customize');
  await choose('Eyes', 'eyc', 3);
  await idle();
  const updated = await debug('code');
  await tab('Presets');
  await page.fill('#preset-name', 'Plain');
  await button('Save').click();
  assert.match(await feedback('preset-feedback'), /Updated "Plain"/);
  assert.equal(await page.locator('.preset').count(), 2);
  assert.equal((await page.evaluate(k => JSON.parse(localStorage.getItem(k)), 'buddypoke-studio:presets')).find(p => p.name === 'Plain').code, updated);
  // Empty name gets a default name.
  await page.fill('#preset-name', '');
  await button('Save').click();
  assert.deepEqual(await page.locator('.preset-name').allTextContents(), ['Street look', 'Plain', 'Preset']);
  // Delete needs a second click.
  await button('Delete Preset').click();
  assert.equal(await page.locator('.preset').count(), 3, 'first click only asks for confirmation');
  await button('Confirm delete Preset').click();
  assert.deepEqual(await page.locator('.preset-name').allTextContents(), ['Street look', 'Plain']);
  await page.screenshot({ path: resultPath('presets', 'presets.png') });
});

await check('presets persist across reloads and new tabs', async () => {
  await page.reload();
  await studioReady(page);
  await tab('Presets');
  assert.deepEqual(await page.locator('.preset-name').allTextContents(), ['Street look', 'Plain']);
  await button('Load Street look').click();
  await idle();
  assert.equal(await debug('code'), streetCode);
  const second = await context.newPage();
  allProblems.push(watch(second));
  await second.goto(studio.url);
  await studioReady(second);
  await second.getByRole('tab', { name: 'Presets' }).click();
  assert.deepEqual(await second.locator('.preset-name').allTextContents(), ['Street look', 'Plain']);
  await second.close();
});

await check('preset codes are reproduced exactly by the original BuddyRevival app', async () => {
  const stored = await page.evaluate(k => JSON.parse(localStorage.getItem(k)), 'buddypoke-studio:presets');
  for (const preset of stored) assert.equal(await codeInOriginalApp(preset.code), preset.code, preset.name);
  return `${stored.length} presets`;
});

// ---------------------------------------------------------------------------------------------- preset files
let exported = '';
await check('preset file: export downloads a valid file', async () => {
  const [download] = await Promise.all([page.waitForEvent('download'), button('Export Street look').click()]);
  assert.equal(download.suggestedFilename(), 'street-look.buddypoke.json');
  exported = readFileSync(await download.path(), 'utf8');
  writeFileSync(resultPath('presets', 'street-look.buddypoke.json'), exported);
  const data = JSON.parse(exported);
  assert.deepEqual(data, { format: 'buddypoke-studio-preset', version: 1, name: 'Street look', code: streetCode });
});

await check('preset file: import into a fresh browser profile restores the look', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  allProblems.push(watch(p));
  await p.goto(studio.url);
  await studioReady(p);
  await p.getByRole('tab', { name: 'Presets' }).click();
  await p.locator('[data-testid=preset-file]').setInputFiles({ name: 'street-look.buddypoke.json', mimeType: 'application/json', buffer: Buffer.from(exported) });
  await p.waitForSelector('.preset');
  assert.match(await p.locator('#preset-feedback').textContent(), /Imported "Street look"/);
  await p.getByRole('button', { name: 'Load Street look', exact: true }).click();
  assert.equal(await debug('idle', undefined, p), streetCode);
  // Importing the same file again keeps both, renamed.
  await p.locator('[data-testid=preset-file]').setInputFiles({ name: 'street-look.buddypoke.json', mimeType: 'application/json', buffer: Buffer.from(exported) });
  await p.waitForFunction(() => document.querySelectorAll('.preset').length === 2);
  assert.deepEqual(await p.locator('.preset-name').allTextContents(), ['Street look', 'Street look (2)']);
  await ctx.close();
});

await check('preset file: invalid files are rejected safely', async () => {
  const cases = [
    ['empty.json', '', /empty/],
    ['notes.json', 'just some text', /not valid JSON/],
    ['array.json', '[1,2,3]', /Not a preset file/],
    ['other.json', JSON.stringify({ format: 'other-app', version: 1, code: streetCode }), /Not a BuddyPoke Studio preset/],
    ['future.json', JSON.stringify({ format: 'buddypoke-studio-preset', version: 9, name: 'x', code: streetCode }), /newer version/],
    ['nocode.json', JSON.stringify({ format: 'buddypoke-studio-preset', version: 1, name: 'x' }), /no look code/],
    ['badcode.json', JSON.stringify({ format: 'buddypoke-studio-preset', version: 1, name: 'x', code: 'AAAAAAAAAAAA' }), /look code is invalid/],
    ['huge.json', JSON.stringify({ format: 'buddypoke-studio-preset', version: 1, name: 'x', code: streetCode, pad: 'x'.repeat(70_000) }), /too large/],
    ['image.png', readFileSync(resultPath('presets', 'presets.png')), /not valid JSON|too large/],
  ];
  const before = await page.locator('.preset-name').allTextContents();
  for (const [name, content, message] of cases) {
    await page.locator('[data-testid=preset-file]').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(content) });
    await page.waitForFunction(m => new RegExp(m).test(document.getElementById('preset-feedback').textContent), message.source);
    assert.match(await feedback('preset-feedback'), message, name);
  }
  assert.deepEqual(await page.locator('.preset-name').allTextContents(), before, 'preset list unchanged');
  return `${cases.length} invalid files rejected`;
});

// ---------------------------------------------------------------------------------------------- undo / redo
await check('undo/redo: buttons and keyboard step through every change in order', async () => {
  await button('Default').click();
  await idle();
  await tab('Customize');
  const steps = [['Hair', 'hrt', 12], ['Shirt', 'shc', 30], ['Pants', 'plt', 2], ['Glasses', 'glt', 3], ['Eyes', 'eyt', 2]];
  const codes = [await debug('code')];
  for (const [o, id, i] of steps) {
    await choose(o, id, i);
    codes.push(await idle());
  }
  assert.equal(new Set(codes).size, codes.length);
  for (let k = codes.length - 2; k >= 0; k--) {
    if (k % 2) await button('Undo').click();
    else await page.keyboard.press('Control+z');
    assert.equal(await idle(), codes[k], `undo to step ${k}`);
  }
  assert.equal(await button('Undo').isDisabled(), false, 'earlier history (before Default) still available');
  for (let k = 1; k < codes.length; k++) {
    if (k === 1) await button('Redo').click();
    else if (k % 2) await page.keyboard.press('Control+Shift+z');
    else await page.keyboard.press('Control+y');
    assert.equal(await idle(), codes[k], `redo to step ${k}`);
  }
  assert.equal(await button('Redo').isDisabled(), true, 'redo disabled at the newest step');
  // A new change after undo drops the redo branch.
  await page.keyboard.press('Control+z');
  await idle();
  await choose('Hair', 'hrt', 30);
  await idle();
  assert.equal((await debug('history')).canRedo, false);
});

await check('undo/redo covers Default, Random, preset loading, pasted codes and category reset', async () => {
  await tab('Presets');
  const start = await idle();
  await button('Random').click();
  const afterRandom = await idle();
  await button('Load Street look').click();
  const afterPreset = await idle();
  await button('Default').click();
  const afterDefault = await idle();
  await tab('Code');
  await page.fill('#paste-code', originalRandomCode);
  await button('Apply').click();
  const afterPaste = await idle();
  await tab('Customize');
  await choose('Hair', 'hrt', 5);
  const afterHair = await idle();
  await page.getByRole('button', { name: 'Reset Hair', exact: true }).click();
  const afterReset = await idle();
  assert.deepEqual([afterPreset, afterDefault, afterPaste], [streetCode, DEFAULT_CODE, originalRandomCode]);
  const expected = [afterHair, afterPaste, afterDefault, afterPreset, afterRandom, start];
  for (const code of expected) {
    await page.keyboard.press('Control+z');
    assert.equal(await idle(), code);
  }
  for (const code of [afterRandom, afterPreset, afterDefault, afterPaste, afterHair, afterReset]) {
    await page.keyboard.press('Control+y');
    assert.equal(await idle(), code);
  }
  await rendersLikeOriginal(afterReset);
});

await check('undo/redo with rapid interactions (10 fast clicks, then fast undo/redo)', async () => {
  await button('Default').click();
  const start = await idle();
  const before = await debug('history');
  const picker = page.locator('.option[data-option="Hair"] .picker');
  if ((await picker.getAttribute('aria-expanded')) !== 'true') await picker.click();
  const indices = [3, 9, 14, 20, 26, 31, 35, 40, 44, 47];
  for (const i of indices) await page.locator('.choices[data-selector="hrt"] [role=option]').nth(i).click({ noWaitAfter: true });
  await idle();
  const after = await debug('history');
  assert.equal(after.length - before.length, indices.length, 'one step per click, none lost or merged');
  assert.equal((await debug('look')).hrt, indices.at(-1), 'last click wins');
  const codes = await debug('historyCodes');
  for (let k = 0; k < indices.length; k++) await page.keyboard.press('Control+z');
  assert.equal(await idle(), start, '10 fast undos return to the start');
  for (let k = 0; k < 4; k++) await page.keyboard.press('Control+y');
  assert.equal(await idle(), codes[codes.length - indices.length + 3], '4 fast redos land on the 4th click');
  assert.equal((await debug('look')).hrt, indices[3]);
});

await check('undo/redo with mixed rapid operations (Random, Default, preset, choices) stays consistent', async () => {
  await tab('Presets');
  const start = await idle();
  await button('Random').click({ noWaitAfter: true });
  await button('Default').click({ noWaitAfter: true });
  await button('Load Plain').click({ noWaitAfter: true });
  await button('Random').click({ noWaitAfter: true });
  await button('Load Street look').click({ noWaitAfter: true });
  const final = await idle();
  assert.equal(final, streetCode, 'operations applied in click order');
  const codes = await debug('historyCodes');
  const { index } = await debug('history');
  assert.equal(codes[index], streetCode);
  assert.equal(codes[index - 3], DEFAULT_CODE, 'Default recorded in order');
  for (let k = 1; k <= 5; k++) {
    await page.keyboard.press('Control+z');
    assert.equal(await idle(), codes[index - k]);
  }
  assert.equal(codes[index - 5], start);
  await rendersLikeOriginal(codes[index - 1]);
});

await check('Ctrl+Z inside a text field edits the text, not the character', async () => {
  await tab('Code');
  const code = await idle();
  const history = await debug('history');
  await page.click('#paste-code');
  await page.keyboard.type('abc');
  await page.keyboard.press('Control+z');
  await idle();
  assert.equal(await debug('code'), code);
  assert.deepEqual(await debug('history'), history);
});

// ---------------------------------------------------------------------------------------------- storage edge cases
await check('corrupted preset storage: app loads, bad data ignored, saving works', async () => {
  await page.evaluate(k => localStorage.setItem(k, '{corrupted'), 'buddypoke-studio:presets');
  await page.reload();
  await studioReady(page);
  await tab('Presets');
  assert.equal(await page.locator('.preset').count(), 0);
  await page.fill('#preset-name', 'Fresh');
  await button('Save').click();
  assert.deepEqual(await page.locator('.preset-name').allTextContents(), ['Fresh']);
});

await check('blocked browser storage: app works, presets kept for the session with a notice', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } }));
  const p = await ctx.newPage();
  allProblems.push(watch(p));
  await p.goto(studio.url);
  await studioReady(p);
  await p.getByRole('tab', { name: 'Presets' }).click();
  assert.match(await p.locator('.tab-body').textContent(), /storage is unavailable/);
  await p.fill('#preset-name', 'Session only');
  await p.getByRole('button', { name: 'Save', exact: true }).click();
  assert.deepEqual(await p.locator('.preset-name').allTextContents(), ['Session only']);
  await ctx.close();
});

// ---------------------------------------------------------------------------------------------- responsive
await check('phone: action bar, tabs, presets and undo usable', async () => {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const p = await ctx.newPage();
  allProblems.push(watch(p));
  await p.goto(studio.url);
  await studioReady(p);
  await p.getByRole('button', { name: 'Random', exact: true }).click();
  const random = await debug('idle', undefined, p);
  await p.getByRole('tab', { name: 'Presets' }).click();
  await p.fill('#preset-name', 'Phone');
  await p.getByRole('button', { name: 'Save', exact: true }).click();
  await p.getByRole('button', { name: 'Undo', exact: true }).click();
  assert.notEqual(await debug('idle', undefined, p), random);
  await p.getByRole('button', { name: 'Load Phone', exact: true }).click();
  assert.equal(await debug('idle', undefined, p), random);
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(overflow <= 0, `overflow ${overflow}px`);
  for (const name of ['Undo', 'Random', 'Load Phone']) {
    const box = await p.getByRole('button', { name, exact: true }).boundingBox();
    assert.ok(box.height >= 24, `${name} ${box.height}px tall`);
  }
  await nextFrames(p, 10);
  await p.screenshot({ path: resultPath('presets', 'phone.png') });
  await ctx.close();
});

await check('tablet layout', async () => {
  const p = await browser.newPage({ viewport: { width: 820, height: 1180 } });
  await p.goto(studio.url);
  await studioReady(p);
  await p.getByRole('tab', { name: 'Code' }).click();
  await nextFrames(p, 10);
  await p.screenshot({ path: resultPath('presets', 'tablet.png') });
  const panel = await p.locator('.panel').boundingBox();
  const view = await p.locator('.viewport').boundingBox();
  assert.ok(view.width > panel.width);
  await p.close();
});

await check('no console or network errors', async () => assert.deepEqual(allProblems.flat(), []));

await browser.close();
studio.server.close();
root.server.close();
finish();
