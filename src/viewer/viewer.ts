import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import type { ViewerMesh, ViewerScene } from '../scene/prepare';
import type { SceneObject } from '../scene/types';

export type ViewName = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso';

/** Direction from the target to the camera, in Blender coordinates (Z up). */
const VIEW_DIRS: Record<ViewName, [number, number, number]> = {
  front: [0, -1, 0], back: [0, 1, 0], right: [1, 0, 0], left: [-1, 0, 0],
  // A tiny Y offset keeps the up vector well defined: top shows +Y up, bottom shows -Y up (as in Blender).
  top: [0, -1e-4, 1], bottom: [0, -1e-4, -1], iso: [1, -1, 1],
};

const ACCENT = 0xffa033;
/** New geometry per load slice (bytes). Keeps each frame's GPU upload small. */
const SLICE_BYTES = 8 * 1024 * 1024;

/** Resolve on the next animation frame, or after 50 ms when frames are paused (hidden tab). */
export const nextFrame = () => new Promise<void>((resolve) => {
  let done = false;
  const finish = () => { if (!done) { done = true; resolve(); } };
  requestAnimationFrame(() => setTimeout(finish, 0));
  setTimeout(finish, 50);
});
const XRAY_OPACITY = 0.35;

export interface ViewerCallbacks {
  onPick?: (id: number | null, ev: PointerEvent) => void;
  onDoubleClick?: (id: number | null) => void;
}

interface NodeData { objectId: number; instanceOf?: number; lineBase?: THREE.Material }

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  private root = new THREE.Group();
  private helpers = new THREE.Group();
  private perspCam: THREE.PerspectiveCamera;
  private orthoCam: THREE.OrthographicCamera;
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  readonly controls: OrbitControls;
  private composer!: EffectComposer;
  private outlinePass!: OutlinePass;
  private renderPass!: RenderPass;
  private dirLight = new THREE.DirectionalLight(0xffffff, 1.6);
  private hemi = new THREE.HemisphereLight(0xffffff, 0x4a4a4a, 1.4);

  /** Primary three.js node per object id. */
  private nodes = new Map<number, THREE.Object3D>();
  /** Instance nodes per instancing empty id (§4.10). */
  private instanceNodes = new Map<number, THREE.Object3D[]>();
  private geometries = new Map<string, THREE.BufferGeometry>();
  private materials = new Map<string, THREE.MeshStandardMaterial>();
  private defaultMaterial = this.makeMaterial([0.8, 0.8, 0.8, 1], 'Default');
  private emptyMaterial = new THREE.LineBasicMaterial({ vertexColors: true });
  private emptySelectedMaterial = new THREE.LineBasicMaterial({ color: ACCENT });
  private markerMaterial = new THREE.LineBasicMaterial({ color: 0x9aa0a8 });

  private sceneData: ViewerScene | null = null;
  private visible: Uint8Array = new Uint8Array(0);
  private selected = new Set<number>();
  private sceneBox = new THREE.Box3(new THREE.Vector3(-5, -5, -5), new THREE.Vector3(5, 5, 5));
  private radius = 5;
  private orthoBase = 10;
  private renderQueued = false;
  private disposed = false;
  private loadToken = 0;

  wireframe = false;
  xray = false;
  showGrid = true;
  showAxes = true;

  constructor(private container: HTMLElement, private cb: ViewerCallbacks = {}) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.className = 'viewport-canvas';
    this.renderer.domElement.tabIndex = 0;

    this.scene.background = new THREE.Color(0x3a3a3a);
    this.perspCam = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
    this.orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
    for (const c of [this.perspCam, this.orthoCam]) {
      c.up.set(0, 0, 1); // Blender is Z-up: keep its coordinates and turn the camera instead.
      this.scene.add(c);
    }
    this.camera = this.perspCam;
    this.perspCam.position.set(10, -10, 7);

    this.hemi.position.set(0, 0, 1);
    this.scene.add(this.hemi);
    this.dirLight.position.set(1, 1.5, 1); // relative to the camera: upper right, from behind
    this.dirLight.target.position.set(0, 0, -1);
    this.perspCam.add(this.dirLight, this.dirLight.target);

    this.scene.add(this.root, this.helpers);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = true;
    this.controls.enableDamping = false;
    this.controls.addEventListener('change', () => this.requestRender());

    this.buildComposer();
    this.installPointer();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.updateHelpers();
  }

  // ------------------------------------------------------------ rendering

  private buildComposer() {
    const size = this.renderer.getSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(Math.max(1, size.x), Math.max(1, size.y), { samples: 4, type: THREE.HalfFloatType });
    this.composer?.dispose();
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(Math.max(1, size.x), Math.max(1, size.y));
    this.renderPass = new RenderPass(this.scene, this.camera);
    // OutlinePass bakes the camera type into its shaders, so it is rebuilt on projection changes.
    this.outlinePass = new OutlinePass(new THREE.Vector2(Math.max(1, size.x), Math.max(1, size.y)), this.scene, this.camera);
    this.outlinePass.visibleEdgeColor.set(ACCENT);
    this.outlinePass.hiddenEdgeColor.set(0x7a4a14);
    this.outlinePass.edgeStrength = 6;
    this.outlinePass.edgeThickness = 1;
    this.outlinePass.edgeGlow = 0;
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.outlinePass);
    this.composer.addPass(new OutputPass());
    this.applySelectionToOutline();
  }

  requestRender() {
    if (this.renderQueued || this.disposed) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.renderNow();
    });
  }

  renderNow() {
    if (this.disposed) return;
    this.updateClipping();
    this.outlinePass.enabled = this.outlinePass.selectedObjects.length > 0;
    this.composer.render();
  }

  private resize() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.perspCam.aspect = w / h;
    this.perspCam.updateProjectionMatrix();
    this.updateOrthoFrustum();
    this.requestRender();
  }

  private get aspect() {
    return Math.max(1, this.container.clientWidth) / Math.max(1, this.container.clientHeight);
  }

  private updateOrthoFrustum() {
    const h = this.orthoBase / 2, w = h * this.aspect;
    const depth = this.radius * 20 + this.camera.position.distanceTo(this.controls?.target ?? new THREE.Vector3());
    Object.assign(this.orthoCam, { left: -w, right: w, top: h, bottom: -h, near: -depth, far: depth });
    this.orthoCam.updateProjectionMatrix();
  }

  /** Near and far planes follow the model size and camera distance (models can be mm or km). */
  private updateClipping() {
    const d = this.camera.position.distanceTo(this.controls.target);
    if (this.camera === this.perspCam) {
      const sceneDist = this.sceneBox.distanceToPoint(this.camera.position);
      const near = Math.max(Math.min(d, Math.max(sceneDist, d * 0.5)) * 1e-3, this.radius * 1e-6);
      const far = d + this.radius * 8;
      if (Math.abs(near - this.perspCam.near) / near > 0.01 || Math.abs(far - this.perspCam.far) / far > 0.01) {
        this.perspCam.near = near;
        this.perspCam.far = far;
        this.perspCam.updateProjectionMatrix();
      }
    } else {
      const depth = this.radius * 20 + d;
      if (Math.abs(this.orthoCam.far - depth) / depth > 0.01) this.updateOrthoFrustum();
    }
  }

  // --------------------------------------------------------------- loading

  /**
   * Build the three.js scene. Work is split into time slices so a big file
   * does not block the page; geometry appears progressively.
   */
  async load(data: ViewerScene, visible: Uint8Array, onProgress?: (f: number) => void): Promise<void> {
    const token = ++this.loadToken;
    this.clear();
    this.sceneData = data;
    this.visible = visible.slice();

    for (const [key, m] of Object.entries(data.materials)) this.materials.set(key, this.makeMaterial(m.color, m.name));

    const box = new THREE.Box3();
    const tmp = new THREE.Box3();
    const mat = new THREE.Matrix4();
    const expand = (key: string | undefined, world: number[]) => {
      if (!key) return;
      const r = data.meshes[key]?.render;
      if (!r || !r.index.length) return;
      tmp.min.fromArray(r.bboxMin);
      tmp.max.fromArray(r.bboxMax);
      box.union(tmp.applyMatrix4(mat.fromArray(world)));
    };
    for (const o of data.objects) if (o.inScene && o.visible) expand(o.mesh, o.worldMatrix);
    for (const inst of data.instances) if (data.objects[inst.instancer].visible) expand(data.objects[inst.object].mesh, inst.matrix);
    if (box.isEmpty()) for (const o of data.objects) if (o.inScene) expand(o.mesh, o.worldMatrix);
    if (box.isEmpty()) {
      for (const o of data.objects) if (o.inScene) box.expandByPoint(new THREE.Vector3(o.worldMatrix[12], o.worldMatrix[13], o.worldMatrix[14]));
      box.expandByScalar(1);
    }
    this.sceneBox.copy(box);
    this.radius = Math.max(1e-6, box.getBoundingSphere(new THREE.Sphere()).radius);
    this.controls.minDistance = this.radius * 1e-5;
    this.controls.maxDistance = this.radius * 200;
    this.updateHelpers();
    this.frameBox(box, VIEW_DIRS.iso);

    // Compile the shaders in parallel before the first frame, so it does not block the page.
    await this.precompile();
    if (token !== this.loadToken) return;

    // Add objects in slices. Each slice is limited in time and in new geometry bytes,
    // and is drawn before the next one, so GPU uploads are spread over several frames.
    const jobs: (() => void)[] = [];
    for (const o of data.objects) jobs.push(() => this.buildObject(o));
    data.instances.forEach((_, idx) => jobs.push(() => this.buildInstance(idx)));
    let i = 0;
    while (i < jobs.length) {
      const start = performance.now();
      this.sliceBytes = 0;
      while (i < jobs.length && performance.now() - start < 10 && this.sliceBytes < SLICE_BYTES) jobs[i++]();
      onProgress?.(i / jobs.length);
      this.requestRender();
      if (i < jobs.length) await nextFrame();
      if (token !== this.loadToken) return;
    }
    this.applyVisibility();
    this.requestRender();
  }

  private sliceBytes = 0;

  private async precompile() {
    const tmp = new THREE.Group();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute([1, 1, 1, 1, 1, 1, 1, 1, 1], 3));
    // One material is enough per shader program; different colours share a program.
    tmp.add(new THREE.Mesh(g, this.defaultMaterial));
    const transparent = [...this.materials.values()].find((m) => m.transparent);
    if (transparent) tmp.add(new THREE.Mesh(g, transparent));
    tmp.add(new THREE.LineSegments(g, this.emptyMaterial), new THREE.LineSegments(g, this.markerMaterial));
    try {
      await this.renderer.compileAsync(tmp, this.camera, this.scene);
    } catch {
      /* compiling on first draw instead is fine */
    }
    g.dispose();
  }

  private makeMaterial(c: number[], name: string): THREE.MeshStandardMaterial {
    // Blender colours are linear: tell three.js so, and keep the sRGB output (§4.12).
    const m = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0, side: THREE.DoubleSide, name });
    m.color.setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace);
    const alpha = c[3] ?? 1;
    m.userData.baseOpacity = alpha < 0.999 ? Math.max(0.05, alpha) : 1;
    this.applyMaterialMode(m);
    return m;
  }

  private applyMaterialMode(m: THREE.MeshStandardMaterial) {
    const base = m.userData.baseOpacity as number;
    m.wireframe = this.wireframe;
    m.transparent = this.xray || base < 1;
    m.opacity = this.xray ? XRAY_OPACITY * base : base;
    m.depthWrite = !this.xray;
    m.needsUpdate = true;
  }

  private geometry(key: string, mesh: ViewerMesh): THREE.BufferGeometry {
    let g = this.geometries.get(key);
    if (g) return g;
    const r = mesh.render;
    g = new THREE.BufferGeometry();
    g.name = mesh.name;
    g.setAttribute('position', new THREE.BufferAttribute(r.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(r.normals, 3));
    g.setIndex(new THREE.BufferAttribute(r.index, 1));
    for (const gr of r.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
    g.boundingBox = new THREE.Box3(new THREE.Vector3().fromArray(r.bboxMin), new THREE.Vector3().fromArray(r.bboxMax));
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
    this.geometries.set(key, g);
    this.sliceBytes += r.positions.byteLength + r.normals.byteLength + r.index.byteLength;
    return g;
  }

  /** Material array indexed by the mesh's material index; indices past the last slot use the last slot. */
  materialsFor(o: SceneObject, mesh: ViewerMesh): THREE.Material[] {
    const maxIndex = mesh.render.groups.reduce((m, g) => Math.max(m, g.materialIndex), 0);
    const slots = o.materialSlots;
    const out: THREE.Material[] = [];
    for (let i = 0; i <= maxIndex; i++) {
      const key = slots.length ? slots[Math.min(i, slots.length - 1)] : null;
      out.push((key && this.materials.get(key)) || this.defaultMaterial);
    }
    return out;
  }

  private meshNode(o: SceneObject, matrix: number[], data: NodeData): THREE.Object3D | null {
    const sd = this.sceneData!;
    if (o.mesh && sd.meshes[o.mesh]?.render.index.length) {
      const vm = sd.meshes[o.mesh];
      const mesh = new THREE.Mesh(this.geometry(o.mesh, vm), this.materialsFor(o, vm));
      mesh.name = o.name;
      return this.place(mesh, matrix, data);
    }
    if (o.type === 'EMPTY') {
      const s = o.emptySize ?? 1;
      const line = new THREE.LineSegments(emptyAxes(s), this.emptyMaterial);
      line.name = o.name;
      return this.place(line, matrix, data);
    }
    if (o.type === 'LIGHT' || o.type === 'CAMERA') {
      // Small marker at the object origin, sized to the scene, without the object's scale.
      const m = new THREE.Matrix4().fromArray(matrix);
      const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
      m.decompose(p, q, sc);
      const size = this.radius * 0.04;
      const geo = o.type === 'LIGHT' ? new THREE.WireframeGeometry(new THREE.OctahedronGeometry(size)) : cameraMarker(size);
      const line = new THREE.LineSegments(geo, this.markerMaterial);
      line.name = o.name;
      return this.place(line, new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1)).toArray(), data);
    }
    return null;
  }

  private place(node: THREE.Object3D, matrix: number[], data: NodeData): THREE.Object3D {
    node.matrixAutoUpdate = false;
    node.matrix.fromArray(matrix);
    node.matrixWorldNeedsUpdate = true;
    if (node instanceof THREE.LineSegments) data.lineBase = node.material as THREE.Material;
    node.userData = data;
    this.root.add(node);
    return node;
  }

  private buildObject(o: SceneObject) {
    const node = this.meshNode(o, o.worldMatrix, { objectId: o.id });
    if (!node) return;
    node.visible = this.visible[o.id] === 1;
    this.nodes.set(o.id, node);
  }

  private buildInstance(idx: number) {
    const sd = this.sceneData!;
    const inst = sd.instances[idx];
    const src = sd.objects[inst.object];
    const node = this.meshNode(src, inst.matrix, { objectId: inst.instancer, instanceOf: inst.object });
    if (!node) return;
    node.name = `${src.name} (instance)`;
    node.visible = this.visible[inst.instancer] === 1;
    let list = this.instanceNodes.get(inst.instancer);
    if (!list) this.instanceNodes.set(inst.instancer, (list = []));
    list.push(node);
  }

  clear() {
    this.root.clear();
    for (const g of this.geometries.values()) g.dispose();
    for (const m of this.materials.values()) m.dispose();
    this.geometries.clear();
    this.materials.clear();
    this.nodes.clear();
    this.instanceNodes.clear();
    this.selected.clear();
    this.applySelectionToOutline();
    this.sceneData = null;
    this.requestRender();
  }

  // ---------------------------------------------------------- visibility

  setVisibility(visible: Uint8Array) {
    this.visible = visible.slice();
    this.applyVisibility();
  }

  private applyVisibility() {
    for (const [id, node] of this.nodes) node.visible = this.visible[id] === 1;
    for (const [id, list] of this.instanceNodes) for (const n of list) n.visible = this.visible[id] === 1;
    this.applySelectionToOutline();
    this.requestRender();
  }

  // ----------------------------------------------------------- selection

  setSelection(ids: Iterable<number>) {
    this.selected = new Set(ids);
    this.applySelectionToOutline();
    this.requestRender();
  }

  private nodesOf(id: number): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    const n = this.nodes.get(id);
    if (n) out.push(n);
    for (const i of this.instanceNodes.get(id) ?? []) out.push(i);
    return out;
  }

  private applySelectionToOutline() {
    if (!this.outlinePass) return;
    // Meshes get an outline; helper lines (empties, light/camera markers) switch to the accent colour.
    const meshes: THREE.Object3D[] = [];
    const lines = (id: number, on: boolean) => {
      for (const n of this.nodesOf(id)) {
        if (n instanceof THREE.LineSegments) n.material = on ? this.emptySelectedMaterial : (n.userData as NodeData).lineBase!;
      }
    };
    for (const id of this.nodes.keys()) lines(id, this.selected.has(id));
    for (const id of this.selected) {
      for (const n of this.nodesOf(id)) if (n instanceof THREE.Mesh && n.visible) meshes.push(n);
    }
    this.outlinePass.selectedObjects = meshes;
  }

  // ------------------------------------------------------------- picking

  private raycaster = new THREE.Raycaster();

  /** Object id under a client (CSS pixel) position, or null. Instances pick their instancing empty. */
  pickAt(clientX: number, clientY: number): number | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    this.raycaster.params.Line = { threshold: this.radius * 0.01 };
    const candidates: THREE.Object3D[] = [];
    this.root.traverseVisible((n) => { if (n !== this.root && (n instanceof THREE.Mesh || n instanceof THREE.LineSegments)) candidates.push(n); });
    const hits = this.raycaster.intersectObjects(candidates, false);
    // Prefer surfaces over the thin helper lines when both are hit.
    const hit = hits.find((h) => h.object instanceof THREE.Mesh) ?? hits[0];
    return hit ? (hit.object.userData as NodeData).objectId : null;
  }

  private installPointer() {
    const el = this.renderer.domElement;
    let down: { x: number; y: number; button: number } | null = null;
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, button: e.button }; });
    el.addEventListener('pointerup', (e) => {
      if (!down || down.button !== 0) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved < 5) this.cb.onPick?.(this.pickAt(e.clientX, e.clientY), e);
    });
    el.addEventListener('dblclick', (e) => this.cb.onDoubleClick?.(this.pickAt(e.clientX, e.clientY)));
  }

  // -------------------------------------------------------------- camera

  /** World-space bounding box of an object (exact, from its vertices) including its instances. */
  worldBox(id: number, precise = true): THREE.Box3 {
    const box = new THREE.Box3();
    for (const n of this.nodesOf(id)) {
      n.updateMatrixWorld(true);
      box.expandByObject(n, precise && n instanceof THREE.Mesh);
    }
    if (box.isEmpty() && this.sceneData) {
      const m = this.sceneData.objects[id].worldMatrix;
      box.setFromCenterAndSize(new THREE.Vector3(m[12], m[13], m[14]), new THREE.Vector3().setScalar(this.radius * 0.1));
    }
    return box;
  }

  /** Frame the given objects (all visible objects if omitted). */
  frame(ids?: number[]) {
    const box = new THREE.Box3();
    const list = ids ?? [...this.nodes.keys(), ...this.instanceNodes.keys()].filter((id) => this.visible[id]);
    for (const id of list) box.union(this.worldBox(id, false));
    if (box.isEmpty()) box.copy(this.sceneBox);
    this.frameBox(box);
  }

  private frameBox(box: THREE.Box3, dir?: [number, number, number]) {
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(sphere.radius, this.radius * 1e-4, 1e-6);
    const d = dir ? new THREE.Vector3(...dir).normalize() : this.camera.position.clone().sub(this.controls.target).normalize();
    if (!Number.isFinite(d.x) || d.lengthSq() === 0) d.set(...VIEW_DIRS.iso).normalize();
    const vfov = THREE.MathUtils.degToRad(this.perspCam.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.aspect);
    const dist = (r / Math.sin(Math.min(vfov, hfov) / 2)) * 1.05;
    this.controls.target.copy(sphere.center);
    this.perspCam.position.copy(sphere.center).addScaledVector(d, dist);
    this.orthoCam.position.copy(sphere.center).addScaledVector(d, dist);
    this.orthoBase = this.radius * 2.2;
    const needed = (2.2 * r) / Math.min(1, this.aspect);
    this.orthoCam.zoom = this.orthoBase / needed;
    this.orthoCam.updateProjectionMatrix();
    this.updateOrthoFrustum();
    this.camera.lookAt(sphere.center);
    this.controls.update();
    this.requestRender();
  }

  setView(name: ViewName) {
    const t = this.controls.target;
    const dist = this.camera.position.distanceTo(t);
    const d = new THREE.Vector3(...VIEW_DIRS[name]).normalize();
    this.camera.position.copy(t).addScaledVector(d, dist);
    this.camera.lookAt(t);
    this.controls.update();
    this.requestRender();
  }

  get ortho() { return this.camera === this.orthoCam; }

  setOrtho(on: boolean) {
    if (on === this.ortho) return;
    const t = this.controls.target;
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(this.perspCam.fov) / 2);
    if (on) {
      const d = this.perspCam.position.distanceTo(t);
      this.orthoCam.position.copy(this.perspCam.position);
      this.orthoCam.quaternion.copy(this.perspCam.quaternion);
      this.orthoCam.zoom = this.orthoBase / (2 * d * tanHalf);
      this.camera = this.orthoCam;
    } else {
      const visibleH = this.orthoBase / this.orthoCam.zoom;
      const d = visibleH / (2 * tanHalf);
      const dir = this.orthoCam.position.clone().sub(t).normalize();
      this.perspCam.position.copy(t).addScaledVector(dir, d);
      this.perspCam.quaternion.copy(this.orthoCam.quaternion);
      this.camera = this.perspCam;
    }
    this.camera.add(this.dirLight, this.dirLight.target);
    this.updateOrthoFrustum();
    this.controls.object = this.camera;
    this.controls.update();
    this.buildComposer();
    this.requestRender();
  }

  // --------------------------------------------------------------- modes

  setWireframe(on: boolean) {
    this.wireframe = on;
    this.forEachMaterial((m) => this.applyMaterialMode(m));
    this.requestRender();
  }

  setXray(on: boolean) {
    this.xray = on;
    this.forEachMaterial((m) => this.applyMaterialMode(m));
    this.requestRender();
  }

  private forEachMaterial(f: (m: THREE.MeshStandardMaterial) => void) {
    f(this.defaultMaterial);
    for (const m of this.materials.values()) f(m);
  }

  setGrid(on: boolean) { this.showGrid = on; this.updateHelpers(); }
  setAxes(on: boolean) { this.showAxes = on; this.updateHelpers(); }

  /** Grid on the XY plane and X/Y/Z axis lines, sized to the model. */
  private updateHelpers() {
    this.helpers.clear();
    const b = this.sceneBox;
    const extent = Math.max(Math.abs(b.min.x), Math.abs(b.max.x), Math.abs(b.min.y), Math.abs(b.max.y), this.radius * 0.5, 1e-6);
    let unit = Math.pow(10, Math.floor(Math.log10(extent)));
    let cells = Math.ceil(extent / unit) * 2 + 2;
    while (cells > 120) { unit *= 10; cells = Math.ceil(extent / unit) * 2 + 2; }
    const size = cells * unit;
    if (this.showGrid) {
      const g = new THREE.GridHelper(size, cells, 0x5a5a5a, 0x4a4a4a);
      g.rotation.x = Math.PI / 2;
      this.helpers.add(g);
    }
    if (this.showAxes) {
      const h = size / 2;
      const pts = [-h, 0, 0, h, 0, 0, 0, -h, 0, 0, h, 0, 0, 0, 0, 0, 0, h / 2];
      const col = [0.9, 0.25, 0.3, 0.9, 0.25, 0.3, 0.45, 0.75, 0.15, 0.45, 0.75, 0.15, 0.25, 0.45, 0.95, 0.25, 0.45, 0.95];
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      const a = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true }));
      a.renderOrder = 1;
      this.helpers.add(a);
    }
    this.requestRender();
  }

  // ------------------------------------------------------------ test hooks

  /** Screen position (client px) of a point inside the object, for automated click tests. */
  screenPointOf(id: number): { x: number; y: number } | null {
    const box = this.worldBox(id, false);
    if (box.isEmpty()) return null;
    const c = box.getCenter(new THREE.Vector3()).project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + ((c.x + 1) / 2) * rect.width, y: rect.top + ((1 - c.y) / 2) * rect.height };
  }

  debugState() {
    const nodes = [...this.nodes.entries()].map(([id, n]) => ({
      id,
      name: n.name,
      kind: n instanceof THREE.Mesh ? 'mesh' : 'lines',
      visible: n.visible,
      matrix: n.matrix.toArray(),
      colors: n instanceof THREE.Mesh ? (n.material as THREE.MeshStandardMaterial[]).map((m) => m.color.toArray()) : [],
    }));
    const instances = [...this.instanceNodes.entries()].flatMap(([id, list]) =>
      list.map((n) => ({ instancer: id, of: (n.userData as NodeData).instanceOf, visible: n.visible, matrix: n.matrix.toArray() })));
    return { nodes, instances, selected: [...this.selected], ortho: this.ortho, wireframe: this.wireframe, xray: this.xray };
  }

  /** WebGL renderer string (for test reports). */
  glRenderer(): string {
    const gl = this.renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  }

  /** Shared geometry for a mesh key (Blender coordinates), for export. */
  geometryFor(key: string): THREE.BufferGeometry | null {
    const m = this.sceneData?.meshes[key];
    return m && m.render.index.length ? this.geometry(key, m) : null;
  }

  dispose() {
    this.disposed = true;
    this.clear();
    this.renderer.dispose();
  }
}

/** Blender "Plain Axes" empty: three lines through the origin, coloured X/Y/Z. */
function emptyAxes(s: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-s, 0, 0, s, 0, 0, 0, -s, 0, 0, s, 0, 0, 0, -s, 0, 0, s], 3));
  const r = [0.95, 0.35, 0.4], gr = [0.55, 0.85, 0.3], b = [0.35, 0.55, 1];
  g.setAttribute('color', new THREE.Float32BufferAttribute([...r, ...r, ...gr, ...gr, ...b, ...b], 3));
  return g;
}

/** Small pyramid pointing down -Z (a Blender camera looks along its local -Z). */
function cameraMarker(s: number): THREE.BufferGeometry {
  const w = s * 0.7, h = s * 0.5, d = s * 1.4;
  const c = [0, 0, 0], p = [[-w, -h, -d], [w, -h, -d], [w, h, -d], [-w, h, -d]];
  const pts: number[] = [];
  for (let i = 0; i < 4; i++) pts.push(...c, ...p[i], ...p[i], ...p[(i + 1) % 4]);
  pts.push(-w * 0.5, h * 1.15, -d, 0, h * 1.6, -d, 0, h * 1.6, -d, w * 0.5, h * 1.15, -d); // "up" triangle
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
}
