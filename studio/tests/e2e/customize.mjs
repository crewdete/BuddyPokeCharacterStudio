// M2A customization tests, driven through the real panel (clicks), checked against the ORIGINAL code:
//  - every wardrobe option (all 32, rule-gated ones made visible with their original prerequisite),
//    every selector: choose via UI -> look updated, 3D view redrawn, render matches the original
//    Canvas 2D renderer for the same look code, Reset restores the original default;
//  - original visibility rules (OPTION_RULES) reflected in the panel;
//  - combinations built by clicking; their look codes reproduced by the original BuddyRevival app;
//  - a look made with the original app's Random button loads identically in the studio;
//  - phone layout usable. Screenshots in test-results/customize/.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { devices } from 'playwright';
import { checklist, compareImages, launch, nextFrames, repoRoot, resultPath, serve, studioDist, studioReady, watch } from './lib.mjs';

const THRESHOLDS = { iou: 0.95, colorDiff: 14 };
// Original OPTION_RULES (web/src/domain/wardrobe.js): a look under which each gated option is shown.
const PREREQUISITE = {
  'Hair Color': { hrt: 5 }, 'Hair Streak': { hrt: 5 }, 'Shaved Hair': { hrt: 31 }, Cap: { hrt: 0 }, 'Cap 2': { hrt: 0 },
  'High Belt Pattern': { blt: 1 }, 'Low Belt Pattern': { blt: 4 }, 'Sling Pattern': { sst: 1 }, 'Shoe Pattern': { sst: 4 },
  'Boot Pattern': { sst: 5 }, 'Skirt 2': { ski: 1 }, 'Skirt 3': { ski: 1 },
};

const studio = await serve(studioDist);
const root = await serve(repoRoot);
const browser = await launch();
const { check, finish } = checklist();

// UI page (the real editor), comparison page (original camera) and the original reference renderer.
const ui = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const compare = await browser.newPage({ viewport: { width: 692, height: 520 } });
const original = await browser.newPage({ viewport: { width: 692, height: 520 } });
const problems = [ui, compare, original].map(watch);
await ui.goto(studio.url);
await studioReady(ui);
await compare.goto(`${studio.url}?compare=1`);
await studioReady(compare);
await original.goto(`${root.url}studio/tests/e2e/fixtures/original-bind.html`);
await original.waitForFunction(() => window.__original?.ready, null, { timeout: 60_000 });

const debug = (page, fn, arg) => page.evaluate(([fn, arg]) => window.__studio.debug[fn](arg), [fn, arg]);
const version = () => debug(ui, 'version');
const waitVersion = v => ui.waitForFunction(v => window.__studio.debug.version() >= v, v, { timeout: 30_000 });
const viewportShot = () => ui.locator('.viewport canvas').screenshot();

/** Open a picker (if closed) and click choice `index`, exactly as a user would. */
async function chooseInUi(optionName, selectorId, index) {
  const picker = ui.locator(`.option[data-option="${optionName}"] .picker[data-selector="${selectorId}"]`);
  if ((await picker.getAttribute('aria-expanded')) !== 'true') await picker.click();
  const choices = ui.locator(`.choices[data-selector="${selectorId}"] [role=option]`);
  const size = await choices.count();
  const before = await version();
  await choices.nth(Math.min(index, size - 1)).click();
  await waitVersion(before + 1);
  await nextFrames(ui, 3);
}

/** Render a look code with the studio (compare mode) and the original renderer; return metrics. */
async function compareWithOriginal(code, sheetName) {
  const studioCode = await debug(compare, 'wearCode', code);
  const originalCode = await original.evaluate(code => window.__original.render(code), code);
  assert.equal(studioCode, code, 'compare page wears the code unchanged');
  assert.equal(originalCode, code, 'original renderer wears the code unchanged');
  await nextFrames(compare, 3);
  const [a, b] = await Promise.all([
    original.locator('canvas').screenshot({ omitBackground: true }),
    compare.locator('canvas').screenshot({ omitBackground: true }),
  ]);
  const m = await compareImages(compare, a.toString('base64'), b.toString('base64'));
  if (sheetName) writeFileSync(resultPath('customize', `${sheetName}.png`), Buffer.from(m.sheet, 'base64'));
  assert.ok(m.iou >= THRESHOLDS.iou, `IoU ${m.iou.toFixed(4)}`);
  assert.ok(m.colorDiff <= THRESHOLDS.colorDiff, `colour Δ ${m.colorDiff.toFixed(2)}`);
  const rig = await debug(compare, 'rigErrors');
  assert.ok(rig.bones < 1e-3 && rig.rigid < 1e-3, 'skeleton and rigid attachments exact');
  return m;
}

const defaultLook = await debug(ui, 'look');
// All 32 options with their selectors, from the original Wardrobe.
const allOptions = await debug(ui, 'options');
let changed = 0, unchangedVisually = [], worstIou = 1, worstColour = 0, selectorsTested = 0;

for (const option of allOptions) {
  await check(`category "${option.name}" (${option.selectors.length} selector${option.selectors.length > 1 ? 's' : ''})`, async () => {
    await debug(ui, 'wearLook', PREREQUISITE[option.name] ?? {});
    await nextFrames(ui, 2);
    assert.equal(await ui.locator(`.option[data-option="${option.name}"]`).count(), 1, 'row visible');
    const results = [];
    for (const selector of option.selectors) {
      // Row content can change after a choice (rules), so re-read the current value from the original.
      const look = await debug(ui, 'look');
      if (await ui.locator(`.option[data-option="${option.name}"] .picker[data-selector="${selector.id}"]`).count() === 0) continue;
      const index = (look[selector.id] + Math.ceil(selector.size / 2)) % selector.size;
      const before = await viewportShot();
      await chooseInUi(option.name, selector.id, index);
      const after = await debug(ui, 'look');
      assert.equal(after[selector.id], index, `${selector.id} = ${index}`);
      const selected = await ui.locator(`.choices[data-selector="${selector.id}"] [aria-selected=true]`).count();
      assert.equal(selected, 1, 'exactly one choice marked selected');
      if ((await viewportShot()).equals(before)) unchangedVisually.push(`${option.name}/${selector.id}`);
      else changed++;
      const m = await compareWithOriginal(await debug(ui, 'code'), null);
      worstIou = Math.min(worstIou, m.iou);
      worstColour = Math.max(worstColour, m.colorDiff);
      selectorsTested++;
      results.push(`${selector.id}→${index}`);
    }
    // Reset the category: every selector back to the original default, button disabled.
    const reset = ui.getByRole('button', { name: `Reset ${option.name}`, exact: true });
    if (await reset.count()) {
      const before = await version();
      await reset.click();
      await waitVersion(before + 1);
      const look = await debug(ui, 'look');
      for (const s of option.selectors) assert.equal(look[s.id], defaultLook[s.id], `${s.id} reset to default`);
      if (await reset.count()) assert.equal(await reset.isDisabled(), true, 'Reset disabled at default');
    }
    return results.join(', ');
  });
}

await check('every selector changed through the UI and redrew the 3D view', async () => {
  assert.ok(selectorsTested >= 76, `${selectorsTested} selectors tested`);
  // A few choices are invisible from the front camera (e.g. a back-only pattern); everything else must redraw.
  assert.ok(changed / selectorsTested > 0.85, `${changed}/${selectorsTested} redrew; unchanged: ${unchangedVisually.join(', ')}`);
  return `${selectorsTested} selectors; ${changed} visibly redrew; worst IoU ${worstIou.toFixed(4)}, worst colour Δ ${worstColour.toFixed(2)}${unchangedVisually.length ? `; no visible change from the front: ${unchangedVisually.join(', ')}` : ''}`;
});

await check('original visibility rules drive the panel rows', async () => {
  const rows = async look => {
    await debug(ui, 'wearCode', null);
    await debug(ui, 'wearLook', look);
    return ui.evaluate(() => [...document.querySelectorAll('.option')].map(o => o.dataset.option));
  };
  const cap = await rows({ hrt: 0 });
  assert.ok(cap.includes('Cap') && !cap.includes('Hair Color') && !cap.includes('Shaved Hair'));
  const hair = await rows({ hrt: 20 });
  assert.ok(hair.includes('Hair Color') && hair.includes('Hair Streak') && !hair.includes('Cap'));
  const shaved = await rows({ hrt: 31 });
  assert.ok(shaved.includes('Shaved Hair') && !shaved.includes('Hair Color'));
  const boots = await rows({ sst: 5 });
  assert.ok(boots.includes('Boot Pattern') && !boots.includes('Shoe Pattern') && !boots.includes('Sling Pattern'));
  const skirt = await rows({ ski: 1 });
  assert.ok(skirt.includes('Skirt 2') && skirt.includes('Skirt 3'));
});

await check('original selector resets: switching shoes clears the old pattern', async () => {
  await debug(ui, 'wearCode', null);
  await chooseInUi('Shoes', 'sst', 5); // boots
  await chooseInUi('Boot Pattern', 'sd5', 2);
  assert.equal((await debug(ui, 'look')).sd5, 2);
  await chooseInUi('Shoes', 'sst', 1); // sandals: original SELECTOR_RESETS clears the boot pattern
  assert.equal((await debug(ui, 'look')).sd5, 0);
});

// Combinations built only with clicks: [option, selector, index] steps.
const COMBOS = {
  'cap-glasses-mask-skirt-boots': [['Hair', 'hrt', 0], ['Cap', 'cpc', 3], ['Glasses', 'glt', 2], ['Mask', 'mkt', 1], ['Skirt', 'ski', 1], ['Shoes', 'sst', 5], ['Shirt', 'shc', 40]],
  'pigtails-longsleeve-belt-gloves': [['Hair', 'hrt', 25], ['Hair Color', 'hrc', 60], ['Shirt', 'sht', 2], ['Belt', 'blt', 2], ['Gloves', 'glvt', 1], ['Pants', 'plt', 3]],
  'shaved-mustache-freckles-sandals': [['Hair', 'hrt', 31], ['Mustache', 'mst', 2], ['Freckles', 'spo', 1], ['Shoes', 'sst', 2], ['Socks', 'sot', 2], ['Eyes', 'eyt', 3]],
  'spiky-skirt-long-eyeshadow': [['Hair', 'hrt', 44], ['Skirt', 'ski', 2], ['Eye Shadow', 'est', 2], ['Shirt 2', 'sl2t', 5], ['Body Color', 'bdc', 12], ['Head Color', 'hdc', 12]],
};
const comboCodes = {};
for (const [name, steps] of Object.entries(COMBOS)) {
  await check(`combination ${name} (clicked in the panel)`, async () => {
    await debug(ui, 'wearCode', null);
    for (const [option, id, index] of steps) {
      if (await ui.locator(`.option[data-option="${option}"] .picker[data-selector="${id}"]`).count() === 0) {
        throw new Error(`${option}/${id} not available in this look`);
      }
      await chooseInUi(option, id, index);
    }
    await ui.screenshot({ path: resultPath('customize', `${name}-studio.png`) });
    const code = await debug(ui, 'code');
    comboCodes[name] = code;
    const m = await compareWithOriginal(code, `${name}-vs-original`);
    return `IoU ${m.iou.toFixed(4)}, colour Δ ${m.colorDiff.toFixed(2)}`;
  });
}

await check('look codes from the studio are reproduced exactly by the original BuddyRevival app', async () => {
  for (const [name, code] of Object.entries(comboCodes)) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 700 } });
    const page = await context.newPage();
    const errors = watch(page);
    await page.goto(`${root.url}web/?buddy=${encodeURIComponent(code)}`);
    await page.waitForSelector('#wardrobe button', { timeout: 60_000 });
    await page.waitForFunction(() => document.getElementById('code').value.length > 20);
    const originalCode = await page.inputValue('#code');
    assert.equal(originalCode, code, `${name}: original app shows the same code`);
    if (name === Object.keys(comboCodes)[0]) await page.screenshot({ path: resultPath('customize', `${name}-original-app.png`) });
    assert.deepEqual(errors, []);
    await context.close();
  }
  return `${Object.keys(comboCodes).length} codes identical`;
});

await check('a look made with the original app\'s Random button loads identically in the studio', async () => {
  const context = await browser.newContext({ viewport: { width: 1100, height: 700 } });
  const page = await context.newPage();
  await page.goto(`${root.url}web/`);
  await page.waitForSelector('#wardrobe button', { timeout: 60_000 });
  const codes = [];
  for (let i = 0; i < 3; i++) {
    const previous = await page.inputValue('#code');
    await page.click('#randomize');
    await page.waitForFunction(p => document.getElementById('code').value !== p, previous);
    codes.push(await page.inputValue('#code'));
  }
  await context.close();
  for (const code of codes) {
    const studioPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await studioPage.goto(`${studio.url}?buddy=${encodeURIComponent(code)}`);
    await studioReady(studioPage);
    assert.equal(await studioPage.evaluate(() => window.__studio.debug.code()), code, 'studio produces the same code');
    await studioPage.close();
    await compareWithOriginal(code, null);
  }
  return `${codes.length} random original looks`;
});

await check('no console or network errors', async () => assert.deepEqual(problems.flat(), []));

await check('phone: panel usable (open a picker, choose, reset)', async () => {
  const context = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await context.newPage();
  const errors = watch(page);
  await page.goto(studio.url);
  await studioReady(page);
  await page.locator('.option[data-option="Hair"] .picker').click();
  const before = await page.evaluate(() => window.__studio.debug.version());
  await page.locator('.choices[data-selector="hrt"] [role=option]').nth(25).click();
  await page.waitForFunction(v => window.__studio.debug.version() > v, before);
  assert.equal((await page.evaluate(() => window.__studio.debug.look())).hrt, 25);
  await nextFrames(page, 10);
  await page.screenshot({ path: resultPath('customize', 'phone.png') });
  await page.getByRole('button', { name: 'Reset Hair', exact: true }).click();
  await page.waitForFunction(() => window.__studio.debug.look().hrt !== 25);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(overflow <= 0, `no horizontal scroll (${overflow}px)`);
  const target = await page.locator('.reset').first().boundingBox();
  assert.ok(target.height >= 30, `touch target height ${target.height}px`);
  assert.deepEqual(errors, []);
  await context.close();
});

await check('tablet: panel and viewport side by side', async () => {
  const page = await browser.newPage({ viewport: { width: 820, height: 1180 } });
  await page.goto(studio.url);
  await studioReady(page);
  const panel = await page.locator('.panel').boundingBox();
  const view = await page.locator('.viewport').boundingBox();
  assert.ok(view.width > panel.width, `viewport ${view.width}px wider than panel ${panel.width}px`);
  await page.locator('.option[data-option="Shirt"] .picker').first().click();
  await page.screenshot({ path: resultPath('customize', 'tablet.png') });
  await page.close();
});

await browser.close();
studio.server.close();
root.server.close();
finish();
