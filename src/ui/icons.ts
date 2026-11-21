/** Small inline SVG icons (16x16, stroke = currentColor). */
const svg = (body: string) =>
  `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS: Record<string, string> = {
  MESH: svg('<path d="M8 2 14 13H2Z"/><path d="M8 2 8 13M5 7.5h6"/>'),
  EMPTY: svg('<path d="M8 2v12M2 8h12M3.8 3.8l8.4 8.4"/>'),
  CURVE: svg('<path d="M2 12C5 12 4 4 8 4s3 8 6 8"/>'),
  SURFACE: svg('<path d="M2 11c3-4 9-4 12 0M2 6c3-4 9-4 12 0"/>'),
  FONT: svg('<path d="M3 3h10M8 3v10M6 13h4"/>'),
  META: svg('<circle cx="6" cy="8" r="3.5"/><circle cx="11" cy="8" r="2.5"/>'),
  LIGHT: svg('<circle cx="8" cy="7" r="3.5"/><path d="M6.5 12h3M7 14h2"/>'),
  CAMERA: svg('<rect x="2" y="5" width="9" height="7" rx="1"/><path d="M11 7.5 14 6v5l-3-1.5"/>'),
  ARMATURE: svg('<path d="M4 12 12 4M3 13l2-1-1-1Z"/><circle cx="12" cy="4" r="1.5"/>'),
  LATTICE: svg('<rect x="3" y="3" width="10" height="10"/><path d="M3 8h10M8 3v10"/>'),
  OTHER: svg('<circle cx="8" cy="8" r="2.5"/>'),
  collection: svg('<path d="M2 5h12v8H2zM3.5 5V3h9v2"/>'),
  instance: svg('<path d="M6 10 10 6M5 7 3.5 8.5a2.5 2.5 0 0 0 3.5 3.5L8.5 11M11 9l1.5-1.5a2.5 2.5 0 0 0-3.5-3.5L7.5 5"/>'),
  eye: svg('<path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/>'),
  eyeOff: svg('<path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" opacity=".45"/><path d="M3 13 13 3"/>'),
  twisty: svg('<path d="M6 4l4 4-4 4"/>'),
  warn: svg('<path d="M8 2 15 14H1Z"/><path d="M8 6.5v3.5M8 12v.01"/>'),
};

export const iconFor = (type: string) => ICONS[type] ?? ICONS.OTHER;

export const TYPE_NAMES: Record<string, string> = {
  EMPTY: 'Empty', MESH: 'Mesh', CURVE: 'Curve', SURFACE: 'Surface', FONT: 'Text', META: 'Metaball', LIGHT: 'Light',
  CAMERA: 'Camera', SPEAKER: 'Speaker', LIGHT_PROBE: 'Light probe', LATTICE: 'Lattice', ARMATURE: 'Armature',
  GPENCIL: 'Grease Pencil (legacy)', CURVES: 'Hair curves', POINTCLOUD: 'Point cloud', VOLUME: 'Volume',
  GREASEPENCIL: 'Grease Pencil', OTHER: 'Other',
};

const cache = new Map<string, Element>();
/** A fresh copy of an icon as a DOM node (cloning is much faster than parsing markup per row). */
export function iconNode(name: string): Node {
  let el = cache.get(name);
  if (!el) {
    const t = document.createElement('template');
    t.innerHTML = ICONS[name] ?? ICONS.OTHER;
    el = t.content.firstElementChild!;
    cache.set(name, el);
  }
  return el.cloneNode(true);
}
