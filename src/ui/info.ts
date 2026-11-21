import { fmtVersion } from '../scene/extract';
import type { ViewerScene } from '../scene/prepare';
import { TYPE_NAMES } from './icons';

export interface InfoCallbacks {
  select(id: number): void;
  frame(ids: number[]): void;
  isolate(ids: number[]): void;
}

/** Bounding box size in world space, from the viewer. */
export type BoxFn = (ids: number[]) => { size: [number, number, number]; center: [number, number, number] } | null;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const n = (x: number) => x.toLocaleString('en-US');

export function fmtLen(x: number): string {
  if (!Number.isFinite(x)) return '–';
  const a = Math.abs(x);
  if (a === 0) return '0';
  if (a >= 1e5 || a < 1e-3) return x.toExponential(3);
  return x.toFixed(a >= 100 ? 2 : a >= 1 ? 4 : 5).replace(/\.?0+$/, '');
}

/** Linear [0..1] to an sRGB CSS colour for swatches. */
export function cssColor(c: number[]): string {
  const s = (v: number) => {
    v = Math.min(1, Math.max(0, v));
    const g = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.round(g * 255);
  };
  return `rgb(${s(c[0])}, ${s(c[1])}, ${s(c[2])})`;
}

export class InfoPanel {
  private scene: ViewerScene | null = null;
  private fileName = '';
  private ids: number[] = [];

  constructor(private el: HTMLElement, private cb: InfoCallbacks, private box: BoxFn) {
    el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const link = t.closest<HTMLElement>('[data-select]');
      if (link) { e.preventDefault(); this.cb.select(Number(link.dataset.select)); return; }
      const act = t.closest<HTMLElement>('[data-act]');
      if (act?.dataset.act === 'frame') this.cb.frame(this.ids);
      if (act?.dataset.act === 'isolate') this.cb.isolate(this.ids);
    });
    this.renderEmpty();
  }

  setScene(scene: ViewerScene | null, fileName: string) {
    this.scene = scene;
    this.fileName = fileName;
    this.show([]);
  }

  show(ids: number[]) {
    this.ids = ids;
    if (!this.scene) return this.renderEmpty();
    if (ids.length === 0) return this.renderSummary();
    if (ids.length === 1) return this.renderObject(ids[0]);
    return this.renderMulti(ids);
  }

  private renderEmpty() {
    this.el.innerHTML = '<h2>No file loaded</h2><p class="note">Open or drop a .blend file. Select an object to see its details here.</p>';
  }

  private dims(ids: number[]): string {
    const b = this.box(ids);
    if (!b) return '';
    return `<h3>Dimensions (world, Blender units)</h3><dl>
      <dt>X</dt><dd>${fmtLen(b.size[0])}</dd><dt>Y</dt><dd>${fmtLen(b.size[1])}</dd><dt>Z</dt><dd>${fmtLen(b.size[2])}</dd>
      <dt>Center</dt><dd>${b.center.map(fmtLen).join(', ')}</dd></dl>`;
  }

  private renderSummary() {
    const s = this.scene!;
    const visibleMeshes = s.objects.filter((o) => o.mesh && o.inScene).length;
    const byType = new Map<string, number>();
    for (const o of s.objects) byType.set(o.type, (byType.get(o.type) ?? 0) + 1);
    const types = [...byType.entries()].sort((a, b) => b[1] - a[1]).map(([t, c]) => `${c} ${TYPE_NAMES[t] ?? t}`).join(', ');
    this.el.innerHTML = `
      <h2>${esc(this.fileName)}</h2>
      <div class="sub">Saved with Blender ${fmtVersion(s.blenderVersion)}${s.sceneName ? ` · scene "${esc(s.sceneName)}"` : ''}</div>
      <dl>
        <dt>Objects</dt><dd>${n(s.objects.length)}</dd>
        <dt>Types</dt><dd>${esc(types)}</dd>
        <dt>Mesh objects</dt><dd>${n(visibleMeshes)}</dd>
        <dt>Meshes</dt><dd>${n(Object.keys(s.meshes).length)}</dd>
        <dt>Triangles</dt><dd>${n(s.stats.triangles)}</dd>
        <dt>Materials</dt><dd>${n(Object.keys(s.materials).length)}</dd>
        <dt>Collections</dt><dd>${n(Object.keys(s.collectionIndex).length)}</dd>
        <dt>Instances</dt><dd>${n(s.instances.length)}</dd>
        <dt>File format</dt><dd>${s.fileFormat === 'large' ? '5.x' : 'legacy'}, ${s.compression === 'none' ? 'not compressed' : s.compression}</dd>
      </dl>
      ${this.dims(s.objects.filter((o) => o.inScene).map((o) => o.id))}
      <p class="note">Click an object in the outliner or the 3D view to see its details.</p>`;
  }

  private renderMulti(ids: number[]) {
    const s = this.scene!;
    let tris = 0;
    for (const id of ids) { const m = s.objects[id].mesh; if (m) tris += s.meshes[m].ntris; }
    const list = ids.slice(0, 50).map((id) => `<li><a class="objlink" data-select="${id}" href="#">${esc(s.objects[id].name)}</a></li>`).join('');
    this.el.innerHTML = `
      <h2>${n(ids.length)} objects selected</h2>
      <dl><dt>Triangles</dt><dd>${n(tris)}</dd></dl>
      ${this.dims(ids)}
      <div class="info-actions"><button data-act="frame">Frame</button><button data-act="isolate">Isolate</button></div>
      <h3>Selection</h3><ul>${list}${ids.length > 50 ? `<li>… and ${n(ids.length - 50)} more</li>` : ''}</ul>`;
  }

  private renderObject(id: number) {
    const s = this.scene!;
    const o = s.objects[id];
    const parts: string[] = [];
    parts.push(`<h2>${esc(o.name)}</h2><div class="sub">${esc(TYPE_NAMES[o.type] ?? o.type)}${o.inScene ? '' : ' · not in the active scene'}</div>`);
    for (const w of o.warnings) parts.push(`<div class="warnline">⚠ ${esc(w)}</div>`);
    const rows: string[] = [];
    rows.push(`<dt>Parent</dt><dd>${o.parentId !== null ? `<a class="objlink" data-select="${o.parentId}" href="#">${esc(o.parent!)}</a>` : '–'}</dd>`);
    rows.push(`<dt>Collections</dt><dd>${o.collections.length ? esc(o.collections.join(', ')) : '–'}</dd>`);
    const kids = s.objects.filter((c) => c.parentId === id);
    if (kids.length) rows.push(`<dt>Children</dt><dd>${kids.slice(0, 20).map((c) => `<a class="objlink" data-select="${c.id}" href="#">${esc(c.name)}</a>`).join(', ')}${kids.length > 20 ? ` … (${kids.length})` : ''}</dd>`);
    if (o.mesh) {
      const m = s.meshes[o.mesh];
      rows.push(`<dt>Mesh</dt><dd>${esc(m.name)}${m.users > 1 ? `<span class="tag">shared by ${m.users} objects</span>` : ''}</dd>`);
      rows.push(`<dt>Vertices</dt><dd>${n(m.nverts)}</dd><dt>Faces</dt><dd>${n(m.nfaces)}</dd><dt>Triangles</dt><dd>${n(m.ntris)}</dd>`);
    } else if (o.dataName) rows.push(`<dt>Data</dt><dd>${esc(o.dataName)}</dd>`);
    if (o.instanceCollection) {
      const count = s.instances.filter((i) => i.instancer === id).length;
      rows.push(`<dt>Instances</dt><dd>collection "${esc(s.collectionIndex[o.instanceCollection]?.name ?? o.instanceCollection)}" (${count} objects)</dd>`);
    }
    if (o.library) rows.push(`<dt>Linked from</dt><dd>${esc(o.library)}</dd>`);
    parts.push(`<dl>${rows.join('')}</dl>`);
    parts.push(this.dims([id]));

    if (o.type !== 'EMPTY' && (o.mesh || o.materialSlots.length)) {
      const slots = o.materialSlots.length ? o.materialSlots : [null];
      const items = slots.map((k, i) => {
        const m = k ? s.materials[k] : null;
        const c = m ? m.color : [0.8, 0.8, 0.8, 1];
        const name = m ? esc(m.name) : o.materialSlots.length ? '<i>empty slot</i>' : '<i>no material (default grey)</i>';
        const src = m ? (m.source.startsWith('node:') ? 'node colour' : m.source.replace(/^viewport/, 'viewport colour')) : '';
        const link = o.materialSlots.length ? (o.slotLinks[i] === 'OBJECT' ? ' · object link' : '') : '';
        return `<div class="slot"><span class="swatch" style="background:${cssColor(c)}"></span><span>${name}<br><small>${esc(src)}${link}</small></span></div>`;
      });
      parts.push(`<h3>Material slots</h3>${items.join('')}`);
    }
    if (o.modifiers.length) {
      const items = o.modifiers.map((m) => `<li>${esc(m.name)} <span class="tag">${esc(m.kind)}</span><br><small class="note">not applied${m.enabled ? '' : ', disabled in the viewport'}</small></li>`);
      parts.push(`<h3>Modifiers</h3><ul>${items.join('')}</ul>`);
    }
    if (o.notes.length) parts.push(`<h3>Notes</h3>${o.notes.map((t) => `<p class="note">${esc(t)}</p>`).join('')}`);
    parts.push('<div class="info-actions"><button data-act="frame">Frame</button><button data-act="isolate">Isolate</button></div>');
    this.el.innerHTML = parts.join('');
  }
}
