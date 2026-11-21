import { decompress as zstdDecompress } from 'fzstd';

export type Compression = 'none' | 'zstd' | 'gzip';

/** Thrown for any problem the user should see as a plain message. */
export class BlendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlendError';
  }
}

const BLENDER = [0x42, 0x4c, 0x45, 0x4e, 0x44, 0x45, 0x52]; // "BLENDER"

export function detectCompression(b: Uint8Array): Compression | 'unknown' {
  if (b.length >= 4 && b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd) return 'zstd';
  if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) return 'gzip';
  if (b.length >= 7 && BLENDER.every((c, i) => b[i] === c)) return 'none';
  return 'unknown';
}

async function gunzip(b: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new BlendError('This browser cannot decompress gzip-compressed .blend files (no DecompressionStream).');
  }
  const stream = new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Undo zstd (Blender 3.0+) or gzip (pre-3.0) compression.
 * Returns the raw "BLENDER..." bytes.
 */
export async function decompressBlend(input: Uint8Array): Promise<{ data: Uint8Array; compression: Compression }> {
  const kind = detectCompression(input);
  if (kind === 'none') return { data: input, compression: 'none' };
  if (kind === 'unknown') {
    throw new BlendError('This is not a .blend file. It does not start with "BLENDER" and is not zstd- or gzip-compressed.');
  }
  let data: Uint8Array;
  try {
    data = kind === 'zstd' ? zstdDecompress(input) : await gunzip(input);
  } catch (e) {
    throw new BlendError(`The file looks ${kind}-compressed, but it could not be decompressed: ${(e as Error).message}`);
  }
  if (detectCompression(data) !== 'none') {
    throw new BlendError(`The file is ${kind}-compressed, but the content is not a .blend file.`);
  }
  return { data, compression: kind };
}
