import bpy, json, sys
bpy.ops.wm.read_factory_settings(use_empty=True)
gt={}
for i,mode in enumerate(['XYZ','ZXY','QUATERNION','AXIS_ANGLE','YZX']):
    bpy.ops.mesh.primitive_cube_add(location=(i*3,0,0)); o=bpy.context.object; o.name=f"D_{mode}"
    o.rotation_mode=mode
    if mode=='QUATERNION': o.rotation_quaternion=(0.8,0.3,0.2,0.1); o.delta_rotation_quaternion=(0.9,0.0,0.4,0.1)
    elif mode=='AXIS_ANGLE': o.rotation_axis_angle=(0.6,0.2,0.5,1.0)
    else: o.rotation_euler=(0.3,0.7,1.1); o.delta_rotation_euler=(0.4,-0.2,0.9)
    if mode!='AXIS_ANGLE': pass
bpy.context.view_layer.update()
for o in bpy.data.objects: gt[o.name]={'type':o.type,'parent':None,'matrix_world':[list(r) for r in o.matrix_world],'mesh':o.data.name,'nverts':len(o.data.vertices),'nfaces':6,'ntris':12,'v0':list(o.data.vertices[0].co),'face_mats':[0]*6,'slots':[],'smooth':[False]*4}
json.dump(gt,open(sys.argv[1]+'/ground_truth.json','w'))
bpy.ops.wm.save_as_mainfile(filepath=sys.argv[1]+'/drot.blend')
