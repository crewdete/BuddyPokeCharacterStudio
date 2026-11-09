// M3A-1 playback core vs the ORIGINAL BuddyRevival renderer and engine.
//  - All 94 clips, 5 frames each (first, middle, last, 2 seeded random) = 470 samples: the Studio frame
//    (player.seek) against a FRESH original buddy at the same clip/frame (no state carried between clips).
//    Compared: silhouette IoU, bbox, colour, drop-shadow opacity, engine world position of every named
//    node (bones, rigid parts, props, shadow), Three-vs-engine attachment error, face frame, props.
//  - Every frame of every prop clip: prop visibility identical to the original.
//  - Pose bleed, Stop -> exact rest pose, bone lengths, timing/speed/loop in real time, redraw on demand,
//    customization during playback. Screenshots: test-results/animation/.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { checklist, compareImages, launch, nextFrames, repoRoot, resultPath, serve, studioDist, studioReady, watch } from './lib.mjs';

const T = { iou: 0.95, bboxDelta: 4, colorDiff: 14, world: 1e-6 };
const studio = await serve(studioDist);
const root = await serve(repoRoot);
const browser = await launch();
const { check, finish } = checklist();
const problems = [];

const compare = await browser.newPage({ viewport: { width: 692, height: 520 } });
const original = await browser.newPage({ viewport: { width: 692, height: 520 } });
problems.push(watch(compare), watch(original));
await compare.goto(`${studio.url}?compare=1`);
await studioReady(compare);
await original.goto(`${root.url}studio/tests/e2e/fixtures/original-bind.html`);
await original.waitForFunction(() => window.__original?.ready, null, { timeout: 60_000 });

const anim = (page, fn, arg) => page.evaluate(([fn, arg]) => window.__studio.debug.anim[fn](arg), [fn, arg]);
const dbg = (page, fn, arg) => page.evaluate(([fn, arg]) => window.__studio.debug[fn](arg), [fn, arg]);
const maxWorldDiff = (a, b) => {
  let worst = 0;
  for (const [name, p] of Object.entries(b)) {
    const q = a[name];
    if (!q) throw new Error(`node ${name} missing in studio`);
    worst = Math.max(worst, ...p.map((v, i) => Math.abs(v - q[i])));
  }
  return worst;
};
function seeded(seed) {
  return () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

/** Studio (compare page) frame + original fresh-buddy frame -> metrics. */
async function sample(clip, frame, { sheet } = {}) {
  await anim(compare, 'seek', frame);
  const ref = await original.evaluate(f => window.__original.show(f), frame);
  await nextFrames(compare, 3);
  const [a, b] = await Promise.all([
    original.locator('canvas').screenshot({ omitBackground: true }),
    compare.locator('canvas').screenshot({ omitBackground: true }),
  ]);
  const m = await compareImages(compare, a.toString('base64'), b.toString('base64'));
  const studioState = await compare.evaluate(() => {
    const d = window.__studio.debug;
    return { world: d.anim.worldPositions(), head: d.anim.headFrame(), props: d.anim.props(), rig: d.rigErrors(), state: d.anim.state() };
  });
  if (sheet) writeFileSync(resultPath('animation', `${sheet}.png`), Buffer.from(m.sheet, 'base64'));
  return { m, ref, s: studioState, world: maxWorldDiff(studioState.world, ref.world) };
}

const clips = await anim(compare, 'clips');
const code = await dbg(compare, 'code');
const rows = [];
const SHEETS = new Set(['mood_swordTwirl@40', 'jamA1@40', 'jamA2@40', 'rose1@80', 'mood_lookingForLove@45', 'mood_flying@50', 'hug1@70', 'mood_sleeping@40']);

await check('94 clips available', async () => assert.equal(clips.length, 94));

for (const { name, frameCount } of clips) {
  await check(`clip ${name} (${frameCount} frames)`, async () => {
    assert.equal(await original.evaluate(([c, n]) => window.__original.prepare(c, n), [code, name]), code);
    await anim(compare, 'select', name); // previous clip left the scene posed: select must not bleed
    const random = seeded(name.length * 7919 + frameCount);
    const frames = [...new Set([0, Math.floor(frameCount / 2), frameCount - 1, Math.floor(random() * frameCount), Math.floor(random() * frameCount)])];
    while (frames.length < 5) frames.push((frames.at(-1) + 1) % frameCount);
    const notes = [];
    for (const frame of frames) {
      const key = `${name}@${frame}`;
      const extra = [...SHEETS].find(s => s.startsWith(`${name}@`));
      const { m, ref, s, world } = await sample(name, frame, { sheet: extra && frame === frames[1] ? key : undefined });
      rows.push({ clip: name, frame, iou: m.iou, bboxDelta: m.bboxDelta, colorDiff: m.colorDiff, shadow: m.softAlphaRatio, world, rig: Math.max(s.rig.bones, s.rig.rigid), head: [s.head, ref.headFrame] });
      assert.equal(s.state.frame, frame, `${key}: studio at frame`);
      assert.ok(world <= T.world, `${key}: engine world positions differ from the original by ${world}`);
      assert.ok(s.rig.bones < 1e-3 && s.rig.rigid < 1e-3, `${key}: Three bones/rigid parts off the engine (${s.rig.bones}, ${s.rig.rigid})`);
      assert.equal(s.head, ref.headFrame, `${key}: face frame`);
      assert.deepEqual(s.props.engine, ref.props, `${key}: engine props`);
      assert.deepEqual(s.props.three, ref.props, `${key}: rendered props`);
      assert.ok(m.iou >= T.iou, `${key}: IoU ${m.iou.toFixed(4)}`);
      assert.ok(m.bboxDelta <= T.bboxDelta, `${key}: bbox Δ ${m.bboxDelta}px`);
      assert.ok(m.colorDiff <= T.colorDiff, `${key}: colour Δ ${m.colorDiff.toFixed(2)}`);
      if (m.softAlphaRatio > 0) assert.ok(m.softAlphaRatio > 0.7 && m.softAlphaRatio < 1.3, `${key}: shadow ratio ${m.softAlphaRatio.toFixed(2)}`);
      notes.push(`${frame}:${m.iou.toFixed(3)}`);
    }
    return notes.join(' ');
  });
}

await check('470 sampled frames: summary', async () => {
  writeFileSync(resultPath('animation', 'metrics.json'), JSON.stringify(rows, null, 2));
  const worst = (k, min) => rows.reduce((w, r) => (min ? Math.min(w, r[k]) : Math.max(w, r[k])), min ? 1 : 0);
  assert.equal(rows.length, 470);
  return `${rows.length} frames; worst IoU ${worst('iou', true).toFixed(4)}, worst bbox Δ ${worst('bboxDelta')}px, worst colour Δ ${worst('colorDiff').toFixed(2)}, shadow ratio ${Math.min(...rows.filter(r => r.shadow > 0).map(r => r.shadow)).toFixed(2)}–${worst('shadow').toFixed(2)}, worst world Δ ${worst('world').toExponential(1)}, worst attachment ${worst('rig').toExponential(1)}`;
});

const PROP_CLIPS = { mood_lookingForLove: 'Rose', mood_swordTwirl: 'Sword', jamB1: 'Strat', jamB2: 'Strat', jamA1: 'Strat', jamA2: 'Mic', rose1: 'Rose', rose2: 'Rose', swordA1: 'Sword', swordA2: 'Sword' };
for (const [name, prop] of Object.entries(PROP_CLIPS)) {
  await check(`props: ${name} (${prop}) visibility identical to the original on every frame`, async () => {
    await original.evaluate(([c, n]) => window.__original.prepare(c, n), [code, name]);
    await anim(compare, 'select', name);
    const { frameCount } = clips.find(c => c.name === name);
    let shown = 0;
    for (let f = 0; f < frameCount; f++) {
      await anim(compare, 'seek', f);
      const ref = await original.evaluate(f => window.__original.show(f), f);
      const props = await anim(compare, 'props');
      assert.deepEqual(props.three, ref.props, `${name}@${f}`);
      if (ref.props.includes(prop)) shown++;
    }
    assert.ok(shown > 0, `${prop} appears`);
    return `${prop} on ${shown}/${frameCount} frames`;
  });
}

// ------------------------------------------------------------------------- editor page (real viewport)
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
problems.push(watch(page));
await page.goto(studio.url);
await studioReady(page);
const restLocals = await anim(page, 'localMatrices');
const restLengths = await anim(page, 'boneLengths');
const frames = () => page.evaluate(() => window.__studioFrames.viewport);

await check('Stop restores the exact original rest pose (bit-for-bit), hides props, renders like the original rest', async () => {
  for (const name of ['mood_swordTwirl', 'jamA1', 'hug1', 'mood_flying']) {
    await anim(page, 'select', name);
    await anim(page, 'seek', 40);
    await anim(page, 'stop');
    assert.deepEqual(await anim(page, 'localMatrices'), restLocals, `${name}: local matrices`);
    assert.deepEqual((await anim(page, 'props')).three, [], `${name}: props hidden`);
    assert.equal((await anim(page, 'state')).state, 'rest');
  }
  const lengths = await anim(page, 'boneLengths');
  for (const [bone, l] of Object.entries(restLengths)) assert.equal(lengths[bone], l, bone);
  await anim(compare, 'select', 'mood_swordTwirl');
  await anim(compare, 'seek', 40);
  await anim(compare, 'stop');
  await original.evaluate(c => window.__original.render(c), code);
  await nextFrames(compare, 3);
  const [a, b] = await Promise.all([original.locator('canvas').screenshot({ omitBackground: true }), compare.locator('canvas').screenshot({ omitBackground: true })]);
  const m = await compareImages(compare, a.toString('base64'), b.toString('base64'));
  assert.ok(m.iou >= T.iou && m.colorDiff <= T.colorDiff, `rest render IoU ${m.iou.toFixed(4)} colour ${m.colorDiff.toFixed(2)}`);
  return `rest render after Stop: IoU ${m.iou.toFixed(4)}`;
});

await check('no pose bleed when switching clips (hug1@50 -> holdHands1@0 equals a fresh original buddy)', async () => {
  await original.evaluate(([c, n]) => window.__original.prepare(c, n), [code, 'holdHands1']);
  const ref = await original.evaluate(() => window.__original.show(0));
  await anim(compare, 'select', 'hug1');
  await anim(compare, 'seek', 50);
  await anim(compare, 'select', 'holdHands1');
  await anim(compare, 'seek', 0);
  assert.ok(maxWorldDiff(await anim(compare, 'worldPositions'), ref.world) <= T.world);
});

await check('bone lengths: constant within every clip in the Three skeleton', async () => {
  let worst = 0;
  for (const { name, frameCount } of clips.filter((_, i) => i % 4 === 0)) {
    await anim(page, 'select', name);
    const first = await anim(page, 'boneLengths');
    for (const f of [Math.floor(frameCount / 2), frameCount - 1]) {
      await anim(page, 'seek', f);
      const now = await anim(page, 'boneLengths');
      for (const bone of Object.keys(first)) worst = Math.max(worst, Math.abs(now[bone] - first[bone]));
    }
  }
  assert.ok(worst < 1e-4, `worst ${worst}`);
  return `worst change ${worst.toExponential(1)} (24 clips × 3 frames)`;
});

await check('real-time playback: 30 fps at 1x, 2x speed, 0.5x speed', async () => {
  const measure = async speed => {
    await anim(page, 'select', 'pose_joinNow'); // 341 frames: no wrap during the measurement
    await anim(page, 'setSpeed', speed);
    await anim(page, 'play');
    await page.waitForTimeout(400);
    const a = await page.evaluate(() => ({ f: window.__studio.debug.anim.state().frame, t: performance.now() }));
    await page.waitForTimeout(2000);
    const b = await page.evaluate(() => ({ f: window.__studio.debug.anim.state().frame, t: performance.now() }));
    await anim(page, 'pause');
    return (b.f - a.f) / ((b.t - a.t) / 1000);
  };
  const rates = { 1: await measure(1), 2: await measure(2), 0.5: await measure(0.5) };
  for (const [speed, rate] of Object.entries(rates)) assert.ok(Math.abs(rate - 30 * speed) <= 30 * speed * 0.1 + 1, `${speed}x: ${rate.toFixed(1)} frames/s`);
  await anim(page, 'setSpeed', 1);
  return Object.entries(rates).map(([s, r]) => `${s}x ${r.toFixed(1)} f/s`).join(', ');
});

await check('looping wraps; loop off ends on the last frame', async () => {
  await anim(page, 'select', 'celebrate1'); // 31 frames ≈ 1 s
  await anim(page, 'setLoop', true);
  await anim(page, 'play');
  await page.waitForTimeout(1600);
  const looping = await anim(page, 'state');
  assert.equal(looping.state, 'playing');
  assert.ok(looping.frame < 25, `wrapped (frame ${looping.frame})`);
  await anim(page, 'setLoop', false);
  await anim(page, 'select', 'celebrate1');
  await anim(page, 'play');
  await page.waitForTimeout(1600);
  const ended = await anim(page, 'state');
  assert.deepEqual([ended.state, ended.frame], ['ended', 30]);
  await anim(page, 'setLoop', true);
});

await check('viewport redraws continuously while playing and stops when paused / stopped', async () => {
  await anim(page, 'play', 'mood_happy');
  await page.waitForTimeout(300);
  const a = await frames();
  await page.waitForTimeout(1000);
  const b = await frames();
  await anim(page, 'pause');
  await page.waitForTimeout(200);
  const c = await frames();
  await page.waitForTimeout(1000);
  const d = await frames();
  await anim(page, 'play');
  await page.waitForTimeout(500);
  await anim(page, 'stop');
  await page.waitForTimeout(200);
  const e = await frames();
  await page.waitForTimeout(1000);
  const f = await frames();
  assert.ok(b - a >= 15, `${b - a} frames in 1 s of playback`);
  assert.equal(d - c, 0, 'no frames while paused');
  assert.equal(f - e, 0, 'no frames after stop');
  return `${b - a} renders/s playing, 0 paused, 0 stopped`;
});

await check('customizing during playback: look code unaffected, frame still matches the original', async () => {
  await anim(page, 'play', 'mood_swordTwirl');
  await page.waitForTimeout(300);
  const lookCode = await dbg(page, 'wearLook', { hrt: 0, cpc: 3, ski: 1 });
  const staticPage = await browser.newPage();
  await staticPage.goto(`${studio.url}?buddy=${encodeURIComponent(lookCode)}`);
  await studioReady(staticPage);
  assert.equal(await dbg(staticPage, 'code'), lookCode, 'same code as without animation');
  await staticPage.close();
  await anim(page, 'pause');
  await anim(page, 'seek', 40);
  // Re-dress while paused: props and face must come back immediately.
  await dbg(page, 'wearLook', { hrt: 0, cpc: 3, ski: 1, shc: 20 });
  assert.deepEqual((await anim(page, 'props')).three, ['Sword']);
  const head = await anim(page, 'headFrame');
  const finalCode = await dbg(page, 'code');
  await original.evaluate(([c, n]) => window.__original.prepare(c, n), [finalCode, 'mood_swordTwirl']);
  await dbg(compare, 'wearCode', finalCode);
  await anim(compare, 'select', 'mood_swordTwirl');
  const { m, ref, world } = await sample('mood_swordTwirl', 40, { sheet: 'customized-during-playback' });
  assert.equal(head, ref.headFrame);
  assert.ok(world <= T.world && m.iou >= T.iou && m.colorDiff <= T.colorDiff, `IoU ${m.iou.toFixed(4)} colour ${m.colorDiff.toFixed(2)}`);
  return `IoU ${m.iou.toFixed(4)}, colour Δ ${m.colorDiff.toFixed(2)}`;
});

await check('showcase screenshots (editor viewport)', async () => {
  await dbg(page, 'wearCode', null);
  for (const [name, frame] of [['mood_swordTwirl', 40], ['jamA1', 40], ['jamA2', 40], ['rose1', 80], ['mood_lookingForLove', 45], ['mood_flying', 50], ['hug1', 70], ['mood_happy', 20], ['kick1', 40]]) {
    await anim(page, 'select', name);
    await anim(page, 'seek', frame);
    await nextFrames(page, 4);
    await page.locator('.viewport canvas').screenshot({ path: resultPath('animation', `showcase-${name}-${frame}.png`) });
  }
  await anim(page, 'stop');
});

await check('no console or network errors', async () => assert.deepEqual(problems.flat(), []));

await browser.close();
studio.server.close();
root.server.close();
finish();
