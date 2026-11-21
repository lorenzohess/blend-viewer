"""Make a large .blend stress-test file from a small one, without Blender.

Copies the "NoMaterial Monkey" object and its "Suzanne" mesh N times, each with a
unique ID address, a unique name and its own grid position, and links every copy
into the scene's master collection and first view layer (Base flag 0xD6 = visible).
The DATA blocks inside each copy keep their original addresses, so the result also
exercises the "addresses repeat across ID groups" rule (HANDOFF.md section 4.4).

Usage:
  python3 -I scripts/make-big-blend.py SOURCE.blend OUTPUT.blend [--mb 200] [--zstd OUTPUT_ZSTD.blend]
Needs numpy (and zstandard for --zstd). The output is only for testing this viewer.
"""
import argparse, os, struct, sys

here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(here, '..', 'blend-viewer-handoff', 'reference'))
from blendref import Blend  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument('source')
ap.add_argument('output')
ap.add_argument('--mb', type=float, default=200)
ap.add_argument('--zstd')
ap.add_argument('--object', default='NoMaterial Monkey')
args = ap.parse_args()

b = Blend(args.source)
d = bytearray(b.data)
e = b.end
P = 'Q' if b.ptr == 8 else 'I'
hs = 32 if b.large else (24 if b.ptr == 8 else 20)


def head(blk):
    return blk['off'] - hs


def group_blocks(i):
    """Block index i (an ID block) plus the DATA blocks that follow it."""
    out = [i]
    j = i + 1
    while j < len(b.bl) and b.bl[j]['code'] == b'DATA':
        out.append(j)
        j += 1
    return out


def raw_block(blk):
    return bytes(d[head(blk):blk['off'] + blk['len']])


def make_header(code, sdna, old, length, nr):
    code = code.ljust(4, b'\0')
    if b.large:
        return code + struct.pack(e + 'iQqq', sdna, old, length, nr)
    if b.ptr == 8:
        return code + struct.pack(e + 'iQii', length, old, sdna, nr)
    return code + struct.pack(e + 'iIii', length, old, sdna, nr)


def field_off(sname, path):
    off = 0
    for i, p in enumerate(path.split('.')):
        t, isptr, cnt, o, sz = b.fields(sname)[p]
        off += o
        if i < len(path.split('.')) - 1:
            sname = t
    return off, cnt


def put_name(buf, base, sname, name):
    off, cnt = field_off(sname, 'id.name')
    raw = name.encode()[:cnt - 1]
    buf[base + off:base + off + cnt] = raw + b'\0' * (cnt - len(raw))


def put_ptr(buf, base, sname, path, value):
    off, _ = field_off(sname, path)
    struct.pack_into(e + P, buf, base + off, value)


def get_ptr(buf, base, sname, path):
    off, _ = field_off(sname, path)
    return struct.unpack_from(e + P, buf, base + off)[0]


# ---------------------------------------------------------------- locate sources
ob_i = next(i for i, x in enumerate(b.bl) if x['code'] == b'OB' and b.get('Object', x['off'], 'id.name')[2:] == args.object)
ob = b.bl[ob_i]
me_ptr = b.get('Object', ob['off'], 'data')
me_i = next(i for i, x in enumerate(b.bl) if x['code'] == b'ME' and x['old'] == me_ptr)
ob_group = group_blocks(ob_i)
me_group = group_blocks(me_i)
copy_size = sum(hs + b.bl[i]['len'] for i in ob_group + me_group)
n = max(1, int(args.mb * 1024 * 1024 / copy_size))
print(f'one copy = {copy_size} bytes, making {n} copies', file=sys.stderr)

sc_i = next(i for i, x in enumerate(b.bl) if x['code'] == b'SC')
sc = b.bl[sc_i]
sc_group = group_blocks(sc_i)
mc = b.resolve(b.get('Scene', sc['off'], 'master_collection'), sc['group'])
vl = b.resolve(b.get('ListBase', sc['off'] + b.fields('Scene')['view_layers'][3], 'first'), sc['group'])

used = {x['old'] for x in b.bl}
next_addr = [0x7E0000000000]


def new_addr():
    while True:
        next_addr[0] += 0x1000
        if next_addr[0] not in used:
            used.add(next_addr[0])
            return next_addr[0]


# ------------------------------------------------------------------ build copies
copies = []           # bytes for new OB+ME groups (appended before DNA1)
new_obs = []
ob_hdr_struct = b.sname(ob)
for k in range(n):
    ob_addr, me_addr = new_addr(), new_addr()
    new_obs.append(ob_addr)
    # mesh group
    for gi, i in enumerate(me_group):
        blk = b.bl[i]
        payload = bytearray(d[blk['off']:blk['off'] + blk['len']])
        old = blk['old']
        if gi == 0:
            put_name(payload, 0, 'Mesh', f'MESuzanne.{k:05d}')
            old = me_addr
        copies.append(make_header(blk['code'], blk['sdna'], old, blk['len'], blk['nr']) + payload)
    # object group
    for gi, i in enumerate(ob_group):
        blk = b.bl[i]
        payload = bytearray(d[blk['off']:blk['off'] + blk['len']])
        old = blk['old']
        if gi == 0:
            put_name(payload, 0, 'Object', f'OBMonkey.{k:05d}')
            put_ptr(payload, 0, 'Object', 'data', me_addr)
            put_ptr(payload, 0, 'Object', 'parent', 0)
            lo, _ = field_off('Object', 'loc')
            struct.pack_into(e + '3f', payload, lo, 10 + (k % 60) * 3.0, -(k // 60) * 3.0, 0.0)
            old = ob_addr
        copies.append(make_header(blk['code'], blk['sdna'], old, blk['len'], blk['nr']) + payload)


def chain(list_off_abs, item_struct, make_item):
    """Append items to a ListBase stored at absolute offset list_off_abs (in d). Returns new DATA block bytes."""
    first, last = struct.unpack_from(e + P + P, d, list_off_abs)
    addrs = [new_addr() for _ in range(n)]
    size = b.tlen[b.types.index(item_struct)]
    sdna = b.sidx[item_struct]
    out = []
    if last:
        lb = b.resolve(last, sc['group'])
        struct.pack_into(e + P, d, lb['off'], addrs[0])  # old last.next
    else:
        struct.pack_into(e + P, d, list_off_abs, addrs[0])
    struct.pack_into(e + P, d, list_off_abs + b.ptr, addrs[-1])
    for k, a in enumerate(addrs):
        item = bytearray(size)
        struct.pack_into(e + P, item, 0, addrs[k + 1] if k + 1 < n else 0)
        struct.pack_into(e + P, item, b.ptr, addrs[k - 1] if k > 0 else last)
        make_item(item, k)
        out.append(make_header(b'DATA', sdna, a, size, 1) + item)
    return out


def co_item(item, k):
    off, _ = field_off('CollectionObject', 'ob')
    struct.pack_into(e + P, item, off, new_obs[k])


def base_item(item, k):
    off, _ = field_off('Base', 'object')
    struct.pack_into(e + P, item, off, new_obs[k])
    off, _ = field_off('Base', 'flag')
    struct.pack_into(e + 'h', item, off, 0xD6)


co_blocks = chain(mc['off'] + b.fields('Collection')['gobject'][3], 'CollectionObject', co_item)
base_blocks = chain(vl['off'] + b.fields('ViewLayer')['object_bases'][3], 'Base', base_item)

# ----------------------------------------------------------------------- write
dna_i = next(i for i, x in enumerate(b.bl) if x['code'] == b'DNA1')
with open(args.output, 'wb') as f:
    f.write(bytes(d[:b.hdr]))
    for i, blk in enumerate(b.bl):
        if i == dna_i:
            for c in copies:
                f.write(c)
        if blk['code'] == b'ENDB':
            f.write(raw_block(blk))
            break
        f.write(raw_block(blk))
        if i == sc_group[-1]:
            for c in co_blocks + base_blocks:
                f.write(c)
size = os.path.getsize(args.output)
print(f'wrote {args.output}: {size / 1e6:.1f} MB, {n} extra objects', file=sys.stderr)
if args.zstd:
    import zstandard
    with open(args.output, 'rb') as src, open(args.zstd, 'wb') as dst:
        zstandard.ZstdCompressor(level=3).copy_stream(src, dst)
    print(f'wrote {args.zstd}: {os.path.getsize(args.zstd) / 1e6:.1f} MB', file=sys.stderr)
