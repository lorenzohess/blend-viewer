import { BlendError } from './io/decompress';
import { parseBlend } from './scene/extract';
import { prepareForViewer } from './scene/prepare';

export type WorkerRequest = { file?: File; buffer?: ArrayBuffer };
export type WorkerResponse =
  | { type: 'progress'; stage: string; fraction: number }
  | { type: 'result'; scene: import('./scene/prepare').ViewerScene }
  | { type: 'error'; message: string; userError: boolean };

interface WorkerScope {
  postMessage(m: unknown, transfer: Transferable[]): void;
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
}
const ctx = self as unknown as WorkerScope;
const post = (m: WorkerResponse, transfer: Transferable[] = []) => ctx.postMessage(m, transfer);

ctx.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  try {
    post({ type: 'progress', stage: 'Reading file', fraction: 0 });
    const { file, buffer } = ev.data;
    const bytes = buffer ? new Uint8Array(buffer) : new Uint8Array(await file!.arrayBuffer());
    const onProgress = (stage: string, fraction: number) => post({ type: 'progress', stage, fraction });
    const parsed = await parseBlend(bytes, { onProgress });
    const { scene, transfer } = prepareForViewer(parsed, onProgress);
    post({ type: 'result', scene }, transfer);
  } catch (e) {
    post({ type: 'error', message: (e as Error).message ?? String(e), userError: e instanceof BlendError });
  }
};
