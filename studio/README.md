# BuddyPoke 3D Character Studio

A WebGL character creator built on the original BuddyRevival data and code.
It lives next to the original app (`../web/`), which keeps working unchanged.

- **Original code is imported, not copied.** `@original/*` resolves to `../web/src/*` (decoder, catalog,
  wardrobe, texture composer, look codes). Types for those modules are declared in `src/original/modules.d.ts`.
- **Original assets are served as-is.** Vite's `publicDir` is `../web/assets`.

Plan and analysis: [`../docs/studio/ANALYSIS_AND_PLAN.md`](../docs/studio/ANALYSIS_AND_PLAN.md).

## Status

M0 (scaffold): app shell, empty WebGL viewport, original data decoded in the browser. The character is rendered from M1.

## Commands

```bash
npm ci              # install (npm 10 or newer)
npm run dev         # http://localhost:5417
npm run build       # type-check + production build to dist/
npm test            # original engine regression test + unit tests (Node)
npm run test:e2e    # build, then browser smoke test (studio + original web/ app)
```

Requires Node 22. End-to-end tests use Playwright's Chromium (`npx playwright install chromium` if not present).

**Changing dependencies:** use npm 11 or newer (`npx npm@11 install <pkg>`). npm 10.9 crashes while resolving
Vitest 4's optional peer dependencies; installing from the committed lockfile (`npm ci`) works with npm 10.

## Layout

```
src/
  original/   typed adapter around ../web/src (no re-implementation)
  viewport/   React Three Fiber canvas
  ui/         panels
tests/
  unit/       Vitest (Node): rig, skinning, bind pose, look codes
  e2e/        Playwright smoke test
```
