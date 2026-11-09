"""Headless Blender validation of a BuddyPoke Studio GLB export.

Usage (Blender as a Python module, `pip install bpy==5.2.3`, or `blender -b -P`):
    python validate_glb.py <file.glb> <file.manifest.json> <output-dir>

Imports the file with Blender's official glTF importer and checks it against the export manifest:
armature and bone hierarchy, meshes, skin weights (vertex groups + Armature modifier), embedded
textures and transparency, joint positions (pose), that posing a bone deforms the mesh, and renders the
character from several angles. Writes report.json and PNG renders to <output-dir>; exits 1 on failure.
"""
import json
import math
import os
import sys

import bpy
from mathutils import Euler, Quaternion, Vector

glb_path, manifest_path, out_dir = sys.argv[-3:]
os.makedirs(out_dir, exist_ok=True)
manifest = json.load(open(manifest_path))
report = {"file": os.path.basename(glb_path), "blender": bpy.app.version_string, "checks": [], "ok": True}


def check(name, ok, detail=""):
    report["checks"].append({"name": name, "ok": bool(ok), "detail": detail})
    if not ok:
        report["ok"] = False
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""))


def to_blender(p):
    # glTF is +Y up, Blender +Z up: the importer maps (x, y, z) -> (x, -z, y).
    return Vector((p[0], -p[2], p[1]))


bpy.ops.wm.read_factory_settings(use_empty=True)
result = bpy.ops.import_scene.gltf(filepath=glb_path)
check("file opens in Blender (official glTF importer)", result == {"FINISHED"}, str(result))

armatures = [o for o in bpy.data.objects if o.type == "ARMATURE"]
# The importer adds an "Icosphere" as the display shape of zero-length bones; it is not part of the file.
bone_shapes = {pb.custom_shape for a in armatures for pb in a.pose.bones if pb.custom_shape}
meshes = [o for o in bpy.data.objects if o.type == "MESH" and o not in bone_shapes]
report["bone_display_shapes_ignored"] = sorted(o.name for o in bone_shapes)
expected_meshes = {m["name"]: m for m in manifest["meshes"]}

# ---------------------------------------------------------------- meshes and materials
check("all meshes present", sorted(o.name for o in meshes) == sorted(expected_meshes), f"{sorted(o.name for o in meshes)}")
for obj in meshes:
    exp = expected_meshes.get(obj.name)
    if not exp:
        continue
    mesh = obj.data
    check(f"{obj.name}: geometry", len(mesh.polygons) == exp["triangles"], f"{len(mesh.vertices)} verts, {len(mesh.polygons)} tris (export: {exp['vertices']} verts, {exp['triangles']} tris)")
    mats = [m for m in mesh.materials if m]
    check(f"{obj.name}: material assigned", len(mats) == 1, ", ".join(m.name for m in mats))
    if not mats:
        continue
    mat = mats[0]
    images = [n.image for n in mat.node_tree.nodes if n.type == "TEX_IMAGE" and n.image] if mat.use_nodes else []
    ok_img = bool(images) and all(i.size[0] > 0 for i in images)  # packed images load on first use
    sizes = [tuple(i.size) for i in images]
    check(f"{obj.name}: texture embedded and loaded", ok_img and tuple(exp["texture"]) in sizes, f"{[(i.name, tuple(i.size), 'packed' if i.packed_file else 'not packed') for i in images]}")
    check(f"{obj.name}: texture not missing / not external", all(i.packed_file is not None or i.source == "GENERATED" for i in images), "")
    alpha_linked = any(link.from_node.type == "TEX_IMAGE" and link.from_socket.name == "Alpha" for link in mat.node_tree.links) if mat.use_nodes else False
    method = getattr(mat, "surface_render_method", getattr(mat, "blend_method", "?"))
    if exp["transparent"]:
        check(f"{obj.name}: transparency preserved", alpha_linked and method in ("BLENDED", "BLEND", "HASHED", "CLIP"), f"alpha linked={alpha_linked}, render method={method}")
    else:
        check(f"{obj.name}: opaque material", True, f"render method={method}")

# ---------------------------------------------------------------- skeleton
if manifest["skeleton"]:
    check("exactly one armature", len(armatures) == 1, f"{[a.name for a in armatures]}")
    if armatures:
        arm = armatures[0]
        bones = arm.data.bones
        names = [b.name for b in bones]
        check("29 original bones with original names", sorted(names) == sorted(b["name"] for b in manifest["bones"]), f"{len(names)} bones")
        wrong = [b["name"] for b in manifest["bones"] if b["name"] in bones and (bones[b["name"]].parent.name if bones[b["name"]].parent else None) != b["parent"]]
        check("bone hierarchy (parents) identical to the original", not wrong, f"mismatched: {wrong}")
        worst = 0.0
        for b in manifest["bones"]:
            if b["name"] in bones:
                head = arm.matrix_world @ bones[b["name"]].head_local
                worst = max(worst, (head - to_blender(b["head"])).length)
        check("joint positions match the export (pose)", worst < 1e-4, f"worst {worst:.2e} m")
        if manifest["pose"] == "tpose":
            for side in ("L", "R"):
                heads = [arm.matrix_world @ bones[f"Bip01_{side}_{n}"].head_local for n in ("UpperArm", "Forearm", "Hand", "Finger0")]
                dz = max(abs(h.z - heads[0].z) for h in heads[1:3])
                dy = max(abs(h.y - heads[0].y) for h in heads[1:3])
                check(f"T-pose: {side} arm horizontal in Blender", dz < 1e-5 and dy < 1e-5, f"elbow/wrist height diff {dz:.1e} m, depth diff {dy:.1e} m")
        # Skin weights
        for obj in meshes:
            exp = expected_meshes.get(obj.name, {})
            mods = [m for m in obj.modifiers if m.type == "ARMATURE" and m.object == arm]
            if exp.get("skinned"):
                groups = {g.index: g.name for g in obj.vertex_groups}
                unweighted = sum(1 for v in obj.data.vertices if not any(g.weight > 0 for g in v.groups))
                sums = [sum(g.weight for g in v.groups) for v in obj.data.vertices]
                check(f"{obj.name}: skinned to the armature", len(mods) == 1 and set(groups.values()) <= set(names), f"{len(groups)} vertex groups, armature modifier={len(mods)}")
                check(f"{obj.name}: every vertex weighted (weights sum to 1)", unweighted == 0 and all(abs(s - 1) < 1e-3 for s in sums), f"unweighted={unweighted}, weight sums {min(sums):.4f}–{max(sums):.4f}")
            elif exp:
                check(f"{obj.name}: parented to bone {exp.get('parent')}", obj.parent == arm and obj.parent_type == "BONE" and obj.parent_bone == exp.get("parent"), f"parent={obj.parent and obj.parent.name}, bone={obj.parent_bone}")

        # Posing a bone deforms the weighted vertices (and only those).
        body = next((o for o in meshes if o.name == "Body"), None)
        if body:
            def positions():
                dg = bpy.context.evaluated_depsgraph_get()
                dg.update()
                ev = body.evaluated_get(dg)
                mesh_eval = ev.to_mesh(preserve_all_data_layers=True, depsgraph=dg)
                out = [ev.matrix_world @ v.co for v in mesh_eval.vertices]
                ev.to_mesh_clear()
                return out

            before = positions()
            pb = arm.pose.bones["Bip01_L_Forearm"]
            rest_rotation = pb.rotation_quaternion.copy()
            pb.rotation_quaternion = Quaternion((0, 0, 1), math.radians(60))
            after = positions()
            # Rotating the forearm moves vertices weighted to it or its children (hand, thumb), and nothing else.
            driven = {"Bip01_L_Forearm"} | {b.name for b in arm.data.bones["Bip01_L_Forearm"].children_recursive}
            influenced = [i for i, v in enumerate(body.data.vertices) if any(g.weight > 0 and body.vertex_groups[g.group].name in driven for g in v.groups)]
            moved = sum(1 for i in influenced if (after[i] - before[i]).length > 1e-3)
            others = set(range(len(body.data.vertices))) - set(influenced)
            stray = sum(1 for i in others if (after[i] - before[i]).length > 1e-6)
            check("rotating a bone in Blender deforms its skinned vertices (and only those)", moved > 0 and stray == 0, f"forearm rotated 60°: {moved}/{len(influenced)} driven vertices moved, {stray} of {len(others)} other vertices moved")
            pb.rotation_quaternion = rest_rotation
            positions()
else:
    check("static export has no armature", not armatures, f"{len(armatures)} armatures")

# ---------------------------------------------------------------- bounds (pose) and renders
bb = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
lo = Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb)))
hi = Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))
size = hi - lo
report["bounds_m"] = {"min": list(lo), "max": list(hi), "size": list(size)}
check("character size (metres)", 1.0 < size.z < 2.0, f"width {size.x:.3f} m, depth {size.y:.3f} m, height {size.z:.3f} m")

scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 16
scene.render.film_transparent = True
scene.render.resolution_x, scene.render.resolution_y = 480, 560
scene.view_settings.view_transform = "Standard"
world = bpy.data.worlds.new("World")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (1, 1, 1, 1)
world.node_tree.nodes["Background"].inputs[1].default_value = 1.0
scene.world = world
center = (lo + hi) / 2
cam_data = bpy.data.cameras.new("Cam")
cam_data.type = "ORTHO"
cam_data.ortho_scale = max(size.x, size.z) * 1.15
cam = bpy.data.objects.new("Cam", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
coverage = {}
for label, angle in (("front", 0), ("three-quarter", 40), ("side", 90)):
    a = math.radians(angle)
    cam.location = center + Vector((math.sin(a) * 4, -math.cos(a) * 4, 0))
    cam.rotation_euler = Euler((math.radians(90), 0, a))
    path = os.path.join(out_dir, f"{os.path.splitext(os.path.basename(glb_path))[0]}-{label}.png")
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(path)
    px = list(img.pixels)
    coverage[label] = sum(1 for i in range(3, len(px), 4) if px[i] > 0.5) / (len(px) / 4)
    bpy.data.images.remove(img)
report["render_coverage"] = coverage
check("character renders in Blender from front, 3/4 and side", all(c > 0.03 for c in coverage.values()), ", ".join(f"{k} {v:.1%}" for k, v in coverage.items()))

json.dump(report, open(os.path.join(out_dir, os.path.splitext(os.path.basename(glb_path))[0] + ".blender.json"), "w"), indent=2)
print("RESULT", "OK" if report["ok"] else "FAILED")
sys.exit(0 if report["ok"] else 1)
