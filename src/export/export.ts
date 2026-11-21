import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import type { ViewerScene } from '../scene/prepare';
import type { SceneObject } from '../scene/types';

/**
 * Blender is Z-up, glTF is Y-up. Blender's glTF exporter maps (x, y, z) -> (x, z, -y),
 * which is a -90 degree rotation about X. Do the same.
 */
const C = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);
const C_INV = C.clone().invert();

export interface ExportSource {
  scene: ViewerScene;
  /** Geometry per mesh key, in Blender coordinates (shared with the viewer). */
  geometry(meshKey: string): THREE.BufferGeometry | null;
}

const toY = (m: number[]) => C.clone().multiply(new THREE.Matrix4().fromArray(m)).multiply(C_INV);

function isIdentity(m: THREE.Matrix4, eps = 1e-6): boolean {
  const e = m.elements, id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  return e.every((v, i) => Math.abs(v - id[i]) < eps);
}

/**
 * Export objects to binary glTF with names and the parent/child hierarchy.
 * glTF node matrices must be pure translation/rotation/scale. A child of a
 * non-uniformly scaled parent can need shear, so each local matrix is
 * decomposed and the small remainder is baked into that object's vertices.
 * Every object keeps its exact world transform.
 */
export async function exportGLB(src: ExportSource, ids: number[], sceneName: string): Promise<ArrayBuffer> {
  const s = src.scene;
  const include = new Set(ids);
  const yGeo = new Map<string, THREE.BufferGeometry>();
  const mats = new Map<string, THREE.MeshStandardMaterial>();
  const material = (key: string | null): THREE.MeshStandardMaterial => {
    const k = key ?? '';
    let m = mats.get(k);
    if (!m) {
      const info = key ? s.materials[key] : null;
      const c = info?.color ?? [0.8, 0.8, 0.8, 1];
      m = new THREE.MeshStandardMaterial({ name: info?.name ?? 'Default', roughness: 0.6, metalness: 0, side: THREE.DoubleSide });
      m.color.setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace);
      if (c[3] < 0.999) { m.transparent = true; m.opacity = c[3]; }
      mats.set(k, m);
    }
    return m;
  };
  const geometryY = (key: string): THREE.BufferGeometry | null => {
    let g = yGeo.get(key);
    if (g) return g;
    const base = src.geometry(key);
    if (!base) return null;
    g = base.clone().applyMatrix4(C);
    g.name = s.meshes[key].name;
    yGeo.set(key, g);
    return g;
  };
  const materialsFor = (o: SceneObject, g: THREE.BufferGeometry) => {
    const maxIndex = g.groups.reduce((m, gr) => Math.max(m, gr.materialIndex ?? 0), 0);
    const out: THREE.Material[] = [];
    for (let i = 0; i <= maxIndex; i++) out.push(material(o.materialSlots.length ? o.materialSlots[Math.min(i, o.materialSlots.length - 1)] : null));
    return out;
  };

  /** Node whose exported world is parentWorld * TRS; returns the node and its exported world. */
  const makeNode = (o: SceneObject, worldY: THREE.Matrix4, parentWorld: THREE.Matrix4, name: string) => {
    const local = parentWorld.clone().invert().multiply(worldY);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    local.decompose(p, q, sc);
    const trs = new THREE.Matrix4().compose(p, q, sc);
    const exportedWorld = parentWorld.clone().multiply(trs);
    const residual = exportedWorld.clone().invert().multiply(worldY);
    let node: THREE.Object3D;
    const g = o.mesh ? geometryY(o.mesh) : null;
    if (g && g.index && g.index.count) {
      const geo = isIdentity(residual) ? g : g.clone().applyMatrix4(residual);
      node = new THREE.Mesh(geo, materialsFor(o, g));
    } else node = new THREE.Object3D();
    node.name = name;
    node.position.copy(p);
    node.quaternion.copy(q);
    node.scale.copy(sc);
    node.userData = { blenderType: o.type };
    return { node, exportedWorld };
  };

  const root = new THREE.Scene();
  root.name = sceneName;
  const built = new Map<number, { node: THREE.Object3D; exportedWorld: THREE.Matrix4 }>();
  const build = (id: number, guard = 0): { node: THREE.Object3D; exportedWorld: THREE.Matrix4 } => {
    const hit = built.get(id);
    if (hit) return hit;
    const o = s.objects[id];
    const parentId = o.parentId !== null && include.has(o.parentId) && guard < 256 ? o.parentId : null;
    const parent = parentId !== null ? build(parentId, guard + 1) : null;
    const r = makeNode(o, toY(o.worldMatrix), parent ? parent.exportedWorld : new THREE.Matrix4(), o.name);
    (parent ? parent.node : root).add(r.node);
    built.set(id, r);
    return r;
  };
  for (const id of ids) build(id);

  // Collection instances become read-only children of their instancing empty.
  for (const inst of s.instances) {
    const owner = built.get(inst.instancer);
    if (!owner) continue;
    const srcObj = s.objects[inst.object];
    const r = makeNode(srcObj, toY(inst.matrix), owner.exportedWorld, srcObj.name);
    r.node.userData.instanceOf = srcObj.name;
    owner.node.add(r.node);
  }

  const exporter = new GLTFExporter();
  const out = await exporter.parseAsync(root, { binary: true, onlyVisible: false, trs: true });
  for (const g of yGeo.values()) g.dispose();
  return out as ArrayBuffer;
}

/** Binary STL of the given objects (and their instances) in world space, Blender coordinates (Z up). */
export function exportSTL(src: ExportSource, ids: number[]): ArrayBuffer {
  const s = src.scene;
  const group = new THREE.Group();
  const add = (meshKey: string | undefined, matrix: number[]) => {
    const g = meshKey ? src.geometry(meshKey) : null;
    if (!g) return;
    const m = new THREE.Mesh(g);
    m.matrixAutoUpdate = false;
    m.matrix.fromArray(matrix);
    group.add(m);
  };
  const want = new Set(ids);
  for (const id of ids) add(s.objects[id].mesh, s.objects[id].worldMatrix);
  for (const inst of s.instances) if (want.has(inst.instancer)) add(s.objects[inst.object].mesh, inst.matrix);
  group.updateMatrixWorld(true);
  const dv = new STLExporter().parse(group, { binary: true }) as DataView;
  return dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength) as ArrayBuffer;
}

export function download(data: ArrayBuffer, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
