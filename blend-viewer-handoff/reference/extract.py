"""Prototype extractor: .blend -> scene description (names, hierarchy, world matrices, triangles, colors).
Validates the algorithm described in the handoff plan. Python reference only."""
import sys, struct, math, json
import numpy as np
import os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from blendref import Blend

CD_MVERT, CD_MFACE, CD_PROP_INT32, CD_MPOLY, CD_MLOOP, CD_PROP_FLOAT3, CD_PROP_BOOL = 0, 4, 11, 25, 26, 48, 50
OB_TYPES = {0: 'EMPTY', 1: 'MESH', 2: 'CURVE', 3: 'SURF', 4: 'FONT', 5: 'MBALL', 10: 'LAMP', 11: 'CAMERA'}

def struct_size(b, name): return b.tlen[b.types.index(name)]

def listbase(b, off_of_listbase, group, item_struct):
    """Yield (block, offset) for each element in a ListBase (first/last)."""
    ptr = b.get('ListBase', off_of_listbase, 'first'); seen = set()
    while ptr and ptr not in seen:
        seen.add(ptr); blk = b.resolve(ptr, group)
        if blk is None: break
        yield blk
        ptr = b.get(item_struct, blk['off'], 'next')

def array(b, blk, dtype, count, comps=1):
    a = np.frombuffer(b.data, dtype=np.dtype(dtype).newbyteorder(b.end), count=count * comps, offset=blk['off'])
    return a.reshape(count, comps) if comps > 1 else a

# ---------- transforms ----------
def euler_to_mat(rot, mode):
    x, y, z = rot
    cx, sx, cy, sy, cz, sz = math.cos(x), math.sin(x), math.cos(y), math.sin(y), math.cos(z), math.sin(z)
    R = {'X': np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]]),
         'Y': np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]]),
         'Z': np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])}
    order = {1: 'XYZ', 2: 'XZY', 3: 'YXZ', 4: 'YZX', 5: 'ZXY', 6: 'ZYX'}[mode]
    M = np.eye(3)
    for axis in order:          # first letter applied first -> leftmost multiply last
        M = R[axis] @ M
    return M

def quat_to_mat(q):
    w, x, y, z = q; n = math.sqrt(w*w + x*x + y*y + z*z) or 1; w, x, y, z = w/n, x/n, y/n, z/n
    return np.array([[1-2*(y*y+z*z), 2*(x*y-w*z), 2*(x*z+w*y)],
                     [2*(x*y+w*z), 1-2*(x*x+z*z), 2*(y*z-w*x)],
                     [2*(x*z-w*y), 2*(y*z+w*x), 1-2*(x*x+y*y)]])

def axis_angle_to_mat(axis, ang):
    a = np.array(axis, float); n = np.linalg.norm(a)
    if n == 0: return np.eye(3)
    a /= n; s, c = math.sin(ang/2), math.cos(ang/2)
    return quat_to_mat((c, *(a*s)))

def rot_mat(b, o, prefix=''):
    mode = b.get('Object', o, 'rotmode')
    if mode == 0: return quat_to_mat(b.get('Object', o, prefix + 'quat'))
    if mode == -1: return axis_angle_to_mat(b.get('Object', o, prefix + 'rotAxis'), b.get('Object', o, prefix + 'rotAngle'))
    return euler_to_mat(b.get('Object', o, prefix + 'rot'), mode)

def local_matrix(b, o):
    loc = np.add(b.get('Object', o, 'loc'), b.get('Object', o, 'dloc'))
    scale = np.multiply(b.get('Object', o, 'size'), b.get('Object', o, 'dscale'))
    R = rot_mat(b, o, 'd') @ rot_mat(b, o)
    M = np.eye(4); M[:3, :3] = R @ np.diag(scale); M[:3, 3] = loc
    return M

def mat4(b, o, field):  # Blender stores float[4][4] column-major-ish: m[col][row]
    return np.array(b.get('Object', o, field), float).reshape(4, 4).T

# ---------- mesh ----------
def mesh_geometry(b, blk):
    o, g = blk['off'], blk['group']
    nv, np_, nl = b.get('Mesh', o, 'totvert'), b.get('Mesh', o, 'totpoly'), b.get('Mesh', o, 'totloop')
    pos = corner_vert = poly_off = mat_idx = sharp = None
    # 1) Blender 5.0+: AttributeStorage
    if b.has('Mesh', 'attribute_storage') and b.get('Mesh', o, 'attribute_storage.dna_attributes_num'):
        n = b.get('Mesh', o, 'attribute_storage.dna_attributes_num')
        ab = b.resolve(b.get('Mesh', o, 'attribute_storage.dna_attributes'), g); asz = struct_size(b, 'Attribute')
        for i in range(n):
            ao = ab['off'] + i * asz
            name = b.cstr(b.resolve(b.get('Attribute', ao, 'name'), g))
            dtype, domain, stype = b.get('Attribute', ao, 'data_type'), b.get('Attribute', ao, 'domain'), b.get('Attribute', ao, 'storage_type')
            db = b.resolve(b.get('Attribute', ao, 'data'), g)
            if stype == 0:   # Array
                size = b.get('AttributeArray', db['off'], 'size'); raw = b.resolve(b.get('AttributeArray', db['off'], 'data'), g)
                if name == 'position': pos = array(b, raw, 'f4', size, 3)
                elif name == '.corner_vert': corner_vert = array(b, raw, 'i4', size)
                elif name == 'material_index': mat_idx = array(b, raw, 'i4', size)
                elif name == 'sharp_face': sharp = array(b, raw, 'u1', size).astype(bool)
            else:            # Single value for whole domain
                raw = b.resolve(b.get('AttributeSingle', db['off'], 'data'), g)
                if name == 'material_index': mat_idx = np.full(np_, array(b, raw, 'i4', 1)[0])
                elif name == 'sharp_face': sharp = np.full(np_, bool(b.data[raw['off']]))
    else:
        # 2) CustomData layers (2.63 .. 4.5)
        def layers(cdname):
            n = b.get('Mesh', o, cdname + '.totlayer'); lb = b.resolve(b.get('Mesh', o, cdname + '.layers'), g)
            sz = struct_size(b, 'CustomDataLayer')
            for i in range(n):
                lo = lb['off'] + i * sz
                yield b.get('CustomDataLayer', lo, 'type'), b.get('CustomDataLayer', lo, 'name'), b.resolve(b.get('CustomDataLayer', lo, 'data'), g)
        mpoly = None
        for t, name, d in layers('vdata'):
            if t == CD_PROP_FLOAT3 and name == 'position': pos = array(b, d, 'f4', nv, 3)
            elif t == CD_MVERT:   # struct MVert { float co[3]; ... } -- stride from DNA
                stride = struct_size(b, 'MVert'); pos = np.array([struct.unpack_from(b.end + '3f', b.data, d['off'] + i * stride) for i in range(nv)], 'f4')
        for t, name, d in layers('ldata'):
            if t == CD_PROP_INT32 and name == '.corner_vert': corner_vert = array(b, d, 'i4', nl)
            elif t == CD_MLOOP: corner_vert = np.array([struct.unpack_from(b.end + 'I', b.data, d['off'] + i * struct_size(b, 'MLoop'))[0] for i in range(nl)])
        for t, name, d in layers('pdata'):
            if t == CD_PROP_INT32 and name == 'material_index': mat_idx = array(b, d, 'i4', np_)
            elif t == CD_PROP_BOOL and name == 'sharp_face': sharp = array(b, d, 'u1', np_).astype(bool)
            elif t == CD_MPOLY: mpoly = d
        if mpoly is not None:  # struct MPoly { int loopstart; int totloop; short mat_nr; char flag; }
            st = struct_size(b, 'MPoly'); f = b.fields('MPoly')
            ls = [struct.unpack_from(b.end + 'i', b.data, mpoly['off'] + i*st + f['loopstart'][3])[0] for i in range(np_)]
            poly_off = np.array(ls + [nl])
            mat_idx = np.array([struct.unpack_from(b.end + 'h', b.data, mpoly['off'] + i*st + f['mat_nr'][3])[0] for i in range(np_)])
            sharp = np.array([not (b.data[mpoly['off'] + i*st + f['flag'][3]] & 1) for i in range(np_)])
    if poly_off is None and np_:
        pb = b.resolve(b.get('Mesh', o, 'poly_offset_indices'), g); poly_off = array(b, pb, 'i4', np_ + 1)
    if pos is None: return None
    if mat_idx is None: mat_idx = np.zeros(np_, int)
    if sharp is None: sharp = np.zeros(np_, bool)   # attribute absent => no face is sharp => all smooth
    tris, tri_mat = [], []
    for f in range(np_):
        a, z = poly_off[f], poly_off[f + 1]; vs = corner_vert[a:z]
        for k in range(1, len(vs) - 1):         # fan triangulation (fine for convex n-gons; use earcut for concave)
            tris.append((vs[0], vs[k], vs[k + 1])); tri_mat.append(mat_idx[f])
    return dict(pos=pos, nverts=nv, nfaces=np_, tris=np.array(tris), tri_mat=np.array(tri_mat), sharp=sharp, poly_off=poly_off, mat_idx=mat_idx)

# ---------- materials ----------
def material_color(b, mblk):
    o, g = mblk['off'], mblk['group']
    viewport = [b.get('Material', o, k) for k in 'rgba']
    nt_ptr = b.get('Material', o, 'nodetree'); use_nodes = b.get('Material', o, 'use_nodes') if b.has('Material', 'use_nodes') else 1
    ntb = b.resolve(nt_ptr, g)
    if not ntb or not use_nodes: return viewport, 'viewport'
    ng = ntb['group']; nto = ntb['off']
    linked_to = {b.get('bNodeLink', lk['off'], 'tosock') for lk in listbase(b, nto + b.fields('bNodeTree')['links'][3], ng, 'bNodeLink')}
    for nb in listbase(b, nto + b.fields('bNodeTree')['nodes'][3], ng, 'bNode'):
        idname = b.get('bNode', nb['off'], 'idname')
        if idname in ('ShaderNodeBsdfPrincipled', 'ShaderNodeBsdfDiffuse', 'ShaderNodeEmission'):
            for sb in listbase(b, nb['off'] + b.fields('bNode')['inputs'][3], ng, 'bNodeSocket'):
                ident = b.get('bNodeSocket', sb['off'], 'identifier')
                if ident in ('Base Color', 'Color'):
                    if sb['old'] in linked_to: return viewport, 'viewport (base color is linked to a texture)'
                    vb = b.resolve(b.get('bNodeSocket', sb['off'], 'default_value'), ng)
                    return list(struct.unpack_from(b.end + '4f', b.data, vb['off'])), 'node:' + idname
    return viewport, 'viewport'

def ptr_array(b, ptr, group, n):
    blk = b.resolve(ptr, group)
    if not blk or n == 0: return []
    return [struct.unpack_from(b.end + ('Q' if b.ptr == 8 else 'I'), b.data, blk['off'] + i * b.ptr)[0] for i in range(n)]

# ---------- scene ----------
def extract(path):
    b = Blend(path)
    objs = {}
    for blk in [x for x in b.bl if x['code'] == b'OB']:
        o = blk['off']
        objs[blk['old']] = dict(blk=blk, name=b.get('Object', o, 'id.name')[2:], type=OB_TYPES.get(b.get('Object', o, 'type'), '?'),
                                parent=b.get('Object', o, 'parent'), data=b.get('Object', o, 'data'))
    def world(ob):
        if 'world' in ob: return ob['world']
        o = ob['blk']['off']; M = local_matrix(b, o)
        if ob['parent'] in objs: M = world(objs[ob['parent']]) @ mat4(b, o, 'parentinv') @ M
        ob['world'] = M; return M
    mats = {x['old']: x for x in b.bl if x['code'] == b'MA'}
    out = {}
    for ob in objs.values():
        e = dict(type=ob['type'], parent=objs[ob['parent']]['name'] if ob['parent'] in objs else None, matrix_world=world(ob).tolist())
        if ob['type'] == 'MESH':
            meblk = b.ids[ob['data']]; geo = mesh_geometry(b, meblk)
            o = ob['blk']['off']; g = ob['blk']['group']
            totcol = b.get('Object', o, 'totcol')
            ob_mats = ptr_array(b, b.get('Object', o, 'mat'), g, totcol)
            mb = b.resolve(b.get('Object', o, 'matbits'), g)
            bits = list(b.data[mb['off']:mb['off'] + totcol]) if mb else [0] * totcol
            me_mats = ptr_array(b, b.get('Mesh', meblk['off'], 'mat'), meblk['group'], b.get('Mesh', meblk['off'], 'totcol'))
            slots = []
            for i in range(max(totcol, len(me_mats))):
                p = ob_mats[i] if i < len(ob_mats) and i < len(bits) and bits[i] else (me_mats[i] if i < len(me_mats) else 0)
                slots.append(('OBJECT' if i < len(bits) and bits[i] else 'DATA', b.get('Material', mats[p]['off'], 'id.name')[2:] if p in mats else None))
            e.update(mesh=b.get('Mesh', meblk['off'], 'id.name')[2:], nverts=geo['nverts'], nfaces=geo['nfaces'], ntris=len(geo['tris']),
                     v0=geo['pos'][0].tolist(), face_mats=geo['mat_idx'][:12].tolist(), smooth=(~geo['sharp'][:4]).tolist(), slots=slots)
        out[ob['name']] = e
    out['_materials'] = {}
    for p, m in mats.items():
        c, src = material_color(b, m); out['_materials'][b.get('Material', m['off'], 'id.name')[2:]] = dict(color=c, source=src)
    # collections: scene master collection -> children
    sc = [x for x in b.bl if x['code'] == b'SC'][0]
    mc = b.resolve(b.get('Scene', sc['off'], 'master_collection'), sc['group'])
    def coll_tree(cblk):
        co = cblk['off']; g = cblk['group']
        node = dict(name=b.get('Collection', co, 'id.name')[2:], flag=b.get('Collection', co, 'flag'), objects=[], children=[])
        for it in listbase(b, co + b.fields('Collection')['gobject'][3], g, 'CollectionObject'):
            op = b.get('CollectionObject', it['off'], 'ob'); node['objects'].append(objs[op]['name'] if op in objs else '?')
        for it in listbase(b, co + b.fields('Collection')['children'][3], g, 'CollectionChild'):
            cp = b.get('CollectionChild', it['off'], 'collection'); node['children'].append(coll_tree(b.ids[cp]))
        return node
    out['_collections'] = coll_tree(mc)
    out['_version'] = b.version
    return out

if __name__ == '__main__':
    print(json.dumps(extract(sys.argv[1]), indent=1, default=str)[:4000])
