import { BlendError } from './io/decompress';
import { parseBlend } from './scene/extract';
import { prepareForViewer, type ViewerScene } from './scene/prepare';
import type { WorkerResponse } from './worker';
import ParserWorker from './worker?worker&inline';

export type Progress = (stage: string, fraction: number) => void;

/** Fallback when a Worker cannot be created (for example a strict browser policy on file://). */
async function parseOnMainThread(file: File, onProgress: Progress): Promise<ViewerScene> {
  onProgress('Reading file (no worker available)', 0);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const parsed = await parseBlend(bytes, { onProgress });
  return prepareForViewer(parsed, onProgress).scene;
}

/** Parse a .blend file in a Web Worker, so large files do not freeze the page. */
export function parseBlendFile(file: File, onProgress: Progress): Promise<ViewerScene & { usedWorker: boolean }> {
  let worker: Worker;
  try {
    worker = new ParserWorker();
  } catch {
    return parseOnMainThread(file, onProgress).then((s) => ({ ...s, usedWorker: false }));
  }
  return new Promise((resolve, reject) => {
    let started = false;
    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      started = true;
      const m = ev.data;
      if (m.type === 'progress') onProgress(m.stage, m.fraction);
      else {
        worker.terminate();
        if (m.type === 'result') resolve({ ...m.scene, usedWorker: true });
        else reject(m.userError ? new BlendError(m.message) : new Error(m.message));
      }
    };
    worker.onerror = (ev) => {
      ev.preventDefault();
      worker.terminate();
      if (!started) parseOnMainThread(file, onProgress).then((s) => resolve({ ...s, usedWorker: false }), reject);
      else reject(new Error(ev.message || 'The parser worker crashed (the file may be too large for available memory).'));
    };
    worker.postMessage({ file });
  });
}
