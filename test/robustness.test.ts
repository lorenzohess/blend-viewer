import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BlendError } from '../src/io/decompress';
import { parseBlend } from '../src/scene/extract';
import { loadCases } from './helpers';

const unc = loadCases().find((c) => c.dir === 'blender-5.3' && c.file === 'test_uncompressed.blend')!;
const legacy = loadCases().find((c) => c.dir === 'blender-4.2' && c.file === 'test_uncompressed.blend')!;

describe('graceful failure', () => {
  it('rejects a file that is not a .blend with a clear message', async () => {
    await expect(parseBlend(new TextEncoder().encode('hello world, not a blend file'))).rejects.toThrow(/not a \.blend file/);
    await expect(parseBlend(new Uint8Array(0))).rejects.toBeInstanceOf(BlendError);
  });

  it('rejects broken zstd data with a clear message', async () => {
    const bytes = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3, 4, 5, 6, 7, 8]);
    await expect(parseBlend(bytes)).rejects.toThrow(/could not be decompressed/);
  });

  it('decompresses gzip (pre-3.0 compression)', async () => {
    const raw = readFileSync(legacy.path);
    const gz = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    const s = await parseBlend(gz);
    expect(s.compression).toBe('gzip');
    expect(s.objects.length).toBe(14);
  });

  it('a truncated file (DNA missing) gives a BlendError, not a crash', async () => {
    const raw = new Uint8Array(readFileSync(unc.path));
    await expect(parseBlend(raw.slice(0, raw.length >> 1))).rejects.toThrow(/DNA1|truncated/);
  });

  it('a file cut just before ENDB still parses with a warning', async () => {
    const raw = new Uint8Array(readFileSync(unc.path));
    // A 5.x ENDB marker is a bare 32-byte block header at the very end.
    expect(new TextDecoder().decode(raw.subarray(raw.length - 32, raw.length - 28))).toBe('ENDB');
    const s = await parseBlend(raw.slice(0, raw.length - 32));
    expect(s.objects.length).toBe(14);
    expect(s.warnings.join(' ')).toMatch(/truncated|end marker/);
  });

  it('survives random corruption of DATA bytes without throwing', async () => {
    const raw = new Uint8Array(readFileSync(unc.path));
    let seed = 1234;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (let run = 0; run < 20; run++) {
      const copy = raw.slice();
      // Corrupt bytes in the middle of the file, but leave the DNA (at the end) alone.
      for (let k = 0; k < 200; k++) copy[Math.floor(200 + rnd() * (copy.length * 0.7))] = Math.floor(rnd() * 256);
      try {
        const s = await parseBlend(copy);
        expect(Array.isArray(s.objects)).toBe(true);
      } catch (e) {
        expect(e).toBeInstanceOf(BlendError);
      }
    }
  });
});
