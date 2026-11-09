// Shared helpers for the end-to-end tests.
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = fileURLToPath(new URL('.', import.meta.url));
export const studioDist = resolve(here, '../../dist');
export const repoRoot = resolve(here, '../../..');
export const resultsDir = resolve(here, '../../test-results');
mkdirSync(resultsDir, { recursive: true });

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.xml': 'application/xml', '.png': 'image/png', '.svg': 'image/svg+xml', '.bin': 'application/octet-stream', '.wasm': 'application/wasm',
};

/** Minimal static file server on a free port. */
export function serve(root) {
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

/** Collects page errors, console errors, failed requests and HTTP errors. */
export function watch(page) {
  const problems = [];
  page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
  page.on('console', m => m.type() === 'error' && problems.push(`console: ${m.text()}`));
  page.on('requestfailed', r => problems.push(`requestfailed: ${r.url()}`));
  page.on('response', r => r.status() >= 400 && problems.push(`http ${r.status()}: ${r.url()}`));
  return problems;
}

export const launch = () => chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

export async function studioReady(page) {
  await page.waitForFunction(() => window.__studio && window.__studio.status !== 'loading', null, { timeout: 60_000 });
  const state = await page.evaluate(() => ({ status: window.__studio.status, message: window.__studio.message }));
  if (state.status !== 'ready') throw new Error(`studio failed to load: ${state.message}`);
}

/** Wait until the R3F frame loop has drawn the current state. */
export const nextFrames = (page, n = 3) =>
  page.evaluate(n => new Promise(ok => { const step = k => (k ? requestAnimationFrame(() => step(k - 1)) : ok()); step(n); }), n);

/** Collects check results and prints them. */
export function checklist() {
  const results = [];
  return {
    async check(name, fn) {
      try {
        const note = await fn();
        results.push(`PASS ${name}${note ? ` — ${note}` : ''}`);
      } catch (error) {
        results.push(`FAIL ${name}: ${error.message}`);
      }
    },
    finish() {
      console.log(results.join('\n'));
      if (results.some(r => r.startsWith('FAIL'))) process.exit(1);
      console.log('ok');
    },
  };
}

/**
 * Compare two transparent PNGs (base64) in the browser: silhouette IoU (alpha >= 128), bounding-box
 * offset, and mean RGB difference over pixels covered in both. Returns a side-by-side + diff PNG.
 */
export async function compareImages(page, aBase64, bBase64) {
  return page.evaluate(async ([a, b]) => {
    const load = src => new Promise(ok => { const i = new Image(); i.onload = () => ok(i); i.src = `data:image/png;base64,${src}`; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const w = ia.width, h = ia.height;
    const pixels = img => { const c = new OffscreenCanvas(w, h); const g = c.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, w, h).data; };
    const pa = pixels(ia), pb = pixels(ib);
    let inter = 0, union = 0, colorSum = 0, softA = 0, softB = 0;
    const box = () => ({ x0: w, y0: h, x1: -1, y1: -1 });
    const ba = box(), bb = box();
    const grow = (bx, x, y) => { bx.x0 = Math.min(bx.x0, x); bx.y0 = Math.min(bx.y0, y); bx.x1 = Math.max(bx.x1, x); bx.y1 = Math.max(bx.y1, y); };
    const diff = new ImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const ina = pa[i + 3] >= 128, inb = pb[i + 3] >= 128;
      // Semi-transparent coverage (the original drop shadow is black at <= 25% opacity).
      if (pa[i + 3] > 0 && pa[i + 3] < 128) softA += pa[i + 3];
      if (pb[i + 3] > 0 && pb[i + 3] < 128) softB += pb[i + 3];
      if (ina) grow(ba, x, y);
      if (inb) grow(bb, x, y);
      if (ina || inb) union++;
      if (ina && inb) {
        inter++;
        const d = (Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2])) / 3;
        colorSum += d;
        const v = Math.min(255, d * 3);
        diff.data.set([v, v, v, 255], i);
      } else if (ina || inb) {
        diff.data.set(ina ? [255, 60, 60, 255] : [60, 160, 255, 255], i); // red: original only, blue: studio only
      } else diff.data.set([0, 0, 0, 255], i);
    }
    const sheet = new OffscreenCanvas(w * 3, h);
    const g = sheet.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w * 2, h);
    g.drawImage(ia, 0, 0);
    g.drawImage(ib, w, 0);
    g.putImageData(diff, w * 2, 0);
    const blob = await sheet.convertToBlob({ type: 'image/png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return {
      iou: inter / union,
      bboxDelta: Math.max(Math.abs(ba.x0 - bb.x0), Math.abs(ba.y0 - bb.y0), Math.abs(ba.x1 - bb.x1), Math.abs(ba.y1 - bb.y1)),
      colorDiff: colorSum / Math.max(1, inter),
      softAlphaRatio: softB / Math.max(1, softA),
      sheet: btoa(bin),
    };
  }, [aBase64, bBase64]);
}

export const resultPath = (...parts) => {
  const file = join(resultsDir, ...parts);
  mkdirSync(resolve(file, '..'), { recursive: true });
  return file;
};
