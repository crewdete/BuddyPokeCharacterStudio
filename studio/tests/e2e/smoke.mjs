// End-to-end smoke test (run after `vite build`; `npm run test:e2e` does both).
//  1. Serves studio/dist and checks, in Chromium, that the studio loads the original data
//     through the original engine, shows a WebGL canvas and logs no errors (desktop + phone).
//  2. Serves the repository root and checks that the original BuddyRevival app (web/) still
//     loads and paints its Canvas 2D buddy, i.e. the studio did not break it.
// Screenshots go to studio/test-results/.
import assert from 'node:assert/strict';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

const here = fileURLToPath(new URL('.', import.meta.url));
const studioDist = resolve(here, '../../dist');
const repoRoot = resolve(here, '../../..');
const out = resolve(here, '../../test-results');
mkdirSync(out, { recursive: true });

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.xml': 'application/xml', '.png': 'image/png', '.svg': 'image/svg+xml', '.bin': 'application/octet-stream', '.wasm': 'application/wasm',
};

function serve(root) {
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    let file = join(root, path);
    if (!file.startsWith(root)) return res.writeHead(403).end();
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise(ok => server.listen(0, '127.0.0.1', () => ok({ server, url: `http://127.0.0.1:${server.address().port}/` })));
}

const watch = page => {
  const problems = [];
  page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
  page.on('console', m => m.type() === 'error' && problems.push(`console: ${m.text()}`));
  page.on('requestfailed', r => problems.push(`requestfailed: ${r.url()}`));
  page.on('response', r => r.status() >= 400 && problems.push(`http ${r.status()}: ${r.url()}`));
  return problems;
};

assert.ok(existsSync(join(studioDist, 'index.html')), 'studio/dist is missing: run `npm run build` first');
const studio = await serve(studioDist);
const original = await serve(repoRoot);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push(`PASS ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error.message}`);
  }
};

async function studioPage(contextOptions, shot) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const problems = watch(page);
  await page.goto(studio.url);
  await page.waitForFunction(() => window.__studio && window.__studio.status !== 'loading', null, { timeout: 60_000 });
  const state = await page.evaluate(() => window.__studio);
  const canvas = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    if (!c) return null;
    const gl = c.getContext('webgl2') ?? c.getContext('webgl');
    return { width: c.clientWidth, height: c.clientHeight, webgl: !!gl, overflowX: document.documentElement.scrollWidth - innerWidth };
  });
  await page.screenshot({ path: join(out, shot) });
  await context.close();
  return { state, canvas, problems };
}

await check('studio (desktop) loads original data via the original engine', async () => {
  const { state, canvas, problems } = await studioPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 }, 'studio-desktop.png');
  assert.equal(state.status, 'ready', state.message);
  assert.deepEqual(
    { bones: state.info.bones, meshes: state.info.meshes, skinned: state.info.skinnedMeshes, animations: state.info.animations, selectors: state.info.selectors },
    { bones: 29, meshes: 58, skinned: 32, animations: 94, selectors: 76 },
  );
  assert.ok(state.info.lookCode.length > 40, 'look code produced');
  assert.ok(canvas?.webgl, 'WebGL canvas present');
  assert.ok(canvas.width > 600 && canvas.height > 500, `viewport is the main area (${canvas.width}x${canvas.height})`);
  assert.deepEqual(problems, []);
});

await check('studio (phone) responsive layout', async () => {
  const { state, canvas, problems } = await studioPage({ ...devices['iPhone 13'] }, 'studio-phone.png');
  assert.equal(state.status, 'ready', state.message);
  assert.ok(canvas?.webgl && canvas.width <= 400 && canvas.height > 250, `viewport ${canvas?.width}x${canvas?.height}`);
  assert.ok(canvas.overflowX <= 0, `no horizontal page scroll (overflow ${canvas.overflowX}px)`);
  assert.deepEqual(problems, []);
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
  await page.screenshot({ path: join(out, 'original-web.png') });
  assert.ok(painted > 0.02, `buddy painted on the original canvas (${(painted * 100).toFixed(1)}% of pixels)`);
  assert.deepEqual(problems, []);
  await page.close();
});

await browser.close();
studio.server.close();
original.server.close();
console.log(results.join('\n'));
if (results.some(r => r.startsWith('FAIL'))) process.exit(1);
console.log('ok');
