import { BlendError } from '../io/decompress';

export interface DnaField {
  /** Lookup key: '*next' -> 'next', 'co[3]' -> 'co', '(*func)()' -> 'func'. */
  name: string;
  rawName: string;
  type: string;
  isPointer: boolean;
  /** Product of all [N] dimensions (1 for scalars). */
  count: number;
  offset: number;
  /** Size of one element (pointer size for pointers). */
  elemSize: number;
  /** elemSize * count */
  size: number;
}

export interface DnaStruct {
  name: string;
  index: number;
  /** Size from TLEN; use it as the array stride. */
  size: number;
  fields: DnaField[];
  byName: Map<string, DnaField>;
}

export interface SDNA {
  names: string[];
  types: string[];
  tlen: number[];
  structs: DnaStruct[];
  structByName: Map<string, DnaStruct>;
  typeIndex: Map<string, number>;
}

/**
 * Parse the DNA1 block. `start` is the offset of the block DATA (not the header);
 * every 4-byte alignment is relative to `start`, not to the file (gotcha §4.5).
 */
export function parseDNA(d: Uint8Array, start: number, len: number, le: boolean, ptrSize: number): SDNA {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const end = start + len;
  let p = start;
  const align = () => { p = start + ((p - start + 3) & ~3); };
  const tag = (want: string) => {
    const got = String.fromCharCode(d[p], d[p + 1], d[p + 2], d[p + 3]);
    if (got !== want) throw new BlendError(`The file's DNA block is damaged (expected "${want}", found "${got}").`);
    p += 4;
  };
  const dec = new TextDecoder('latin1');
  const strings = (): string[] => {
    const n = dv.getInt32(p, le); p += 4;
    const out = new Array<string>(n);
    for (let i = 0; i < n; i++) {
      let q = p;
      while (q < end && d[q] !== 0) q++;
      out[i] = dec.decode(d.subarray(p, q));
      p = q + 1;
    }
    align();
    return out;
  };

  tag('SDNA');
  tag('NAME'); const names = strings();
  tag('TYPE'); const types = strings();
  tag('TLEN');
  const tlen = new Array<number>(types.length);
  for (let i = 0; i < types.length; i++) { tlen[i] = dv.getInt16(p, le); p += 2; }
  align();
  tag('STRC');
  const nstruct = dv.getInt32(p, le); p += 4;

  const typeIndex = new Map<string, number>();
  types.forEach((t, i) => typeIndex.set(t, i));
  const structs: DnaStruct[] = [];
  const structByName = new Map<string, DnaStruct>();
  for (let s = 0; s < nstruct; s++) {
    const ti = dv.getInt16(p, le), nf = dv.getInt16(p + 2, le); p += 4;
    const fields: DnaField[] = [];
    const byName = new Map<string, DnaField>();
    let off = 0;
    for (let f = 0; f < nf; f++) {
      const ft = dv.getInt16(p, le), fn = dv.getInt16(p + 2, le); p += 4;
      const rawName = names[fn];
      const isPointer = rawName.includes('*');
      let count = 1;
      for (const m of rawName.matchAll(/\[(\d+)\]/g)) count *= parseInt(m[1], 10);
      const name = rawName.replace(/\[.*$/, '').replace(/[*()]/g, '');
      const elemSize = isPointer ? ptrSize : tlen[ft];
      const field: DnaField = { name, rawName, type: types[ft], isPointer, count, offset: off, elemSize, size: elemSize * count };
      fields.push(field);
      if (!byName.has(name)) byName.set(name, field);
      off += field.size;
    }
    const st: DnaStruct = { name: types[ti], index: s, size: tlen[ti], fields, byName };
    structs.push(st);
    structByName.set(st.name, st);
  }
  return { names, types, tlen, structs, structByName, typeIndex };
}
