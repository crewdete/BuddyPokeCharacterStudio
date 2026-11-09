// M1 renderer comparison: the studio's WebGL character vs the ORIGINAL Canvas 2D renderer.
// Both render the bind pose with the original Camera_Long2 at 692x520 on a transparent background
// (studio: ?compare=1, original: fixtures/original-bind.html). For every look both pipelines wear
// the same look code; the test asserts they agree on the code, compares silhouettes and colours,
// and checks that bones and rigid attachments match the engine's transforms exactly.
// Looks: default, the original "friend" look, every hairstyle (caps included), every skirt, and
// seeded random looks. Side-by-side sheets (original | studio | diff) go to test-results/compare/.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { checklist, compareImages, launch, nextFrames, repoRoot, resultPath, serve, studioDist, studioReady, watch } from './lib.mjs';

const THRESHOLDS = { iou: 0.95, bboxDelta: 4, colorDiff: 14 };
// The look BuddyRevival's main.js gives the friend buddy (boots, long hair, other colours).
const FRIEND_LOOK = { hdc: 9, bdc: 9, hrt: 25, hrc: 180, eyc: 13, shc: 120, sl1t: 0, sl2t: 0, plc: 1, sst: 5, ssc: 2 };

const studio = await serve(studioDist);
const root = await serve(repoRoot);
const browser = await launch();
const { check, finish } = checklist();

const ctx = { viewport: { width: 692, height: 520 } };
const studioPage = await browser.newPage(ctx);
const originalPage = await browser.newPage(ctx);
const problems = [...[studioPage, originalPage].map(watch)];
await studioPage.goto(`${studio.url}?compare=1`);
await studioReady(studioPage);
await originalPage.goto(`${root.url}studio/tests/e2e/fixtures/original-bind.html`);
await originalPage.waitForFunction(() => window.__original?.ready, null, { timeout: 60_000 });

const sizes = await studioPage.evaluate(() => window.__studio.debug.selectorSizes());
const looks = [
  ['default', { code: null }],
  ['friend', { look: FRIEND_LOOK }],
  ...Array.from({ length: sizes.hrt }, (_, i) => [`hair-${String(i).padStart(2, '0')}`, { look: { hrt: i } }]),
  ...Array.from({ length: sizes.ski }, (_, i) => [`skirt-${i}`, { look: { ski: i } }]),
  ...[1, 2, 3, 4, 5, 6, 7, 8].map(seed => [`random-${seed}`, { seed }]),
];
const SAVE = new Set(['default', 'friend', 'hair-00', 'hair-03', 'hair-29', 'skirt-1', 'skirt-2', 'random-1', 'random-2', 'random-3']);
const rows = [];

for (const [name, spec] of looks) {
  await check(`look ${name}`, async () => {
    const code = await studioPage.evaluate(async spec => {
      const d = window.__studio.debug;
      if (spec.seed) return d.randomLook(spec.seed);
      if (spec.look) return d.wearLook(spec.look);
      return d.wearCode(spec.code);
    }, spec);
    const originalCode = await originalPage.evaluate(code => window.__original.render(code), code);
    assert.equal(originalCode, code, 'both pipelines wear the same look');
    await nextFrames(studioPage);
    const [a, b] = await Promise.all([
      originalPage.locator('canvas').screenshot({ omitBackground: true }),
      studioPage.locator('canvas').screenshot({ omitBackground: true }),
    ]);
    const m = await compareImages(studioPage, a.toString('base64'), b.toString('base64'));
    const rig = await studioPage.evaluate(() => window.__studio.debug.rigErrors());
    const parts = await studioPage.evaluate(() => window.__studio.debug.parts());
    rows.push({ name, iou: m.iou, bboxDelta: m.bboxDelta, colorDiff: m.colorDiff, shadow: m.softAlphaRatio, parts: parts.map(p => p.name).join(' ') });
    if (SAVE.has(name) || m.iou < THRESHOLDS.iou) writeFileSync(resultPath('compare', `${name}.png`), Buffer.from(m.sheet, 'base64'));
    assert.ok(rig.bones < 1e-3 && rig.rigid < 1e-3, `rig error bones=${rig.bones} rigid=${rig.rigid}`);
    assert.ok(parts.some(p => p.name === 'Body') && parts.some(p => p.name === 'Head'), 'body and head present');
    assert.ok(parts.every(p => p.texture && p.triangles > 0), 'every visible part has triangles and a texture');
    assert.ok(m.iou >= THRESHOLDS.iou, `silhouette IoU ${m.iou.toFixed(4)} < ${THRESHOLDS.iou}`);
    assert.ok(m.bboxDelta <= THRESHOLDS.bboxDelta, `bounding box off by ${m.bboxDelta}px`);
    assert.ok(m.softAlphaRatio > 0.7 && m.softAlphaRatio < 1.3, `drop shadow opacity ratio ${m.softAlphaRatio.toFixed(2)} (studio / original)`);
    assert.ok(m.colorDiff <= THRESHOLDS.colorDiff, `mean colour difference ${m.colorDiff.toFixed(2)} > ${THRESHOLDS.colorDiff}`);
    return `IoU ${m.iou.toFixed(4)}, bbox Δ${m.bboxDelta}px, colour Δ${m.colorDiff.toFixed(2)}, shadow ${m.softAlphaRatio.toFixed(2)}`;
  });
}

await check('no console or network errors during comparisons', async () => assert.deepEqual(problems.flat(), []));

writeFileSync(resultPath('compare', 'metrics.json'), JSON.stringify(rows, null, 2));
const worst = key => rows.reduce((w, r) => (key === 'iou' ? Math.min(w, r[key]) : Math.max(w, r[key])), key === 'iou' ? 1 : 0);
console.log(`looks: ${rows.length}, worst IoU ${worst('iou').toFixed(4)}, worst bbox Δ ${worst('bboxDelta')}px, worst colour Δ ${worst('colorDiff').toFixed(2)}`);
await browser.close();
studio.server.close();
root.server.close();
finish();
