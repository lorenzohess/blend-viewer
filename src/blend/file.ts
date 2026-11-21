import { BlendError } from '../io/decompress';
import { type Block, type BlendHeader, parseHeader, readBlocks } from './header';
import { type DnaField, type DnaStruct, type SDNA, parseDNA } from './dna';

export type { Block, BlendHeader } from './header';
export type { DnaField, DnaStruct, SDNA } from './dna';

type Kind = 'i8' | 'u8' | 'i16' | 'u16' | 'i32' | 'u32' | 'i64' | 'u64' | 'f32' | 'f64';

const PRIM: Record<string, Kind> = {
  char: 'i8', uchar: 'u8', int8_t: 'i8', uint8_t: 'u8', bool: 'u8',
  short: 'i16', ushort: 'u16', int16_t: 'i16', uint16_t: 'u16',
  int: 'i32', uint: 'u32', int32_t: 'i32', uint32_t: 'u32',
  float: 'f32', double: 'f64', int64_t: 'i64', uint64_t: 'u64',
};

const HOST_LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const utf8 = new TextDecoder('utf-8');

export interface FieldRef { field: DnaField; offset: number }

/** One ID block and the DATA blocks that follow it (§4.4). */
export interface Group {
  head: Block;
  isId: boolean;
  local: Map<bigint, Block>;
}

/**
 * A parsed .blend file: blocks, ID groups, DNA and typed field access.
 * Every read goes through the file's own DNA, so no struct offsets are hard-coded.
 */
export class BlendFile {
  readonly data: Uint8Array;
  readonly dv: DataView;
  readonly header: BlendHeader;
  readonly blocks: Block[];
  readonly dna: SDNA;
  readonly groups: Group[] = [];
  /** ID blocks by address. ID addresses are unique, unlike DATA addresses. */
  readonly ids = new Map<bigint, Block>();
  readonly warnings: string[] = [];
  readonly le: boolean;
  readonly ptrSize: number;
  private pathCache = new Map<string, FieldRef | null>();

  constructor(data: Uint8Array) {
    this.data = data;
    this.dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.header = parseHeader(data);
    this.le = this.header.littleEndian;
    this.ptrSize = this.header.pointerSize;
    this.blocks = readBlocks(data, this.header, this.warnings);
    const dnaBlock = this.blocks.find((b) => b.code === 'DNA1');
    if (!dnaBlock) throw new BlendError('The .blend file has no DNA1 block, so its structs cannot be decoded. It may be truncated.');
    this.dna = parseDNA(data, dnaBlock.offset, dnaBlock.len, this.le, this.ptrSize);
    this.buildGroups();
  }

  get version(): number { return this.header.version; }

  private buildGroups() {
    let cur = -1;
    let dupIds = 0;
    for (const b of this.blocks) {
      if (b.code === 'DATA') {
        if (cur < 0) continue; // stray DATA before any owner: ignore
        b.group = cur;
        const loc = this.groups[cur].local;
        if (!loc.has(b.oldPtr)) loc.set(b.oldPtr, b);
        continue;
      }
      const isId = b.code.length === 2;
      this.groups.push({ head: b, isId, local: new Map() });
      cur = this.groups.length - 1;
      b.group = cur;
      if (isId) {
        if (this.ids.has(b.oldPtr)) dupIds++;
        else this.ids.set(b.oldPtr, b);
      }
    }
    if (dupIds) this.warnings.push(`${dupIds} ID blocks share an address with another ID; the first one was used.`);
  }

  // ------------------------------------------------------------------ blocks

  structOf(b: Block): DnaStruct | undefined { return this.dna.structs[b.sdnaIndex]; }
  structName(b: Block): string { return this.dna.structs[b.sdnaIndex]?.name ?? '?'; }
  blocksWithCode(code: string): Block[] { return this.blocks.filter((b) => b.code === code); }

  /**
   * Resolve a pointer read from inside `group`: that group's DATA blocks first,
   * then ID blocks globally (§4.4). Returns null for null or dangling pointers.
   */
  resolve(ptr: bigint, group: number): Block | null {
    if (!ptr) return null;
    if (group >= 0) {
      const b = this.groups[group]?.local.get(ptr);
      if (b) return b;
    }
    return this.ids.get(ptr) ?? null;
  }

  resolveId(ptr: bigint): Block | null { return ptr ? this.ids.get(ptr) ?? null : null; }

  // --------------------------------------------------------------------- DNA

  hasStruct(name: string): boolean { return this.dna.structByName.has(name); }
  structSize(name: string): number { return this.dna.structByName.get(name)?.size ?? 0; }

  /** Field offset for a dotted path such as 'id.name' or 'attribute_storage.dna_attributes_num'. */
  ref(struct: string, path: string): FieldRef | null {
    const key = struct + '|' + path;
    const hit = this.pathCache.get(key);
    if (hit !== undefined) return hit;
    let st = this.dna.structByName.get(struct);
    let off = 0;
    let field: DnaField | undefined;
    const parts = path.split('.');
    for (let i = 0; i < parts.length; i++) {
      if (!st) { field = undefined; break; }
      field = st.byName.get(parts[i]);
      if (!field) break;
      off += field.offset;
      if (i < parts.length - 1) st = field.isPointer ? undefined : this.dna.structByName.get(field.type);
    }
    const r = field ? { field, offset: off } : null;
    this.pathCache.set(key, r);
    return r;
  }

  has(struct: string, path: string): boolean { return this.ref(struct, path) !== null; }

  /** Offset of a field relative to the struct start (throws if missing). */
  offsetOf(struct: string, path: string): number {
    const r = this.ref(struct, path);
    if (!r) throw new BlendError(`Field ${struct}.${path} is missing from this file's DNA.`);
    return r.offset;
  }

  // ----------------------------------------------------------------- readers

  readPtrAt(off: number): bigint {
    return this.ptrSize === 8 ? this.dv.getBigUint64(off, this.le) : BigInt(this.dv.getUint32(off, this.le));
  }

  private kindOf(f: DnaField): Kind {
    const k = PRIM[f.type];
    if (k) return k;
    switch (f.elemSize) { case 1: return 'i8'; case 2: return 'i16'; case 8: return 'i64'; default: return 'i32'; }
  }

  readKind(kind: Kind, off: number): number {
    const dv = this.dv, le = this.le;
    switch (kind) {
      case 'i8': return dv.getInt8(off);
      case 'u8': return dv.getUint8(off);
      case 'i16': return dv.getInt16(off, le);
      case 'u16': return dv.getUint16(off, le);
      case 'i32': return dv.getInt32(off, le);
      case 'u32': return dv.getUint32(off, le);
      case 'i64': return Number(dv.getBigInt64(off, le));
      case 'u64': return Number(dv.getBigUint64(off, le));
      case 'f32': return dv.getFloat32(off, le);
      case 'f64': return dv.getFloat64(off, le);
    }
  }

  /** Number field (first element for arrays). Returns `def` if the field does not exist. */
  num(struct: string, base: number, path: string, def = 0): number {
    const r = this.ref(struct, path);
    if (!r || r.field.isPointer) return def;
    return this.readKind(this.kindOf(r.field), base + r.offset);
  }

  /** All elements of a numeric array field, e.g. Object.loc -> [x, y, z]. */
  nums(struct: string, base: number, path: string, def: number[] = []): number[] {
    const r = this.ref(struct, path);
    if (!r || r.field.isPointer) return def;
    const k = this.kindOf(r.field), es = r.field.elemSize;
    const out = new Array<number>(r.field.count);
    for (let i = 0; i < r.field.count; i++) out[i] = this.readKind(k, base + r.offset + i * es);
    return out;
  }

  ptr(struct: string, base: number, path: string): bigint {
    const r = this.ref(struct, path);
    if (!r || !r.field.isPointer) return 0n;
    return this.readPtrAt(base + r.offset);
  }

  /** char[N] field as a UTF-8 string up to the first NUL. */
  str(struct: string, base: number, path: string): string {
    const r = this.ref(struct, path);
    if (!r || r.field.isPointer) return '';
    return this.cstrAt(base + r.offset, r.field.size);
  }

  cstrAt(off: number, max: number): string {
    const end = Math.min(off + max, this.data.length);
    let q = off;
    while (q < end && this.data[q] !== 0) q++;
    return utf8.decode(this.data.subarray(off, q));
  }

  /** Whole block as a NUL-terminated string (used for `char *name` attributes). */
  blockStr(b: Block | null): string { return b ? this.cstrAt(b.offset, b.len) : ''; }

  // ------------------------------------------------------------- ID helpers

  /** Raw ID name with the 2-letter prefix, e.g. 'OBCube'. Works for ID placeholders too. */
  idRawName(b: Block): string {
    const st = this.structName(b);
    if (st === 'ID') return this.str('ID', b.offset, 'name');
    return this.has(st, 'id.name') ? this.str(st, b.offset, 'id.name') : '';
  }

  /** Display name: ID name without the 2-letter type prefix (§4.6). */
  idName(b: Block): string { return this.idRawName(b).slice(2); }

  /** Library path when the ID is linked from another .blend, else null. */
  idLibrary(b: Block): string | null {
    const st = this.structName(b);
    const lib = st === 'ID' ? this.ptr('ID', b.offset, 'lib') : this.ptr(st, b.offset, 'id.lib');
    if (!lib) return null;
    const lb = this.resolveId(lib);
    if (!lb) return '(unknown library)';
    const ls = this.structName(lb);
    return this.str(ls, lb.offset, 'filepath') || this.str(ls, lb.offset, 'name') || this.idName(lb) || '(unknown library)';
  }

  // ------------------------------------------------------------ containers

  /** Walk a ListBase { first, last } stored at absolute offset `lbOff`. */
  listBase(lbOff: number, group: number, limit = 1_000_000): Block[] {
    const out: Block[] = [];
    let p = this.readPtrAt(lbOff);
    const seen = new Set<bigint>();
    while (p && !seen.has(p) && out.length < limit) {
      seen.add(p);
      const b = this.resolve(p, group);
      if (!b) break;
      out.push(b);
      p = this.readPtrAt(b.offset); // Link.next is always the first member
    }
    return out;
  }

  /** ListBase field of a struct, e.g. listOf('Collection', off, 'gobject', group). */
  listOf(struct: string, base: number, path: string, group: number): Block[] {
    const r = this.ref(struct, path);
    if (!r) return [];
    return this.listBase(base + r.offset, group);
  }

  /** `Foo **arr` with n entries -> array of pointers. */
  ptrArray(ptr: bigint, group: number, n: number): bigint[] {
    const b = this.resolve(ptr, group);
    if (!b || n <= 0) return [];
    n = Math.min(n, Math.floor(b.len / this.ptrSize));
    const out = new Array<bigint>(n);
    for (let i = 0; i < n; i++) out[i] = this.readPtrAt(b.offset + i * this.ptrSize);
    return out;
  }

  // ------------------------------------------------------- bulk array copy
  // 5.x block data starts at odd offsets, so never view the file buffer
  // directly with a typed array: copy first (gotcha §4.3).

  private bulkCount(b: Block, n: number, bytes: number, byteOffset: number): number {
    const avail = Math.max(0, b.len - byteOffset);
    if (n * bytes > avail) {
      this.warnings.push(`A data array is shorter than expected (${Math.floor(avail / bytes)} of ${n} values); the rest was filled with zeros.`);
      return Math.floor(avail / bytes);
    }
    return n;
  }

  f32(b: Block, n: number, byteOffset = 0): Float32Array {
    const m = this.bulkCount(b, n, 4, byteOffset);
    const off = b.offset + byteOffset;
    const out = new Float32Array(n);
    if (this.le === HOST_LE) out.set(new Float32Array(this.data.buffer.slice(this.data.byteOffset + off, this.data.byteOffset + off + m * 4)));
    else for (let i = 0; i < m; i++) out[i] = this.dv.getFloat32(off + i * 4, this.le);
    return out;
  }

  i32(b: Block, n: number, byteOffset = 0): Int32Array {
    const m = this.bulkCount(b, n, 4, byteOffset);
    const off = b.offset + byteOffset;
    const out = new Int32Array(n);
    if (this.le === HOST_LE) out.set(new Int32Array(this.data.buffer.slice(this.data.byteOffset + off, this.data.byteOffset + off + m * 4)));
    else for (let i = 0; i < m; i++) out[i] = this.dv.getInt32(off + i * 4, this.le);
    return out;
  }

  u8(b: Block, n: number, byteOffset = 0): Uint8Array {
    const m = this.bulkCount(b, n, 1, byteOffset);
    const out = new Uint8Array(n);
    out.set(this.data.subarray(b.offset + byteOffset, b.offset + byteOffset + m));
    return out;
  }

  /** Read one field from each element of a struct array (stride = TLEN). */
  strided(b: Block, n: number, struct: string, path: string, comps = 1): Float64Array {
    const r = this.ref(struct, path);
    const out = new Float64Array(n * comps);
    if (!r) return out;
    const stride = this.structSize(struct);
    const k = this.kindOf(r.field), es = r.field.elemSize;
    const m = Math.min(n, Math.floor(b.len / stride));
    if (m < n) this.warnings.push(`A ${struct} array is shorter than expected (${m} of ${n}).`);
    for (let i = 0; i < m; i++) {
      const o = b.offset + i * stride + r.offset;
      for (let c = 0; c < comps; c++) out[i * comps + c] = this.readKind(k, o + c * es);
    }
    return out;
  }
}
