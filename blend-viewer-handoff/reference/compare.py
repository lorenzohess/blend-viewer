import sys, json, numpy as np
import os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from extract import extract
blend, gtpath = sys.argv[1], sys.argv[2]
got = extract(blend); gt = json.load(open(gtpath))
bad = 0
for name, e in gt.items():
    if name.startswith('_'): continue
    g = got.get(name)
    if g is None: print('MISSING', name); bad += 1; continue
    errs = []
    if g['type'] != e['type']: errs.append(f"type {g['type']} vs {e['type']}")
    if g['parent'] != e['parent']: errs.append(f"parent {g['parent']} vs {e['parent']}")
    d = np.abs(np.array(g['matrix_world']) - np.array(e['matrix_world'])).max()
    if d > 1e-4: errs.append(f'matrix diff {d:.4f}')
    if e['type'] == 'MESH':
        for k in ('nverts', 'nfaces', 'ntris', 'face_mats', 'mesh'):
            if g[k] != e[k]: errs.append(f'{k} {g[k]} vs {e[k]}')
        if np.abs(np.array(g['v0']) - e['v0']).max() > 1e-5: errs.append('v0')
        if [tuple(s) for s in g['slots']] != [tuple(s) for s in e['slots']]: errs.append(f"slots {g['slots']} vs {e['slots']}")
        if 'smooth' in e and g['smooth'] != e['smooth']: errs.append(f"smooth {g['smooth']} vs {e['smooth']}")
    if errs: bad += 1; print('FAIL', name, '; '.join(errs))
for m, v in gt.get('_materials', {}).items():
    c = got['_materials'][m]
    exp = v['viewport'] if 'linked' in c['source'] else v['base']
    if np.abs(np.array(c['color']) - exp).max() > 1e-5: bad += 1; print('FAIL material', m, c, v)
print(os.path.basename(blend), 'version', got['_version'], 'failures:', bad)
print('  collections:', json.dumps(got['_collections']))
