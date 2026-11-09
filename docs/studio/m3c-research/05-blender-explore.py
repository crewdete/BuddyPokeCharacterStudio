import bpy, sys
path = sys.argv[-1]
bpy.ops.wm.read_factory_settings(use_empty=True)
print('scene fps before import', bpy.context.scene.render.fps)
bpy.ops.import_scene.gltf(filepath=path)
print('scene fps after import', bpy.context.scene.render.fps, 'frame range', bpy.context.scene.frame_start, bpy.context.scene.frame_end)
for a in bpy.data.actions:
    slots = [s.identifier for s in getattr(a, 'slots', [])]
    print('ACTION', a.name, 'range', tuple(round(x, 2) for x in a.frame_range), 'slots', slots, 'users', a.users)
for o in bpy.data.objects:
    ad = o.animation_data
    if not ad: continue
    print('OBJ', o.name, o.type, 'active action', ad.action and ad.action.name, 'slot', getattr(ad, 'action_slot', None) and ad.action_slot.identifier,
          'NLA tracks', [(t.name, [s.action.name for s in t.strips]) for t in ad.nla_tracks])
