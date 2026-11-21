import type { MeshData } from './types';

/** GPU-ready buffers for one mesh. Plain typed arrays, so it runs in the worker and in Node. */
export interface RenderMesh {
  positions: Float32Array;
  normals: Float32Array;
  index: Uint32Array;
  /** Index ranges per material slot index (start/count in indices). */
  groups: { start: number; count: number; materialIndex: number }[];
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
}

/**
 * Build render buffers. Smooth faces share one vertex per mesh vertex with the
 * area-weighted normal of the adjacent smooth faces. Flat faces get their own
 * vertices with the face normal. Triangles are sorted by material index (§4.11).
 */
export function buildRenderMesh(m: MeshData): RenderMesh {
  const P = m.positions, T = m.triangles, nT = m.triMaterial.length, nV = m.nverts;
  const nF = m.nfaces;

  // Per-triangle unnormalised normals (length = 2 * area).
  const triN = new Float32Array(nT * 3);
  const vertN = new Float32Array(nV * 3);
  const faceN = new Float32Array(nF * 3);
  for (let t = 0; t < nT; t++) {
    const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    triN[t * 3] = nx; triN[t * 3 + 1] = ny; triN[t * 3 + 2] = nz;
    if (m.triSmooth[t]) {
      for (const v of [a, b, c]) { vertN[v] += nx; vertN[v + 1] += ny; vertN[v + 2] += nz; }
    } else {
      const f = m.triFace[t] * 3;
      faceN[f] += nx; faceN[f + 1] += ny; faceN[f + 2] += nz;
    }
  }

  // Map (vertex, flat face) -> output vertex. Triangles of one face are contiguous.
  const smoothMap = new Int32Array(nV).fill(-1);
  const flatMap = new Int32Array(nV).fill(-1);
  const touched: number[] = [];
  const outIndex = new Uint32Array(nT * 3);
  let outCount = 0, curFace = -1;
  for (let t = 0; t < nT; t++) {
    const smooth = m.triSmooth[t] === 1;
    if (!smooth && m.triFace[t] !== curFace) {
      for (const v of touched) flatMap[v] = -1;
      touched.length = 0;
      curFace = m.triFace[t];
    }
    for (let k = 0; k < 3; k++) {
      const v = T[t * 3 + k];
      const map = smooth ? smoothMap : flatMap;
      let o = map[v];
      if (o < 0) {
        o = map[v] = outCount++;
        if (!smooth) touched.push(v);
      }
      outIndex[t * 3 + k] = o;
    }
  }

  const positions = new Float32Array(outCount * 3);
  const normals = new Float32Array(outCount * 3);
  const written = new Uint8Array(outCount);
  const bmin: [number, number, number] = [Infinity, Infinity, Infinity];
  const bmax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < nT; t++) {
    const smooth = m.triSmooth[t] === 1;
    for (let k = 0; k < 3; k++) {
      const o = outIndex[t * 3 + k];
      if (written[o]) continue;
      written[o] = 1;
      const v = T[t * 3 + k] * 3;
      const src = smooth ? vertN : faceN;
      const s = smooth ? v : m.triFace[t] * 3;
      let nx = src[s], ny = src[s + 1], nz = src[s + 2];
      const len = Math.hypot(nx, ny, nz);
      if (len > 0) { nx /= len; ny /= len; nz /= len; } else { nx = 0; ny = 0; nz = 1; }
      normals[o * 3] = nx; normals[o * 3 + 1] = ny; normals[o * 3 + 2] = nz;
      for (let c = 0; c < 3; c++) {
        const x = P[v + c];
        positions[o * 3 + c] = x;
        if (x < bmin[c]) bmin[c] = x;
        if (x > bmax[c]) bmax[c] = x;
      }
    }
  }
  if (!outCount) { bmin.fill(0); bmax.fill(0); }

  // Counting sort of triangles by material index -> contiguous groups.
  let maxMat = 0;
  for (let t = 0; t < nT; t++) if (m.triMaterial[t] > maxMat) maxMat = m.triMaterial[t];
  const counts = new Uint32Array(maxMat + 2);
  for (let t = 0; t < nT; t++) counts[m.triMaterial[t] + 1]++;
  for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1];
  const index = new Uint32Array(nT * 3);
  const cursor = counts.slice(0, maxMat + 1);
  for (let t = 0; t < nT; t++) {
    const d = cursor[m.triMaterial[t]]++ * 3;
    index[d] = outIndex[t * 3]; index[d + 1] = outIndex[t * 3 + 1]; index[d + 2] = outIndex[t * 3 + 2];
  }
  const groups: RenderMesh['groups'] = [];
  for (let mi = 0; mi <= maxMat; mi++) {
    const count = (counts[mi + 1] - counts[mi]) * 3;
    if (count) groups.push({ start: counts[mi] * 3, count, materialIndex: mi });
  }
  return { positions, normals, index, groups, bboxMin: bmin, bboxMax: bmax };
}
