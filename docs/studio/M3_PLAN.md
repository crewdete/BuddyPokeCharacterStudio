# M3 Plan — Animation System, Pose Controls, T-pose, Skeleton View

Status: **plan only, awaiting approval.** No M3 code has been written.
Based on: `web/src/engine/animation.js`, `scene-graph.js`, `skin.js`, `domain/buddy.js`, `domain/poses.js`, `web/assets/moods.xml`,
`pokes.xml`, the decoded `chick.bin`, and the Studio as of M2B (`5c4b8f3`).

---

## 1. Architecture findings

### 1.1 Animation data (decoded from `chick.bin`)

| Fact | Value | Consequence |
|---|---|---|
| Clips | **94**, all **30 fps**, all flagged `loop=true` | Loop on/off is a Studio setting, not data |
| Lengths | 31–341 frames (1–11 s) | |
| Track encoding | Rotations: D4-wavelet quaternions → per-frame axis-angle. Positions: 16-bit quantised. Visibility: 1 byte/frame. Material frames: 1 per frame | Already fully decoded per frame by the original `Animation.decode()` |
| Animation targets | 29 names, **not the same set as the 29 skeleton bones**: 21 Biped/IG bones + `Head` (face mesh), `Shadow`, and props `Strat`, `Mic`, `Rose`, `Sword` | |
| Never animated | `Bip01_Neck`, `Bip01_{L,R}_Finger0`, `Bip01_Footsteps`, `IG_Root`, `IG_Vesp_Root` (scooter props are never shown by any clip) | They stay at the bind pose |
| Tracks per clip | 19–26 (e.g. `holdHands*`, `handshake*` key only 19) | **Untracked bones keep whatever pose the previous clip left.** The original app has this "pose bleed"; the Studio must reset to the bind pose when a clip starts |
| Position tracks | Only `Bip01` (root motion) and `Shadow` | Bones only rotate → bone lengths are constant (testable) |
| Root motion | Bip01 moves up to ~±50 units in Z; poke halves walk toward/turn to a partner | Optional "In place" mode later |
| Face | Every clip keys `Head` material frames (blinks, expressions) via `Material.showFrame()` | Already supported by `CharacterRig.refreshTextures()` |
| Props | `Rose`, `Sword`, `Strat`, `Mic` revealed by visibility tracks in 9 clips | See 1.3 |

Clip groups, from original data:
- **Moods** — 39 entries in `moods.xml` (`name`, caption, `a0` clip, icon).
- **Pokes** — 28 entries in `pokes.xml`, each a pair (`a0` = you, `a1` = friend), authored for two buddies on the `setting.bin` stage.
- **Idle poses** — 13 `pose_*` clips, chained by the original Markov table in `domain/poses.js`.
- **Other** — clips not referenced above (e.g. `standBreathe`, `pose_joinNow`, `mood_gonnaSoarNow`), computed at runtime.

### 1.2 Original playback logic

- `Animation.showFrame(scene, f)` sets `current = start + f` and calls `apply()`: `scene.hideProps()`, then each track writes
  `node.position`, `node.rotation` (axis-angle), `node.visible`, and `mesh.material.showFrame()`.
- Frames are **stepped** (no interpolation): `frame = trunc(seconds·fps + start + 0.499)`.
- Looping wraps with `(current − start) % (end − start)`: the last frame equals the first (seamless loop), so a loop is
  `frameCount − 1` frames long (the original exporter also uses `frameCount − 1`).
- `Animation.step()` uses `performance.now()`, so it cannot do speed control or deterministic seeking. **`showFrame` can, and is what the Studio should call.**
- `Track.apply` creates `node.position`/`node.rotation` objects on first use (e.g. `Bip01_Pelvis` has no bind `cpos`). **Animations mutate the
  engine's bind values in place**, so a bind snapshot is required to return to the rest pose.

### 1.3 Studio (M2B) touch points

- `CharacterRig.syncPose()` already walks the engine tree with the original `updateWorld()` and copies each `node.local` into the Three
  objects. Driving bones from the engine therefore needs **no new math**: a frame is `showFrame` → `syncPose` → render.
- Bones are `THREE.Bone`s with the engine's own inverse binds; skinned meshes use the original weights (≤3 influences). GPU skinning
  does the deformation; M1 verified the bind pose bit-for-bit (0 attachment error) and 61 looks against the original renderer.
- **Props:** catalog props are worn (`visible="true"`) so `dress()` gives them materials, then the original `hideProps()` hides them.
  `CharacterRig.update()` only builds parts for meshes visible at that moment, so prop meshes are never built. Playback needs a
  cheap per-frame visibility sync that builds a part the first time its node becomes visible.
- **Rendering is on demand** (M2A). Playback must request a frame every animation frame while playing, and stop requesting when paused.
- **Customization is catalog-only.** `dress()` replaces materials, which resets the face frame until the next `showFrame()` sets it again.
  Look codes, presets and undo never touch transforms, so they stay compatible with animation.
- The edit queue (`CharacterController.edit`) serialises `dress()`. The player runs per frame outside the queue; this is safe because
  `dress()`'s synchronous parts (`applyMaterials`, `applyVisibility`) never interleave with a frame update in single-threaded JS.

### 1.4 Can the animations be loaded into Three.js directly?

Yes. Each decoded track is a per-frame array that maps directly onto `THREE.AnimationClip`
(`QuaternionKeyframeTrack` for rotations, `VectorKeyframeTrack` for `Bip01`/`Shadow` positions, discrete tracks for visibility).
Face material frames have no Three.js equivalent and would need a custom track.

Two ways to play them:

| | A. Drive the original engine (`showFrame` → `syncPose`) | B. Convert to `THREE.AnimationClip` + `AnimationMixer` |
|---|---|---|
| Fidelity | Identical to the original by construction (same code); props and face frames included | Equal only if the axis-angle → quaternion conversion matches the engine's rotation convention (the engine's `rotate()` uses `cos(−angle)`); face frames and prop visibility need custom tracks |
| Code | ~150 lines (player + bind snapshot + prop sync) | Converter + mixer integration + custom tracks |
| Testability | Frame-exact comparison with the original renderer | Same test, more places to go wrong |
| Needed for export? | No | Only if animations are exported later (not in scope) |

**Recommendation: A for playback.** Build the converter (B) later only if animation export is requested.

---

## 2. Recommended implementation

### 2.1 Bind snapshot (`pose/bind.ts`)
At load, store every engine node's bind `position`/`rotation` (copies, keeping `null` where the original had none).
`restoreBind()` puts them back. This is used on Stop, when switching clips (no pose bleed), and as the base for the T-pose.

### 2.2 Animation player (`pose/player.ts`)
A small class with its own clock: `{ clip, playing, time, speed, loop }`.
- `frameAt(time)` follows the original rules (stepped frames, `+0.499` rounding, loop over `frameCount − 1`, clamp at the
  last frame when not looping).
- Each frame: `restoreBind()` (only when the clip changes) → original `animation.showFrame(scene, f)` → `rig.syncPose()` →
  `rig.syncVisibility()` (props, built on first use) → `rig.refreshTextures()` (face frames) → `invalidate()`.
- **Play, Pause, Stop** (Stop returns to the bind pose), **speed** 0.25×–2× (scales the clock only), **loop** toggle,
  **seek(frame)** for scrubbing and deterministic tests.
- When a clip is selected, prewarm its face material frames so the first loop doesn't stutter while expressions are composed.
- Stepped 30 fps playback by default (faithful, and needed for frame-exact tests). Smooth interpolation is a possible later option.
- Optional **Idle** entry: the original idle chain via the original `startPosing`/`keepPosing` (wall-clock, 1× only), so the
  Markov table isn't duplicated.

### 2.3 Animation catalog (`pose/catalog.ts`)
Built from the original `moods.xml`, `pokes.xml` and the package's clip list. Entries carry name, group, clip, frames and duration.
Pokes offer both halves ("you" side `a0`, "friend" side `a1`). Search matches names and clip ids.
Clips that aren't in the package are reported, never invented.

### 2.4 Pose modes (`pose/modes.ts`): **Rest | T-pose | Animation**
- **Rest** = the original bind pose (arms down), from the snapshot.
- **T-pose** = deterministic reconstruction computed from the bind pose, never from the current animation frame:
  for `UpperArm`, `Forearm`, `Hand` on each side, rotate so the Biped bone axis (local +X) points along world ±X with minimal twist.
  Everything else stays at bind (legs are already near-straight). The result is a fixed set of local matrices applied to the
  Three bones. Skinned meshes deform through the original weights; rigid parts (head, hair, props) follow their bones.
- **Animation** = the player's current frame.
- Switching to Rest or T-pose pauses the player. Switching back resumes from the paused frame.
- M3A only displays the T-pose. Baking it as an export rest pose (deformed vertices + new inverse binds) belongs to the export
  milestone; the M0 spike already proved it round-trips through GLB.

### 2.5 Skeleton overlay (`viewport/SkeletonOverlay.tsx`)
- Built from the rig's real `THREE.Bone`s: a line from each bone to its parent bone, plus a small joint marker.
  It updates with whatever pose is shown.
- Drawn on top of the mesh (depth test off), in the grey palette: charcoal lines over a light halo so they read on any outfit.
  Helper bones (`IG_Hair*`, `IG_Root`, `IG_Vesp_Root`, `Bip01_Footsteps`) are drawn lighter and dashed.
- Viewport toolbar: **Skeleton** toggle (shortcut `B`) and an optional **X-ray** mesh dimming. Bone names appear on hover only if it
  stays cheap; otherwise this is left out.

### 2.6 UI (industrial grey, responsive)
- New sidebar tab **Animate**: group filter (Moods / Pokes / Idle / Other / All), search field, clip list
  (name, group, duration; selected row marked).
- **Transport bar** docked at the bottom of the viewport: Play/Pause, Stop, frame scrubber with frame counter, Loop toggle,
  Speed selector, and the pose mode switch **Rest | T-pose | Animation**.
- On phones the transport becomes two compact rows; the list stays in the sidebar tab.
- Keyboard: `Space` play/pause, `,` `.` step one frame while paused (only when focus isn't in a text field).

### 2.7 Customization during animation
Edits keep going through the queue. After `rig.update()` the player re-applies the current frame (so props and the face frame
are restored immediately, even when paused). Look codes, presets and undo are unchanged: the pose is never part of the look.

---

## 3. Files likely to change (all in `studio/`)

New:
- `src/pose/bind.ts`: bind snapshot and restore
- `src/pose/player.ts`: playback clock, original frame rules, prewarm
- `src/pose/catalog.ts`: groups and search from the original XML
- `src/pose/modes.ts`: Rest / T-pose / Animation; T-pose solver
- `src/state/playback.ts`: UI state (selected clip, mode, speed, loop, overlay flags)
- `src/viewport/SkeletonOverlay.tsx`
- `src/viewport/Transport.tsx`
- `src/ui/AnimatePanel.tsx`
- `tests/unit/pose.test.ts`: frame rules, bind restore, T-pose math (Node; engine scene without textures)
- `tests/e2e/animation.mjs`: browser suite
- `tests/e2e/fixtures/original-bind.html`: extended to render any `clip@frame` with the original renderer (test fixture only)

Modified:
- `src/scene/CharacterRig.ts`: `syncVisibility()` with lazy prop parts; pose application from a mode
- `src/viewport/Viewport.tsx`, `ViewportToolbar.tsx`, `state/viewport.ts`: invalidate while playing, overlay toggles
- `src/ui/Sidebar.tsx`: Animate tab
- `src/original/index.ts`, `modules.d.ts`: load `moods.xml`/`pokes.xml` via the original `fetchXml`; declare used `Animation` members
- `src/App.tsx`, `src/debug.ts`: wiring and test hooks (`seek`, `pose`, `boneMatrices`)
- `src/styles.css`, `README.md`

Not touched: `web/`, the decoder, assets.

---

## 4. Technical risks

| Risk | Impact | Mitigation |
|---|---|---|
| **Pose bleed** between clips with different track sets | Wrong arms/hair after switching | Restore bind on clip change; test with `holdHands1` (19 tracks) after `hug1` |
| **Props never built** (hidden when dressed) | Sword, rose and guitar missing | Lazy part creation in `syncVisibility()`; test all 9 prop clips |
| Face frame **compose stutter** (SVG stamping on first use) | Hitch on first loop | Prewarm frames for the selected clip; measure |
| **Root motion** moves poke halves off-centre or out of view | Character half off-screen | Keep original motion; Reset view frames the current pose; optional "In place" (M3B) |
| **Pokes are paired** | Solo half reaches for no one | Label as "you"/"friend" side; two-character stage is a separate, later decision |
| Customize during playback | Face frame resets; props hidden until next frame | Re-apply the current frame after `rig.update()`; tested |
| On-demand rendering | Playback freezes, or the CPU never idles | Invalidate per frame only while playing; test both |
| **T-pose quality** at shoulders (LBS with 1–3 weights) | Stretched armpits | Measure triangle stretch; tune clavicle share in M3B; document |
| **T-pose as export rest + animations (future)** | Re-binding LBS to a new rest changes how blended vertices deform: an animated T-pose rig won't reproduce the original deformation exactly at shoulders and elbows | Static T-pose export is exact (it's the deformed mesh). If animations are exported later, keep the original bind as rest for those files |
| Bone roll/axis for export | Biped bones point along +X; Blender shows bones along +Y | Viewer convention only; document in the export milestone |
| Speed + stepped frames | At low speed, frames hold visibly (faithful) | Optional interpolation later |
| SwiftShader test runtime | Long suites | Seek-based tests (no real-time waits); sample frames |

---

## 5. Proposed milestones

**M3A-1: Playback core (no new UI beyond debug hooks)**
Bind snapshot, player with the original frame rules, `syncVisibility` for props, face frames, on-demand invalidation, prewarm.
Frame-exact parity with the original renderer.

**M3A-2: Animation UI**
Animate tab (groups from original XML, search), transport (Play/Pause/Stop, scrubber, loop, speed), keyboard, responsive layout.
Customization, presets and undo during playback.

**M3A-3: Pose modes and skeleton view**
Rest / T-pose / Animation switch, T-pose solver, skeleton overlay with toolbar toggle and X-ray.

**M3B: T-pose for export (before GLB export)**
Detached export-rest builder (bake T-pose: deformed vertices + new inverse binds) on a copy, never the live scene.
T-pose refinement (clavicle share, symmetry), GLB round-trip and a headless Blender check.
Optional: "In place" root motion, original Idle chain, smooth interpolation.

Each sub-milestone is committed, tested and reported separately.

---

## 6. Acceptance criteria and tests

### M3A-1
- Every one of the 94 clips plays. At sampled frames (first, middle, last, plus 2 random per clip ≈ 470 frames) the Studio render
  matches the **original Canvas renderer at the same clip and frame**: silhouette IoU ≥ 0.95, colour Δ ≤ 14, shadow opacity
  ratio 0.7–1.3. The same thresholds as M1, now in motion.
- For every sampled frame: every Three bone and rigid attachment matches the engine's own world transform (error < 1e-3); no NaN.
- Bone lengths are constant across all frames of all clips (only `Bip01`/`Shadow` translate).
- Props: in the 9 prop clips the prop is visible exactly on the frames whose visibility track says so, and is hidden otherwise.
- Face: `Head` material frame equals the track value on every sampled frame.
- No pose bleed: `holdHands1@0` after playing `hug1` equals `holdHands1@0` from a fresh load.
- Stop restores the bind pose exactly (local matrices equal the snapshot to 1e-9).
- Frame rules: a unit test of `frameAt()` against the original formula for loop on and off, every speed, wrap at `end − start`.
- On-demand rendering: frames are requested while playing, and none for 1 s after pausing.

### M3A-2
- The list shows 39 moods, 28 pokes (both halves), 13 idle poses and the other clips, all named from the original XML; search filters correctly.
- Play/Pause/Stop, the scrubber, loop and speed (0.25×–2×) work via clicks and keys; playback rate matches speed within ±5% over 3 s.
- During playback: change hair, cap and skirt, load a preset, undo/redo, apply a look code. The look code equals the static case;
  the paused frame still matches the original renderer for the new look.
- Phone and tablet layouts work with no horizontal scroll; no console errors; all M0–M2B suites still pass.

### M3A-3
- T-pose: both UpperArm/Forearm/Hand axes within 1° of world ±X; left/right mirror-symmetric within 1e-3; spine, legs and head
  identical to bind; deterministic (identical matrices whether entered from bind, mid-animation, or after customization).
- T-pose mesh: no NaN; only arm-influenced vertices move; shoulder triangle stretch measured and reported.
- Mode switching Rest ↔ T-pose ↔ Animation keeps the playback position; the look code is never affected.
- Skeleton overlay: 29 bones drawn; each joint marker coincides with its bone's world position in Rest, T-pose and animation;
  toggle via button and `B`; no change to character rendering metrics when the overlay is off.
- Screenshots: Rest, T-pose and a mid-animation frame, with and without the skeleton.

### Regression
Full `npm test` and `npm run test:e2e` (smoke, render, viewport, customize, presets, animation) pass; no console errors.

---

## 7. Known limitations (expected)

- Pokes are two-character animations; M3A plays one side solo.
- Stepped 30 fps playback, as in the original.
- `Bip01_Neck`, the fingers and `Bip01_Footsteps` are never animated by the original clips.
- The T-pose is a reconstruction (the source bind pose is arms-down); shoulder quality is limited by the original weights.
- The scooter props (`Vesp_*`) are not shown by any clip.
