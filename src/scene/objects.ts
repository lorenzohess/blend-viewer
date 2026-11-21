import type { BlendFile, Block } from '../blend/file';
import { type Mat3, type Mat4, axisAngleToMat3, compose, eulerToMat3, identity4, mul3, mul4, quatToMat3 } from './math';
import type { ModifierInfo, ObjectType } from './types';

/** Object.type values (§4.7). Unknown values map to OTHER. */
export const OBJECT_TYPES: Record<number, ObjectType> = {
  0: 'EMPTY', 1: 'MESH', 2: 'CURVE', 3: 'SURFACE', 4: 'FONT', 5: 'META', 10: 'LIGHT', 11: 'CAMERA',
  12: 'SPEAKER', 13: 'LIGHT_PROBE', 22: 'LATTICE', 25: 'ARMATURE', 26: 'GPENCIL', 27: 'CURVES',
  28: 'POINTCLOUD', 29: 'VOLUME', 30: 'GREASEPENCIL',
};

export const OB_DUPLICOLLECTION = 0x100;

/** Object with the raw fields the rest of the extractor needs. */
export interface RawObject {
  block: Block;
  name: string;
  typeCode: number;
  type: ObjectType;
  parentPtr: bigint;
  dataPtr: bigint;
  partype: number;
  library: string | null;
  /** The block holds a full Object struct (false for linked ID placeholders). */
  full: boolean;
}

export function readObject(bf: BlendFile, b: Block): RawObject {
  const full = bf.structName(b) === 'Object';
  const o = b.offset;
  const typeCode = full ? bf.num('Object', o, 'type') : -1;
  return {
    block: b,
    name: bf.idName(b),
    typeCode,
    type: full ? OBJECT_TYPES[typeCode] ?? 'OTHER' : 'OTHER',
    parentPtr: full ? bf.ptr('Object', o, 'parent') : 0n,
    dataPtr: full ? bf.ptr('Object', o, 'data') : 0n,
    partype: full ? bf.num('Object', o, 'partype') : 0,
    library: bf.idLibrary(b),
    full,
  };
}

/**
 * Rotation from rotmode (§4.8): 0 quaternion, -1 axis-angle, 1..6 Euler.
 * Mirrors BKE_object_rot_to_mat3: any positive mode is Euler, anything else
 * that is not -1 is a quaternion. `prefix` is '' or 'd' (delta).
 */
function rotation(bf: BlendFile, o: number, mode: number, prefix: '' | 'd'): Mat3 {
  if (mode > 0) return eulerToMat3(bf.nums('Object', o, prefix + 'rot', [0, 0, 0]), mode);
  if (mode === -1) {
    return axisAngleToMat3(bf.nums('Object', o, prefix + 'rotAxis', [0, 1, 0]), bf.num('Object', o, prefix + 'rotAngle'));
  }
  return quatToMat3(bf.nums('Object', o, prefix + 'quat', [1, 0, 0, 0]));
}

/** local = Translate(loc + dloc) * (R_delta * R) * Scale(size * dscale). */
export function localMatrix(bf: BlendFile, b: Block): Mat4 {
  const o = b.offset;
  const loc = bf.nums('Object', o, 'loc', [0, 0, 0]);
  const dloc = bf.nums('Object', o, 'dloc', [0, 0, 0]);
  const size = bf.nums('Object', o, 'size', [1, 1, 1]);
  const dscale = bf.has('Object', 'dscale') ? bf.nums('Object', o, 'dscale') : [1, 1, 1];
  const mode = bf.num('Object', o, 'rotmode', 1);
  const R = mul3(rotation(bf, o, mode, 'd'), rotation(bf, o, mode, ''));
  return compose(
    [loc[0] + dloc[0], loc[1] + dloc[1], loc[2] + dloc[2]],
    R,
    [size[0] * dscale[0], size[1] * dscale[1], size[2] * dscale[2]],
  );
}

/** Blender's float[4][4] is stored so the 16 floats in file order are column-major. */
export function parentInverse(bf: BlendFile, b: Block): Mat4 {
  const m = bf.nums('Object', b.offset, 'parentinv');
  return m.length === 16 ? m : identity4();
}

/**
 * world = parentWorld * parentinv * local, computed recursively.
 * World matrices are not stored in Blender 4.2+ files, so always compute them.
 */
export function computeWorldMatrices(bf: BlendFile, objs: RawObject[], index: Map<bigint, number>): Mat4[] {
  const world: (Mat4 | undefined)[] = new Array(objs.length);
  const visiting = new Uint8Array(objs.length);
  const calc = (i: number): Mat4 => {
    const cached = world[i];
    if (cached) return cached;
    const ob = objs[i];
    if (!ob.full) return (world[i] = identity4());
    let m = localMatrix(bf, ob.block);
    const p = index.get(ob.parentPtr);
    if (p !== undefined && !visiting[i]) {
      visiting[i] = 1;
      m = mul4(mul4(calc(p), parentInverse(bf, ob.block)), m);
      visiting[i] = 0;
    }
    return (world[i] = m);
  };
  return objs.map((_, i) => calc(i));
}

const MODIFIER_NAMES: Record<string, string> = {
  Subsurf: 'Subdivision Surface', Multires: 'Multiresolution', Nodes: 'Geometry Nodes', Mirror: 'Mirror',
  Array: 'Array', Bevel: 'Bevel', Boolean: 'Boolean', Solidify: 'Solidify', Armature: 'Armature',
  Decimate: 'Decimate', Screw: 'Screw', Displace: 'Displace', Smooth: 'Smooth', Triangulate: 'Triangulate',
  Weld: 'Weld', Wireframe: 'Wireframe', Shrinkwrap: 'Shrinkwrap', Curve: 'Curve', Lattice: 'Lattice',
  EdgeSplit: 'Edge Split', Remesh: 'Remesh', Skin: 'Skin', Cast: 'Cast', SimpleDeform: 'Simple Deform',
  WeightedNormal: 'Weighted Normal', DataTransfer: 'Data Transfer', SurfaceDeform: 'Surface Deform',
  MeshDeform: 'Mesh Deform', Hook: 'Hook', LaplacianSmooth: 'Laplacian Smooth', CorrectiveSmooth: 'Smooth Corrective',
  Build: 'Build', ParticleSystem: 'Particle System', ParticleInstance: 'Particle Instance', Cloth: 'Cloth',
  Collision: 'Collision', Explode: 'Explode', Fluid: 'Fluid', Ocean: 'Ocean', Wave: 'Wave', Warp: 'Warp',
  UVProject: 'UV Project', UVWarp: 'UV Warp', Mask: 'Mask', MeshCache: 'Mesh Cache',
  MeshSequenceCache: 'Mesh Sequence Cache', NormalEdit: 'Normal Edit', Softbody: 'Soft Body',
  DynamicPaint: 'Dynamic Paint', Surface: 'Surface', LaplacianDeform: 'Laplacian Deform',
  WeightVGEdit: 'Vertex Weight Edit', WeightVGMix: 'Vertex Weight Mix', WeightVGProximity: 'Vertex Weight Proximity',
  MeshToVolume: 'Mesh to Volume', VolumeToMesh: 'Volume to Mesh', VolumeDisplace: 'Volume Displace',
  GreasePencilLineart: 'Line Art', Lineart: 'Line Art',
};

export function modifierKind(struct: string): string {
  const base = struct.replace(/ModifierData$/, '');
  return MODIFIER_NAMES[base] ?? base.replace(/([a-z])([A-Z])/g, '$1 $2');
}

/** Object.modifiers is a ListBase of modifier structs, each starting with ModifierData (§4.13). */
export function readModifiers(bf: BlendFile, b: Block): ModifierInfo[] {
  if (!bf.has('Object', 'modifiers')) return [];
  const out: ModifierInfo[] = [];
  for (const mb of bf.listOf('Object', b.offset, 'modifiers', b.group)) {
    const struct = bf.structName(mb);
    out.push({
      name: bf.str('ModifierData', mb.offset, 'name'),
      kind: modifierKind(struct),
      struct,
      enabled: (bf.num('ModifierData', mb.offset, 'mode') & 1) !== 0,
    });
  }
  return out;
}
