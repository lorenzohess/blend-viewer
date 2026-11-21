/** Plain scene description produced by the parser (JSON-able plus typed arrays). */

export type ObjectType =
  | 'EMPTY' | 'MESH' | 'CURVE' | 'SURFACE' | 'FONT' | 'META' | 'LIGHT' | 'CAMERA' | 'SPEAKER'
  | 'LIGHT_PROBE' | 'LATTICE' | 'ARMATURE' | 'GPENCIL' | 'CURVES' | 'POINTCLOUD' | 'VOLUME'
  | 'GREASEPENCIL' | 'OTHER';

export interface ModifierInfo {
  name: string;
  /** Human-readable kind, e.g. "Subdivision Surface". */
  kind: string;
  /** DNA struct name, e.g. "SubsurfModifierData". */
  struct: string;
  /** Enabled in the viewport (eModifierMode_Realtime). */
  enabled: boolean;
}

export interface SceneObject {
  /** Index into SceneDescription.objects. */
  id: number;
  name: string;
  type: ObjectType;
  typeCode: number;
  parent: string | null;
  parentId: number | null;
  /** 16 floats, column-major (three.js Matrix4.fromArray order). Blender Z-up coordinates. */
  worldMatrix: number[];
  /** Key into SceneDescription.meshes. */
  mesh?: string;
  /** Name of the object data ID (mesh, curve, light, ...). */
  dataName?: string;
  /** Material keys per slot (null = empty slot). */
  materialSlots: (string | null)[];
  slotLinks: ('OBJECT' | 'DATA')[];
  modifiers: ModifierInfo[];
  /** Initial visibility (§4.9). */
  visible: boolean;
  /** Reachable from the active scene's collection tree. */
  inScene: boolean;
  /** Names of collections that directly contain the object. */
  collections: string[];
  /** Collection key, when the object instances a collection (§4.10). */
  instanceCollection?: string;
  /** Empty display size (empties only). */
  emptySize?: number;
  /** Library path when linked from another .blend. */
  library?: string;
  /** Explanations shown in the info panel. */
  notes: string[];
  /** Problems with this object (shown with a warning sign). */
  warnings: string[];
}

export interface MeshData {
  name: string;
  nverts: number;
  nfaces: number;
  ntris: number;
  /** Flat xyz, one entry per vertex. */
  positions: Float32Array;
  /** Flat vertex indices, 3 per triangle. */
  triangles: Uint32Array;
  /** Material slot index per triangle. */
  triMaterial: Uint16Array;
  /** 1 = smooth-shaded face. */
  triSmooth: Uint8Array;
  /** Face index per triangle. */
  triFace: Uint32Array;
  /** Per-face material index and smooth flag. */
  faceMaterial: Uint16Array;
  faceSmooth: Uint8Array;
  /** Which of the storage layouts in §4.11 the mesh used. */
  layout: 'attribute-storage' | 'customdata-generic' | 'customdata-legacy' | 'mface' | 'empty';
  /** Number of objects that use this mesh. */
  users: number;
  library?: string;
}

export interface MaterialInfo {
  name: string;
  /** Linear RGBA. */
  color: [number, number, number, number];
  /** Where the colour came from, e.g. "node:ShaderNodeBsdfPrincipled" or "viewport". */
  source: string;
  viewport: [number, number, number, number];
  library?: string;
}

export interface CollectionNode {
  key: string;
  name: string;
  /** Collection.flag & 1: "disable in viewports". */
  hidden: boolean;
  /** Object ids, in file order. */
  objects: number[];
  children: CollectionNode[];
  library?: string;
}

export interface CollectionInfo {
  key: string;
  name: string;
  hidden: boolean;
  objects: number[];
  children: string[];
  /** Collection.dupli_ofs (instance offset). */
  instanceOffset: [number, number, number];
  library?: string;
}

export interface InstanceRecord {
  /** Object id of the instanced object. */
  object: number;
  /** Object id of the top-level instancing empty. */
  instancer: number;
  /** Instancing empties from the top level down (nested instances). */
  chain: number[];
  collection: string;
  /** Column-major world matrix of this instance. */
  matrix: number[];
}

export interface SceneDescription {
  /** e.g. 402, 503 */
  blenderVersion: number;
  fileFormat: 'legacy' | 'large';
  compression: 'none' | 'zstd' | 'gzip';
  pointerSize: number;
  littleEndian: boolean;
  sceneName: string;
  objects: SceneObject[];
  /** Keyed by mesh key (the mesh ID name, made unique). Shared by several objects. */
  meshes: Record<string, MeshData>;
  materials: Record<string, MaterialInfo>;
  /** Root = scene master collection ("Scene Collection"). */
  collections: CollectionNode;
  /** Every collection in the file, including ones only used for instancing. */
  collectionIndex: Record<string, CollectionInfo>;
  instances: InstanceRecord[];
  /** Human-readable, shown in a banner. */
  warnings: string[];
  stats: { objects: number; meshes: number; triangles: number; parseMs: number };
}
