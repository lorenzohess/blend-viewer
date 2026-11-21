import { BlendFile, type Block } from '../blend/file';
import { type Compression, decompressBlend } from '../io/decompress';
import {
  BASE_VISIBLE, buildCollectionTree, findScene, readBaseFlags, readCollectionInfo, readLegacySceneObjects,
} from './collections';
import { readMaterial, resolveSlots } from './materials';
import { type Mat4, identity4, mul4, translate4 } from './math';
import { extractMesh } from './mesh';
import { OB_DUPLICOLLECTION, type RawObject, computeWorldMatrices, readModifiers, readObject } from './objects';
import type {
  CollectionInfo, CollectionNode, InstanceRecord, MaterialInfo, MeshData, ObjectType, SceneDescription, SceneObject,
} from './types';

export interface ExtractOptions {
  compression?: Compression;
  onProgress?: (stage: string, fraction: number) => void;
}

const TYPE_LABEL: Partial<Record<ObjectType, string>> = {
  CURVE: 'Curve', SURFACE: 'Surface', FONT: 'Text', META: 'Metaball', CURVES: 'Hair curves',
  POINTCLOUD: 'Point cloud', VOLUME: 'Volume', GPENCIL: 'Grease Pencil', GREASEPENCIL: 'Grease Pencil',
  ARMATURE: 'Armature', LATTICE: 'Lattice',
};

const PARENT_TYPES: Record<number, string> = { 4: 'armature', 5: 'vertex', 6: 'vertex (3)', 7: 'bone' };
const OB_HIDE_VIEWPORT = 1;
const MAX_INSTANCE_DEPTH = 8;

/** Assigns unique, readable keys to ID blocks (names can repeat across libraries). */
function keyer() {
  const used = new Set<string>();
  const byBlock = new Map<number, string>();
  return (b: Block, name: string): string => {
    const hit = byBlock.get(b.index);
    if (hit !== undefined) return hit;
    let k = name, n = 2;
    while (used.has(k)) k = `${name} (${n++})`;
    used.add(k);
    byBlock.set(b.index, k);
    return k;
  };
}

/** Decompress (zstd / gzip) and parse. */
export async function parseBlend(input: Uint8Array, opts: ExtractOptions = {}): Promise<SceneDescription> {
  opts.onProgress?.('Decompressing', 0);
  const { data, compression } = await decompressBlend(input);
  return extractScene(data, { ...opts, compression });
}

/** Build a SceneDescription from uncompressed .blend bytes. */
export function extractScene(data: Uint8Array, opts: ExtractOptions = {}): SceneDescription {
  const t0 = performance.now();
  const progress = opts.onProgress ?? (() => {});
  progress('Reading blocks', 0.05);
  const bf = new BlendFile(data);
  const warnings: string[] = [];
  if (!bf.le || bf.ptrSize === 4) {
    warnings.push('This file comes from a very old Blender (big-endian or 32-bit). Support for it is best-effort.');
  }
  if (bf.version > 0 && bf.version < 280) {
    warnings.push(`This file was saved with Blender ${fmtVersion(bf.version)}, before collections existed. Objects are shown in a flat list.`);
  }

  // ---------------------------------------------------------------- objects
  const rawObjects: RawObject[] = [];
  const objIndex = new Map<bigint, number>();
  for (const b of bf.blocks) {
    const isOb = b.code === 'OB' || (b.code === 'ID' && bf.idRawName(b).startsWith('OB'));
    if (!isOb) continue;
    try {
      const ro = readObject(bf, b);
      objIndex.set(b.oldPtr, rawObjects.length);
      rawObjects.push(ro);
    } catch (e) {
      warnings.push(`Could not read an object block: ${(e as Error).message}`);
    }
  }
  progress('Computing transforms', 0.1);
  const worlds = computeWorldMatrices(bf, rawObjects, objIndex);

  // ------------------------------------------------------------- materials
  const materials: Record<string, MaterialInfo> = {};
  const matKey = keyer();
  const matKeyByPtr = new Map<bigint, string>();
  for (const b of bf.blocks) {
    const isMa = b.code === 'MA' || (b.code === 'ID' && bf.idRawName(b).startsWith('MA'));
    if (!isMa) continue;
    try {
      const m = readMaterial(bf, b);
      const k = matKey(b, m.name);
      materials[k] = m;
      matKeyByPtr.set(b.oldPtr, k);
    } catch (e) {
      warnings.push(`Could not read a material: ${(e as Error).message}`);
    }
  }

  // ---------------------------------------------------------- collections
  const sc = findScene(bf);
  const colKey = keyer();
  const reader = { keyOf: (b: Block) => colKey(b, bf.idName(b)), objectIndex: objIndex };
  const collectionIndex: Record<string, CollectionInfo> = {};
  const hasCollections = bf.hasStruct('Collection') && bf.has('Collection', 'gobject');
  let rootInfo: CollectionInfo | null = null;
  if (sc && hasCollections && bf.has('Scene', 'master_collection')) {
    const mc = bf.resolve(bf.ptr('Scene', sc.offset, 'master_collection'), sc.group);
    if (mc && bf.structName(mc) === 'Collection') {
      rootInfo = readCollectionInfo(bf, mc, reader);
      collectionIndex[rootInfo.key] = rootInfo;
    }
  }
  if (hasCollections) {
    for (const b of bf.blocks) {
      if (b.code !== 'GR' || bf.structName(b) !== 'Collection') continue;
      try {
        const info = readCollectionInfo(bf, b, reader);
        collectionIndex[info.key] = info;
      } catch (e) {
        warnings.push(`Could not read a collection: ${(e as Error).message}`);
      }
    }
  }
  if (!rootInfo) {
    // Pre-2.80 file or no scene: a flat list.
    const legacy = sc ? readLegacySceneObjects(bf, sc) : [];
    const ids = legacy.length
      ? legacy.map((p) => objIndex.get(p)).filter((i): i is number => i !== undefined)
      : rawObjects.map((_, i) => i);
    rootInfo = { key: 'Scene Collection', name: 'Scene Collection', hidden: false, objects: ids, children: [], instanceOffset: [0, 0, 0] };
    collectionIndex[rootInfo.key] = rootInfo;
  }
  const tree = buildCollectionTree(rootInfo, collectionIndex);

  // Direct collection membership and scene reachability.
  const membership: string[][] = rawObjects.map(() => []);
  const inScene = new Uint8Array(rawObjects.length);
  const walk = (n: CollectionNode) => {
    for (const i of n.objects) {
      if (!membership[i].includes(n.name)) membership[i].push(n.name);
      inScene[i] = 1;
    }
    n.children.forEach(walk);
  };
  walk(tree);
  const orphans = rawObjects.map((_, i) => i).filter((i) => !inScene[i]);
  if (orphans.length) {
    tree.children.push({ key: '__not_in_scene__', name: 'Not in this scene', hidden: true, objects: orphans, children: [] });
  }

  // ------------------------------------------------------------ visibility
  const baseFlags = sc ? readBaseFlags(bf, sc) : null;
  const sceneLay = sc && bf.has('Scene', 'lay') ? bf.num('Scene', sc.offset, 'lay') : 0;
  const legacyBases = new Map<bigint, number>();
  if (sc && !baseFlags && bf.has('Scene', 'base') && bf.has('Base', 'lay')) {
    for (const b of bf.listOf('Scene', sc.offset, 'base', sc.group)) legacyBases.set(bf.ptr('Base', b.offset, 'object'), bf.num('Base', b.offset, 'lay'));
  }

  // --------------------------------------------------------------- meshes
  const meshes: Record<string, MeshData> = {};
  const meshKey = keyer();
  const meshKeyByBlock = new Map<number, string>();
  const objects: SceneObject[] = [];
  let anyModifiers = false;
  const total = rawObjects.length || 1;

  for (let i = 0; i < rawObjects.length; i++) {
    if (i % 16 === 0) progress('Reading objects and meshes', 0.15 + 0.8 * (i / total));
    const ro = rawObjects[i];
    const parentId = objIndex.get(ro.parentPtr) ?? null;
    const so: SceneObject = {
      id: i,
      name: ro.name,
      type: ro.type,
      typeCode: ro.typeCode,
      parent: parentId !== null ? rawObjects[parentId].name : null,
      parentId,
      worldMatrix: worlds[i],
      materialSlots: [],
      slotLinks: [],
      modifiers: [],
      visible: false,
      inScene: inScene[i] === 1,
      collections: membership[i],
      notes: [],
      warnings: [],
    };
    objects.push(so);
    try {
      // Initial visibility (§4.9).
      if (!so.inScene) so.visible = false;
      else if (baseFlags) {
        const f = baseFlags.get(ro.block.oldPtr);
        so.visible = f !== undefined && (f & BASE_VISIBLE) !== 0;
        if (f === undefined) so.notes.push('Not in the active view layer (its collection is excluded), so it starts hidden.');
      } else if (legacyBases.size && sceneLay) {
        const lay = legacyBases.get(ro.block.oldPtr);
        so.visible = lay === undefined || (lay & sceneLay) !== 0;
      } else so.visible = true;

      if (ro.library) {
        so.library = ro.library;
        so.notes.push(`Linked from ${ro.library}. Its data is not stored in this file.`);
      }
      if (!ro.full) continue;
      const o = ro.block.offset;
      if (ro.partype && PARENT_TYPES[ro.partype & 15] && parentId !== null) {
        const kind = PARENT_TYPES[ro.partype & 15];
        if (kind !== 'armature') so.warnings.push(`Parented to a ${kind}; treated as a plain object parent.`);
      }
      if (bf.has('Object', 'constraints') && bf.listOf('Object', o, 'constraints', ro.block.group).length) {
        so.notes.push('Constraints are ignored.');
      }
      so.modifiers = readModifiers(bf, ro.block);
      if (so.modifiers.length) anyModifiers = true;
      if (ro.type === 'EMPTY') so.emptySize = bf.num('Object', o, 'empty_drawsize', 1) || 1;

      const transflag = bf.num('Object', o, 'transflag');
      const dupGroup = bf.ptr('Object', o, 'dup_group');
      if (transflag & OB_DUPLICOLLECTION && dupGroup) {
        const cb = bf.resolveId(dupGroup);
        if (cb) so.instanceCollection = reader.keyOf(cb);
      }

      const data = bf.resolveId(ro.dataPtr);
      if (data) so.dataName = bf.idName(data);
      if (ro.type === 'MESH') {
        if (!data) so.warnings.push('The mesh data is missing from the file.');
        else if (bf.structName(data) !== 'Mesh') {
          const lib = bf.idLibrary(data);
          so.notes.push(lib ? `Mesh is linked from ${lib}; no geometry in this file.` : 'Mesh data is not stored in this file.');
        } else {
          let key = meshKeyByBlock.get(data.index);
          if (key === undefined) {
            const mw: string[] = [];
            const md = extractMesh(bf, data, mw);
            key = meshKey(data, md.name);
            meshKeyByBlock.set(data.index, key);
            meshes[key] = md;
            if (mw.length) warnings.push(`Mesh "${md.name}": ${mw.join('; ')}.`);
          }
          so.mesh = key;
          meshes[key].users++;
          if (meshes[key].layout === 'mface') so.notes.push('Mesh uses the pre-2.63 face format.');
        }
      } else if (ro.type === 'ARMATURE' || ro.type === 'LATTICE') {
        so.notes.push(`${TYPE_LABEL[ro.type]} objects are not drawn by this viewer.`);
      } else if (TYPE_LABEL[ro.type]) {
        so.notes.push(`${TYPE_LABEL[ro.type]} object: geometry is generated by Blender, not stored in the file.`);
      } else if (ro.type === 'OTHER') {
        so.notes.push(`Object type ${ro.typeCode} is not recognised.`);
      }

      if (ro.type !== 'EMPTY') {
        const meshBlock = data && bf.structName(data) !== 'ID' ? data : null;
        const { ptrs, links } = resolveSlots(bf, ro.block, meshBlock);
        so.materialSlots = ptrs.map((p) => (p ? matKeyByPtr.get(p) ?? null : null));
        so.slotLinks = links;
      }
    } catch (e) {
      so.warnings.push(`Could not read this object: ${(e as Error).message}`);
    }
  }

  // ------------------------------------------------------------ instances
  progress('Expanding collection instances', 0.96);
  const instances = expandInstances(bf, rawObjects, objects, collectionIndex, worlds);

  if (anyModifiers) warnings.push('Some objects use modifiers, which this viewer does not apply. They are shown in their base shape.');
  for (const w of bf.warnings) warnings.push(w);
  const objWithIssues = objects.filter((o) => o.warnings.length).length;
  if (objWithIssues) warnings.push(`${objWithIssues} object(s) could not be read completely. They are marked with a warning sign.`);

  let triangles = 0;
  for (const o of objects) if (o.mesh && o.inScene) triangles += meshes[o.mesh].ntris;
  progress('Done', 1);
  return {
    blenderVersion: bf.version,
    fileFormat: bf.header.format,
    compression: opts.compression ?? 'none',
    pointerSize: bf.ptrSize,
    littleEndian: bf.le,
    sceneName: sc ? bf.idName(sc) : '',
    objects,
    meshes,
    materials,
    collections: tree,
    collectionIndex,
    instances,
    warnings,
    stats: { objects: objects.length, meshes: Object.keys(meshes).length, triangles, parseMs: performance.now() - t0 },
  };
}

/**
 * Collection instances (§4.10):
 * instanceWorld(X) = emptyWorld * Translate(-collection.dupli_ofs) * world(X), nested up to 8 levels.
 */
function expandInstances(
  bf: BlendFile, raw: RawObject[], objects: SceneObject[], index: Record<string, CollectionInfo>, worlds: Mat4[],
): InstanceRecord[] {
  const out: InstanceRecord[] = [];
  const hidden = (i: number): boolean => {
    const ro = raw[i];
    if (!ro.full) return true;
    const f = bf.has('Object', 'visibility_flag') ? 'visibility_flag' : bf.has('Object', 'restrictflag') ? 'restrictflag' : null;
    return f ? (bf.num('Object', ro.block.offset, f) & OB_HIDE_VIEWPORT) !== 0 : false;
  };
  const members = (key: string): number[] => {
    const seen = new Set<number>(), visited = new Set<string>();
    const rec = (k: string) => {
      const c = index[k];
      if (!c || visited.has(k) || c.hidden) return;
      visited.add(k);
      for (const i of c.objects) seen.add(i);
      c.children.forEach(rec);
    };
    rec(key);
    return [...seen];
  };
  const expand = (top: number, chain: number[], emptyWorld: Mat4, key: string, depth: number) => {
    const c = index[key];
    if (!c || depth > MAX_INSTANCE_DEPTH) return;
    const [ox, oy, oz] = c.instanceOffset;
    const prefix = mul4(emptyWorld, translate4(-ox, -oy, -oz));
    for (const i of members(key)) {
      if (hidden(i)) continue;
      const m = mul4(prefix, worlds[i] ?? identity4());
      out.push({ object: i, instancer: top, chain, collection: key, matrix: m });
      const nested = objects[i].instanceCollection;
      if (nested && !chain.includes(i)) expand(top, [...chain, i], m, nested, depth + 1);
    }
  };
  for (const o of objects) {
    if (o.instanceCollection && o.inScene) expand(o.id, [o.id], o.worldMatrix, o.instanceCollection, 1);
  }
  return out;
}

export function fmtVersion(v: number): string {
  return `${Math.floor(v / 100)}.${v % 100}`;
}
