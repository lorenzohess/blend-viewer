import type { BlendFile, Block } from '../blend/file';
import type { CollectionInfo, CollectionNode } from './types';

export const COLLECTION_HIDE_VIEWPORT = 1;
/** Base flag bit set when the object is enabled and visible in the viewport (§4.9). */
export const BASE_VISIBLE = 0x02;

/** Active scene: FileGlobal.curscene if it resolves, else the first SC block. */
export function findScene(bf: BlendFile): Block | null {
  const glob = bf.blocks.find((b) => b.code === 'GLOB');
  if (glob && bf.structName(glob) === 'FileGlobal') {
    const sc = bf.resolveId(bf.ptr('FileGlobal', glob.offset, 'curscene'));
    if (sc && sc.code === 'SC' && bf.structName(sc) === 'Scene') return sc;
  }
  return bf.blocks.find((b) => b.code === 'SC' && bf.structName(b) === 'Scene') ?? null;
}

/**
 * Base.flag per object address from the scene's first ViewLayer.
 * Returns null when the file has no view layer data.
 */
export function readBaseFlags(bf: BlendFile, sc: Block): Map<bigint, number> | null {
  if (!bf.has('Scene', 'view_layers')) return null;
  const layers = bf.listOf('Scene', sc.offset, 'view_layers', sc.group);
  if (!layers.length) return null;
  const vl = layers[0];
  const out = new Map<bigint, number>();
  for (const base of bf.listOf('ViewLayer', vl.offset, 'object_bases', vl.group)) {
    out.set(bf.ptr('Base', base.offset, 'object'), bf.num('Base', base.offset, 'flag'));
  }
  return out;
}

/** Pre-2.80 scenes: Scene.base is a ListBase of Base { object }. */
export function readLegacySceneObjects(bf: BlendFile, sc: Block): bigint[] {
  if (!bf.has('Scene', 'base')) return [];
  return bf.listOf('Scene', sc.offset, 'base', sc.group).map((b) => bf.ptr('Base', b.offset, 'object'));
}

export interface CollectionReader {
  /** Unique key per collection block. */
  keyOf: (b: Block) => string;
  objectIndex: Map<bigint, number>;
}

/** Info for one collection block (direct members only). */
export function readCollectionInfo(bf: BlendFile, b: Block, r: CollectionReader): CollectionInfo {
  const o = b.offset, g = b.group;
  const objects: number[] = [];
  for (const it of bf.listOf('Collection', o, 'gobject', g)) {
    const i = r.objectIndex.get(bf.ptr('CollectionObject', it.offset, 'ob'));
    if (i !== undefined) objects.push(i);
  }
  const children: string[] = [];
  for (const it of bf.listOf('Collection', o, 'children', g)) {
    const cb = bf.resolveId(bf.ptr('CollectionChild', it.offset, 'collection'));
    if (cb) children.push(r.keyOf(cb));
  }
  const ofs = bf.nums('Collection', o, 'dupli_ofs', [0, 0, 0]);
  const library = bf.idLibrary(b);
  return {
    key: r.keyOf(b),
    name: bf.idName(b),
    hidden: (bf.num('Collection', o, 'flag') & COLLECTION_HIDE_VIEWPORT) !== 0,
    objects,
    children,
    instanceOffset: [ofs[0] ?? 0, ofs[1] ?? 0, ofs[2] ?? 0],
    ...(library ? { library } : {}),
  };
}

/** Build the tree under the master collection. Guards against cycles. */
export function buildCollectionTree(root: CollectionInfo, index: Record<string, CollectionInfo>): CollectionNode {
  const visit = (c: CollectionInfo, path: Set<string>): CollectionNode => {
    const next = new Set(path).add(c.key);
    return {
      key: c.key,
      name: c.name,
      hidden: c.hidden,
      objects: c.objects.slice(),
      children: c.children.filter((k) => index[k] && !next.has(k)).map((k) => visit(index[k], next)),
      ...(c.library ? { library: c.library } : {}),
    };
  };
  return visit(root, new Set());
}
