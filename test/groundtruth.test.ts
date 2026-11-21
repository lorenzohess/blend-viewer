/**
 * Acceptance tests for milestones M1-M4 and M7 (HANDOFF.md §6), run against every
 * test-files/<dir>/*.blend and its ground_truth.json.
 */
import { describe, expect, it } from 'vitest';
import { fromRows } from '../src/scene/math';
import type { CollectionNode } from '../src/scene/types';
import { byName, loadCases, maxAbsDiff, parseFile } from './helpers';

const cases = loadCases();

describe('test files are present', () => {
  it('finds at least the 7 handoff files', () => {
    expect(cases.length).toBeGreaterThanOrEqual(7);
  });
});

/** Strip the tree down to names, hidden flags and object names, for comparison with §7. */
function shape(n: CollectionNode, names: (i: number) => string): unknown {
  return {
    name: n.name,
    hidden: n.hidden,
    objects: n.objects.map(names).sort(),
    children: n.children.map((c) => shape(c, names)),
  };
}

for (const c of cases) {
  describe(`${c.dir}/${c.file}`, () => {
    const gtObjects = Object.entries(c.gt.objects);

    it('M1: object names, types and parents match', async () => {
      const s = await parseFile(c.path);
      expect(s.objects.map((o) => o.name).sort()).toEqual(gtObjects.map(([n]) => n).sort());
      for (const [name, e] of gtObjects) {
        const o = byName(s, name)!;
        expect({ name, type: o.type, parent: o.parent }).toEqual({ name, type: e.type, parent: e.parent });
      }
    });

    it('M2: world matrices match to 1e-4', async () => {
      const s = await parseFile(c.path);
      for (const [name, e] of gtObjects) {
        const d = maxAbsDiff(byName(s, name)!.worldMatrix, fromRows(e.matrix_world));
        expect(d, `${name} matrix diff`).toBeLessThan(1e-4);
      }
    });

    it('M2: collection membership matches', async () => {
      const s = await parseFile(c.path);
      for (const [name, e] of gtObjects) {
        if (!e.collections) continue;
        expect(byName(s, name)!.collections.slice().sort(), name).toEqual(e.collections.slice().sort());
      }
    });

    it('M3: mesh geometry matches', async () => {
      const s = await parseFile(c.path);
      for (const [name, e] of gtObjects) {
        if (e.type !== 'MESH') continue;
        const o = byName(s, name)!;
        expect(o.mesh, `${name} has a mesh`).toBeDefined();
        const m = s.meshes[o.mesh!];
        expect({ name, mesh: m.name, nverts: m.nverts, nfaces: m.nfaces, ntris: m.ntris }).toEqual({
          name, mesh: e.mesh, nverts: e.nverts, nfaces: e.nfaces, ntris: e.ntris,
        });
        expect(m.triangles.length).toBe(m.ntris * 3);
        expect(maxAbsDiff(m.positions.subarray(0, 3), e.v0!), `${name} v0`).toBeLessThan(1e-5);
        expect(Array.from(m.faceMaterial.subarray(0, 12)), `${name} face_mats`).toEqual(e.face_mats);
        if (e.smooth) expect(Array.from(m.faceSmooth.subarray(0, 4), (x) => x === 1), `${name} smooth`).toEqual(e.smooth);
        // Every triangle index is a valid vertex.
        let maxIdx = 0;
        for (const v of m.triangles) maxIdx = Math.max(maxIdx, v);
        expect(maxIdx).toBeLessThan(m.nverts);
      }
    });

    it('M4: material slots match', async () => {
      const s = await parseFile(c.path);
      for (const [name, e] of gtObjects) {
        if (e.type !== 'MESH') continue;
        const o = byName(s, name)!;
        const got = o.materialSlots.map((k, i) => [o.slotLinks[i], k ? s.materials[k].name : null]);
        expect(got, `${name} slots`).toEqual(e.slots);
      }
    });

    it('M4: material colours match', async () => {
      const s = await parseFile(c.path);
      for (const [name, v] of Object.entries(c.gt.materials ?? {})) {
        const m = s.materials[name];
        expect(m, `material ${name}`).toBeDefined();
        const expected = m.source.includes('linked') ? v.viewport : v.base;
        expect(maxAbsDiff(m.color, expected), `${name} (${m.source})`).toBeLessThan(1e-5);
      }
      if (c.gt.materials?.Textured) {
        expect(s.materials.Textured.source).toContain('linked');
      }
    });

    if (c.gt.instances) {
      it('M7: collection instances match _instances', async () => {
        const s = await parseFile(c.path);
        // Text objects also produce one instance per character in Blender; those are ignored (§4.10).
        const expected = c.gt.instances!.filter((i) => c.gt.objects[i.parent]?.type !== 'FONT');
        const got = s.instances.map((i) => ({ obj: s.objects[i.object].name, parent: s.objects[i.instancer].name, m: i.matrix }));
        expect(got.map((g) => `${g.parent}/${g.obj}`).sort()).toEqual(expected.map((e) => `${e.parent}/${e.obj}`).sort());
        for (const e of expected) {
          const g = got.find((x) => x.obj === e.obj && x.parent === e.parent)!;
          expect(maxAbsDiff(g.m, fromRows(e.matrix_world)), `${e.obj} instance matrix`).toBeLessThan(1e-4);
        }
      });
    }

    if (c.gt.objects['Base Plate']) {
      it('M2: collection tree matches §7', async () => {
        const s = await parseFile(c.path);
        const names = (i: number) => s.objects[i].name;
        expect(shape(s.collections, names)).toEqual({
          name: 'Scene Collection',
          hidden: false,
          objects: ['Cable', 'Child Of Empty', 'Eye-Hidden Ico', 'Fasteners Instance', 'Grandchild Grid', 'Group Empty',
            'Knob', 'Label', 'Ngon Disc', 'NoMaterial Monkey'],
          children: [
            {
              name: 'Assembly', hidden: false, objects: ['Base Plate'],
              children: [{ name: 'Fasteners', hidden: false, objects: ['Bolt.001', 'Bolt.002'], children: [] }],
            },
            { name: 'Hidden Stuff', hidden: true, objects: ['Hidden Torus'], children: [] },
          ],
        });
      });

      it('initial visibility: Hidden Torus and Eye-Hidden Ico start hidden, the rest visible', async () => {
        const s = await parseFile(c.path);
        const hidden = s.objects.filter((o) => !o.visible).map((o) => o.name).sort();
        expect(hidden).toEqual(['Eye-Hidden Ico', 'Hidden Torus']);
        expect(s.objects.filter((o) => o.type === 'MESH').length).toBe(10);
      });

      it('lists the Knob modifier as not applied and shares the Bolt mesh', async () => {
        const s = await parseFile(c.path);
        const knob = byName(s, 'Knob')!;
        expect(knob.modifiers).toEqual([{ name: 'Sub', kind: 'Subdivision Surface', struct: 'SubsurfModifierData', enabled: true }]);
        expect(s.warnings.some((w) => w.includes('modifiers'))).toBe(true);
        const b1 = byName(s, 'Bolt.001')!, b2 = byName(s, 'Bolt.002')!;
        expect(b1.mesh).toBe(b2.mesh);
        expect(s.meshes[b1.mesh!].users).toBe(2);
        expect(byName(s, 'Fasteners Instance')!.instanceCollection).toBe('Fasteners');
        expect(byName(s, 'Cable')!.notes.join(' ')).toContain('geometry is generated by Blender');
      });
    }
  });
}

describe('compressed and uncompressed files give the same scene', () => {
  const dirs = [...new Set(cases.map((c) => c.dir))];
  for (const dir of dirs) {
    const pair = cases.filter((c) => c.dir === dir);
    const comp = pair.find((c) => c.file.includes('compressed') && !c.file.includes('uncompressed'));
    const unc = pair.find((c) => c.file.includes('uncompressed'));
    if (!comp || !unc) continue;
    it(dir, async () => {
      const a = await parseFile(comp.path), b = await parseFile(unc.path);
      expect(a.compression).toBe('zstd');
      expect(b.compression).toBe('none');
      const strip = (s: typeof a) => JSON.stringify({ ...s, compression: '', stats: { ...s.stats, parseMs: 0 } }, (_k, v) =>
        ArrayBuffer.isView(v) ? Array.from(v as Float32Array) : v);
      expect(strip(a)).toBe(strip(b));
    });
  }
});
