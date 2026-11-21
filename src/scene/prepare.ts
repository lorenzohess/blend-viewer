import { buildRenderMesh, type RenderMesh } from './rendermesh';
import type { MeshData, SceneDescription } from './types';

/** Mesh as sent to the main thread: counts and render buffers, no parser arrays. */
export type ViewerMesh = Omit<MeshData, 'positions' | 'triangles' | 'triMaterial' | 'triSmooth' | 'triFace' | 'faceMaterial' | 'faceSmooth'> & {
  render: RenderMesh;
};

export type ViewerScene = Omit<SceneDescription, 'meshes'> & {
  meshes: Record<string, ViewerMesh>;
};

/**
 * Turn the parser output into what the viewer needs, and list the buffers to
 * transfer (zero-copy) from the worker.
 */
export function prepareForViewer(s: SceneDescription, onProgress?: (stage: string, f: number) => void): { scene: ViewerScene; transfer: ArrayBuffer[] } {
  const meshes: Record<string, ViewerMesh> = {};
  const transfer: ArrayBuffer[] = [];
  const keys = Object.keys(s.meshes);
  keys.forEach((k, i) => {
    if (i % 32 === 0) onProgress?.('Building render buffers', i / Math.max(1, keys.length));
    const { positions: _p, triangles: _t, triMaterial: _m, triSmooth: _s, triFace: _f, faceMaterial: _fm, faceSmooth: _fs, ...rest } = s.meshes[k];
    const render = buildRenderMesh(s.meshes[k]);
    meshes[k] = { ...rest, render };
    transfer.push(render.positions.buffer as ArrayBuffer, render.normals.buffer as ArrayBuffer, render.index.buffer as ArrayBuffer);
  });
  return { scene: { ...s, meshes }, transfer };
}
