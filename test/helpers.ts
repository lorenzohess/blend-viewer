import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseBlend } from '../src/scene/extract';
import type { SceneDescription } from '../src/scene/types';

/** test-files/ lives in blend-viewer-handoff/ unless BLEND_TEST_FILES points elsewhere. */
export const TEST_FILES = resolve(
  process.env.BLEND_TEST_FILES ?? (existsSync('test-files') ? 'test-files' : 'blend-viewer-handoff/test-files'),
);

export interface GTObject {
  type: string;
  parent: string | null;
  matrix_world: number[][];
  collections?: string[];
  mesh?: string;
  nverts?: number;
  nfaces?: number;
  ntris?: number;
  v0?: number[];
  face_mats?: number[];
  smooth?: boolean[];
  slots?: [string, string | null][];
}

export interface GroundTruth {
  objects: Record<string, GTObject>;
  materials?: Record<string, { base: number[]; viewport: number[] }>;
  instances?: { obj: string; parent: string; matrix_world: number[][] }[];
}

export interface Case {
  dir: string;
  file: string;
  path: string;
  gt: GroundTruth;
}

export function loadCases(): Case[] {
  const out: Case[] = [];
  for (const dir of readdirSync(TEST_FILES).sort()) {
    const gtPath = join(TEST_FILES, dir, 'ground_truth.json');
    if (!existsSync(gtPath)) continue;
    const raw = JSON.parse(readFileSync(gtPath, 'utf8')) as Record<string, unknown>;
    const gt: GroundTruth = { objects: {} };
    for (const [k, v] of Object.entries(raw)) {
      if (k === '_materials') gt.materials = v as GroundTruth['materials'];
      else if (k === '_instances') gt.instances = v as GroundTruth['instances'];
      else if (!k.startsWith('_')) gt.objects[k] = v as GTObject;
    }
    for (const file of readdirSync(join(TEST_FILES, dir)).sort()) {
      if (file.endsWith('.blend')) out.push({ dir, file, path: join(TEST_FILES, dir, file), gt });
    }
  }
  return out;
}

const cache = new Map<string, Promise<SceneDescription>>();
export function parseFile(path: string): Promise<SceneDescription> {
  let p = cache.get(path);
  if (!p) {
    p = parseBlend(new Uint8Array(readFileSync(path)));
    cache.set(path, p);
  }
  return p;
}

export function byName(s: SceneDescription, name: string) {
  return s.objects.find((o) => o.name === name);
}

export function maxAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
  return d;
}
