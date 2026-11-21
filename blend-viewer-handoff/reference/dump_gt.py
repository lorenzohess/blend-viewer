import bpy, sys, json
bpy.ops.wm.open_mainfile(filepath=sys.argv[1], load_ui=False)
bpy.context.view_layer.update()
gt={}
for o in bpy.data.objects:
    e={'type':o.type,'parent':o.parent.name if o.parent else None,'matrix_world':[list(r) for r in o.matrix_world]}
    if o.type=='MESH':
        me=o.data; e.update(mesh=me.name,nverts=len(me.vertices),nfaces=len(me.polygons),ntris=sum(len(p.vertices)-2 for p in me.polygons),
          v0=list(me.vertices[0].co),face_mats=[p.material_index for p in me.polygons][:12],smooth=[p.use_smooth for p in me.polygons][:4],
          slots=[(s.link, s.material.name if s.material else None) for s in o.material_slots])
    gt[o.name]=e
json.dump(gt,open(sys.argv[2],'w'))
