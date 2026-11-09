import bpy, sys, json
from mathutils import Vector
path, exp_path = sys.argv[-2:]
exp = json.load(open(exp_path))
to_b = lambda p: Vector((p[0], -p[2], p[1]))
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.scene.render.fps = 30          # match the original 30 fps before importing
bpy.ops.import_scene.gltf(filepath=path)
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
sword = bpy.data.objects.get('Sword'); body = bpy.data.objects['Body']
rest_err = max((arm.matrix_world @ arm.data.bones[b].head_local - to_b(p)).length for b, p in exp['restHeads'].items())
print(f'armature REST (edit bones) vs original rest pose: max {rest_err*1000:.3f} mm')
if not exp['clips']:
    bpy.context.view_layer.update()
    pose_err = max((arm.matrix_world @ arm.pose.bones[b].head - to_b(p)).length for b, p in exp['defaultHeads'].items())
    tpose_rest = max((arm.matrix_world @ arm.pose.bones[b].head - to_b(p)).length for b, p in exp['restHeads'].items())
    print(f'POSE with no action vs file default (T-pose): max {pose_err*1000:.3f} mm; vs rest: {tpose_rest*1000:.1f} mm')
    sys.exit(0)
for name, clip in exp['clips'].items():
    act = bpy.data.actions[name]
    for obj in (arm, sword):
        ad = obj.animation_data
        for t in ad.nla_tracks: t.mute = True
        ad.action = act
        ad.action_slot = next(s for s in act.slots if s.identifier == 'OB' + obj.name)
    print(f'CLIP {name}: action frame range {tuple(round(x,2) for x in act.frame_range)} (expected 0..{clip["frames"]-1})')
    worst_bone = worst_body = 0; vis_ok = True
    for f, s in clip['samples'].items():
        bpy.context.scene.frame_set(int(f)); dg = bpy.context.evaluated_depsgraph_get(); dg.update()
        worst_bone = max(worst_bone, max((arm.matrix_world @ arm.pose.bones[b].head - to_b(p)).length for b, p in s['heads'].items()))
        sv = sword.matrix_world.to_scale().length > 1e-3
        vis_ok &= (sv == s['swordVisible'])
        ev = body.evaluated_get(dg); m = ev.to_mesh()
        # Blender drops vertices no triangle uses; match each imported vertex to the nearest expected one.
        from mathutils.kdtree import KDTree
        tree = KDTree(len(s['body']))
        for i, p in enumerate(s['body']): tree.insert(to_b(p), i)
        tree.balance()
        worst_body = max(worst_body, max(tree.find(ev.matrix_world @ v.co)[2] for v in m.vertices))
        ev.to_mesh_clear()
    print(f'   bones vs engine: max {worst_bone*1000:.4f} mm | body vertices vs engine: max {worst_body*1000:.3f} mm | sword visibility matches: {vis_ok}')
