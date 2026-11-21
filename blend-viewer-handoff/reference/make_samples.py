import bpy, sys, json
out = sys.argv[1]
bpy.ops.wm.read_factory_settings(use_empty=True)

def mat(name, rgba, viewport=None):
    m = bpy.data.materials.new(name)
    m.diffuse_color = viewport or (0.8, 0.8, 0.8, 1)
    m.use_nodes = True
    m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = rgba
    return m

red = mat("Red Plastic", (0.8, 0.1, 0.1, 1))
blue = mat("Blue Metal", (0.1, 0.2, 0.8, 1), viewport=(0.1, 0.2, 0.8, 1))
green = mat("Green Override", (0.1, 0.7, 0.2, 1))
tex = mat("Textured", (1, 1, 1, 1), viewport=(0.9, 0.6, 0.1, 1))
nt = tex.node_tree
ch = nt.nodes.new("ShaderNodeTexChecker")
nt.links.new(ch.outputs["Color"], nt.nodes["Principled BSDF"].inputs["Base Color"])

col = bpy.data.collections.new("Assembly"); bpy.context.scene.collection.children.link(col)
sub = bpy.data.collections.new("Fasteners"); col.children.link(sub)
hidden_col = bpy.data.collections.new("Hidden Stuff"); bpy.context.scene.collection.children.link(hidden_col)
hidden_col.hide_viewport = True

def move(o, c):
    for x in list(o.users_collection):
        x.objects.unlink(o)
    c.objects.link(o)

bpy.ops.mesh.primitive_cube_add(size=2, location=(0.5, 0, 0)); base = bpy.context.object; base.name = "Base Plate"
base.scale = (3, 2, 0.2); base.rotation_euler = (0.1, 0.2, 0.3)
base.data.materials.append(red); base.data.materials.append(blue)
for i, p in enumerate(base.data.polygons):
    p.material_index = i % 2
move(base, col)

bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=0.2, depth=1, location=(1, 0, 1)); bolt = bpy.context.object; bolt.name = "Bolt.001"
bolt.data.materials.append(blue); move(bolt, sub)
bpy.ops.object.select_all(action='DESELECT'); bolt.select_set(True); base.select_set(True)
bpy.context.view_layer.objects.active = base
bpy.ops.object.parent_set(type='OBJECT', keep_transform=True)  # gives non-identity parentinv

bolt2 = bolt.copy(); bolt2.name = "Bolt.002"; bolt2.location = (-1, 0, 1); sub.objects.link(bolt2)  # shares mesh data
bolt2.rotation_mode = 'QUATERNION'; bolt2.rotation_quaternion = (0.9, 0.1, 0.3, 0.2)
bolt2.material_slots[0].link = 'OBJECT'; bolt2.material_slots[0].material = green  # object-level override

bpy.ops.mesh.primitive_uv_sphere_add(location=(0, 3, 1)); sph = bpy.context.object; sph.name = "Knob"
bpy.ops.object.shade_smooth(); sph.modifiers.new("Sub", "SUBSURF")
sph.rotation_mode = 'ZXY'; sph.rotation_euler = (0.5, 1.0, 1.5)
sph.delta_location = (0, 0, 0.5); sph.delta_scale = (1, 1, 1.5); sph.data.materials.append(tex)

bpy.ops.object.empty_add(location=(0, 0, 3)); emp = bpy.context.object; emp.name = "Group Empty"
emp.rotation_mode = 'AXIS_ANGLE'; emp.rotation_axis_angle = (0.7, 0, 0, 1)
bpy.ops.mesh.primitive_cone_add(location=(0, 0, 1)); cone = bpy.context.object; cone.name = "Child Of Empty"; cone.parent = emp
bpy.ops.mesh.primitive_grid_add(location=(0, 0, 1)); g = bpy.context.object; g.name = "Grandchild Grid"; g.parent = cone; g.scale = (0.3, 0.3, 0.3)
bpy.ops.curve.primitive_bezier_curve_add(location=(2, 2, 0)); bpy.context.object.name = "Cable"
bpy.ops.object.text_add(location=(0, -3, 0)); bpy.context.object.name = "Label"
bpy.ops.mesh.primitive_monkey_add(location=(4, 0, 0)); bpy.context.object.name = "NoMaterial Monkey"
bpy.ops.mesh.primitive_circle_add(vertices=7, fill_type='NGON', location=(-4, 0, 0)); bpy.context.object.name = "Ngon Disc"
bpy.ops.mesh.primitive_torus_add(location=(0, -6, 0)); t = bpy.context.object; t.name = "Hidden Torus"; move(t, hidden_col)
bpy.ops.mesh.primitive_ico_sphere_add(location=(0, 6, 0)); h = bpy.context.object; h.name = "Eye-Hidden Ico"; h.hide_set(True)

sub.instance_offset = (0.5, 0, 0)
inst = bpy.data.objects.new("Fasteners Instance", None); bpy.context.scene.collection.objects.link(inst)
inst.instance_type = 'COLLECTION'; inst.instance_collection = sub; inst.location = (8, 0, 0); inst.rotation_euler = (0, 0, 0.5)

bpy.context.view_layer.update()
dg = bpy.context.evaluated_depsgraph_get()
instances = [dict(obj=i.object.original.name, parent=i.parent.original.name, matrix_world=[list(r) for r in i.matrix_world])
             for i in dg.object_instances if i.is_instance]
gt = {'_instances': instances}
for o in bpy.data.objects:
    e = {'type': o.type, 'parent': o.parent.name if o.parent else None,
         'matrix_world': [list(r) for r in o.matrix_world],
         'collections': [c.name for c in o.users_collection]}
    if o.type == 'MESH':
        me = o.data
        e.update(mesh=me.name, nverts=len(me.vertices), nfaces=len(me.polygons),
                 ntris=sum(len(p.vertices) - 2 for p in me.polygons), v0=list(me.vertices[0].co),
                 face_mats=[p.material_index for p in me.polygons][:12],
                 smooth=[p.use_smooth for p in me.polygons][:4],
                 slots=[(s.link, s.material.name if s.material else None) for s in o.material_slots])
    gt[o.name] = e
gt['_materials'] = {m.name: {'base': list(m.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value),
                             'viewport': list(m.diffuse_color)} for m in bpy.data.materials}
json.dump(gt, open(out + '/ground_truth.json', 'w'), indent=1)
bpy.ops.wm.save_as_mainfile(filepath=out + "/test_uncompressed.blend", compress=False)
bpy.ops.wm.save_as_mainfile(filepath=out + "/test_compressed.blend", compress=True)
print("ok", bpy.app.version_string, len(bpy.data.objects))
