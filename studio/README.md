# BuddyPoke 3D Character Studio

A WebGL character creator built on the original BuddyRevival data and code.
It lives next to the original app (`../web/`), which keeps working unchanged.

- **Original code is imported, not copied.** `@original/*` resolves to `../web/src/*` (decoder, catalog,
  wardrobe, texture composer, look codes). Types for those modules are declared in `src/original/modules.d.ts`.
- **Original assets are served as-is.** Vite's `publicDir` is `../web/assets`.

Plan and analysis: [`../docs/studio/ANALYSIS_AND_PLAN.md`](../docs/studio/ANALYSIS_AND_PLAN.md).

## Status

- **M0** scaffold: app shell, original data decoded in the browser.
- **M1** viewport: the original character in WebGL (skinned body, rigid head/hair attached to their bones, original
  composed textures, cull regions, transparency, original drop shadow), studio background and floor, orbit/zoom/pan,
  reset view, perspective/orthographic. Unlit, as the original. Pose is the original bind pose (arms down).

- **M2A** customization: sidebar built on the original `Wardrobe` (`visibleOptions`, `choose`, original option rules
  and selector resets), original SVG icons and palettes, per-category Reset to the original default look, live 3D
  update after every change, responsive (side panel on desktop/tablet, stacked on phones). The viewport renders on
  demand (only when the camera, damping or character changes).

- **M2B** library: action bar (Undo, Redo, Default, Random) and Presets / Code tabs. Look codes in the original format
  (copy, paste + apply with validation by the original decoder); Default and Random are the original
  `wearCode(null)` and `Wardrobe.randomize`; named presets saved in `localStorage` (`buddypoke-studio:presets`),
  exported/imported as `*.buddypoke.json`; undo/redo history of look codes (100 steps) covering every change.

- **M3A-1** animation playback core (no UI yet): `AnimationPlayer` plays all 94 original clips through the original
  `Animation.showFrame()` (transforms, root motion, props, face frames), with its own clock for speed/pause, seek, loop
  switch, exact bind-pose restore on Stop and on every clip change (no pose bleed), and on-demand redraw only while
  playing. Driven from tests via `window.__studio.debug.anim`; the Animate UI arrives in M3A-2.

- **M3A-2** animation interface: **Animate** tab (110 entries covering all 94 clips: 39 moods and 28 pokes named from
  the original `moods.xml` / `pokes.xml`, both poke halves labelled you/friend, 13 idle poses, 2 other; group filter and
  search) and a transport bar under the viewport (play/pause, stop, frame counter, frame slider, loop, speed 0.25×–2×,
  clip name, Rest / Animation). Customizing, presets, look codes and undo keep the selected clip and paused frame.

- **M3A-3** poses and skeleton: **Rest | T-pose | Animation** switch. The T-pose is solved from the original rest pose:
  each arm bone (UpperArm, Forearm, Hand) gets the smallest rotation from its rest rotation that points its axis along
  world ±X; every other bone stays at rest. Switching modes never changes the clip, frame, speed, loop or play state
  (the clock freezes outside Animation). **Skeleton** overlay of the 29 real bones (helpers dashed) with **X-ray**.

Animation shortcuts: `Space` play/pause, `,` / `.` previous / next frame while paused (ignored in text fields and menus).
Viewport: `B` skeleton overlay, `X` X-ray (bones through the character).

Editor shortcuts: `Ctrl/Cmd+Z` undo, `Ctrl/Cmd+Shift+Z` or `Ctrl+Y` redo (text fields keep their own undo).

Preset file format (a preset is a name plus an original look code, so it also works in BuddyRevival as `?buddy=<code>`):

```json
{ "format": "buddypoke-studio-preset", "version": 1, "name": "Street look", "code": "eJw1Uk…" }
```

Viewport shortcuts: `5` perspective/orthographic, `Home` or `F` reset view, `G` grid.
`?buddy=<look code>` wears a look on load (original BuddyRevival/Flash format).

## Commands

```bash
npm ci              # install (npm 10 or newer)
npm run dev         # http://localhost:5417
npm run build       # type-check + production build to dist/
npm test            # original engine regression test + unit tests (Node)
npm run test:e2e    # build, then browser tests: smoke, renderer comparison, viewport
```

### How the renderer is checked

`render.mjs` draws 61 looks (default, the original friend look, all 48 hairstyles, all skirts, 8 seeded random looks)
with both the studio (`?compare=1`: original camera `Camera_Long2`, 692×520) and the original Canvas 2D engine, then
compares silhouette IoU, bounding box, colour and drop-shadow opacity, and checks that every bone and rigid attachment
matches the engine's own transforms. Sheets (original | studio | diff) are written to `test-results/compare/`.

Requires Node 22. End-to-end tests use Playwright's Chromium (`npx playwright install chromium` if not present).

**Changing dependencies:** use npm 11 or newer (`npx npm@11 install <pkg>`). npm 10.9 crashes while resolving
Vitest 4's optional peer dependencies; installing from the committed lockfile (`npm ci`) works with npm 10.

## Layout

```
src/
  original/   typed adapter around ../web/src (no re-implementation)
  pose/       BindSnapshot (exact rest pose), AnimationPlayer (original showFrame, timing per Animation.step,
              rest/T-pose/animation mode), tpose.ts (T-pose solver), catalog.ts (original moods.xml / pokes.xml)
  character/  CharacterController: serialized edits through the original Wardrobe, rig update, undo history;
              presets.ts: look-code validation, preset files, storage (pure, unit-tested)
  scene/      engine scene -> Three.js (CharacterRig, textures, depth offset, framing)
  state/      zustand stores
  viewport/   React Three Fiber canvas, cameras, floor, toolbar
  ui/         panels
  debug.ts    window.__studio.debug, used by the browser tests
tests/
  unit/       Vitest (Node): rig, skinning, bind pose, look codes, framing, depth offset, presets/validation
  e2e/        Playwright: smoke.mjs, render.mjs (vs the original Canvas 2D renderer), viewport.mjs,
              customize.mjs (every category via the panel; look codes checked in the original app),
              presets.mjs (look codes, Default/Random, presets, files, undo/redo, storage edge cases),
              animation.mjs (94 clips / 470 frames vs the original renderer, props, Stop, bleed, timing),
              animate.mjs (Animate tab, transport, keyboard, integration, responsive),
              tpose.mjs (modes, T-pose geometry, skeleton overlay, X-ray, camera preservation)
    fixtures/original-bind.html   the original renderer drawing the bind pose (reference for render.mjs)
```
