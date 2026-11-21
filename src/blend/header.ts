import { BlendError } from '../io/decompress';

export interface BlendHeader {
  /** 'legacy' = BLENDER-v402 (12 bytes); 'large' = BLENDER17-01v0503 (Blender 5.0+). */
  format: 'legacy' | 'large';
  headerSize: number;
  pointerSize: 4 | 8;
  littleEndian: boolean;
  /** e.g. 402 for 4.2, 503 for 5.3 */
  version: number;
}

export interface Block {
  index: number;
  /** Block code with trailing NULs removed: 'OB', 'ME', 'DATA', 'DNA1', ... */
  code: string;
  sdnaIndex: number;
  /** Address the data had in memory when saved. NOT unique across the file (see §4.4). */
  oldPtr: bigint;
  len: number;
  count: number;
  /** Byte offset of the block data within the decompressed file. */
  offset: number;
  /** ID group this block belongs to (index into BlendFile.groups), or -1. */
  group: number;
}

const ascii = (d: Uint8Array, a: number, b: number) => String.fromCharCode(...d.subarray(a, b));

export function parseHeader(d: Uint8Array): BlendHeader {
  if (d.length < 12 || ascii(d, 0, 7) !== 'BLENDER') {
    throw new BlendError('This is not a .blend file (missing "BLENDER" header).');
  }
  if (ascii(d, 7, 9) === '17') {
    // BLENDER17-01v0503
    if (d.length < 17) throw new BlendError('The .blend file is truncated (header too short).');
    const fmt = ascii(d, 10, 12);
    if (fmt !== '01') {
      throw new BlendError(`Unsupported .blend file format version "${fmt}". This viewer reads format 01 (Blender 5.x).`);
    }
    if (d[12] !== 0x76 /* v */) throw new BlendError('Big-endian Blender 5.x files are not supported.');
    const version = parseInt(ascii(d, 13, 17), 10);
    return { format: 'large', headerSize: 17, pointerSize: 8, littleEndian: true, version };
  }
  const p = d[7], e = d[8];
  if ((p !== 0x2d && p !== 0x5f) || (e !== 0x76 && e !== 0x56)) {
    const h = ascii(d, 7, 12).replace(/[^\x20-\x7e]/g, '?');
    throw new BlendError(`Unrecognised .blend header "BLENDER${h}". The file may come from a newer Blender than this viewer knows.`);
  }
  const version = parseInt(ascii(d, 9, 12), 10);
  return {
    format: 'legacy',
    headerSize: 12,
    pointerSize: p === 0x2d /* - */ ? 8 : 4,
    littleEndian: e === 0x76 /* v */,
    version: Number.isFinite(version) ? version : 0,
  };
}

/** Read every block header up to ENDB. Throws only if the very first block is unreadable. */
export function readBlocks(d: Uint8Array, h: BlendHeader, warnings: string[]): Block[] {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const le = h.littleEndian;
  const hs = h.format === 'large' ? 32 : h.pointerSize === 8 ? 24 : 20;
  const blocks: Block[] = [];
  let pos = h.headerSize;
  while (pos + hs <= d.length) {
    const code = ascii(d, pos, pos + 4).replace(/\0+$/, '');
    let sdnaIndex: number, oldPtr: bigint, len: number, count: number;
    if (h.format === 'large') {
      sdnaIndex = dv.getInt32(pos + 4, le);
      oldPtr = dv.getBigUint64(pos + 8, le);
      len = Number(dv.getBigInt64(pos + 16, le));
      count = Number(dv.getBigInt64(pos + 24, le));
    } else {
      len = dv.getInt32(pos + 4, le);
      if (h.pointerSize === 8) {
        oldPtr = dv.getBigUint64(pos + 8, le);
        sdnaIndex = dv.getInt32(pos + 16, le);
        count = dv.getInt32(pos + 20, le);
      } else {
        oldPtr = BigInt(dv.getUint32(pos + 8, le));
        sdnaIndex = dv.getInt32(pos + 12, le);
        count = dv.getInt32(pos + 16, le);
      }
    }
    const offset = pos + hs;
    if (len < 0 || offset + len > d.length) {
      warnings.push(`The file is truncated or damaged at byte ${pos}; data after that point was skipped.`);
      break;
    }
    blocks.push({ index: blocks.length, code, sdnaIndex, oldPtr, len, count, offset, group: -1 });
    if (code === 'ENDB') return blocks;
    pos = offset + len;
  }
  if (!blocks.length) throw new BlendError('The .blend file contains no readable blocks.');
  if (blocks[blocks.length - 1].code !== 'ENDB' && !warnings.length) {
    warnings.push('The file has no end marker (ENDB). It may be truncated.');
  }
  return blocks;
}
