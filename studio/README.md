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

- **M3B** export: **Export** tab writing **GLB** (binary glTF 2.0), rigged (original 29-bone skeleton, skin weights) or
  static, in the exact Rest pose or the T-pose, unlit (original look) or lit, with embedded textures. Validated in
  Blender 5.2.3 LTS (headless, official glTF importer). See *Export* below.

- **M3C-1** skeletal animation export (exporter only; the Export-tab controls arrive in M3C-3): all 94 original clips
  in one GLB, bound to the original rest pose, every bone keyed per clip, STEP keys at 30 fps, root motion. See below.

- **M3C-2** props and facial expressions in animated GLB files (exporter only): the original Sword, Rose, guitar (`Strat`)
  and Mic with their rotation and visibility tracks, and the original face expressions as one face node per expression
  frame with the texture the original engine composes. Every frame matches the engine (Three.js and Blender). See below.

Animation shortcuts: `Space` play/pause, `,` / `.` previous / next frame while paused (ignored in text fields and menus).
Viewport: `B` skeleton overlay, `X` X-ray (bones through the character).

Editor shortcuts: `Ctrl/Cmd+Z` undo, `Ctrl/Cmd+Shift+Z` or `Ctrl+Y` redo (text fields keep their own undo).

Preset file format (a preset is a name plus an original look code, so it also works in BuddyRevival as `?buddy=<code>`):

```json
{ "format": "buddypoke-studio-preset", "version": 1, "name": "Street look", "code": "eJw1Uk…" }
```

Viewport shortcuts: `5` perspective/orthographic, `Home` or `F` reset view, `G` grid.
`?buddy=<look code>` wears a look on load (original BuddyRevival/Flash format).

## Export

Each export decodes a **fresh original buddy** from `chick.bin`, dresses it with the current look code and poses it
(exact rest pose, or the M3A-3 T-pose). The live character, its animation state and its rig are never touched.
Animation-only props are exported only in animated files, when an exported clip shows them (M3C-2).

| | GLB · rigged | GLB · static |
|---|---|---|
| Meshes (only worn, visible parts; cull regions applied) | ✓ exact posed vertices | ✓ exact posed vertices |
| Skeleton | 29 original bones, original names and parents | — |
| Skin weights | original (≤3 per vertex), normalised to sum 1 | — |
| Head / short hair (rigid in the original) | skinned to `Bip01_Head` (weight 1) or kept parented | baked |
| Textures | embedded PNG (no external files, no browser URLs) | same |
| Materials | `KHR_materials_unlit` (original look) or PBR; alpha materials as `BLEND` | same |
| Units | metres, 1 original unit = 1 cm (≈1.49 m tall) | same |

Documented adjustments: glTF nodes must be pure translation/rotation/scale, but the original rest rotations have slightly
non-unit axes (M3A-1), so exported bones use the unit-axis rotation (joints move by ≤1.22 mm; the mesh does not move).
Original weights that sum to 0.996–1 are normalised. Three.js writes one skin per skinned mesh, all sharing the same
joints; Blender builds a single armature from them (verified).

**Not offered yet:** *FBX* needs a binary FBX writer (no maintained browser library; `assimpjs` fails to export, see the
M0 analysis). It will only be added once it passes the same Blender validation. *OBJ* cannot carry a skeleton, weights or
transparency modes; the static GLB already covers static use, so OBJ adds little and is not offered.

### Animated GLB (M3C-1)

`exportCharacter(..., { skeleton: true, pose, animations: [clip ids] })` (used by the tests; UI in M3C-3):

- **Bind:** always the original rest pose, with clean inverse bind matrices. `pose` only sets the file's *initial display*
  (Rest, or T-pose with the arm bones turned while the bind stays the rest pose). A T-pose-bound animated file is not
  offered: re-binding cannot reproduce the original deformation (up to 3.6 cm, see `docs/studio/M3C_PLAN.md`).
- **Keys:** sampled from the original engine frame by frame (`Animation.showFrame` on a fresh export copy). One glTF
  animation per clip named with the original id; every one of the 29 bones gets a rotation channel in every clip (no pose
  carry-over between clips), plus `Bip01` translation (root motion). STEP interpolation, no smoothing. Key times are float32
  rounded *down* so a player asked for exactly frame/30 shows that frame. Constant runs are stored once (lossless for STEP).
- **Bind shape:** compensates the clean inverse binds so glTF skinning reproduces the original engine exactly for every
  vertex whose original weights sum to 1.
- **Measured against the original engine (all 94 clips):** bones ≤0.0005 mm, root motion ≤0.00003 mm. Mesh: properly weighted
  vertices ≤0.07 mm (≤0.23 mm where a clip leaves a bone at its rest rotation); all vertices ≤7 mm, because glTF requires
  weights summing to 1 while the original quantised weights sum to 0.996–1 (unavoidable, documented).
- **Blender:** set the scene to **30 fps before importing** (Blender converts glTF seconds to frames at the scene rate and
  has no import option for it). Each clip becomes an Action with its original name.

### Props and facial expressions in animated GLB (M3C-2)

glTF has no visibility channel and no texture swap that Blender imports, so both use **node scale as visibility**
(STEP keys: `1` shown, `1e-6` hidden; never on a bone). Props and face nodes are plain rigid mesh nodes parented to their
original bone, never skinned (glTF ignores a skinned mesh node's transform) and never joints (the skin stays the 29 bones).

- **Props:** each original prop that an exported clip shows (Sword, Rose, Mic under `Bip01_R_Hand`; the guitar `Strat`
  under `Bip01_Pelvis`), with its original local position, its rotation track and its visibility track as the engine
  applies them (`hideProps()` then the clip's tracks, including the original rule that a frame past the end of a short
  track reads its first entry). Hidden in the initial display and keyed hidden in every clip that does not use it. Props
  no exported clip shows (balloon, mallet, ball, scooter) are not written.
- **Facial expressions:** `Head` is the dressed face (= frame 1: the original `TextureLibrary.compose` defaults to frame 1),
  plus one copy `Head_F<nn>` per other expression frame used by the exported clips (up to 31 more for all 94 clips),
  sharing the face geometry, each with the texture the original engine composes for that frame and the current look
  (`Material.showFrame(frame)`; pixel-identical, checked). Exactly one face node is visible at every frame.
- **No carry-over:** every clip keys every prop (rotation + visibility) and every face node, so switching Actions never
  leaves a prop or an expression from the previous clip.
- **Change from M3C-1, needed for this:** in animated files the face (`Head`) is always parented to `Bip01_Head` (it can
  no longer be skinned, since its visibility is a node scale). Its vertices are placed with the engine's own rest relation,
  so its position is unchanged (≤0.0005 mm). Bone/root animation data and skinned meshes are byte-identical to M3C-1.
- **Measured against the original engine:** every frame of all 94 clips (11,609 frames): prop visibility and the visible
  face equal the engine, 0 mismatches (Three.js and Blender). Prop vertices ≤0.001 mm, face vertices ≤0.001 mm.
- **In Blender:** props and face nodes are separate objects, each with its own slot in every Action. Selecting a clip
  means assigning the Action to the armature *and* to those objects (the importer stacks all Actions as NLA tracks on each
  object, which plays them together; `tests/blender/validate_anim.py` shows how to select one).

### Blender validation

`tests/blender/validate_glb.py` opens a GLB in Blender with the official glTF importer and checks meshes, materials and
embedded textures, transparency, a single armature with the original bone names and hierarchy, skin weights (vertex groups,
Armature modifier, weights summing to 1), joint positions and T-pose alignment, that rotating a bone deforms only its
vertices, and renders front / three-quarter / side views.

```bash
python3 -m venv /tmp/bpy && /tmp/bpy/bin/pip install bpy==5.2.3   # Blender as a Python module (Python 3.13, ~1 GB)
BLENDER_PYTHON=/tmp/bpy/bin/python npm run test:blender
```

Without `BLENDER_PYTHON` the export suite still runs and reports the Blender step as **SKIPPED**.

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
  export/     prepare.ts (fresh buddy -> export scene), glb.ts (write + self-check), index.ts (workflow),
              animation/sample.ts (original clips -> STEP keyframes, prop visibility/rotation, face frames)
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
              tpose.mjs (modes, T-pose geometry, skeleton overlay, X-ray, camera preservation),
              export.mjs (GLB structure, pose, skeleton, weights, textures, isolation; Blender if available),
              animexport.mjs (94 clips: structure, accuracy vs the engine, display pose; Blender if available),
              animprops.mjs (props + facial expressions: every-frame timing, textures, sync; Blender if available)
  blender/    validate_glb.py (static/rigged GLB), validate_anim.py (animated GLB, M3C)
    fixtures/original-bind.html   the original renderer drawing the bind pose (reference for render.mjs)
```
