/**
 * Optional cross-check against the Python reference (reference/extract.py).
 * Runs only when BLEND_EXTRA_DIR points at a folder of .blend files:
 *
 *   BLEND_EXTRA_DIR=/path/to/blends npm test
 *
 * Needs python3 with numpy and zstandard.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fromRows } from '../src/scene/math';
import { byName, maxAbsDiff, parseFile } from './helpers';

const dir = process.env.BLEND_EXTRA_DIR;
const files = dir ? readdirSync(dir).filter((f) => /\.blend\d?$/.test(f)).sort().map((f) => resolve(join(dir, f))) : [];
type Ref = Record<string, any>;
let refs: Record<string, Ref> = {};
if (files.length) {
  const py = process.env.PYTHON ?? 'python3';
  refs = JSON.parse(execFileSync(py, ['-I', 'scripts/ref_dump.py', ...files], { maxBuffer: 1 << 28 }).toString());
}

describe.runIf(files.length > 0)('cross-check with the Python reference', () => {
  for (const f of files) {
    it(f.split('/').pop()!, async () => {
      const ref = refs[f];
      if (ref._error) {
        console.warn(`reference failed on ${f}: ${ref._error}; only checking that the viewer parses it`);
        await parseFile(f);
        return;
      }
      const s = await parseFile(f);
      expect(s.blenderVersion).toBe(ref._version);
      for (const [name, e] of Object.entries(ref)) {
        if (name.startsWith('_')) continue;
        const o = byName(s, name);
        expect(o, `object ${name}`).toBeDefined();
        expect([name, o!.type, o!.parent]).toEqual([name, e.type === 'SURF' ? 'SURFACE' : e.type === 'LAMP' ? 'LIGHT' : e.type === 'MBALL' ? 'META' : e.type, e.parent]);
        expect(maxAbsDiff(o!.worldMatrix, fromRows(e.matrix_world)), `${name} matrix`).toBeLessThan(1e-4);
        if (e.type !== 'MESH') continue;
        const m = s.meshes[o!.mesh!];
        expect([name, m.name, m.nverts, m.nfaces, m.ntris]).toEqual([name, e.mesh, e.nverts, e.nfaces, e.ntris]);
        if (e.v0) expect(maxAbsDiff(m.positions.subarray(0, 3), e.v0), `${name} v0`).toBeLessThan(1e-5);
        expect(Array.from(m.faceMaterial.subarray(0, 12)), `${name} face_mats`).toEqual(e.face_mats);
        expect(Array.from(m.faceSmooth.subarray(0, 4), (x) => x === 1), `${name} smooth`).toEqual(e.smooth);
        const slots = o!.materialSlots.map((k, i) => [o!.slotLinks[i], k ? s.materials[k].name : null]);
        expect(slots, `${name} slots`).toEqual(e.slots);
      }
      for (const [name, v] of Object.entries(ref._materials as Record<string, { color: number[] }>)) {
        expect(maxAbsDiff(s.materials[name].color, v.color), `material ${name}`).toBeLessThan(1e-5);
      }
    });
  }
});
