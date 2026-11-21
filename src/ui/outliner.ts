import type { ViewerScene } from '../scene/prepare';
import type { CollectionNode, SceneObject } from '../scene/types';
import { TYPE_NAMES, iconNode } from './icons';

/**
 * Outliner: Scene Collection -> child collections -> objects, with child objects
 * nested under their parent and collection instances under the instancing empty.
 * The tree model is built once; DOM rows are created only for expanded nodes.
 */

interface TNode {
  path: string;
  kind: 'collection' | 'object' | 'instance';
  label: string;
  depth: number;
  objectId?: number;
  collection?: CollectionNode;
  /** Objects whose visibility a collection checkbox controls (direct members, recursively). */
  members?: number[];
  children: TNode[];
  parent: TNode | null;
}

export interface OutlinerCallbacks {
  select(ids: number[], mode: 'replace' | 'toggle' | 'add'): void;
  frame(ids: number[]): void;
  setVisible(ids: number[], visible: boolean): void;
  filterCleared?(): void;
}

const ROW_LIMIT = 500;

function iconSpan(name: string, cls: string): HTMLSpanElement {
  const sp = document.createElement('span');
  sp.className = cls;
  sp.appendChild(iconNode(name));
  return sp;
}

function isAncestor(a: TNode, n: TNode): boolean {
  for (let p = n.parent; p; p = p.parent) if (p === a) return true;
  return false;
}
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export class Outliner {
  private root: TNode | null = null;
  private scene: ViewerScene | null = null;
  private expanded = new Map<string, boolean>();
  private limits = new Map<string, number>();
  /** Rendered rows per object id. */
  private rows = new Map<number, HTMLElement[]>();
  private colRows: { el: HTMLElement; node: TNode }[] = [];
  private firstNode = new Map<number, TNode>();
  private nodeByPath = new Map<string, TNode>();
  private filter = '';
  private visible: Uint8Array = new Uint8Array(0);
  private selected = new Set<number>();
  private active: number | null = null;

  constructor(private el: HTMLElement, private cb: OutlinerCallbacks) {
    el.addEventListener('click', (e) => this.onClick(e));
    el.addEventListener('dblclick', (e) => this.onDblClick(e));
    el.addEventListener('change', (e) => this.onChange(e));
    el.addEventListener('keydown', (e) => this.onKey(e));
    this.showEmpty('Open a .blend file to see its objects.');
  }

  showEmpty(msg: string) {
    this.el.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'tree-empty';
    d.textContent = msg;
    this.el.appendChild(d);
  }

  setScene(scene: ViewerScene, visible: Uint8Array) {
    this.scene = scene;
    this.visible = visible;
    this.selected.clear();
    this.active = null;
    this.expanded.clear();
    this.limits.clear();
    this.firstNode.clear();
    this.nodeByPath.clear();
    this.root = this.buildModel(scene);
    this.render();
  }

  // ---------------------------------------------------------------- model

  private buildModel(s: ViewerScene): TNode {
    const children = new Map<number, number[]>();
    for (const o of s.objects) {
      if (o.parentId !== null) {
        let l = children.get(o.parentId);
        if (!l) children.set(o.parentId, (l = []));
        l.push(o.id);
      }
    }
    const byName = (a: number, b: number) => collator.compare(s.objects[a].name, s.objects[b].name);
    for (const l of children.values()) l.sort(byName);
    const instancesBy = new Map<number, number[]>();
    s.instances.forEach((inst, i) => {
      let l = instancesBy.get(inst.instancer);
      if (!l) instancesBy.set(inst.instancer, (l = []));
      l.push(i);
    });
    const small = s.objects.length < 300;

    const objNode = (o: SceneObject, parent: TNode, seen: Set<number>): TNode => {
      const path = `${parent.path}/o${o.id}`;
      const n: TNode = { path, kind: 'object', label: o.name, depth: parent.depth + 1, objectId: o.id, children: [], parent };
      this.nodeByPath.set(path, n);
      if (!this.firstNode.has(o.id)) this.firstNode.set(o.id, n);
      const next = new Set(seen).add(o.id);
      for (const c of children.get(o.id) ?? []) if (!next.has(c)) n.children.push(objNode(s.objects[c], n, next));
      for (const ii of instancesBy.get(o.id) ?? []) {
        const inst = s.instances[ii];
        const via = inst.chain.slice(1).map((id) => s.objects[id].name);
        const ipath = `${path}/i${ii}`;
        const label = [...via, s.objects[inst.object].name].join(' › ');
        const inode: TNode = { path: ipath, kind: 'instance', label, depth: n.depth + 1, objectId: inst.instancer, children: [], parent: n };
        this.nodeByPath.set(ipath, inode);
        n.children.push(inode);
      }
      if (small && n.children.length) this.expanded.set(path, true);
      return n;
    };

    const colNode = (c: CollectionNode, parent: TNode | null, seen: Set<string>): TNode => {
      const path = parent ? `${parent.path}/c${c.key}` : `c${c.key}`;
      const n: TNode = { path, kind: 'collection', label: c.name, depth: parent ? parent.depth + 1 : 0, collection: c, children: [], parent, members: [] };
      this.nodeByPath.set(path, n);
      if (c.key !== '__not_in_scene__') this.expanded.set(path, true);
      const next = new Set(seen).add(c.key);
      for (const ch of c.children) if (!next.has(ch.key)) n.children.push(colNode(ch, n, next));
      const inCol = new Set(c.objects);
      const roots = c.objects.filter((id) => {
        const p = s.objects[id].parentId;
        return p === null || !inCol.has(p);
      }).sort(byName);
      for (const id of roots) n.children.push(objNode(s.objects[id], n, new Set()));
      const members = new Set<number>(c.objects);
      for (const ch of n.children) {
        // The scene's checkbox must not reveal objects that are not in the scene.
        if (ch.kind === 'collection' && ch.collection!.key !== '__not_in_scene__') for (const m of ch.members!) members.add(m);
      }
      n.members = [...members];
      return n;
    };
    return colNode(s.collections, null, new Set());
  }

  // --------------------------------------------------------------- render

  private render() {
    const keepScroll = this.el.scrollTop;
    this.el.innerHTML = '';
    this.rows.clear();
    this.colRows = [];
    if (!this.root || !this.scene) return;
    const frag = document.createDocumentFragment();
    if (this.filter) {
      const matches = this.matchSet();
      if (!matches.size) {
        this.showEmpty(`No objects match "${this.filter}".`);
        return;
      }
      this.renderNode(this.root, frag, matches);
    } else this.renderNode(this.root, frag, null);
    this.el.appendChild(frag);
    this.el.scrollTop = keepScroll;
  }

  /** Paths of nodes that match the filter, plus their ancestors. */
  private matchSet(): Set<string> {
    const q = this.filter.toLowerCase();
    const out = new Set<string>();
    let rows = 0;
    const visit = (n: TNode): boolean => {
      let hit = n.kind !== 'collection' && n.label.toLowerCase().includes(q);
      for (const c of n.children) if (visit(c)) hit = true;
      if (hit && rows < 5000) { out.add(n.path); rows++; }
      return hit;
    };
    visit(this.root!);
    return out;
  }

  private renderNode(n: TNode, into: DocumentFragment | HTMLElement, matches: Set<string> | null) {
    if (matches && !matches.has(n.path)) return;
    const row = this.makeRow(n);
    into.appendChild(row);
    if (!n.children.length) return;
    const open = matches ? true : this.expanded.get(n.path) === true;
    row.setAttribute('aria-expanded', String(open));
    if (!open) return;
    const box = document.createElement('div');
    box.className = 'children';
    box.setAttribute('role', 'group');
    const limit = matches ? Infinity : this.limits.get(n.path) ?? ROW_LIMIT;
    let shown = 0;
    for (const c of n.children) {
      if (shown >= limit) break;
      this.renderNode(c, box, matches);
      shown++;
    }
    if (n.children.length > shown) {
      const more = document.createElement('div');
      more.className = 'tree-more';
      more.style.setProperty('--depth', String(n.depth + 1));
      const b = document.createElement('button');
      b.dataset.more = n.path;
      b.textContent = `Show ${Math.min(ROW_LIMIT * 4, n.children.length - shown)} more of ${n.children.length - shown} hidden rows`;
      more.appendChild(b);
      box.appendChild(more);
    }
    into.appendChild(box);
  }

  private makeRow(n: TNode): HTMLElement {
    const s = this.scene!;
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.path = n.path;
    row.setAttribute('role', 'treeitem');
    row.tabIndex = -1;
    row.style.setProperty('--depth', String(n.depth));
    const tw = document.createElement('button');
    tw.className = 'twisty' + (n.children.length ? '' : ' leaf');
    tw.tabIndex = -1;
    tw.setAttribute('aria-label', 'Expand or collapse');
    tw.appendChild(iconNode('twisty'));
    row.appendChild(tw);

    if (n.kind === 'collection') {
      const c = n.collection!;
      const chk = document.createElement('label');
      chk.className = 'chk';
      chk.title = 'Show or hide everything in this collection';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.setAttribute('aria-label', `Show ${c.name}`);
      chk.appendChild(input);
      row.appendChild(chk);
      row.appendChild(iconSpan('collection', 'icon t-collection'));
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = c.name;
      row.appendChild(label);
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = String(n.members!.length);
      row.appendChild(count);
      if (c.hidden && c.key !== '__not_in_scene__') row.classList.add('col-disabled');
      if (c.key === '__not_in_scene__') row.title = 'Objects in the file that are not linked to the active scene';
      if (c.library) row.title = `Linked from ${c.library}`;
      this.colRows.push({ el: row, node: n });
      this.updateCollectionRow(row, n);
      return row;
    }

    const o = s.objects[n.objectId!];
    if (n.kind === 'instance') {
      row.classList.add('instance');
      row.title = `Instance from collection "${o.instanceCollection}" (read-only)`;
      const pad = document.createElement('span');
      pad.className = 'eye';
      row.appendChild(pad);
      row.appendChild(iconSpan('instance', 'icon'));
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = n.label;
      row.appendChild(label);
    } else {
      const eye = document.createElement('button');
      eye.className = 'eye';
      eye.tabIndex = -1;
      row.appendChild(eye);
      const type = o.type;
      const ic = iconSpan(type, `icon t-${type}`);
      ic.title = TYPE_NAMES[type] ?? type;
      row.appendChild(ic);
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = o.name;
      row.appendChild(label);
      if (o.warnings.length) {
        const w = document.createElement('span');
        w.className = 'warn';
        w.title = o.warnings.join('\n');
        w.appendChild(iconNode('warn'));
        row.appendChild(w);
      }
      if (!o.inScene) row.classList.add('not-in-scene');
      if (o.library) row.title = `Linked from ${o.library}`;
    }
    let list = this.rows.get(o.id);
    if (!list) this.rows.set(o.id, (list = []));
    list.push(row);
    this.updateObjectRow(row, o.id, n.kind === 'instance');
    return row;
  }

  private updateObjectRow(row: HTMLElement, id: number, instance = row.classList.contains('instance')) {
    const vis = this.visible[id] === 1;
    row.classList.toggle('hidden-obj', !vis);
    row.classList.toggle('selected', this.selected.has(id));
    row.classList.toggle('active', this.active === id);
    row.setAttribute('aria-selected', String(this.selected.has(id)));
    if (instance) return;
    const eye = row.querySelector<HTMLButtonElement>('.eye')!;
    if (eye.dataset.state !== String(vis)) {
      eye.dataset.state = String(vis);
      eye.replaceChildren(iconNode(vis ? 'eye' : 'eyeOff'));
    }
    eye.classList.toggle('off', !vis);
    const name = this.scene!.objects[id].name;
    eye.setAttribute('aria-label', vis ? `Hide ${name}` : `Show ${name}`);
    eye.title = vis ? 'Hide' : 'Show';
  }

  private updateCollectionRow(row: HTMLElement, n: TNode) {
    const input = row.querySelector('input')!;
    const m = n.members!;
    let on = 0;
    for (const id of m) on += this.visible[id];
    input.checked = m.length > 0 ? on === m.length : !n.collection!.hidden;
    input.indeterminate = on > 0 && on < m.length;
  }

  // ---------------------------------------------------------------- state

  setVisibility(visible: Uint8Array) {
    this.visible = visible;
    for (const [id, rows] of this.rows) for (const r of rows) this.updateObjectRow(r, id);
    for (const { el, node } of this.colRows) this.updateCollectionRow(el, node);
  }

  setSelection(selected: Set<number>, active: number | null) {
    const changed = new Set([...this.selected, ...selected]);
    if (this.active !== null) changed.add(this.active);
    this.selected = new Set(selected);
    this.active = active;
    for (const id of changed) for (const r of this.rows.get(id) ?? []) this.updateObjectRow(r, id);
  }

  /** Expand the tree down to the object's first row and scroll it into view. */
  reveal(id: number) {
    const n = this.firstNode.get(id);
    if (!n) return;
    let changed = false;
    for (let p = n.parent; p; p = p.parent) {
      if (!this.expanded.get(p.path)) { this.expanded.set(p.path, true); changed = true; }
      const idx = p.children.findIndex((c) => c === n || isAncestor(c, n));
      if (idx >= (this.limits.get(p.path) ?? ROW_LIMIT)) { this.limits.set(p.path, idx + 1); changed = true; }
    }
    if (this.filter && !this.matchSet().has(n.path)) {
      // The object is filtered out: clear the filter so the row can be shown.
      this.filter = '';
      this.cb.filterCleared?.();
      changed = true;
    }
    if (changed) this.render();
    const row = this.el.querySelector<HTMLElement>(`[data-path="${CSS.escape(n.path)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }

  setFilter(q: string) {
    this.filter = q.trim();
    this.render();
  }

  // --------------------------------------------------------------- events

  private nodeOf(e: Event): TNode | null {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.row');
    return row ? this.nodeByPath.get(row.dataset.path!) ?? null : null;
  }

  private onClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const more = t.closest<HTMLElement>('[data-more]');
    if (more) {
      const p = more.dataset.more!;
      this.limits.set(p, (this.limits.get(p) ?? ROW_LIMIT) + ROW_LIMIT * 4);
      this.render();
      return;
    }
    const n = this.nodeOf(e);
    if (!n) return;
    if (t.closest('.chk')) return; // handled by 'change'
    if (t.closest('.twisty')) {
      if (n.children.length) {
        this.expanded.set(n.path, !this.expanded.get(n.path));
        this.render();
      }
      return;
    }
    if (t.closest('button.eye') && n.kind === 'object') {
      const id = n.objectId!;
      // Toggling a selected object's eye applies to the whole selection.
      const ids = this.selected.has(id) && this.selected.size > 1 ? [...this.selected] : [id];
      this.cb.setVisible(ids, this.visible[id] !== 1);
      return;
    }
    const mode = e.ctrlKey || e.metaKey ? 'toggle' : e.shiftKey ? 'add' : 'replace';
    if (n.kind === 'collection') this.cb.select(n.members!, mode === 'toggle' ? 'add' : mode);
    else this.cb.select([n.objectId!], mode);
    (this.el.querySelector(`[data-path="${CSS.escape(n.path)}"]`) as HTMLElement | null)?.focus({ preventScroll: true });
  }

  private onDblClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    if (t.closest('.twisty, .eye, .chk')) return;
    const n = this.nodeOf(e);
    if (!n) return;
    this.cb.frame(n.kind === 'collection' ? n.members! : [n.objectId!]);
  }

  private onChange(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.type !== 'checkbox') return;
    const n = this.nodeOf(e);
    if (n?.kind === 'collection') this.cb.setVisible(n.members!, input.checked);
  }

  private onKey(e: KeyboardEvent) {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.row');
    if (!row) return;
    const rows = [...this.el.querySelectorAll<HTMLElement>('.row')];
    const i = rows.indexOf(row);
    const n = this.nodeByPath.get(row.dataset.path!)!;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const next = rows[i + (e.key === 'ArrowDown' ? 1 : -1)];
      if (next) {
        next.focus();
        const nn = this.nodeByPath.get(next.dataset.path!)!;
        if (nn.kind !== 'collection') this.cb.select([nn.objectId!], 'replace');
      }
      e.preventDefault();
    } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && n.children.length) {
      this.expanded.set(n.path, e.key === 'ArrowRight');
      this.render();
      (this.el.querySelector(`[data-path="${CSS.escape(n.path)}"]`) as HTMLElement | null)?.focus();
      e.preventDefault();
    } else if (e.key === 'Enter') {
      this.cb.frame(n.kind === 'collection' ? n.members! : [n.objectId!]);
    }
  }
}
