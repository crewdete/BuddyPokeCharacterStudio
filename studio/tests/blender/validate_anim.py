"""Headless Blender validation of an animated BuddyPoke Studio GLB (M3C).

Usage:  python validate_anim.py <file.glb> <file.expected.json> <output-dir>

<file.expected.json> (written by tests/e2e/animexport.mjs) holds, from the ORIGINAL engine:
  clips:   {name: {frames, fps, samples: {frame: {heads: {bone: [x,y,z]}, meshes?: {name: {positions, weightSums}}}}}}
  restHeads: clean rest joint positions (the bind pose), displayHeads: the file's initial pose, display: rest|tpose
  tolerances: {bone_m, mesh_weighted_m, mesh_all_m}

Checks: scene at 30 fps before import; every clip is an Action with its original name and frame range 0..n-1;
every clip can be selected; bone and root positions match the engine at the sampled frames (clips are played
one after another without resetting, so pose carry-over between Actions would show); mesh deformation within
the documented tolerances; armature rest = original rest pose; initial display pose; renders a contact sheet.

M3C-2 (props and facial expressions): prop and face nodes are separate objects parented to their bone, each with
its own slot in every Action. With `timeline` expectations: at EVERY frame of every clip, the visible props and
the one visible face object equal the engine's; at the sampled frames, visible prop and face vertices are where
the engine puts them; switching Actions carries no prop or face state over; renders props and expressions.
"""
import json
import math
import os
import sys

import bpy
from mathutils import Euler, Vector
from mathutils.kdtree import KDTree

glb_path, expected_path, out_dir = sys.argv[-3:]
os.makedirs(out_dir, exist_ok=True)
exp = json.load(open(expected_path))
tol = exp["tolerances"]
base = os.path.splitext(os.path.basename(glb_path))[0]
report = {"file": os.path.basename(glb_path), "blender": bpy.app.version_string, "checks": [], "ok": True, "clips": {}}


def check(name, ok, detail=""):
    report["checks"].append({"name": name, "ok": bool(ok), "detail": detail})
    report["ok"] &= bool(ok)
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""))


def to_b(p):  # glTF +Y up -> Blender +Z up
    return Vector((p[0], -p[2], p[1]))


bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = 30  # Blender converts glTF seconds to frames at the scene rate: set the original 30 fps first
scene.render.fps_base = 1.0
result = bpy.ops.import_scene.gltf(filepath=glb_path)
check("file opens in Blender (official glTF importer), scene at 30 fps", result == {"FINISHED"} and scene.render.fps == 30, f"{result}, {scene.render.fps} fps")

arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
names = list(exp["clips"])

# ---------------------------------------------------------------- initial display pose + rest (before any action is evaluated)
bpy.context.view_layer.update()
rest_err = max((arm.matrix_world @ arm.data.bones[b].head_local - to_b(p)).length for b, p in exp["restHeads"].items())
check("armature rest pose = the original rest pose (bind)", rest_err < tol["bone_m"] * 10 + 2e-3, f"max {rest_err * 1000:.3f} mm (clean-rotation rest, documented ≤1.22 mm)")
if not names:
    disp = max((arm.matrix_world @ arm.pose.bones[b].head - to_b(p)).length for b, p in exp["displayHeads"].items())
    check(f"initial display pose = {exp['display']}", disp < 1e-3, f"max {disp * 1000:.3f} mm")
    json.dump(report, open(os.path.join(out_dir, base + ".blender.json"), "w"), indent=2)
    print("RESULT", "OK" if report["ok"] else "FAILED")
    sys.exit(0 if report["ok"] else 1)

# ---------------------------------------------------------------- actions
actions = {a.name: a for a in bpy.data.actions}
check(f"all {len(names)} clips imported as Actions with their original names", sorted(actions) == sorted(names), f"{len(actions)} actions")
bad_ranges = [n for n in names if n in actions and tuple(round(x, 3) for x in actions[n].frame_range) != (0.0, float(exp["clips"][n]["frames"] - 1))]
check("every Action spans the original frames 0..n-1 at 30 fps", not bad_ranges, f"wrong: {bad_ranges[:5]}")

ad = arm.animation_data
animated_objects = [o for o in bpy.data.objects if o.animation_data]
for o in animated_objects:
    for t in o.animation_data.nla_tracks:
        t.mute = True  # evaluate exactly one Action at a time (armature, props and face nodes)


def use(action):
    """Assign the Action to the armature AND to every prop/face object it has a slot for (Blender 4.4+ slots)."""
    for o in animated_objects:
        slot = next((s for s in action.slots if s.identifier == "OB" + o.name), None)
        o.animation_data.action = action if slot else None
        if slot:
            o.animation_data.action_slot = slot


face_objects = sorted((o for o in bpy.data.objects if o.type == "MESH" and (o.name == "Head" or o.name.startswith("Head_F"))), key=lambda o: o.name)
first_clip = exp["clips"][names[0]]
first_sample = next(iter(first_clip["samples"].values()))
prop_names = sorted(first_sample.get("props", {}))
prop_objects = {n: bpy.data.objects.get(n) for n in prop_names}
has_extras = "faceNode" in first_sample


def shown(o):
    return o is not None and o.matrix_world.to_scale().x > 0.5


def rigid_error(obj, flat):
    """Max distance from each vertex of the object to the nearest engine vertex (the importer drops vertices no
    triangle uses, so every Blender vertex has an engine counterpart but not the other way round)."""
    pts = [to_b(flat[i:i + 3]) for i in range(0, len(flat), 3)]
    tree = KDTree(len(pts))
    for i, p in enumerate(pts):
        tree.insert(p, i)
    tree.balance()
    return max(tree.find(obj.matrix_world @ v.co)[2] for v in obj.data.vertices)


def state():
    return [o.name for o in face_objects if shown(o)], [n for n in prop_names if shown(prop_objects[n])]


def deformed(obj):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    mesh = ev.to_mesh()
    out = [ev.matrix_world @ v.co for v in mesh.vertices]
    ev.to_mesh_clear()
    return out


worst_bone = worst_root = worst_mesh = worst_mesh_weighted = 0.0
mesh_clips = 0
worst_prop = worst_face = 0.0
prop_points = timeline_frames = 0
face_bad, prop_bad, sample_bad = [], [], []
for name in names:  # one after another, no reset in between: catches pose carry-over
    clip = exp["clips"][name]
    if name not in actions:
        continue
    use(actions[name])
    cb = cr = cm = cmw = 0.0
    for f, s in clip["samples"].items():
        scene.frame_set(int(f))
        bpy.context.view_layer.update()
        if has_extras:  # bones, props and face at the same frame: synchronisation
            faces_on, props_on = state()
            if faces_on != [s["faceNode"]] or props_on != sorted(n for n, v in s["props"].items() if v):
                sample_bad.append(f"{name}@{f}: {faces_on} {props_on}")
            for pn, flat in s["propPoints"].items():
                if prop_objects.get(pn):
                    worst_prop = max(worst_prop, rigid_error(prop_objects[pn], flat)); prop_points += 1
            if len(faces_on) == 1:
                worst_face = max(worst_face, rigid_error(bpy.data.objects[faces_on[0]], s["facePoints"]))
        for b, p in s["heads"].items():
            d = (arm.matrix_world @ arm.pose.bones[b].head - to_b(p)).length
            cb = max(cb, d)
            if b == "Bip01":
                cr = max(cr, d)
        for mesh_name, data in (s.get("meshes") or {}).items():
            obj = bpy.data.objects.get(mesh_name)
            if not obj:
                continue
            pts = [to_b(data["positions"][i:i + 3]) for i in range(0, len(data["positions"]), 3)]
            tree = KDTree(len(pts))
            for i, p in enumerate(pts):
                tree.insert(p, i)
            tree.balance()
            for v in deformed(obj):
                _, i, d = tree.find(v)
                cm = max(cm, d)
                if abs(data["weightSums"][i] - 1) < 1e-6:
                    cmw = max(cmw, d)
    t = clip.get("timeline")
    if t:  # every frame: the visible face object and props equal the engine's
        for f in range(clip["frames"]):
            scene.frame_set(f)
            faces_on, props_on = state()
            node = "Head" if t["face"][f] == 1 else "Head_F%02d" % t["face"][f]
            if faces_on != [node]:
                face_bad.append(f"{name}@{f}: {faces_on} (engine {node})")
            expected_props = sorted(n for n, seq in t["props"].items() if seq[f] == "1")
            if props_on != expected_props:
                prop_bad.append(f"{name}@{f}: {props_on} (engine {expected_props})")
            timeline_frames += 1
    report["clips"][name] = {"bone_mm": cb * 1000, "root_mm": cr * 1000, **({"mesh_mm": cm * 1000, "mesh_weighted_mm": cmw * 1000} if cm else {})}
    worst_bone, worst_root = max(worst_bone, cb), max(worst_root, cr)
    if cm:
        mesh_clips += 1
        worst_mesh, worst_mesh_weighted = max(worst_mesh, cm), max(worst_mesh_weighted, cmw)

check(f"bone positions match the original engine in all {len(names)} clips", worst_bone < tol["bone_m"], f"worst {worst_bone * 1000:.4f} mm")
check("root motion matches the original engine", worst_root < tol["bone_m"], f"worst {worst_root * 1000:.5f} mm")
if mesh_clips:
    check(f"mesh deformation, properly weighted vertices ({mesh_clips} clips)", worst_mesh_weighted < tol["mesh_weighted_m"], f"worst {worst_mesh_weighted * 1000:.3f} mm")
    check(f"mesh deformation, all vertices incl. glTF weight normalisation ({mesh_clips} clips)", worst_mesh < tol["mesh_all_m"], f"worst {worst_mesh * 1000:.3f} mm")

if has_extras:
    report["props"] = {"objects": [n for n in prop_names if prop_objects[n]], "worst_mm": worst_prop * 1000, "checked": prop_points}
    report["faces"] = {"objects": [o.name for o in face_objects], "worst_mm": worst_face * 1000}
    report["timeline"] = {"frames": timeline_frames, "face_mismatches": face_bad[:20], "prop_mismatches": prop_bad[:20]}
    check("bones, props and face in sync at every sampled frame (visible prop set and face object = engine)", not sample_bad, f"{len(sample_bad)} wrong: {sample_bad[:3]}")
    check(f"prop vertices where the engine puts them ({prop_points} visible-prop samples)", worst_prop < tol["bone_m"], f"worst {worst_prop * 1000:.5f} mm; props {report['props']['objects']}")
    check(f"face vertices where the engine puts them ({len(face_objects)} face objects)", worst_face < tol["bone_m"], f"worst {worst_face * 1000:.5f} mm")
    if timeline_frames:
        check(f"facial expression timing: exactly the engine's face at every frame ({timeline_frames} frames)", not face_bad, f"{len(face_bad)} wrong: {face_bad[:3]}")
        check(f"prop visibility timing: exactly the engine's props at every frame ({timeline_frames} frames)", not prop_bad, f"{len(prop_bad)} wrong: {prop_bad[:3]}")

    # Explicit prop/face carry-over: a clip that shows a prop (and its own faces), then one that does not, and back.
    pairs = [(a, b) for a, b in (("swordA1", "hug1"), ("hug1", "swordA1"), ("mood_swordTwirl", "jamA2"), ("jamA1", "rose1"), ("rose2", "mood_happy")) if a in actions and b in actions]
    for first, second in pairs:
        use(actions[first]); scene.frame_set(exp["clips"][first]["frames"] // 2)
        use(actions[second])
        f = sorted(exp["clips"][second]["samples"], key=int)[0]
        scene.frame_set(int(f)); bpy.context.view_layer.update()
        s = exp["clips"][second]["samples"][f]
        faces_on, props_on = state()
        want = sorted(n for n, v in s["props"].items() if v)
        check(f"switching {first} -> {second}: no prop or face carry-over", faces_on == [s["faceNode"]] and props_on == want, f"faces {faces_on} (engine {s['faceNode']}), props {props_on} (engine {want})")

# Explicit carry-over check: a clip that keys its hair after one that does not, and back.
if {"hug1", "holdHands1"} <= set(names):
    for first, second in (("hug1", "holdHands1"), ("holdHands1", "hug1")):
        use(actions[first]); scene.frame_set(exp["clips"][first]["frames"] // 2)
        use(actions[second])
        f = sorted(exp["clips"][second]["samples"], key=int)[0]
        scene.frame_set(int(f)); bpy.context.view_layer.update()
        d = max((arm.matrix_world @ arm.pose.bones[b].head - to_b(p)).length for b, p in exp["clips"][second]["samples"][f]["heads"].items())
        check(f"switching {first} -> {second}: no pose carry-over", d < tol["bone_m"], f"max {d * 1000:.4f} mm")

# ---------------------------------------------------------------- contact sheet renders
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 8
scene.render.film_transparent = True
scene.render.resolution_x, scene.render.resolution_y = 240, 300
scene.view_settings.view_transform = "Standard"
world = bpy.data.worlds.new("W"); world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (1, 1, 1, 1)
scene.world = world
cam_data = bpy.data.cameras.new("Cam"); cam_data.type = "ORTHO"; cam_data.ortho_scale = 2.4
cam = bpy.data.objects.new("Cam", cam_data); scene.collection.objects.link(cam); scene.camera = cam
cam.location = Vector((0, -6, 0.85)); cam.rotation_euler = Euler((math.radians(90), 0, 0))
shots = []
for name in exp.get("render", []):
    if name not in actions:
        continue
    use(actions[name])
    frame = int(exp["clips"][name]["frames"] * 0.4)
    scene.frame_set(frame)
    path = os.path.join(out_dir, f"{base}-{name}-{frame}.png")
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    shots.append(os.path.basename(path))
# Prop frames (a frame where the engine shows the prop) and face close-ups (one per expression in the file).
for name in exp.get("renderProps", []):
    t = exp["clips"].get(name, {}).get("timeline")
    if name not in actions or not t:
        continue
    seqs = [seq for seq in t["props"].values() if "1" in seq]
    frame = seqs[0].index("1") + (seqs[0].count("1") * 2) // 3 if seqs else int(t and len(t["face"]) * 0.4)
    use(actions[name]); scene.frame_set(frame)
    path = os.path.join(out_dir, f"{base}-{name}-{frame}.png")
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    shots.append(os.path.basename(path))
if exp.get("renderFaces") and has_extras:
    head = arm.pose.bones["Bip01_Head"]
    cam_data.ortho_scale = 0.42
    scene.render.resolution_x = scene.render.resolution_y = 200
    done = set()
    for name in names:
        t = exp["clips"][name].get("timeline")
        if not t:
            continue
        for f, face in enumerate(t["face"]):
            if face in done:
                continue
            done.add(face)
            use(actions[name]); scene.frame_set(f); bpy.context.view_layer.update()
            # Look at the face from the front of the head (glTF +Z is the buddy's front: Blender -Y).
            hp = arm.matrix_world @ head.head
            cam.location = Vector((hp.x, hp.y - 6, hp.z + 0.08)); cam.rotation_euler = Euler((math.radians(90), 0, 0))
            path = os.path.join(out_dir, f"{base}-face{face:02d}-{name}-{f}.png")
            scene.render.filepath = path
            bpy.ops.render.render(write_still=True)
            shots.append(os.path.basename(path))
report["renders"] = shots
check("renders of representative clips, props and expressions", len(shots) >= len([n for n in exp.get("render", []) if n in actions]), ", ".join(shots[:6]) + (f" … ({len(shots)})" if len(shots) > 6 else ""))

json.dump(report, open(os.path.join(out_dir, base + ".blender.json"), "w"), indent=2)
print("RESULT", "OK" if report["ok"] else "FAILED")
sys.exit(0 if report["ok"] else 1)
