import * as THREE from 'three';
import { download, exportGLB, exportSTL } from '../export/export';
import { parseBlendFile } from '../parseClient';
import { fmtVersion } from '../scene/extract';
import type { ViewerScene } from '../scene/prepare';
import { type ViewName, Viewer, nextFrame } from '../viewer/viewer';
import { InfoPanel } from './info';
import { Outliner } from './outliner';
import { type Prefs, loadPrefs, savePrefs } from './prefs';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const fmt = (x: number) => x.toLocaleString('en-US');

type Mode = 'replace' | 'toggle' | 'add';

export class App {
  readonly viewer: Viewer;
  private outliner: Outliner;
  private info: InfoPanel;
  private prefs: Prefs = loadPrefs();
  scene: ViewerScene | null = null;
  private fileName = '';
  private visible: Uint8Array = new Uint8Array(0);
  private selected = new Set<number>();
  private active: number | null = null;
  loading = false;
  lastError: string | null = null;
  loadCount = 0;
  timings: { parseMs: number; buildMs: number; totalMs: number; usedWorker: boolean; phases?: Record<string, number> } = { parseMs: 0, buildMs: 0, totalMs: 0, usedWorker: false };

  constructor() {
    this.viewer = new Viewer($('#viewport'), {
      onPick: (id, ev) => {
        if (id === null) { if (!ev.ctrlKey && !ev.shiftKey && !ev.metaKey) this.select([], 'replace'); return; }
        this.select([id], ev.ctrlKey || ev.metaKey ? 'toggle' : ev.shiftKey ? 'add' : 'replace', true);
      },
      onDoubleClick: (id) => { if (id !== null) this.frame([id]); },
    });
    this.outliner = new Outliner($('#tree'), {
      select: (ids, mode) => this.select(ids, mode),
      frame: (ids) => this.frame(ids),
      setVisible: (ids, v) => this.setVisible(ids, v),
      filterCleared: () => { $<HTMLInputElement>('#filter').value = ''; },
    });
    this.info = new InfoPanel($('#info'), {
      select: (id) => this.select([id], 'replace', true),
      frame: (ids) => this.frame(ids),
      isolate: (ids) => this.isolate(ids),
    }, (ids) => this.boxOf(ids));

    this.applyPrefs();
    this.wireToolbar();
    this.wireFiles();
    this.wireKeys();
    this.wireSplitter();
    this.updateToolbar();
  }

  // ------------------------------------------------------------- loading

  async openFile(file: File) {
    if (this.loading) return;
    this.loading = true;
    this.lastError = null;
    const t0 = performance.now();
    const loading = $('#loading'), stage = $('.ld-stage'), fill = $<HTMLElement>('.ld-fill');
    loading.hidden = false;
    $('#help').hidden = true;
    const progress = (s: string, f: number) => { stage.textContent = `${s}…`; fill.style.width = `${Math.round(f * 100)}%`; };
    progress(`Reading ${file.name}`, 0);
    try {
      const scene = await parseBlendFile(file, progress);
      const t1 = performance.now();
      this.scene = scene;
      this.fileName = file.name;
      this.visible = Uint8Array.from(scene.objects, (o) => (o.visible ? 1 : 0));
      this.selected.clear();
      this.active = null;
      $('#dropzone').hidden = true;
      progress('Building the 3D view', 0);
      await this.viewer.load(scene, this.visible, (f) => progress('Building the 3D view', f));
      const tView = performance.now();
      await nextFrame(); // let the browser draw between the big steps
      this.outliner.setScene(scene, this.visible);
      const tTree = performance.now();
      await nextFrame();
      this.info.setScene(scene, file.name);
      $<HTMLInputElement>('#filter').value = '';
      const t2 = performance.now();
      this.timings = {
        parseMs: t1 - t0, buildMs: t2 - t1, totalMs: t2 - t0, usedWorker: scene.usedWorker,
        phases: { start: t0, received: t1, viewBuilt: tView, treeBuilt: tTree, infoBuilt: t2 },
      };
      this.showWarnings(scene.warnings);
      this.updateStatus();
      this.loadCount++;
    } catch (e) {
      const msg = (e as Error).message || String(e);
      this.lastError = msg;
      this.showBanner('error', `Could not open ${file.name}`, [msg]);
      if (!this.scene) $('#dropzone').hidden = false;
    } finally {
      loading.hidden = true;
      this.loading = false;
      this.updateToolbar();
    }
  }

  private updateStatus() {
    const s = this.scene;
    if (!s) { $('#status').textContent = 'No file loaded'; return; }
    const meshObjects = s.objects.filter((o) => o.mesh && o.inScene).length;
    const parts = [
      this.fileName,
      `saved with Blender ${fmtVersion(s.blenderVersion)}`,
      `${fmt(s.objects.length)} objects`,
      `${fmt(meshObjects)} mesh objects`,
      `${fmt(Object.keys(s.meshes).length)} meshes`,
      `${fmt(s.stats.triangles)} triangles`,
      `parsed in ${fmt(Math.round(this.timings.parseMs))} ms${this.timings.usedWorker ? '' : ' (no worker)'}`,
    ];
    $('#status').textContent = parts.join(' · ');
  }

  // ------------------------------------------------------------- banner

  private showWarnings(w: string[]) {
    if (!w.length) { $('#banner').hidden = true; return; }
    this.showBanner('warn', w.length === 1 ? 'Note' : `${w.length} notes about this file`, w);
  }

  private showBanner(kind: 'warn' | 'error', title: string, items: string[]) {
    const b = $('#banner');
    b.className = kind === 'error' ? 'error' : '';
    b.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'banner-head';
    const strong = document.createElement('strong');
    strong.textContent = title;
    head.appendChild(strong);
    const single = items.length === 1;
    if (single) head.appendChild(document.createTextNode(items[0]));
    const actions = document.createElement('span');
    actions.className = 'banner-actions';
    const list = document.createElement('ul');
    const LIMIT = 3;
    const fill = (all: boolean) => {
      list.innerHTML = '';
      for (const t of all ? items : items.slice(0, LIMIT)) {
        const li = document.createElement('li');
        li.textContent = t;
        list.appendChild(li);
      }
    };
    if (!single) {
      fill(false);
      if (items.length > LIMIT) {
        const more = document.createElement('button');
        more.textContent = `Show all ${items.length}`;
        more.onclick = () => { fill(true); more.remove(); };
        actions.appendChild(more);
      }
    }
    const close = document.createElement('button');
    close.textContent = 'Dismiss';
    close.setAttribute('aria-label', 'Dismiss this message');
    close.onclick = () => { b.hidden = true; };
    actions.appendChild(close);
    head.appendChild(actions);
    b.appendChild(head);
    if (!single) b.appendChild(list);
    b.hidden = false;
  }

  // ------------------------------------------------------ selection, visibility

  select(ids: number[], mode: Mode, fromView = false) {
    if (!this.scene) return;
    if (mode === 'replace') this.selected = new Set(ids);
    else if (mode === 'add') for (const id of ids) this.selected.add(id);
    else for (const id of ids) { if (this.selected.has(id)) this.selected.delete(id); else this.selected.add(id); }
    this.active = ids.length && this.selected.has(ids[ids.length - 1]) ? ids[ids.length - 1] : [...this.selected].pop() ?? null;
    this.viewer.setSelection(this.selected);
    this.outliner.setSelection(this.selected, this.active);
    if (fromView && this.active !== null) this.outliner.reveal(this.active);
    this.info.show([...this.selected]);
    this.updateToolbar();
  }

  setVisible(ids: number[], v: boolean) {
    for (const id of ids) this.visible[id] = v ? 1 : 0;
    this.pushVisibility();
  }

  private pushVisibility() {
    this.viewer.setVisibility(this.visible);
    this.outliner.setVisibility(this.visible);
    this.info.show([...this.selected]);
  }

  isolate(ids = [...this.selected]) {
    if (!this.scene || !ids.length) return;
    const keep = new Set(ids);
    this.visible = Uint8Array.from(this.scene.objects, (o) => (keep.has(o.id) ? 1 : 0));
    this.pushVisibility();
    this.frame(ids);
  }

  showAll() {
    if (!this.scene) return;
    this.visible = Uint8Array.from(this.scene.objects, (o) => (o.inScene ? 1 : 0));
    this.pushVisibility();
  }

  hideSelected(invert = false) {
    if (!this.scene || !this.selected.size) return;
    for (const o of this.scene.objects) {
      const sel = this.selected.has(o.id);
      if (invert ? !sel : sel) this.visible[o.id] = 0;
    }
    this.pushVisibility();
  }

  frame(ids?: number[]) {
    if (!this.scene) return;
    this.viewer.frame(ids && ids.length ? ids : undefined);
  }

  private boxOf(ids: number[]) {
    if (!this.scene || !ids.length) return null;
    const s = this.scene;
    // Exact boxes walk every vertex. For big selections use the transformed mesh boxes instead.
    let verts = 0;
    for (const id of ids) { const m = s.objects[id].mesh; if (m) verts += s.meshes[m].nverts; }
    const precise = verts <= 300_000;
    const box = new THREE.Box3();
    for (const id of ids) {
      const o = s.objects[id];
      if (o.mesh || o.instanceCollection) box.union(this.viewer.worldBox(id, precise));
    }
    if (box.isEmpty()) return null;
    const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    return { size: size.toArray() as [number, number, number], center: c.toArray() as [number, number, number] };
  }

  // ------------------------------------------------------------- export

  private exportSource() {
    return { scene: this.scene!, geometry: (k: string) => this.viewer.geometryFor(k) };
  }

  private baseName() { return this.fileName.replace(/\.blend\d*$/i, '') || 'scene'; }

  async exportBytes(kind: 'glb-visible' | 'glb-all' | 'stl-selected' | 'stl-visible'): Promise<{ data: ArrayBuffer; name: string; type: string } | null> {
    const s = this.scene;
    if (!s) return null;
    const visibleIds = s.objects.filter((o) => this.visible[o.id]).map((o) => o.id);
    if (kind === 'glb-visible' || kind === 'glb-all') {
      const ids = kind === 'glb-all' ? s.objects.filter((o) => o.inScene).map((o) => o.id) : visibleIds;
      return { data: await exportGLB(this.exportSource(), ids, this.baseName()), name: `${this.baseName()}.glb`, type: 'model/gltf-binary' };
    }
    const ids = kind === 'stl-selected' ? [...this.selected] : visibleIds;
    if (!ids.length) throw new Error('Select one or more objects first.');
    const suffix = kind === 'stl-selected' && ids.length === 1 ? s.objects[ids[0]].name : kind === 'stl-selected' ? 'selection' : 'visible';
    return { data: exportSTL(this.exportSource(), ids), name: `${this.baseName()}-${suffix}.stl`.replace(/[\\/:*?"<>|]/g, '_'), type: 'model/stl' };
  }

  private async runExport(kind: Parameters<App['exportBytes']>[0]) {
    try {
      const r = await this.exportBytes(kind);
      if (r) download(r.data, r.name, r.type);
    } catch (e) {
      this.showBanner('error', 'Export failed', [(e as Error).message]);
    }
  }

  // ------------------------------------------------------------ wiring

  private applyPrefs() {
    const p = this.prefs;
    this.viewer.setWireframe(p.wireframe);
    this.viewer.setXray(p.xray);
    this.viewer.setGrid(p.grid);
    this.viewer.setAxes(p.axes);
    this.viewer.setOrtho(p.ortho);
    $('#app').classList.toggle('info-closed', !p.info);
    document.documentElement.style.setProperty('--outliner-w', `${p.outlinerWidth}px`);
  }

  private toggle(name: keyof Prefs, value?: boolean) {
    const p = this.prefs as unknown as Record<string, boolean>;
    const v = value ?? !p[name];
    p[name] = v;
    if (name === 'ortho') this.viewer.setOrtho(v);
    if (name === 'wireframe') this.viewer.setWireframe(v);
    if (name === 'xray') this.viewer.setXray(v);
    if (name === 'grid') this.viewer.setGrid(v);
    if (name === 'axes') this.viewer.setAxes(v);
    if (name === 'info') $('#app').classList.toggle('info-closed', !v);
    savePrefs(this.prefs);
    this.updateToolbar();
  }

  private updateToolbar() {
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-toggle]')) {
      const k = b.dataset.toggle as keyof Prefs;
      b.setAttribute('aria-pressed', String(Boolean(this.prefs[k])));
    }
    const has = !!this.scene;
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-cmd], [data-view], #btn-export')) b.disabled = !has || this.loading;
    const sel = this.selected.size > 0;
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-cmd="frame-selected"], [data-cmd="isolate"], [data-export="stl-selected"]')) {
      b.disabled = !has || !sel;
    }
  }

  private wireToolbar() {
    $('#btn-open').onclick = () => $<HTMLInputElement>('#file-input').click();
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-view]')) b.onclick = () => this.viewer.setView(b.dataset.view as ViewName);
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-toggle]')) b.onclick = () => this.toggle(b.dataset.toggle as keyof Prefs);
    const cmds: Record<string, () => void> = {
      'frame-all': () => this.frame(),
      'frame-selected': () => this.frame([...this.selected]),
      isolate: () => this.isolate(),
      'show-all': () => this.showAll(),
    };
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-cmd]')) b.onclick = () => cmds[b.dataset.cmd!]?.();
    const menu = $('#export-menu'), btn = $('#btn-export');
    const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    btn.onclick = (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
      btn.setAttribute('aria-expanded', String(!menu.hidden));
      if (!menu.hidden) menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    };
    for (const b of menu.querySelectorAll<HTMLButtonElement>('[data-export]')) {
      b.onclick = () => { close(); void this.runExport(b.dataset.export as Parameters<App['exportBytes']>[0]); };
    }
    document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target as Node)) close(); });
    $('#btn-help').onclick = () => { $('#help').hidden = !$('#help').hidden; };
    $('#help').onclick = () => { $('#help').hidden = true; };
    let t: ReturnType<typeof setTimeout>;
    $<HTMLInputElement>('#filter').addEventListener('input', (e) => {
      clearTimeout(t);
      const v = (e.target as HTMLInputElement).value;
      t = setTimeout(() => this.outliner.setFilter(v), 120);
    });
  }

  private wireFiles() {
    const input = $<HTMLInputElement>('#file-input');
    input.onchange = () => {
      const f = input.files?.[0];
      input.value = '';
      if (f) void this.openFile(f);
    };
    $('#dropzone').onclick = () => input.click();
    let depth = 0;
    const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth++; document.body.classList.add('dragging'); e.preventDefault(); } });
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer!.dropEffect = 'copy'; } });
    window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging'); } });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      document.body.classList.remove('dragging');
      const f = e.dataTransfer?.files?.[0];
      if (f) void this.openFile(f);
    });
  }

  private wireKeys() {
    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if (t.matches('input, textarea, select')) {
        if (e.key === 'Escape') t.blur();
        return;
      }
      const k = e.key, code = e.code, ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && k.toLowerCase() === 'o') { e.preventDefault(); $<HTMLInputElement>('#file-input').click(); return; }
      if (!this.scene) return;
      const views: Record<string, [ViewName, ViewName]> = { 1: ['front', 'back'], 3: ['right', 'left'], 7: ['top', 'bottom'] };
      const digit = code.startsWith('Numpad') ? code.slice(6) : code.startsWith('Digit') ? code.slice(5) : '';
      let handled = true;
      if (views[digit]) this.viewer.setView(views[digit][ctrl ? 1 : 0]);
      else if (digit === '5') this.toggle('ortho');
      else if (k === 'Home') this.frame();
      else if ((k === 'f' && !ctrl) || code === 'NumpadDecimal') this.frame(this.selected.size ? [...this.selected] : undefined);
      else if (k === 'Z' && e.shiftKey) this.toggle('wireframe');
      else if (k.toLowerCase() === 'z' && e.altKey) this.toggle('xray');
      else if (k.toLowerCase() === 'h' && e.altKey) this.showAll();
      else if (k === 'H' && e.shiftKey) this.hideSelected(true);
      else if (k === 'h') this.hideSelected();
      else if (k === '/' || code === 'NumpadDivide') this.isolate();
      else if (k === 'Escape') this.select([], 'replace');
      else handled = false;
      if (handled) e.preventDefault();
    });
  }

  private wireSplitter() {
    const sp = $('#splitter');
    const setW = (w: number) => {
      const width = Math.round(Math.min(window.innerWidth * 0.7, Math.max(160, w)));
      this.prefs.outlinerWidth = width;
      document.documentElement.style.setProperty('--outliner-w', `${width}px`);
    };
    sp.addEventListener('pointerdown', (e) => {
      sp.setPointerCapture(e.pointerId);
      sp.classList.add('dragging');
      const move = (ev: PointerEvent) => setW(ev.clientX - $('#outliner').getBoundingClientRect().left);
      const up = () => {
        sp.classList.remove('dragging');
        sp.removeEventListener('pointermove', move);
        sp.removeEventListener('pointerup', up);
        savePrefs(this.prefs);
      };
      sp.addEventListener('pointermove', move);
      sp.addEventListener('pointerup', up);
    });
    sp.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        setW(this.prefs.outlinerWidth + (e.key === 'ArrowLeft' ? -20 : 20));
        savePrefs(this.prefs);
        e.preventDefault();
      }
    });
  }

  // ----------------------------------------------------------- test hook

  debug() {
    const s = this.scene;
    return {
      loaded: !!s && !this.loading,
      loading: this.loading,
      loadCount: this.loadCount,
      lastError: this.lastError,
      fileName: this.fileName,
      timings: this.timings,
      glRenderer: this.viewer.glRenderer(),
      status: $('#status').textContent,
      banner: $('#banner').hidden ? null : $('#banner').textContent,
      objects: s ? s.objects.map((o) => ({ id: o.id, name: o.name, type: o.type, visible: this.visible[o.id] === 1, mesh: o.mesh ?? null })) : [],
      selected: [...this.selected],
      viewer: this.viewer.debugState(),
      materials: s ? s.materials : {},
    };
  }
}
