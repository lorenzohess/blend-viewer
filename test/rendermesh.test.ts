import { describe, expect, it } from 'vitest';
import { buildRenderMesh } from '../src/scene/rendermesh';
import { byName, loadCases, parseFile } from './helpers';

const file = loadCases().find((c) => c.dir === 'blender-5.3' && c.file === 'test_uncompressed.blend')!;

describe('render mesh builder', () => {
  it('flat cube: 24 vertices, axis-aligned normals, two material groups', async () => {
    const s = await parseFile(file.path);
    const m = s.meshes[byName(s, 'Base Plate')!.mesh!];
    const r = buildRenderMesh(m);
    expect(r.positions.length / 3).toBe(24);
    expect(r.index.length).toBe(36);
    for (let i = 0; i < r.normals.length; i += 3) {
      const comps = [r.normals[i], r.normals[i + 1], r.normals[i + 2]].map(Math.abs).sort();
      expect(comps[2]).toBeCloseTo(1, 5);
      expect(comps[1]).toBeCloseTo(0, 5);
    }
    expect(r.groups).toEqual([
      { start: 0, count: 18, materialIndex: 0 },
      { start: 18, count: 18, materialIndex: 1 },
    ]);
    expect(r.bboxMin).toEqual([-1, -1, -1]);
    expect(r.bboxMax).toEqual([1, 1, 1]);
  });

  it('smooth sphere: shares vertices and normals point outwards', async () => {
    const s = await parseFile(file.path);
    const m = s.meshes[byName(s, 'Knob')!.mesh!];
    const r = buildRenderMesh(m);
    expect(r.positions.length / 3).toBe(m.nverts);
    for (let i = 0; i < r.positions.length; i += 3) {
      const len = Math.hypot(r.positions[i], r.positions[i + 1], r.positions[i + 2]);
      const dot = (r.positions[i] * r.normals[i] + r.positions[i + 1] * r.normals[i + 1] + r.positions[i + 2] * r.normals[i + 2]) / len;
      expect(dot).toBeGreaterThan(0.98);
    }
  });

  it('n-gon disc: earcut triangles keep the face winding', async () => {
    const s = await parseFile(file.path);
    const m = s.meshes[byName(s, 'Ngon Disc')!.mesh!];
    expect(m.ntris).toBe(5);
    const r = buildRenderMesh(m);
    expect(r.positions.length / 3).toBe(7);
    const nz = r.normals[2];
    for (let i = 0; i < r.normals.length; i += 3) expect(r.normals[i + 2]).toBeCloseTo(nz, 6);
    // Each triangle's geometric normal agrees with the face normal.
    for (let t = 0; t < r.index.length; t += 3) {
      const [a, b, c] = [r.index[t], r.index[t + 1], r.index[t + 2]].map((i) => [r.positions[i * 3], r.positions[i * 3 + 1]]);
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      expect(Math.sign(cross)).toBe(Math.sign(nz));
    }
  });

  it('every mesh in every test file builds without NaN', async () => {
    for (const c of loadCases()) {
      const s = await parseFile(c.path);
      for (const m of Object.values(s.meshes)) {
        const r = buildRenderMesh(m);
        expect(r.index.length).toBe(m.ntris * 3);
        expect(r.normals.every(Number.isFinite)).toBe(true);
        expect(r.groups.reduce((n, g) => n + g.count, 0)).toBe(r.index.length);
      }
    }
  });
});
