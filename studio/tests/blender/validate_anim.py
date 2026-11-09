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
for t in ad.nla_tracks:
    t.mute = True  # evaluate exactly one Action at a time


def use(action):
    ad.action = action
    ad.action_slot = next(s for s in action.slots if s.identifier == "OB" + arm.name)


def deformed(obj):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    mesh = ev.to_mesh()
    out = [ev.matrix_world @ v.co for v in mesh.vertices]
    ev.to_mesh_clear()
    return out


worst_bone = worst_root = worst_mesh = worst_mesh_weighted = 0.0
mesh_clips = 0
for name in names:  # one after another, no reset in between: catches pose carry-over
    clip = exp["clips"][name]
    if name not in actions:
        continue
    use(actions[name])
    cb = cr = cm = cmw = 0.0
    for f, s in clip["samples"].items():
        scene.frame_set(int(f))
        bpy.context.view_layer.update()
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
report["renders"] = shots
check("renders of representative clips", len(shots) == len([n for n in exp.get("render", []) if n in actions]), ", ".join(shots))

json.dump(report, open(os.path.join(out_dir, base + ".blender.json"), "w"), indent=2)
print("RESULT", "OK" if report["ok"] else "FAILED")
sys.exit(0 if report["ok"] else 1)
