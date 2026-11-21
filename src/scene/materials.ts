import type { BlendFile, Block } from '../blend/file';
import type { MaterialInfo } from './types';

export const DEFAULT_GREY: [number, number, number, number] = [0.8, 0.8, 0.8, 1];

const SHADER_NODES = new Set(['ShaderNodeBsdfPrincipled', 'ShaderNodeBsdfDiffuse', 'ShaderNodeEmission']);
const COLOR_SOCKETS = new Set(['Base Color', 'Color']);

type RGBA = [number, number, number, number];

/**
 * Material colour (§4.12): the unlinked Base Color / Color default of the first
 * Principled, Diffuse or Emission node; otherwise the viewport display colour.
 * Values are linear.
 */
export function materialColor(bf: BlendFile, mb: Block): { color: RGBA; source: string; viewport: RGBA } {
  const o = mb.offset, g = mb.group;
  const viewport: RGBA = [
    bf.num('Material', o, 'r', 0.8), bf.num('Material', o, 'g', 0.8),
    bf.num('Material', o, 'b', 0.8), bf.num('Material', o, 'a', 1),
  ];
  const useNodes = bf.has('Material', 'use_nodes') ? bf.num('Material', o, 'use_nodes') : 1;
  const nt = bf.resolve(bf.ptr('Material', o, 'nodetree'), g);
  if (!nt || !useNodes || bf.structName(nt) !== 'bNodeTree') return { color: viewport, source: 'viewport', viewport };
  // The node tree is embedded: pointers inside it resolve in the owner's group (§4.4).
  const ng = nt.group;
  const linkedTo = new Set<bigint>();
  for (const lk of bf.listOf('bNodeTree', nt.offset, 'links', ng)) linkedTo.add(bf.ptr('bNodeLink', lk.offset, 'tosock'));
  for (const nb of bf.listOf('bNodeTree', nt.offset, 'nodes', ng)) {
    const idname = bf.str('bNode', nb.offset, 'idname');
    if (!SHADER_NODES.has(idname)) continue;
    for (const sb of bf.listOf('bNode', nb.offset, 'inputs', ng)) {
      if (!COLOR_SOCKETS.has(bf.str('bNodeSocket', sb.offset, 'identifier'))) continue;
      if (linkedTo.has(sb.oldPtr)) return { color: viewport, source: 'viewport (base color is linked to a texture or node)', viewport };
      const vb = bf.resolve(bf.ptr('bNodeSocket', sb.offset, 'default_value'), ng);
      if (!vb || vb.len < 16) break;
      const c: RGBA = [0, 1, 2, 3].map((i) => bf.dv.getFloat32(vb.offset + i * 4, bf.le)) as RGBA;
      return { color: c, source: 'node:' + idname, viewport };
    }
  }
  return { color: viewport, source: 'viewport', viewport };
}

export function readMaterial(bf: BlendFile, mb: Block): MaterialInfo {
  const name = bf.idName(mb);
  const library = bf.idLibrary(mb);
  if (bf.structName(mb) !== 'Material') {
    return { name, color: DEFAULT_GREY, source: 'linked (not stored in this file)', viewport: DEFAULT_GREY, ...(library ? { library } : {}) };
  }
  return { name, ...materialColor(bf, mb), ...(library ? { library } : {}) };
}

/**
 * Slot i uses Object.mat[i] if Object.matbits[i] != 0, else Mesh.mat[i] (§4.12).
 * Returns material block addresses (0n = empty slot) and the link type per slot.
 */
export function resolveSlots(bf: BlendFile, ob: Block, data: Block | null): { ptrs: bigint[]; links: ('OBJECT' | 'DATA')[] } {
  const o = ob.offset, g = ob.group;
  const totcol = Math.max(0, bf.num('Object', o, 'totcol'));
  const obMats = bf.ptrArray(bf.ptr('Object', o, 'mat'), g, totcol);
  const bitsBlock = bf.resolve(bf.ptr('Object', o, 'matbits'), g);
  const bits = bitsBlock ? bf.data.subarray(bitsBlock.offset, bitsBlock.offset + Math.min(totcol, bitsBlock.len)) : new Uint8Array(0);
  let dataMats: bigint[] = [];
  if (data) {
    const st = bf.structName(data);
    if (bf.has(st, 'mat') && bf.has(st, 'totcol')) {
      dataMats = bf.ptrArray(bf.ptr(st, data.offset, 'mat'), data.group, bf.num(st, data.offset, 'totcol'));
    }
  }
  const n = Math.max(totcol, dataMats.length);
  const ptrs: bigint[] = [], links: ('OBJECT' | 'DATA')[] = [];
  for (let i = 0; i < n; i++) {
    const useOb = i < bits.length && bits[i] !== 0;
    ptrs.push(useOb ? obMats[i] ?? 0n : dataMats[i] ?? 0n);
    links.push(useOb ? 'OBJECT' : 'DATA');
  }
  return { ptrs, links };
}
