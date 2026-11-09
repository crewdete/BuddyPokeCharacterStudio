"""Headless Blender validation of a BuddyPoke Studio OBJ export (ZIP with .obj, .mtl and PNG textures), with Blender's
official OBJ importer (bpy.ops.wm.obj_import, default axes: -Z forward, Y up).

Usage:  python validate_obj.py <file.zip> <file.expected.json> <output-dir>

<file.expected.json> (written by tests/e2e/objfbx.mjs): meshes [{name, triangles, transparent, texture [w, h],
positions (world, metres, Y up: the static GLB of the same look and pose, validated in M3B)}], pose.
"""
import json
import math
import os
import sys
import zipfile

import bpy
from mathutils import Euler, Vector
from mathutils.kdtree import KDTree

zip_path, expected_path, out_dir = sys.argv[-3:]
os.makedirs(out_dir, exist_ok=True)
exp = json.load(open(expected_path))
base = os.path.splitext(os.path.basename(zip_path))[0]
report = {"file": os.path.basename(zip_path), "blender": bpy.app.version_string, "checks": [], "ok": True}


def check(name, ok, detail=""):
    report["checks"].append({"name": name, "ok": bool(ok), "detail": detail})
    report["ok"] &= bool(ok)
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""))


def to_b(p):
    return Vector((p[0], -p[2], p[1]))


folder = os.path.join(out_dir, base + "-unzipped")
os.makedirs(folder, exist_ok=True)
with zipfile.ZipFile(zip_path) as z:
    bad = z.testzip()
    z.extractall(folder)
    names = z.namelist()
check("ZIP is valid (CRC) and holds the .obj, the .mtl and the textures", bad is None and any(n.endswith(".obj") for n in names) and any(n.endswith(".mtl") for n in names), f"{len(names)} files: {', '.join(names[:4])}…")
obj_file = os.path.join(folder, next(n for n in names if n.endswith(".obj")))

bpy.ops.wm.read_factory_settings(use_empty=True)
result = bpy.ops.wm.obj_import(filepath=obj_file)
check("file opens with Blender's OBJ importer", result == {"FINISHED"}, str(result))

objects = {o.name: o for o in bpy.data.objects if o.type == "MESH"}
expected = {m["name"]: m for m in exp["meshes"]}
check(f"one object per mesh part ({len(expected)})", sorted(objects) == sorted(expected), f"{sorted(objects)}")

bad_tris, worst = [], 0.0
for name, m in expected.items():
    o = objects.get(name)
    if not o:
        continue
    tris = sum(len(p.vertices) - 2 for p in o.data.polygons)
    if tris != m["triangles"]:
        bad_tris.append(f"{name}: {tris}")
    pts = [to_b(m["positions"][i:i + 3]) for i in range(0, len(m["positions"]), 3)]
    tree = KDTree(len(pts))
    for i, p in enumerate(pts):
        tree.insert(p, i)
    tree.balance()
    for v in o.data.vertices:
        worst = max(worst, tree.find(o.matrix_world @ v.co)[2])
check("triangle count of every part = the export", not bad_tris, f"wrong: {bad_tris}")
check(f"vertex positions = the static GLB of the same look and pose ({exp['pose']})", worst < 1e-5, f"max {worst * 1000:.5f} mm (OBJ stores 6 decimals)")

no_uv = [n for n, o in objects.items() if not o.data.uv_layers]
check("texture coordinates on every part", not no_uv, f"missing: {no_uv}")

tex_bad, alpha_bad = [], []
for name, m in expected.items():
    o = objects.get(name)
    if not o or not o.material_slots or not o.material_slots[0].material:
        tex_bad.append(f"{name}: no material")
        continue
    mat = o.material_slots[0].material
    images = [n for n in mat.node_tree.nodes if n.type == "TEX_IMAGE" and n.image]
    if not images:
        tex_bad.append(f"{name}: no image")
        continue
    img = images[0].image
    if tuple(img.size) != tuple(m["texture"]) or len(img.pixels) == 0:
        tex_bad.append(f"{name}: image {tuple(img.size)}")
    bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    alpha_linked = bool(bsdf and bsdf.inputs["Alpha"].is_linked)
    if alpha_linked != m["transparent"]:
        alpha_bad.append(f"{name}: alpha {'linked' if alpha_linked else 'not linked'}")
check("every part has its original texture (loaded, original size)", not tex_bad, "; ".join(tex_bad) or f"{len(expected)} materials")
check("transparency: alpha from the texture exactly on the transparent parts (map_d)", not alpha_bad, "; ".join(alpha_bad) or f"{sum(m['transparent'] for m in exp['meshes'])} transparent")

# Render (front view)
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 8
scene.render.film_transparent = True
scene.render.resolution_x, scene.render.resolution_y = (360, 300) if exp["pose"] == "tpose" else (240, 300)
scene.view_settings.view_transform = "Standard"
world = bpy.data.worlds.new("W"); world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (1, 1, 1, 1)
scene.world = world
cam_data = bpy.data.cameras.new("Cam"); cam_data.type = "ORTHO"; cam_data.ortho_scale = 2.4 if exp["pose"] == "tpose" else 1.8
cam = bpy.data.objects.new("Cam", cam_data); scene.collection.objects.link(cam); scene.camera = cam
cam.location = Vector((0, -6, 0.75)); cam.rotation_euler = Euler((math.radians(90), 0, 0))
path = os.path.join(out_dir, f"{base}-front.png")
scene.render.filepath = path
bpy.ops.render.render(write_still=True)
report["renders"] = [os.path.basename(path)]
check("render", os.path.exists(path), os.path.basename(path))

json.dump(report, open(os.path.join(out_dir, base + ".blender.json"), "w"), indent=2)
print("RESULT", "OK" if report["ok"] else "FAILED")
sys.exit(0 if report["ok"] else 1)
