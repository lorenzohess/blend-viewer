import './ui/styles.css';
import { App } from './ui/app';

const app = new App();

/** Hook for the automated browser tests (scripts/browser-test.mjs). Harmless for users. */
(window as unknown as { __blendViewer: unknown }).__blendViewer = {
  state: () => app.debug(),
  /** Cheap status for polling while a file loads. */
  status: () => ({ loadCount: app.loadCount, loaded: !!app.scene && !app.loading, lastError: app.lastError }),
  selectByName: (name: string, mode: 'replace' | 'toggle' | 'add' = 'replace') => {
    const o = app.scene?.objects.find((x) => x.name === name);
    if (o) app.select([o.id], mode, true);
    return !!o;
  },
  screenPoint: (name: string) => {
    const o = app.scene?.objects.find((x) => x.name === name);
    return o ? app.viewer.screenPointOf(o.id) : null;
  },
  pickAt: (x: number, y: number) => {
    const id = app.viewer.pickAt(x, y);
    return id === null ? null : app.scene!.objects[id].name;
  },
  exportBase64: async (kind: 'glb-visible' | 'glb-all' | 'stl-selected' | 'stl-visible') => {
    const r = await app.exportBytes(kind);
    if (!r) return null;
    const bytes = new Uint8Array(r.data);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { name: r.name, base64: btoa(bin) };
  },
  frame: (names?: string[]) => app.frame(names?.map((n) => app.scene!.objects.find((o) => o.name === n)!.id)),
  setView: (v: Parameters<typeof app.viewer.setView>[0]) => app.viewer.setView(v),
  renderNow: () => app.viewer.renderNow(),
  worldBox: (name: string) => {
    const o = app.scene!.objects.find((x) => x.name === name)!;
    const b = app.viewer.worldBox(o.id, true);
    return { min: b.min.toArray(), max: b.max.toArray() };
  },
  visibleTriangles: () => {
    const s = app.scene!, st = app.debug();
    const vis = new Set(st.objects.filter((o) => o.visible).map((o) => o.id));
    let n = 0;
    for (const o of s.objects) if (vis.has(o.id) && o.mesh) n += s.meshes[o.mesh].ntris;
    for (const i of s.instances) { const m = s.objects[i.object].mesh; if (vis.has(i.instancer) && m) n += s.meshes[m].ntris; }
    return n;
  },
};
