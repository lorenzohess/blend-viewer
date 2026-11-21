import earcut from 'earcut';
import type { BlendFile, Block } from '../blend/file';
import type { MeshData } from './types';

// CustomData layer types (§4.11).
const CD_MVERT = 0, CD_MFACE = 4, CD_PROP_INT32 = 11, CD_MPOLY = 25, CD_MLOOP = 26, CD_PROP_FLOAT3 = 48, CD_PROP_BOOL = 50;
const ME_SMOOTH = 1;

/** Raw face data before triangulation. */
export interface MeshCore {
  nverts: number;
  nfaces: number;
  positions: Float32Array;
  cornerVert: Int32Array;
  /** nfaces + 1 entries: face f uses corners faceOffsets[f] .. faceOffsets[f+1]. */
  faceOffsets: Int32Array;
  faceMaterial: Int32Array;
  /** 1 = flat ("sharp") face. */
  faceSharp: Uint8Array;
  layout: MeshData['layout'];
}

function firstField(bf: BlendFile, names: string[]): string | null {
  for (const n of names) if (bf.has('Mesh', n)) return n;
  return null;
}

function meshCount(bf: BlendFile, o: number, names: string[]): number {
  const f = firstField(bf, names);
  return f ? Math.max(0, bf.num('Mesh', o, f)) : 0;
}

interface Layer { type: number; name: string; data: Block | null }

function customDataLayers(bf: BlendFile, me: Block, cd: string): Layer[] {
  if (!bf.has('Mesh', cd + '.layers')) return [];
  const n = bf.num('Mesh', me.offset, cd + '.totlayer');
  const lb = bf.resolve(bf.ptr('Mesh', me.offset, cd + '.layers'), me.group);
  if (!lb || n <= 0) return [];
  const sz = bf.structSize('CustomDataLayer');
  const out: Layer[] = [];
  for (let i = 0; i < n && (i + 1) * sz <= lb.len; i++) {
    const lo = lb.offset + i * sz;
    out.push({
      type: bf.num('CustomDataLayer', lo, 'type'),
      name: bf.str('CustomDataLayer', lo, 'name'),
      data: bf.resolve(bf.ptr('CustomDataLayer', lo, 'data'), me.group),
    });
  }
  return out;
}

/** Layout A: Blender 5.0+ Mesh.attribute_storage. Returns false if not present. */
function readAttributeStorage(bf: BlendFile, me: Block, c: MeshCore, nloops: number): boolean {
  if (!bf.has('Mesh', 'attribute_storage.dna_attributes_num')) return false;
  const o = me.offset, g = me.group;
  const n = bf.num('Mesh', o, 'attribute_storage.dna_attributes_num');
  if (n <= 0) return false;
  const ab = bf.resolve(bf.ptr('Mesh', o, 'attribute_storage.dna_attributes'), g);
  if (!ab) return false;
  const asz = bf.structSize('Attribute');
  for (let i = 0; i < n && (i + 1) * asz <= ab.len; i++) {
    const ao = ab.offset + i * asz;
    const name = bf.blockStr(bf.resolve(bf.ptr('Attribute', ao, 'name'), g));
    if (name !== 'position' && name !== '.corner_vert' && name !== 'material_index' && name !== 'sharp_face') continue;
    const storage = bf.num('Attribute', ao, 'storage_type');
    const db = bf.resolve(bf.ptr('Attribute', ao, 'data'), g);
    if (!db) continue;
    if (storage === 0) {
      // Array: AttributeArray { void *data; ...; int64 size }. The size equals the domain size.
      const raw = bf.resolve(bf.ptr('AttributeArray', db.offset, 'data'), g);
      if (!raw) continue;
      if (name === 'position') c.positions = bf.f32(raw, c.nverts * 3);
      else if (name === '.corner_vert') c.cornerVert = bf.i32(raw, nloops);
      else if (name === 'material_index') c.faceMaterial = bf.i32(raw, c.nfaces);
      else c.faceSharp = bf.u8(raw, c.nfaces);
    } else {
      // Single: one value for the whole domain.
      const raw = bf.resolve(bf.ptr('AttributeSingle', db.offset, 'data'), g);
      if (!raw) continue;
      if (name === 'material_index') c.faceMaterial.fill(bf.dv.getInt32(raw.offset, bf.le));
      else if (name === 'sharp_face') c.faceSharp.fill(bf.data[raw.offset] ? 1 : 0);
      else if (name === 'position') {
        const p = bf.f32(raw, 3);
        for (let v = 0; v < c.nverts; v++) c.positions.set(p, v * 3);
      }
    }
  }
  c.layout = 'attribute-storage';
  return true;
}

/** Layouts B (generic CustomData attributes) and C (legacy MVert/MLoop/MPoly). */
function readCustomData(bf: BlendFile, me: Block, c: MeshCore, nloops: number): { havePolyOffsets: boolean } {
  let legacy = false;
  for (const l of customDataLayers(bf, me, 'vdata')) {
    if (!l.data) continue;
    if (l.type === CD_PROP_FLOAT3 && l.name === 'position') c.positions = bf.f32(l.data, c.nverts * 3);
    else if (l.type === CD_MVERT) {
      // MVert stride differs between versions: always use the DNA size.
      c.positions = Float32Array.from(bf.strided(l.data, c.nverts, 'MVert', 'co', 3));
      legacy = true;
    }
  }
  for (const l of customDataLayers(bf, me, 'ldata')) {
    if (!l.data) continue;
    if (l.type === CD_PROP_INT32 && l.name === '.corner_vert') c.cornerVert = bf.i32(l.data, nloops);
    else if (l.type === CD_MLOOP) {
      c.cornerVert = Int32Array.from(bf.strided(l.data, nloops, 'MLoop', 'v'));
      legacy = true;
    }
  }
  let mpoly: Block | null = null;
  for (const l of customDataLayers(bf, me, 'pdata')) {
    if (!l.data) continue;
    if (l.type === CD_PROP_INT32 && l.name === 'material_index') c.faceMaterial = bf.i32(l.data, c.nfaces);
    else if (l.type === CD_PROP_BOOL && l.name === 'sharp_face') c.faceSharp = bf.u8(l.data, c.nfaces);
    else if (l.type === CD_MPOLY) mpoly = l.data;
  }
  if (mpoly) {
    // struct MPoly { int loopstart; int totloop; short mat_nr; char flag; ... }
    const ls = bf.strided(mpoly, c.nfaces, 'MPoly', 'loopstart');
    const mat = bf.strided(mpoly, c.nfaces, 'MPoly', 'mat_nr');
    const flag = bf.strided(mpoly, c.nfaces, 'MPoly', 'flag');
    for (let f = 0; f < c.nfaces; f++) {
      c.faceOffsets[f] = ls[f];
      c.faceMaterial[f] = mat[f];
      c.faceSharp[f] = flag[f] & ME_SMOOTH ? 0 : 1;
    }
    c.faceOffsets[c.nfaces] = nloops;
    legacy = true;
  }
  c.layout = legacy ? 'customdata-legacy' : 'customdata-generic';
  return { havePolyOffsets: mpoly !== null };
}

/** Pre-2.63 meshes: tessellated MFace { v1, v2, v3, v4, mat_nr, edcode, flag } in fdata. */
function readMFace(bf: BlendFile, me: Block, c: MeshCore): boolean {
  const totface = meshCount(bf, me.offset, ['totface']);
  if (!totface) return false;
  const layer = customDataLayers(bf, me, 'fdata').find((l) => l.type === CD_MFACE && l.data);
  if (!layer?.data) return false;
  const v = ['v1', 'v2', 'v3', 'v4'].map((k) => bf.strided(layer.data!, totface, 'MFace', k));
  const mat = bf.strided(layer.data, totface, 'MFace', 'mat_nr');
  const flag = bf.strided(layer.data, totface, 'MFace', 'flag');
  const corners: number[] = [];
  c.nfaces = totface;
  c.faceOffsets = new Int32Array(totface + 1);
  c.faceMaterial = new Int32Array(totface);
  c.faceSharp = new Uint8Array(totface);
  for (let f = 0; f < totface; f++) {
    c.faceOffsets[f] = corners.length;
    corners.push(v[0][f], v[1][f], v[2][f]);
    if (v[3][f]) corners.push(v[3][f]);
    c.faceMaterial[f] = mat[f];
    c.faceSharp[f] = flag[f] & ME_SMOOTH ? 0 : 1;
  }
  c.faceOffsets[totface] = corners.length;
  c.cornerVert = Int32Array.from(corners);
  c.layout = 'mface';
  return true;
}

/** Read vertices, corners and faces from a Mesh block. Detects the layout from the data (§4.11). */
export function readMeshCore(bf: BlendFile, me: Block, warnings: string[]): MeshCore {
  const o = me.offset;
  const nverts = meshCount(bf, o, ['totvert', 'verts_num']);
  const nfaces = meshCount(bf, o, ['totpoly', 'faces_num']);
  const nloops = meshCount(bf, o, ['totloop', 'corners_num']);
  const c: MeshCore = {
    nverts,
    nfaces,
    positions: new Float32Array(nverts * 3),
    cornerVert: new Int32Array(nloops),
    faceOffsets: new Int32Array(nfaces + 1),
    faceMaterial: new Int32Array(nfaces),
    faceSharp: new Uint8Array(nfaces), // missing sharp_face means smooth
    layout: 'empty',
  };
  let havePolyOffsets = false;
  if (!readAttributeStorage(bf, me, c, nloops)) havePolyOffsets = readCustomData(bf, me, c, nloops).havePolyOffsets;
  if (!havePolyOffsets && nfaces) {
    const f = firstField(bf, ['poly_offset_indices', 'face_offset_indices']);
    const pb = f ? bf.resolve(bf.ptr('Mesh', o, f), me.group) : null;
    if (pb) c.faceOffsets = bf.i32(pb, nfaces + 1);
    else warnings.push('face offsets are missing');
  }
  if (nfaces === 0 && readMFace(bf, me, c)) {
    warnings.push('stored in the pre-2.63 face format (MFace)');
  }
  if (c.nverts === 0) c.layout = 'empty';
  return c;
}

/** Fan for 3-4 corners, earcut (on the best-fit plane) for 5+. Emits triangles with the face's winding. */
export function triangulate(c: MeshCore, warnings: string[]): Pick<MeshData, 'triangles' | 'triMaterial' | 'triSmooth' | 'triFace'> {
  const { positions: P, cornerVert: CV, faceOffsets: FO, nverts, nfaces } = c;
  let upper = 0;
  for (let f = 0; f < nfaces; f++) upper += Math.max(0, FO[f + 1] - FO[f] - 2);
  const tris = new Uint32Array(upper * 3);
  const triMat = new Uint16Array(upper);
  const triSmooth = new Uint8Array(upper);
  const triFace = new Uint32Array(upper);
  let t = 0, bad = 0;
  const poly: number[] = [];
  const flat: number[] = [];
  const nloops = CV.length;
  for (let f = 0; f < nfaces; f++) {
    const a = FO[f], z = FO[f + 1], n = z - a;
    if (n < 3) continue;
    if (a < 0 || z > nloops) { bad++; continue; }
    poly.length = 0;
    let ok = true;
    for (let k = a; k < z; k++) {
      const v = CV[k];
      if (v < 0 || v >= nverts) { ok = false; break; }
      poly.push(v);
    }
    if (!ok) { bad++; continue; }
    const mat = Math.min(65535, Math.max(0, c.faceMaterial[f]));
    const smooth = c.faceSharp[f] ? 0 : 1;
    const emit = (i0: number, i1: number, i2: number) => {
      tris[t * 3] = i0; tris[t * 3 + 1] = i1; tris[t * 3 + 2] = i2;
      triMat[t] = mat; triSmooth[t] = smooth; triFace[t] = f; t++;
    };
    if (n <= 4) {
      for (let k = 1; k < n - 1; k++) emit(poly[0], poly[k], poly[k + 1]);
      continue;
    }
    // Newell normal -> drop the dominant axis -> 2D polygon with the same orientation.
    let nx = 0, ny = 0, nz = 0;
    for (let k = 0; k < n; k++) {
      const p = poly[k] * 3, q = poly[(k + 1) % n] * 3;
      nx += (P[p + 1] - P[q + 1]) * (P[p + 2] + P[q + 2]);
      ny += (P[p + 2] - P[q + 2]) * (P[p] + P[q]);
      nz += (P[p] - P[q]) * (P[p + 1] + P[q + 1]);
    }
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    let iu: number, iv: number, sign: number;
    if (az >= ax && az >= ay) { iu = 0; iv = 1; sign = nz >= 0 ? 1 : -1; }
    else if (ax >= ay) { iu = 1; iv = 2; sign = nx >= 0 ? 1 : -1; }
    else { iu = 2; iv = 0; sign = ny >= 0 ? 1 : -1; }
    flat.length = 0;
    for (let k = 0; k < n; k++) flat.push(P[poly[k] * 3 + iu] * sign, P[poly[k] * 3 + iv]);
    const idx = earcut(flat);
    if (idx.length < 3) {
      for (let k = 1; k < n - 1; k++) emit(poly[0], poly[k], poly[k + 1]);
      continue;
    }
    for (let k = 0; k < idx.length; k += 3) {
      let i0 = idx[k], i1 = idx[k + 1], i2 = idx[k + 2];
      const area = (flat[i1 * 2] - flat[i0 * 2]) * (flat[i2 * 2 + 1] - flat[i0 * 2 + 1]) - (flat[i2 * 2] - flat[i0 * 2]) * (flat[i1 * 2 + 1] - flat[i0 * 2 + 1]);
      if (area < 0) { const tmp = i1; i1 = i2; i2 = tmp; }
      emit(poly[i0], poly[i1], poly[i2]);
    }
  }
  if (bad) warnings.push(`${bad} faces reference missing vertices and were skipped`);
  return {
    triangles: t * 3 === tris.length ? tris : tris.slice(0, t * 3),
    triMaterial: t === upper ? triMat : triMat.slice(0, t),
    triSmooth: t === upper ? triSmooth : triSmooth.slice(0, t),
    triFace: t === upper ? triFace : triFace.slice(0, t),
  };
}

export function extractMesh(bf: BlendFile, me: Block, warnings: string[]): MeshData {
  const core = readMeshCore(bf, me, warnings);
  const tri = triangulate(core, warnings);
  const faceMaterial = new Uint16Array(core.nfaces);
  for (let f = 0; f < core.nfaces; f++) faceMaterial[f] = Math.min(65535, Math.max(0, core.faceMaterial[f]));
  const faceSmooth = new Uint8Array(core.nfaces);
  for (let f = 0; f < core.nfaces; f++) faceSmooth[f] = core.faceSharp[f] ? 0 : 1;
  const library = bf.idLibrary(me);
  return {
    name: bf.idName(me),
    nverts: core.nverts,
    nfaces: core.nfaces,
    ntris: tri.triMaterial.length,
    positions: core.positions,
    ...tri,
    faceMaterial,
    faceSmooth,
    layout: core.layout,
    users: 0,
    ...(library ? { library } : {}),
  };
}
