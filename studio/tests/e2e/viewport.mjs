// M1 viewport behaviour with real mouse/wheel/keyboard input: framing, orbit, zoom, reset,
// perspective <-> orthographic, keyboard shortcuts, phone layout. Screenshots to test-results/viewport/.
import assert from 'node:assert/strict';
import { devices } from 'playwright';
import { checklist, launch, nextFrames, resultPath, serve, studioDist, studioReady, watch } from './lib.mjs';

const studio = await serve(studioDist);
const browser = await launch();
const { check, finish } = checklist();

const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
const problems = watch(page);
await page.goto(studio.url);
await studioReady(page);
const view = () => page.evaluate(() => window.__studio.debug.view());
const settle = async () => {
  await nextFrames(page, 45); // let orbit damping come to rest
};
const canvasBox = await page.locator('.viewport canvas').boundingBox();
const center = { x: canvasBox.x + canvasBox.width / 2, y: canvasBox.y + canvasBox.height / 2 };
const shot = name => page.screenshot({ path: resultPath('viewport', `${name}.png`) });

const assertFramed = (v, label) => {
  const { minX, maxX, minY, maxY } = v.ndc;
  assert.ok(minX > -0.98 && maxX < 0.98 && minY > -0.98 && maxY < 0.98, `${label}: character fully visible (ndc ${JSON.stringify(v.ndc)})`);
};
const azimuth = v => Math.atan2(v.position[0] - v.target[0], v.position[2] - v.target[2]) * (180 / Math.PI);

await settle();
const initial = await view();

await check('initial view: perspective, character fully visible and centred', async () => {
  assert.equal(initial.type, 'perspective');
  assertFramed(initial, 'initial');
  const { minX, maxX, minY, maxY } = initial.ndc;
  assert.ok(Math.abs((minX + maxX) / 2) < 0.05, `horizontally centred (${((minX + maxX) / 2).toFixed(3)})`);
  assert.ok(Math.abs((minY + maxY) / 2) < 0.08, `vertically centred (${((minY + maxY) / 2).toFixed(3)})`);
  const fill = (maxY - minY) / 2;
  assert.ok(fill > 0.6 && fill < 0.95, `character fills ${Math.round(fill * 100)}% of the height`);
  await shot('01-initial-perspective');
  return `fills ${Math.round(fill * 100)}% of viewport height`;
});

await check('orbit: dragging rotates around the character at constant distance', async () => {
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 260, center.y, { steps: 12 });
  await page.mouse.up();
  await settle();
  const v = await view();
  const turned = Math.abs(azimuth(v) - azimuth(initial));
  assert.ok(turned > 30, `azimuth changed by ${turned.toFixed(1)}°`);
  assert.ok(Math.abs(v.distance - initial.distance) / initial.distance < 0.01, 'distance unchanged');
  assert.deepEqual(v.target.map(n => n.toFixed(2)), initial.target.map(n => n.toFixed(2)), 'target unchanged');
  assertFramed(v, 'orbited');
  await shot('02-orbit');
  return `turned ${turned.toFixed(0)}°`;
});

await check('zoom: wheel moves the camera closer', async () => {
  const before = await view();
  await page.mouse.move(center.x, center.y);
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -200);
  await settle();
  const v = await view();
  assert.ok(v.distance < before.distance * 0.8, `distance ${before.distance.toFixed(0)} -> ${v.distance.toFixed(0)}`);
  await shot('03-zoomed');
  return `distance ${before.distance.toFixed(0)} → ${v.distance.toFixed(0)}`;
});

await check('reset view button restores the initial framing', async () => {
  await page.getByRole('button', { name: 'Reset view' }).click();
  await settle();
  const v = await view();
  const offset = Math.hypot(...v.position.map((n, i) => n - initial.position[i]));
  assert.ok(offset < 0.5, `camera back at start (off by ${offset.toFixed(3)})`);
  assertFramed(v, 'reset');
});

let perspectiveHeight = 0;
await check('orthographic: same framing, character fully visible', async () => {
  perspectiveHeight = initial.ndc.maxY - initial.ndc.minY;
  await page.getByRole('button', { name: 'Ortho' }).click();
  await settle();
  const v = await view();
  assert.equal(v.type, 'orthographic');
  assertFramed(v, 'ortho');
  const height = v.ndc.maxY - v.ndc.minY;
  assert.ok(Math.abs(height - perspectiveHeight) / perspectiveHeight < 0.15, `apparent size kept (${height.toFixed(3)} vs ${perspectiveHeight.toFixed(3)})`);
  assert.ok(Math.abs((v.ndc.minX + v.ndc.maxX) / 2) < 0.05, 'centred');
  await shot('04-orthographic');
  return `apparent height ${height.toFixed(3)} vs perspective ${perspectiveHeight.toFixed(3)}`;
});

await check('orthographic orbit and zoom', async () => {
  const before = await view();
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x - 200, center.y - 60, { steps: 10 });
  await page.mouse.up();
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -200);
  await settle();
  const v = await view();
  assert.equal(v.type, 'orthographic');
  assert.ok(Math.abs(azimuth(v) - azimuth(before)) > 20, 'rotated');
  assert.ok(v.zoom > before.zoom * 1.2, `zoom ${before.zoom.toFixed(2)} -> ${v.zoom.toFixed(2)}`);
  await shot('05-orthographic-orbit-zoom');
});

await check('switching back to perspective keeps orientation; keyboard 5 and Home work', async () => {
  const ortho = await view();
  await page.keyboard.press('5');
  await settle();
  const v = await view();
  assert.equal(v.type, 'perspective');
  assert.ok(Math.abs(azimuth(v) - azimuth(ortho)) < 1, 'same viewing direction');
  await page.keyboard.press('Home');
  await settle();
  const reset = await view();
  assert.ok(Math.hypot(...reset.position.map((n, i) => n - initial.position[i])) < 0.5, 'Home resets the camera');
});

await check('side and back views render the whole character', async () => {
  for (const [name, dx] of [['06-side', 160], ['07-back', 160]]) {
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.move(center.x + dx, center.y, { steps: 8 });
    await page.mouse.up();
    await settle();
    assertFramed(await view(), name);
    await shot(name);
  }
  await page.keyboard.press('Home');
  await settle();
});

await check('grid toggle (button and G key)', async () => {
  await page.getByRole('button', { name: 'Grid' }).click();
  assert.equal(await page.getByRole('button', { name: 'Grid' }).getAttribute('aria-pressed'), 'false');
  await page.keyboard.press('g');
  assert.equal(await page.getByRole('button', { name: 'Grid' }).getAttribute('aria-pressed'), 'true');
});

await check('no console or network errors (desktop)', async () => assert.deepEqual(problems, []));

await check('phone: character framed in the smaller viewport, no horizontal scroll', async () => {
  const context = await browser.newContext({ ...devices['iPhone 13'] });
  const phone = await context.newPage();
  const phoneProblems = watch(phone);
  await phone.goto(studio.url);
  await studioReady(phone);
  await nextFrames(phone, 30);
  const v = await phone.evaluate(() => window.__studio.debug.view());
  assertFramed(v, 'phone');
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(overflow <= 0, `overflow ${overflow}px`);
  await phone.screenshot({ path: resultPath('viewport', '08-phone.png') });
  assert.deepEqual(phoneProblems, []);
  await context.close();
});

await browser.close();
studio.server.close();
finish();
