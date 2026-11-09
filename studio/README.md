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
  character/  CharacterController: serialized edits through the original Wardrobe, then rig update
  scene/      engine scene -> Three.js (CharacterRig, textures, depth offset, framing)
  state/      zustand stores
  viewport/   React Three Fiber canvas, cameras, floor, toolbar
  ui/         panels
  debug.ts    window.__studio.debug, used by the browser tests
tests/
  unit/       Vitest (Node): rig, skinning, bind pose, look codes, framing, depth offset
  e2e/        Playwright: smoke.mjs, render.mjs (vs the original Canvas 2D renderer), viewport.mjs,
              customize.mjs (every category via the panel; look codes checked in the original app)
    fixtures/original-bind.html   the original renderer drawing the bind pose (reference for render.mjs)
```
