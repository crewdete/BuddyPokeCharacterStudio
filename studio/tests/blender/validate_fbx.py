"""Headless Blender validation of a BuddyPoke Studio FBX (binary 7.4), with Blender's official FBX importer.

Usage:  python validate_fbx.py <file.fbx> <file.expected.json> <output-dir>

<file.expected.json> (written by tests/e2e/objfbx.mjs) holds, from the ORIGINAL engine, the same data as for the
animated GLB (validate_anim.py): clips {name: {frames, fps, samples {frame: {heads, meshes?, props, propPoints, faceNode,
facePoints}}, timeline?}}, restHeads (bind), displayHeads, bones [{name, parent}], meshes [names], tolerances.

The importer is used with its defaults, as a user would: it sets the scene frame rate from the file (30 fps) and
places frame 0 of every clip at Blender frame 1 ("Animation Offset" = 1), so engine frame f is Blender frame f + 1.
Props and facial-expression nodes are skinned to helper bones "Ctrl_<name>"; visibility is that bone's scale.
"""
import json
import math
import os
import sys

import bpy
from mathutils import Euler, Vector
from mathutils.kdtree import KDTree

fbx_path, expected_path, out_dir = sys.argv[-3:]
os.makedirs(out_dir, exist_ok=True)
exp = json.load(open(expected_path))
tol = exp["tolerances"]
base = os.path.splitext(os.path.basename(fbx_path))[0]
report = {"file": os.path.basename(fbx_path), "blender": bpy.app.version_string, "checks": [], "ok": True, "clips": {}}
OFFSET = 1  # Blender FBX importer default "Animation Offset"


def check(name, ok, detail=""):
    report["checks"].append({"name": name, "ok": bool(ok), "detail": detail})
    report["ok"] &= bool(ok)
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""))


def to_b(p):  # FBX/glTF +Y up (metres) -> Blender +Z up
    return Vector((p[0], -p[2], p[1]))


bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = 24  # deliberately not 30: the importer must set it from the file
result = bpy.ops.import_scene.fbx(filepath=fbx_path)
check("file opens with Blender's FBX importer; scene set to 30 fps from the file", result == {"FINISHED"} and scene.render.fps == 30 and scene.render.fps_base == 1.0, f"{result}, {scene.render.fps} fps")

arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
check("one armature", len(arms) == 1, f"{len(arms)} armatures")
arm = arms[0]
names = [b["name"] for b in exp["bones"]]
helpers = sorted(b.name for b in arm.data.bones if b.name.startswith("Ctrl_"))
original = [b.name for b in arm.data.bones if not b.name.startswith("Ctrl_")]
check(f"the {len(names)} original bones with their original names (+ {len(helpers)} Ctrl_ helper bones)", sorted(original) == sorted(names), f"{len(original)} original, helpers {helpers[:4]}{'…' if len(helpers) > 4 else ''}")
bad_parents = [b["name"] for b in exp["bones"] if b["name"] in arm.data.bones and ((arm.data.bones[b["name"]].parent.name if arm.data.bones[b["name"]].parent else None) != b["parent"])]
check("original hierarchy (every bone's parent)", not bad_parents, f"wrong: {bad_parents[:5]}")

meshes = {o.name: o for o in bpy.data.objects if o.type == "MESH"}
missing = [m for m in exp["meshes"] if m not in meshes]
check(f"all {len(exp['meshes'])} meshes imported", not missing, f"missing {missing}")
unskinned = [n for n in exp["meshes"] if n in meshes and exp["meshSkinned"].get(n) and not any(m.type == "ARMATURE" and m.object == arm for m in meshes[n].modifiers)]
check("skinned meshes deformed by the armature (Armature modifier + vertex groups)", not unskinned, f"not skinned: {unskinned}")

images = [i for i in bpy.data.images if i.packed_file or i.filepath]
loaded = [i for i in images if i.size[0] > 0 and len(i.pixels) > 0]
textured = [m for m in bpy.data.materials if m.node_tree and any(n.type == "TEX_IMAGE" and n.image for n in m.node_tree.nodes)]
check("embedded textures load; every mesh material has its image", len(loaded) == len(images) > 0 and all(any(ms.material in textured for ms in meshes[n].material_slots) for n in exp["meshes"] if n in meshes), f"{len(loaded)}/{len(images)} images, {len(textured)} textured materials")

bpy.context.view_layer.update()
rest = max((arm.matrix_world @ arm.data.bones[b].head_local - to_b(p)).length for b, p in exp["restHeads"].items())
check("armature rest pose = the original rest pose (bind)", rest < 2e-3, f"max {rest * 1000:.3f} mm (clean unit-axis rest, ≤1.22 mm documented)")

clips = list(exp["clips"])
ad = arm.animation_data
if not clips:
    disp = max((arm.matrix_world @ arm.pose.bones[b].head - to_b(p)).length for b, p in exp["displayHeads"].items())
    check(f"initial display pose = {exp['display']}", disp < 1e-3, f"max {disp * 1000:.4f} mm")
    json.dump(report, open(os.path.join(out_dir, base + ".blender.json"), "w"), indent=2)
    print("RESULT", "OK" if report["ok"] else "FAILED")
    sys.exit(0 if report["ok"] else 1)

actions = {a.name.split("|", 1)[-1]: a for a in bpy.data.actions}
check(f"all {len(clips)} clips imported as Actions (BuddyPoke|<original name>)", sorted(actions) == sorted(clips), f"{len(actions)} actions")
bad_range = [c for c in clips if c in actions and tuple(round(x) for x in actions[c].frame_range) != (OFFSET, OFFSET + exp["clips"][c]["frames"] - 1)]
check("every Action spans the original frames (Blender frames 1..n)", not bad_range, f"wrong: {bad_range[:5]}")
if ad:
    for t in ad.nla_tracks:
        t.mute = True


def use(action):
    arm.animation_data_create()
    arm.animation_data.action = action
    if action.slots:
        arm.animation_data.action_slot = action.slots[0]


def shown_bone(name):
    pb = arm.pose.bones.get(name)
    return pb is not None and (arm.matrix_world @ pb.matrix).to_scale().x > 0.5


def deformed(obj):
    ev = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh = ev.to_mesh()
    out = [ev.matrix_world @ v.co for v in mesh.vertices]
    ev.to_mesh_clear()
    return out


def nearest_error(obj, flat):
    pts = [to_b(flat[i:i + 3]) for i in range(0, len(flat), 3)]
    tree = KDTree(len(pts))
    for i, p in enumerate(pts):
        tree.insert(p, i)
    tree.balance()
    return max(tree.find(v)[2] for v in deformed(obj))


faces = sorted(h[5:] for h in helpers if h[5:] == "Head" or h[5:].startswith("Head_F"))
props = sorted(h[5:] for h in helpers if h[5:] not in faces)


def state():
    return [f for f in faces if shown_bone("Ctrl_" + f)], [p for p in props if shown_bone("Ctrl_" + p)]


worst = {"bone": 0.0, "root": 0.0, "mesh": 0.0, "weighted": 0.0, "prop": 0.0, "face": 0.0}
mesh_clips = timeline = 0
sync_bad, face_bad, prop_bad = [], [], []
for name in clips:  # one after another, no reset: pose / prop / face carry-over would show
    clip = exp["clips"][name]
    if name not in actions:
        continue
    use(actions[name])
    cb = cm = 0.0
    for f, s in clip["samples"].items():
        scene.frame_set(int(f) + OFFSET)
        for b, p in s["heads"].items():
            d = (arm.matrix_world @ arm.pose.bones[b].head - to_b(p)).length
            cb = max(cb, d)
            if b == "Bip01":
                worst["root"] = max(worst["root"], d)
        faces_on, props_on = state()
        want_props = sorted(p for p, v in s["props"].items() if v)
        if faces and (faces_on != [s["faceNode"]] or props_on != want_props):
            sync_bad.append(f"{name}@{f}: {faces_on} {props_on}")
        for pn, flat in s["propPoints"].items():
            if pn in meshes and pn in props:
                worst["prop"] = max(worst["prop"], nearest_error(meshes[pn], flat))
        if faces and len(faces_on) == 1 and faces_on[0] in meshes:
            worst["face"] = max(worst["face"], nearest_error(meshes[faces_on[0]], s["facePoints"]))
        for mesh_name, data in (s.get("meshes") or {}).items():
            if mesh_name not in meshes:
                continue
            pts = [to_b(data["positions"][i:i + 3]) for i in range(0, len(data["positions"]), 3)]
            tree = KDTree(len(pts))
            for i, p in enumerate(pts):
                tree.insert(p, i)
            tree.balance()
            for v in deformed(meshes[mesh_name]):
                _, i, d = tree.find(v)
                cm = max(cm, d)
                worst["mesh"] = max(worst["mesh"], d)
                if abs(data["weightSums"][i] - 1) < 1e-6:
                    worst["weighted"] = max(worst["weighted"], d)
    if cm:
        mesh_clips += 1
    worst["bone"] = max(worst["bone"], cb)
    report["clips"][name] = {"bone_mm": cb * 1000}
    t = clip.get("timeline")
    if t and faces:
        for f in range(clip["frames"]):
            scene.frame_set(f + OFFSET)
            faces_on, props_on = state()
            node = "Head" if t["face"][f] == 1 else "Head_F%02d" % t["face"][f]
            if faces_on != [node]:
                face_bad.append(f"{name}@{f}: {faces_on} (engine {node})")
            want = sorted(p for p, seq in t["props"].items() if seq[f] == "1")
            if props_on != want:
                prop_bad.append(f"{name}@{f}: {props_on} (engine {want})")
            timeline += 1

check(f"bone positions match the original engine in all {len(clips)} clips", worst["bone"] < tol["bone_m"], f"worst {worst['bone'] * 1000:.4f} mm")
check("root motion matches the original engine", worst["root"] < tol["bone_m"], f"worst {worst['root'] * 1000:.5f} mm")
if mesh_clips:
    check(f"mesh deformation, properly weighted vertices ({mesh_clips} clips)", worst["weighted"] < tol["mesh_weighted_m"], f"worst {worst['weighted'] * 1000:.3f} mm")
    check(f"mesh deformation, all vertices incl. weight normalisation ({mesh_clips} clips)", worst["mesh"] < tol["mesh_all_m"], f"worst {worst['mesh'] * 1000:.3f} mm")
if faces:
    check("bones, props and face in sync at every sampled frame", not sync_bad, f"{len(sync_bad)} wrong: {sync_bad[:3]}")
    check(f"prop vertices where the engine puts them ({', '.join(props) or 'no props'})", worst["prop"] < tol["bone_m"], f"worst {worst['prop'] * 1000:.5f} mm")
    check(f"face vertices where the engine puts them ({len(faces)} face nodes)", worst["face"] < tol["bone_m"], f"worst {worst['face'] * 1000:.5f} mm")
    if timeline:
        check(f"facial expression timing: the engine's face at every frame ({timeline} frames)", not face_bad, f"{len(face_bad)} wrong: {face_bad[:3]}")
        check(f"prop visibility timing: the engine's props at every frame ({timeline} frames)", not prop_bad, f"{len(prop_bad)} wrong: {prop_bad[:3]}")

# Explicit carry-over: switch Actions mid-clip and compare the first sampled frame of the next one.
pairs = [(a, b) for a, b in (("swordA1", "hug1"), ("hug1", "swordA1"), ("mood_flying", "hug1")) if a in actions and b in actions]
for first, second in pairs:
    use(actions[first]); scene.frame_set(exp["clips"][first]["frames"] // 2 + OFFSET)
    use(actions[second])
    f = sorted(exp["clips"][second]["samples"], key=int)[0]
    scene.frame_set(int(f) + OFFSET)
    s = exp["clips"][second]["samples"][f]
    d = max((arm.matrix_world @ arm.pose.bones[b].head - to_b(p)).length for b, p in s["heads"].items())
    faces_on, props_on = state()
    ok = d < tol["bone_m"] and (not faces or (faces_on == [s["faceNode"]] and props_on == sorted(p for p, v in s["props"].items() if v)))
    check(f"switching {first} -> {second}: no pose, prop or face carry-over", ok, f"bones {d * 1000:.4f} mm, faces {faces_on}, props {props_on}")

# Renders
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
    t = exp["clips"][name].get("timeline")
    seqs = [seq for seq in (t or {}).get("props", {}).values() if "1" in seq]
    frame = (seqs[0].index("1") + (seqs[0].count("1") * 2) // 3) if seqs else int(exp["clips"][name]["frames"] * 0.4)
    scene.frame_set(frame + OFFSET)
    path = os.path.join(out_dir, f"{base}-{name}-{frame}.png")
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    shots.append(os.path.basename(path))
report["renders"] = shots
if exp.get("render"):
    check("renders", len(shots) == len([n for n in exp["render"] if n in actions]), ", ".join(shots))

json.dump(report, open(os.path.join(out_dir, base + ".blender.json"), "w"), indent=2)
print("RESULT", "OK" if report["ok"] else "FAILED")
sys.exit(0 if report["ok"] else 1)
