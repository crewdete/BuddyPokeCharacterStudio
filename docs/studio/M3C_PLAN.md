# M3C Plan: Animation Export (GLB/glTF)

Status: **investigation complete, plan awaiting approval.** No implementation has been done, and the M3B export system has not been
changed. All measurements below come from experiments run in this phase. They can be reproduced with the scripts in
[`m3c-research/`](m3c-research/) (Node + the original engine; headless Blender 5.2.3 LTS through `bpy`).

---

## 1. Findings: the original animation system

### 1.1 Storage (from `chick.bin`, decoded by the original `engine/animation.js`)

| Item | Finding |
|---|---|
| Clips | **94**, all 30 fps, **11,609 frames** in total (387 s); 31–341 frames per clip |
| Library | One animation library with 29 *targets* and a position bounding box; each clip is a list of tracks, one per target |
| Rotations | 2,128 rotation tracks: 1,694 wavelet-compressed (Daubechies D4, per-frame quaternion channels) and 434 constant. Decoded to one quaternion per frame, then converted to axis-angle |
| Positions | 16-bit quantised per frame, normalised into the library bounds. Only `Bip01` (root motion) and `Shadow` have position tracks |
| Scale | **None** (no scale tracks, no node scale in the package) |
| Visibility | One byte per frame, on the four props only |
| Material frames | One value per frame, on the face mesh `Head` only |

### 1.2 What is animated

| Target | Kind | Animated by | In how many clips |
|---|---|---|---|
| 21 Biped/IG bones (`Bip01`, pelvis, spine, legs, arms, head, 4 hair helpers) | **skeleton joints** | rotation (all); `Bip01` also translation | 79–94 each |
| `Bip01_Neck`, `Bip01_{L,R}_Finger0`, `Bip01_Footsteps`, `IG_Root`, `IG_Vesp_Root` | skeleton joints | **never animated** (stay at rest) | 0 |
| `Head` (face mesh, rigid child of `Bip01_Head`) | external mesh | **material frame** only (facial expressions) | 94 |
| `Shadow` (ground quad) | external mesh | translation (86), rotation (25) | 86 |
| `Sword`, `Rose`, `Strat` (guitar), `Mic` | external props, rigid children of `Bip01_R_Hand` (`Strat` of the pelvis) | **visibility + rotation** | 3, 3, 3, 1 |

### 1.3 Bone transforms
Each node has an optional position (Vector3) and an optional rotation (axis-angle). The local matrix is `T(position) · R(axis, angle)`.
The original `rotate(angle, axis)` equals `THREE.Matrix4.makeRotationAxis(axis, +angle)` for unit axes (verified in M3A-3).
Animated rotations come from unit quaternions. The stored **rest** rotations have slightly non-unit axes (M3A-1), which glTF node
transforms cannot represent; M3B already writes their unit-axis form.

### 1.4 Timing
Playback is stepped at 30 fps: `frame = trunc(t·fps + 0.499)`. A looping clip wraps at `end − start`, so its last frame equals the first.
The Studio player reproduces this exactly (M3A-1, checked against the original `Animation.step()`).

### 1.5 Root motion
`Bip01` translation and rotation move the whole body (pokes walk toward a partner; "flying" rises about 50 units). The `Shadow` node
follows in X/Z on the ground.

### 1.6 Facial animation
**Not skeletal.** The face is a texture: the `Head` material is recomposed with another frame of the multi-frame face symbols (`Eyes_*`,
`Mouth`, `Brows_*`, mustaches; 33 frames each). **32 distinct face frames** are used across all clips, at most **7 per clip**. Each frame
is a different composed bitmap for the current look.

### 1.7 Rest pose vs T-pose: measured
The question is whether glTF skinning (which Blender also uses) reproduces the original engine's deformation. I deformed every skinned
mesh (32) for all 94 clips at 5 frames each, 2,812,950 vertex positions in total, and compared each method with the original engine.
Units are original units (≈cm; the character is about 140 tall).

| File binding | median | p95 | p99 | max |
|---|---|---|---|---|
| **T-pose bind** (bind shape = M3B T-pose mesh) | 0.084 | 0.19 | 0.41 | **3.56** |
| Rest bind, clean (unit-axis) inverse binds, normalised weights | 0.095 | 0.47 | 0.52 | 0.86 |
| Rest bind, engine inverse binds, normalised weights | **0.000** | 0.54 | 0.60 | 0.84 |
| Rest bind, engine inverse binds, raw (unnormalised) weights | **0.000** | 0.04 | 0.07 | 0.22 |

What this shows:
- **A T-pose-bound file cannot reproduce the original animation exactly.** Linear blend skinning is not invariant to re-binding: a vertex
  weighted to several bones (shoulders, elbows, hips) deforms differently once the bind shape is the T-pose. The worst error is 3.6 cm.
  So "static T-pose export works" does **not** mean "T-pose animation works".
- **Bound to the original rest pose, the error is essentially the original quantisation.** The remaining 0.5–0.6 tail is the original
  weights (they sum to 0.996–1) being applied raw by the engine, while glTF requires weights that sum to 1 and Blender normalises them anyway.
  This cannot be reproduced in a glTF file; it is an inherent, documented limitation (≈0.6 cm worst case).
- The last 0.22 comes from joints a clip does not animate, which keep the non-unit rest rotation glTF cannot store.

### 1.8 Blender 5.2.3 LTS: measured (official glTF importer, headless)
Test files: 3 clips (`hug1`, `mood_swordTwirl` with the sword, `mood_flying` with root motion), per-frame STEP keys, every joint keyed,
bound to the rest pose. Blender was compared with the original engine at sampled frames.

| Behaviour | Result |
|---|---|
| Clips | **One Action per glTF animation, original names kept** (`hug1`, …); each Action has a **slot** per animated object (armature, `Sword`); all clips are stacked as NLA tracks, the first is active, every clip can be selected |
| Frame rate | Blender converts glTF seconds to frames at the **scene's** frame rate at import time and has no import option for it. At the default 24 fps a 30 fps clip lands on fractional frames (`hug1` spans 0–112). **With the scene set to 30 fps before import, frames are exact** (0–140, 0–110, 0–100) |
| Armature rest | Built from the inverse bind matrices (`guess_original_bind_pose`, on by default) = the original rest pose |
| Bone positions vs engine (clean inverse binds) | **≤ 0.0007 mm** at every sampled frame, root motion included |
| Bone positions vs engine (engine inverse binds) | ≤ 0.93 mm (Blender approximates non-orthonormal inverse binds when it builds the rest) |
| Deformed body vs engine | ≤ 4.1 mm (the weight normalisation above) |
| Prop visibility (scale-toggled node) | Matches the engine at every sampled frame |
| Rest-bound file with a **T-pose default** (node TRS = T-pose, inverse binds = rest) | Opens **showing the T-pose** (within 0.9 mm), while the armature rest stays the original pose the animations need |

---

## 2. Recommended approach

### 2.1 Format and structure
**One GLB with the character and the selected clips** (all 94, or a chosen subset), as a new "GLB · animated" format next to the M3B formats.

```
BuddyPoke (scene root)
├─ IG_Root ─ IG_Vesp_Root                 joints (29 original bones, original names and hierarchy, clean TRS)
├─ Bip01 ─ … ─ Bip01_Head ─ Face_01…Face_N    one face node per expression used (rigid, toggled by scale)
│                 └─ … Bip01_R_Hand ─ Sword, Rose, Mic           props (rigid, rotation + visibility)
│           └─ Bip01_Pelvis ─ … Strat                            prop
├─ Body, hair, clothes …                   skinned meshes (single skin joint set)
animations[]: one glTF animation per clip, named with the original clip id (e.g. "hug1", "mood_happy")
extras: per-clip display name (from moods.xml / pokes.xml), fps 30, frame count, loop, look code
```

### 2.2 Binding and pose
- **Bind to the original rest pose with clean inverse binds** (§1.7, §1.8): bones match the engine exactly in Blender, and deformation
  matches to the measured ≤0.6 cm normalisation limit.
- **Default (static) pose of the file**, chosen by the user:
  - *Rest* (default): what the file is bound to;
  - *T-pose*: nodes default to the M3A-3 T-pose while the bind stays the original rest. Verified in Blender: the file opens in T-pose
    and the animations still use the correct rest. This gives a T-pose-looking file without the 3.6 cm T-bind error.
- **A T-pose-bound animated file will not be offered.** It is technically possible but cannot reproduce the original animation (§1.7).
  The M3B static T-pose export stays the format for T-pose-bound workflows (retargeting, auto-rigging).

### 2.3 Keyframes
- **Sample the original engine frame by frame** with the M3A-1 player path (`Animation.showFrame` on a fresh export buddy, the same
  isolation as M3B), and read each node's position and axis-angle. This reproduces exactly what the Studio plays (checked against the
  original renderer on 470 frames in M3A-1), including the engine's own conversions and its small-angle axis fallback.
- One key per original frame at `t = frame / 30`. Clip duration `(frameCount − 1) / 30`. Interpolation **STEP** by default (exact,
  stepped like the original), **LINEAR** as an option (smooth at higher frame rates; identical at integer frames).
- **Every joint keyed in every clip.** Joints a clip does not animate get constant rest keys, so each clip is self-contained. Without
  this, Blender keeps the previous action's pose on unkeyed bones, which is the same "pose bleed" the Studio removed.
- Constant runs are reduced to two keys (start/end). Estimated size: about 5–7 MB for all 94 clips with textures, less for subsets.

### 2.4 Root motion
`Bip01` translation is exported as recorded (×0.01 m). Optional **"in place"**: zero the horizontal (X/Z) root translation and keep the
vertical motion, for game-engine locomotion setups. The shadow is excluded (§2.6).

### 2.5 Props
Each prop is exported as a rigid mesh node under its original parent bone, with its rest TRS, its rotation track and **visibility as a
STEP scale track** (1 shown / 1e-6 hidden; glTF has no visibility channel). Props are **nodes, not joints**, so they do not change the
skin or the 29-bone rig. They are included only when at least one exported clip uses them, and are hidden in every other clip.
Verified in Blender with the sword.

### 2.6 Facial animation
glTF cannot swap a texture over time in a way Blender imports reliably. **Recommended:** one copy of the face (`Head`) mesh per
expression used by the exported clips, each with its own composed texture, parented to `Bip01_Head`, with exactly one visible per frame
through STEP scale keys. This is the same mechanism verified with the sword. Cost: up to 32 small meshes and 250×125 textures
(≈0.6 MB) for all clips, at most 7 per clip. Face visibility keys are sparse (only on changes).
*Not chosen:* `KHR_animation_pointer` with a texture atlas (cleaner, but importer support is uncertain and unverified here), and morph
targets (cannot change texture images).

### 2.7 Excluded (cannot be supported reliably, or out of scope)
- **T-pose-bound animated files** (§1.7: cannot reproduce the original deformation; up to 3.6 cm error).
- **Exact reproduction of the original under-weighted vertices** (glTF requires weights summing to 1; ≤0.6 cm, documented).
- **Two-character pokes as a pair:** each half is exported as its own clip on the one character. A two-buddy stage scene is a separate decision.
- **The ground shadow** (a decal, not part of the character), and the scooter props (never shown by any clip).
- **Automatic 30 fps in Blender:** Blender has no import option for it; the user sets the scene to 30 fps before importing
  (documented in the dialog and the README). The file also records the frame rate in its extras.
- **FBX/OBJ animation** (FBX is a separate milestone; OBJ cannot hold animation).

---

## 3. Proposed architecture (implementation not started)

| Module (new, in `studio/src/export/`) | Role |
|---|---|
| `animation/sample.ts` | On the fresh export buddy: for each selected clip, restore the rest pose, step `showFrame` 0…n−1, record joint TRS, root translation, prop visibility/rotation, face frame. Pure data, unit-testable in Node |
| `animation/clips.ts` | Turn samples into `THREE.AnimationClip`s (STEP/LINEAR, constant-run reduction, in-place option, props, face visibility) |
| `animation/faces.ts` | Compose the face texture for each used frame (original `TextureLibrary.compose` with that frame) and build the face nodes |
| `prepare.ts` (extended, not rewritten) | An `animated` mode: rest bind with clean inverse binds, default pose rest/T-pose, prop and face nodes. The M3B static/rigged paths stay as they are |
| `glb.ts` (extended) | Write `animations`; self-check (clip count/names/durations, keyed joints, every channel targets a valid node) |
| `ui/ExportPanel.tsx` (extended) | "GLB · animated": clip picker (All / group / search, reusing the M3A-2 catalog), default pose, interpolation, in-place, size estimate, the Blender 30 fps note |

---

## 4. Testing strategy

**Unit (Node, original engine):**
- sampled TRS equal the engine's state at every frame (0 difference);
- STEP timing `t = f/30` and durations;
- constant-run reduction is lossless;
- the in-place option zeroes only root X/Z;
- face and prop visibility sequences equal the engine's.

**Browser (Playwright):**
- export all 94 clips plus subsets;
- re-load with `GLTFLoader` and play with `AnimationMixer`: at sampled frames, bone world positions match the original engine; deformed
  vertices are within the documented limit; props and the visible face node match the engine;
- the Studio is unchanged after exporting (as in M3B);
- the size estimate is accurate; no console errors.

**Blender (headless `bpy`, extending `tests/blender/validate_glb.py`):**
1. Set the scene to 30 fps, then import.
2. **All clips present** as Actions with the **original names**; the frame range of each equals 0…frameCount−1.
3. **Every clip selectable:** assign each Action (and its slots) in turn.
4. **Bone transforms:** at sampled frames of every clip, pose-bone heads equal the engine's world positions (target ≤ 0.001 mm with clean
   inverse binds), root motion included.
5. **Deformation:** evaluated mesh vertices equal the engine's within the documented normalisation limit (≤ 6 mm).
6. **Props:** visible exactly on the frames where the engine shows them.
7. **Face:** exactly one face node visible per sampled frame, and it is the engine's frame.
8. **Default pose:** with no action the pose equals the chosen default (rest or T-pose); the armature rest equals the original rest.
9. **Renders** of a few frames per clip group (contact sheet) for visual review.

---

## 5. Estimated stages

| Stage | Content | Size |
|---|---|---|
| **M3C-1** | Sampling + clip building for joints and root motion (rest bind, clean inverse binds, STEP); GLTFLoader playback tests; Blender checks 1–5 and 8 for all 94 clips | Medium |
| **M3C-2** | Props (rotation + visibility) and face expressions (face nodes); Blender checks 6–7 | Medium |
| **M3C-3** | Export UI (clip picker, default pose, interpolation, in-place, size estimate, Blender 30 fps note), docs, sample files, full regression | Small–medium |

Each stage would be tested, committed and reported separately, as before.

---

## 6. Known limitations (expected after implementation)

1. **Weight normalisation:** up to ≈0.6 cm (median 0) difference from the original engine on vertices whose quantised weights sum below 1.
2. **Unanimated joints keep the clean rest rotation** (fingers, and hair or spine in the clips that do not animate them): ≤0.22 cm effect.
3. **Blender must be set to 30 fps before importing**, or the stepped keys land on fractional frames.
4. **Facial expressions are mesh swaps**, not texture animation: one face mesh per expression in the file.
5. **Prop visibility is a scale trick** (1e-6 when hidden), the standard workaround in glTF.
6. **Pokes are one-character halves.**
7. **Animated files are rest-bound** (they may *display* the T-pose by default); a T-pose-bound animated file is not offered.
8. **Validated in Blender 5.2.3 LTS only;** other engines (Unity, Unreal, Godot) are untested.
