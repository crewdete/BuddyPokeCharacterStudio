// Smoke test: the studio loads the original data through the original engine and shows the character
// in a WebGL viewport without errors; the original BuddyRevival app (web/) still works.
import assert from 'node:assert/strict';
import { checklist, launch, nextFrames, repoRoot, resultPath, serve, studioDist, studioReady, watch } from './lib.mjs';

const studio = await serve(studioDist);
const original = await serve(repoRoot);
const browser = await launch();
const { check, finish } = checklist();

await check('studio loads original data and renders the character', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const problems = watch(page);
  await page.goto(studio.url);
  await studioReady(page);
  await nextFrames(page, 10);
  const state = await page.evaluate(() => window.__studio);
  assert.deepEqual(
    { bones: state.info.bones, meshes: state.info.meshes, skinned: state.info.skinnedMeshes, animations: state.info.animations, selectors: state.info.selectors },
    { bones: 29, meshes: 58, skinned: 32, animations: 94, selectors: 76 },
  );
  const parts = await page.evaluate(() => window.__studio.debug.parts());
  assert.deepEqual(parts.map(p => p.name).sort(), ['Body', 'Hair_Simple_ScruffySide', 'Head']);
  const canvas = await page.evaluate(() => {
    const c = document.querySelector('.viewport canvas');
    return { webgl: !!(c.getContext('webgl2') ?? c.getContext('webgl')), width: c.clientWidth, height: c.clientHeight };
  });
  assert.ok(canvas.webgl && canvas.width > 600 && canvas.height > 500, `WebGL viewport is the main area (${canvas.width}x${canvas.height})`);
  await page.screenshot({ path: resultPath('studio-desktop.png') });
  assert.deepEqual(problems, []);
  await page.close();
});

await check('original BuddyRevival app (web/) still works', async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  const problems = watch(page);
  await page.goto(`${original.url}web/`);
  await page.waitForSelector('#wardrobe button', { timeout: 60_000 });
  await page.waitForTimeout(1000);
  const painted = await page.evaluate(() => {
    const c = document.getElementById('stage');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n / (c.width * c.height);
  });
  await page.screenshot({ path: resultPath('original-web.png') });
  assert.ok(painted > 0.02, `buddy painted on the original canvas (${(painted * 100).toFixed(1)}% of pixels)`);
  assert.deepEqual(problems, []);
  await page.close();
});

await browser.close();
studio.server.close();
original.server.close();
finish();
