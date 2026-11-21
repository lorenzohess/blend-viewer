# Handoff: Lightweight `.blend` Viewer (single HTML page)

**For:** the local coding agent building this on the user's Arch Linux machine
**Goal:** a single, self-contained HTML file that opens a Blender `.blend` file directly, with **no Blender install**. It shows the model in 3D the way a CAD viewer does, with every object listed by its real name, and it shows material colours.

This plan was checked against real Blender output before handoff. A Python reference implementation of the parser (in `reference/`) was run against files saved by Blender 4.2, 4.5, 5.0 and 5.3, plus third-party files from Blender 2.80, 2.90, 3.0, 3.5, 4.2 and 5.2. For every object it reproduced Blender's own values: names, types, parents, world matrices, vertex, face and triangle counts, per-face material indices, material slots, smooth flags and material colours. The world matrices matched to within 1e‑4. Everything marked **(verified)** below was confirmed this way. Anything marked **(unverified)** comes from Blender's source or docs and should be tested before you rely on it.

---

## 1. Requirements

### Must have
1. **Opens a `.blend` file** by drag-and-drop or a file picker, entirely in the browser. No server, no upload, and it works offline from `file://`.
2. **Shows the actual geometry** of every mesh object, correctly positioned, rotated, scaled and parented, the way it sits in Blender's viewport (ignoring modifiers, see §6).
3. **Object tree (outliner):** every object with its **real Blender name**, arranged by collection and parent/child. Clicking a name selects and highlights the object in 3D. Clicking in 3D selects it in the tree.
4. **Per-object visibility toggles** (and per-collection toggles that apply to all children), plus "isolate selected" and "show all".
5. **Material colours:** each face is drawn in its material's colour. Multiple materials per object must work.
6. **CAD-style navigation:** orbit, pan, zoom, "frame selected", "frame all", preset views (front, back, left, right, top, bottom, iso), perspective/orthographic toggle, and wireframe and X-ray (semi-transparent) toggles.
7. **Info panel** for the selected object: name, type, parent, collection(s), mesh name, vertex/face/triangle counts, material slot names and colours, a list of modifiers with a "not applied" note, and world-space dimensions (bounding box size).
8. **Runs on Arch Linux** in current Firefox and Chromium as a single `.html` file the user double-clicks.

### Nice to have (in priority order)
1. **Export** the loaded scene to **GLB** with object names and hierarchy kept (three.js `GLTFExporter`), and export selected or all objects to **STL**. This covers the user's original "convert .blend to GLB/STL" wish.
2. **Collection instances** (an empty that instances a collection, common in assembly files). See §4.10.
3. Search box that filters the outliner by name.
4. Show non-mesh objects (empties, curves, text, lights, cameras) in the tree with a type icon, plus a small axis gizmo for empties.
5. Remember UI toggles in `localStorage`, wrapped in try/catch.

### Out of scope (explicitly agreed with the user)
- **Modifiers and Geometry Nodes are not evaluated.** Objects show their stored base mesh. The info panel must say which modifiers were skipped, so the user knows why something looks different from Blender (e.g. "Subdivision Surface: not applied").
- Realistic rendering: shader node graphs, textures, PBR. Use flat or simple-lit colours only.
- Curve, text, surface and metaball geometry: list these objects in the tree, but there is no mesh to draw.
- Animation, armatures and shape keys. Use the rest pose and base shape.
- Editing or saving `.blend` files.

---

## 2. Tech stack and deliverable

| Concern | Choice |
|---|---|
| Build | **Vite** + **vite-plugin-singlefile** → `dist/blend-viewer.html` with all JS and CSS inlined |
| 3D | **three.js** (`WebGLRenderer`, `OrbitControls` or `TrackballControls`, `GLTFExporter`, `STLExporter`) |
| zstd | **fzstd** (pure JS, small). **(verified)** It correctly decompresses Blender 4.2, 5.0 and 5.3 compressed files, including Blender's multi-frame and skippable-frame layout. The output matched the uncompressed files byte for byte. |
| gzip | Built-in `DecompressionStream('gzip')`, used for old files saved before 3.0 with compression on |
| N-gon triangulation | `THREE.ShapeUtils.triangulateShape` (earcut) after projecting the polygon onto its best-fit plane. Fan triangulation is fine for triangles and quads. |
| Language | TypeScript is recommended: the binary parsing is fiddly and types help |
| Parsing thread | A **Web Worker**, so big files don't freeze the UI. With singlefile builds, create the worker from a Blob URL or use Vite's `?worker&inline`. Send geometry back as transferable typed arrays. |

The deliverable is a repo containing the source, `npm run build` (produces `dist/blend-viewer.html`), and `npm test` (parser tests against the files in `test-files/`).

---

## 3. Architecture

```
src/
  io/decompress.ts        detect & undo zstd / gzip
  blend/header.ts         file header + block headers (legacy and 5.x formats)
  blend/dna.ts            parse the DNA1 block -> struct layouts (names, types, sizes, field offsets)
  blend/file.ts           BlendFile: blocks, ID groups, pointer resolution, typed field access
  scene/objects.ts        Objects, types, world matrices (§4.8)
  scene/collections.ts    collection tree, visibility, instances (§4.9, §4.10)
  scene/mesh.ts           mesh extraction for all three storage layouts (§4.11)
  scene/materials.ts      slot resolution + colour (§4.12)
  scene/extract.ts        builds a plain SceneDescription (JSON-able + typed arrays)
  worker.ts               runs extract in a worker
  viewer/                 three.js scene building, selection, highlighting, camera tools
  ui/                     outliner, info panel, toolbar, drop zone, error/warning banner
  export/                 GLB + STL export
test/                     parser tests using test-files/*.blend + ground_truth.json
```

Keep the parser (`blend/`, `scene/`) free of three.js, so it can be tested in Node.

**SceneDescription (the worker's output):**
```ts
interface SceneDescription {
  blenderVersion: number;            // e.g. 402, 503
  objects: SceneObject[];
  meshes: Record<string, MeshData>;  // keyed by mesh ID name; shared by several objects
  materials: Record<string, { color: [number,number,number,number]; source: string }>;
  collections: CollectionNode;       // root = scene master collection
  warnings: string[];                // human-readable, shown in a banner
}
interface SceneObject {
  name: string; type: string; parent: string | null;
  worldMatrix: number[];             // 16 floats, column-major (three.js Matrix4.fromArray order)
  mesh?: string; materialSlots: (string | null)[];
  modifiers: { name: string; kind: string }[];
  visible: boolean;                  // initial visibility (§4.9)
  instanceCollection?: string;       // §4.10
}
interface MeshData {
  positions: Float32Array;           // flat xyz, one entry per vertex
  triangles: Uint32Array;            // flat vertex indices, 3 per triangle
  triMaterial: Uint16Array;          // material slot index per triangle
  triSmooth: Uint8Array;             // 1 = smooth-shaded face
}
```

---

## 4. The `.blend` file format: what to implement

A `.blend` file is essentially a memory dump: a header, then a list of **blocks**, each a chunk of C structs. One special block, **DNA1**, describes the layout of every struct type in that file. Because the file describes itself, **you never hard-code struct offsets**. You look up field offsets in the file's own DNA. Struct layouts change between Blender versions, and this is how the parser copes.

### 4.1 Compression (verified)
Look at the first bytes of the file:
- `28 B5 2F FD` → **zstd** (Blender 3.0+ with "Compress" on). The file can contain several frames plus a skippable seek-table frame, and fzstd handles this.
- `1F 8B` → **gzip** (pre-3.0 compressed files).
- `BLENDER` → uncompressed.

### 4.2 File header (verified)
| Format | Example | Length | Meaning |
|---|---|---|---|
| Legacy (≤ 4.5) | `BLENDER-v402` | 12 bytes | byte 7: `-` = 8-byte pointers, `_` = 4-byte; byte 8: `v` = little-endian, `V` = big-endian; bytes 9–11: version (402 = 4.2) |
| New (5.0+) | `BLENDER17-01v0503` | 17 bytes | `17` = header length, `01` = file-format version, `v` = little-endian, 4-digit version (0503 = 5.3). Always 8-byte pointers, little-endian. |

Detect the format with `bytes[7..9] == "17"`.

### 4.3 Block headers (verified)
Each block = header + `len` bytes of data. They follow each other until a block with code `ENDB`.

| Format | Layout (little-endian) | Size |
|---|---|---|
| 5.0+ | `char code[4]; int32 sdna_index; uint64 old_ptr; int64 len; int64 count;` | 32 |
| Legacy, 8-byte ptr | `char code[4]; int32 len; uint64 old_ptr; int32 sdna_index; int32 count;` | 24 |
| Legacy, 4-byte ptr | `char code[4]; int32 len; uint32 old_ptr; int32 sdna_index; int32 count;` | 20 |

- `code` is 4 bytes. ID blocks use a 2-letter code padded with zeros: `OB` Object, `ME` Mesh, `MA` Material, `SC` Scene, `GR` Collection, `CU` Curve/Text, `LI` Library, etc. Non-ID blocks: `DATA`, `DNA1`, `ENDB`, `REND`, `TEST`, `GLOB`, `USER`.
- `sdna_index` = which DNA struct the block holds. `count` = how many of them are stored back to back.
- `old_ptr` = the memory address the data had when saved. Other structs point to it.
- **Gotcha: alignment.** In 5.x files the data starts at odd offsets (17-byte header). Do **not** make `new Float32Array(buffer, offset, n)` views straight onto the file buffer, because that throws on unaligned offsets. Copy first (`buffer.slice(off, off + len)`) or read through a `DataView`.

### 4.4 Pointer resolution (verified, a critical gotcha)
**`old_ptr` values are NOT unique across the file.** In Blender 5.3 test files, 21 addresses appear on more than one block, and 4.2 files have some too. If you build one global `address → block` map, you will silently read another object's data. In testing, an early version of the parser read the monkey's vertices for the cube.

The correct rule, which mirrors Blender's own reader:
1. Walk the blocks in order. Each **ID block** (any 2-letter code) starts a **group**. The `DATA` blocks that follow it, up to the next ID block, belong to that group.
2. To resolve a pointer found inside a group, look in **that group's DATA blocks first**. If it's not there, look it up among **ID blocks globally**. ID addresses are unique, and pointers to other IDs (e.g. Object → Mesh, Mesh → Material) resolve this way.
3. **Embedded data** is stored as `DATA` blocks inside the owner's group, *not* as separate ID blocks. Examples: a material's node tree (`bNodeTree`) and the scene's master collection (`Collection`). **(verified)** To read pointers *inside* that embedded data, use the owner's group again.

### 4.5 Parsing the DNA1 block (verified)
The data of the `DNA1` block:
```
"SDNA"
"NAME" int32 n, then n zero-terminated strings     (field names, e.g. "*next", "co[3]", "name[66]")
  align to 4 bytes
"TYPE" int32 n, then n zero-terminated strings     (type names, e.g. "char", "float", "Object")
  align to 4 bytes
"TLEN" n × int16                                    (byte size of each type, same order as TYPE)
  align to 4 bytes
"STRC" int32 n, then n structs: int16 type_index, int16 field_count, then field_count × (int16 type_index, int16 name_index)
```
- **Alignment is relative to the start of the DNA1 block's data**, not to the file offset. (With 5.x's 17-byte header, aligning to absolute offsets breaks.)
- A field's **byte offset** is the sum of the sizes of the fields before it. There is no implicit padding: Blender pads its structs explicitly with `_pad` fields.
- Field size: if the name contains `*` (including function pointers like `(*func)()`) it's a pointer, so use the pointer size. Otherwise use `TLEN[type]`. Multiply by every `[N]` in the name (e.g. `float mat[4][4]` → 64 bytes).
- Strip `*`, `(`, `)` and `[...]` from the name to get the lookup key (`*next` → `next`, `co[3]` → `co`).
- Build `structName → { fieldName → {type, isPointer, count, offset, size} }` once, then access fields through a helper like `get(structName, blockOffset, "id.name")` that walks nested structs by name.

### 4.6 Use the names stored in the file, not Blender's Python names (verified)
The file's DNA uses older internal names that often differ from what you see in Blender's Python API or UI. Names that matter here:

| What | Name in the file's DNA | (Python/UI name — don't use) |
|---|---|---|
| Object scale | `Object.size` | `scale` |
| Delta scale | `Object.dscale` | `delta_scale` |
| Instanced collection | `Object.dup_group` | `instance_collection` |
| Collection instance offset | `Collection.dupli_ofs` | `instance_offset` |
| Mesh face count | `Mesh.totpoly` | `faces_num` |
| Mesh corner count | `Mesh.totloop` | `corners_num` |
| Face start offsets | `Mesh.poly_offset_indices` | `face_offset_indices` |
| Mesh CustomData | `Mesh.vdata / edata / pdata / ldata` | `vert_data` … |

`ID.name` includes a **2-letter type prefix**: `"OBBolt.001"`, `"MEBolt"`, `"MARed Plastic"`. Strip the first 2 characters for display. Names are UTF-8. The buffer is 66 bytes in older versions and 258 in 5.x, and the DNA handles that automatically.

### 4.7 Objects (verified)
Every `OB` block is one Object. Fields used: `id.name`, `type`, `parent` (pointer to an Object), `data` (pointer to an ID such as a Mesh), `loc`, `dloc`, `rot`, `drot`, `quat`, `dquat`, `rotAxis`, `rotAngle`, `drotAxis`, `drotAngle`, `rotmode`, `size`, `dscale`, `parentinv`, `totcol`, `mat`, `matbits`, `modifiers`, `transflag`, `dup_group`.

`Object.type` values: 0 Empty, 1 Mesh, 2 Curve, 3 Surface, 4 Text, 5 Metaball, 10 Light, 11 Camera, 12 Speaker, 13 Light Probe, 22 Lattice, 25 Armature, 26 legacy Grease Pencil, 27 Curves (hair), 28 Point Cloud, 29 Volume, 30 Grease Pencil. Only 0, 1, 2, 4, 10 and 11 were seen in testing. The rest come from Blender's source **(unverified)**, so treat any value you don't recognise as "Other".

### 4.8 World transforms (verified on 4.2, 4.5, 5.0, 5.3)
**Blender 4.2+ files do not store the world matrix.** It lives in runtime data that isn't saved, so you must compute it:

```
local = Translate(loc + dloc) · (R_delta · R) · Scale(size ⊙ dscale)      (⊙ = element-wise multiply)
world = parentWorld · parentinv · local                                   (recursive; no parent → world = local)
```
- Rotation `R` depends on `rotmode`:
  - `0` = quaternion `quat` (w, x, y, z). Normalise it first.
  - `-1` = axis-angle `rotAxis` + `rotAngle`.
  - `1..6` = Euler `rot` in order XYZ, XZY, YXZ, YZX, ZXY, ZYX. **Order semantics:** for "XYZ", X is applied first, so `R = Rz · Ry · Rx` (column vectors). In general, multiply each axis's matrix onto the **left** in the order the letters appear.
- `R_delta` is built the same way from `dquat` / `drotAxis`+`drotAngle` / `drot`, **using the same `rotmode`**.
- `parentinv` is a `float[4][4]`. Blender stores 4×4 matrices so that the 16 floats in file order are **column-major**, which matches three.js `Matrix4.fromArray()` directly. (In the reference Python it's read as `reshape(4,4).T`.)
- Parent types other than plain Object (bone or vertex parents) aren't handled specially: treat them as object parents and add a warning. Constraints are ignored too.
- Blender is **Z-up**, three.js is Y-up. Either set `camera.up = (0,0,1)` and keep Blender coordinates, or put everything under a root group rotated −90° about X. Use the same convention as Blender's glTF exporter when exporting GLB.

### 4.9 Collections and initial visibility (verified)
- `SC` block → `Scene.master_collection` (embedded `Collection`, §4.4) → the root "Scene Collection".
- `Collection.gobject` = ListBase of `CollectionObject { next, prev, ob }`. `Collection.children` = ListBase of `CollectionChild { next, prev, collection }` (pointers to `GR` ID blocks).
- A `ListBase` is `{ first, last }`. Follow `first`, then each item's `next`, until null. Guard against cycles.
- An object can be in **several** collections. Show it under each one, sharing one selection and visibility state.
- `Collection.flag & 1` = hidden in viewports (the "disable in viewports" toggle).
- The eye icon is stored per view layer: `Scene.view_layers` (ListBase of `ViewLayer`) → `object_bases` (ListBase of `Base { object, flag }`). In the test files, visible objects had `Base.flag = 0xD6`, the eye-hidden object `0x1C0`, and an object in a disabled collection `0x80`. **Rule: an object starts visible iff its Base in the first ViewLayer has bit `0x02` set.** If there's no Base or ViewLayer data, start visible. Everything can still be toggled in the UI.
- Pre-2.80 files have no collections: fall back to a flat list of objects (low priority).

### 4.10 Collection instances (verified, "nice to have" #2)
An object whose `transflag & 0x100` is set and whose `dup_group` isn't null instances that collection. Each object `X` in the instanced collection, recursively including child collections, is drawn again with:
```
instanceWorld(X) = emptyWorld · Translate(−collection.dupli_ofs) · world(X)
```
This matched Blender's own instance matrices exactly. Instances can nest, so recurse with a depth limit (e.g. 8). In the outliner, show instances as read-only children of the instancing empty.

(Text objects also produce instances in Blender's instance list, one per character. Ignore those.)

### 4.11 Meshes: three storage layouts (verified)
Blender has changed how meshes are stored. **Detect the layout from what's in the file, not from the version number**, in this order:

**Common fields:** `Mesh.totvert`, `Mesh.totpoly` (faces), `Mesh.totloop` (corners, i.e. face-vertex slots).

**A) Blender 5.0+: `Mesh.attribute_storage`** (use when `attribute_storage.dna_attributes_num > 0`)
- `dna_attributes` → array of `Attribute { char *name; short data_type; int8 domain; int8 storage_type; void *data }`.
- `storage_type 0` (Array): `data` → `AttributeArray { void *data; ...; int64 size }`, and its `data` → the raw values.
  `storage_type 1` (Single): `data` → `AttributeSingle { void *data }`, one value for the whole domain.
- `domain`: 0 point, 1 edge, 2 face, 3 corner.
- `data_type` seen in testing: 0 bool, 3 int32, 4 int32×2, 6 float×2, 7 float×3. Match on the **name** first.
- Needed attributes:
  - `position` (point, float×3)
  - `.corner_vert` (corner, int32: the vertex index of each corner)
  - `material_index` (face, int32; may be missing → all 0)
  - `sharp_face` (face, bool; **missing means smooth**)
- In 5.x files the old CustomData layers are empty.

**B) Blender ~3.5/3.6–4.5: CustomData generic attributes**
- `vdata`/`pdata`/`ldata` are `CustomData { CustomDataLayer *layers; ...; int totlayer; ... }`.
- `CustomDataLayer { int type; ...; char name[68]; void *data; ... }`. Read `totlayer` entries with the stride `TLEN["CustomDataLayer"]`.
- Needed layers:
  - vdata: `type 48` (float×3) named `position`
  - ldata: `type 11` (int32) named `.corner_vert`
  - pdata: `type 11` named `material_index`; `type 50` (bool) named `sharp_face`

**C) Blender 2.63–3.5: legacy structs in CustomData**
- vdata `type 0` = array of `MVert { float co[3]; ... }`. **The stride changed between versions** (20 bytes in 2.8x, 16 in 3.x), so always use `TLEN["MVert"]`.
- ldata `type 26` = `MLoop { uint v; uint e; }`. Use `v`.
- pdata `type 25` = `MPoly { int loopstart; int totloop; short mat_nr; char flag; ... }`. Smooth when `flag & 1`.

**Face ranges:** in layouts A and B, face `f` uses corners `poly_offset_indices[f] .. poly_offset_indices[f+1]` (`totpoly + 1` int32s). In layout C, use `MPoly.loopstart` and `totloop` instead.

**Pre-2.63** files only have `MFace` (tessellated faces in `fdata`, `type 4`). This is low priority: show a warning if `totpoly == 0` but `fdata` has layers.

**Triangulation:** for each face, take its corners' vertex indices and triangulate: fan for 3–4 vertices, earcut for 5+ (concave n-gons). Record each triangle's material index and smooth flag.

**Normals:** build one three.js `BufferGeometry` per mesh. Flat faces get the face normal. Smooth faces get the vertex normal averaged over adjacent smooth faces. The simplest correct approach is to un-index into corners, then compute per-corner normals. Edge sharpness (`sharp_edge`) and auto-smooth angles can be ignored.

**Sharing:** several objects can use one Mesh (`Bolt.001` and `Bolt.002` in the test file). Build the geometry once and reuse it.

**Mesh-like data that isn't a Mesh** (Curves, Text, Metaball, Point Cloud): no geometry. List the object and add an info-panel note: "Curve object — geometry is generated by Blender, not stored in the file."

### 4.12 Materials (verified)
**Slot resolution, per object:** slot `i` uses the **object's** material `Object.mat[i]` if `Object.matbits[i] != 0`, otherwise the **mesh's** material `Mesh.mat[i]`. `Object.mat` and `Mesh.mat` are pointers to arrays of Material pointers (`Material **`). `Object.totcol` and `Mesh.totcol` give the lengths. A face's `material_index` beyond the last slot is clamped to the last slot. An empty slot or no material means default grey `(0.8, 0.8, 0.8)`.

**Colour, per material, in priority order:**
1. If `use_nodes` and there's a `nodetree` (embedded, §4.4): walk `bNodeTree.nodes` (ListBase of `bNode`) and find the first node whose `idname` is `ShaderNodeBsdfPrincipled`, `ShaderNodeBsdfDiffuse` or `ShaderNodeEmission`. In its `inputs` (ListBase of `bNodeSocket`), find the socket whose `identifier` is `Base Color` or `Color`. If **no** `bNodeLink` in `bNodeTree.links` has `tosock` equal to that socket's address, the colour is `bNodeSocket.default_value` → 4 floats (RGBA).
2. Otherwise use the material's viewport display colour, `Material.r, g, b, a`. This applies when the colour input is driven by a texture or other node, or when nodes are off. It's what Blender's solid view shows.

In testing, both paths matched Blender, including a material whose Base Color was linked to a checker texture (correctly fell back to the viewport colour).

**Colour space:** these values are **linear**. In three.js use `color.setRGB(r, g, b, THREE.LinearSRGBColorSpace)` with the renderer's output colour space left at sRGB. Otherwise colours look washed out or too dark.

**Rendering:** `MeshStandardMaterial` (roughness ~0.6, metalness 0) or `MeshLambertMaterial`, with a hemisphere light plus a directional light attached to the camera. Use per-material groups (`geometry.addGroup`) with a material array per mesh.

### 4.13 Modifiers, listed only (verified)
`Object.modifiers` = ListBase of modifier structs. Each starts with `ModifierData { next, prev, type, mode, ..., char name[64] }`. Read `name`, and take the block's DNA struct name as the kind: `SubsurfModifierData` → "Subdivision Surface". Show these in the info panel as "not applied". If any object has modifiers, show one banner: "Some objects use modifiers, which this viewer doesn't apply. They're shown in their base shape."

### 4.14 Degrade gracefully, never crash
- Wrap each object's extraction in try/catch. On failure, keep the object in the tree with a ⚠ and a message, and carry on.
- Before reading any struct or field, check it exists in this file's DNA.
- Library-linked data (an ID with a non-null `id.lib`, data that lives in another `.blend`) has no geometry in this file. Show it as "linked from <library path>".
- Big-endian or 4-byte-pointer files (very old, pre-2.8 era) are low priority. Either support them through `DataView` endianness and pointer size, or show a clear "unsupported old file" message.
- If the file isn't a `.blend` at all, say so clearly.

---

## 5. Viewer and UI specification

**Layout:** left sidebar = outliner (resizable). Right sidebar = info panel (collapsible). Top toolbar. A drop zone fills the canvas until a file is loaded. A banner area for warnings.

**Outliner**
- Root "Scene Collection" → child collections → objects. Under each object, its child objects (by `parent`). Collapsible nodes, a type icon, an eye toggle per row, and a checkbox per collection that cascades to its contents.
- Click = select (highlight in 3D, show info). Ctrl/Shift-click = multi-select. Double-click = frame the object.
- Filter box (nice to have).

**3D view**
- Click to pick (three.js `Raycaster` against visible meshes) → select in the outliner and scroll to it.
- Selection highlight: an outline (`OutlinePass`, or an edges overlay in an accent colour). Don't change the material colour.
- Toolbar: Frame All, Frame Selected, view presets (Front −Y, Back +Y, Right +X, Left −X, Top +Z, Bottom −Z, Iso; these are Blender's conventions), Perspective/Ortho, Wireframe, X-ray (opacity ~0.35, depthWrite off), Isolate selected, Show all, plus a grid and axes toggle.
- Camera near/far planes and grid size adapt to the model's bounding box. Models can be in millimetres or kilometres.

**Info panel:** name, type, parent, collections, mesh name (and "shared by N objects"), vertex/face/triangle counts, world-space bounding box size in Blender units, material slots with colour swatches, modifiers (not applied), and warnings.

**Status bar:** file name, Blender version it was saved with (e.g. "saved with Blender 5.3"), object/mesh/triangle totals, parse time.

---

## 6. Milestones and acceptance criteria

**M1: Parser core (Node-testable)**
Decompress, read the header, blocks, DNA, ID groups and pointer resolution. Then list every object with name, type and parent.
*Accept:* for every file in `test-files/`, object names, types and parents equal `ground_truth.json`.

**M2: Transforms and collections**
World matrices (§4.8), collection tree (§4.9).
*Accept:* every `matrix_world` matches the ground truth to 1e‑4 (note: ground truth stores matrices **row-major**, as lists of rows). The collection tree matches §7's expected output.

**M3: Mesh geometry**
All three layouts, triangulation, smooth flags.
*Accept:* `nverts`, `nfaces`, `ntris`, the first vertex `v0` (1e‑5), the first 12 `face_mats` and the first 4 `smooth` values match the ground truth for every mesh object.

**M4: Materials**
Slot resolution and colour (§4.12).
*Accept:* `slots` matches the ground truth for every mesh object. Material colours match `_materials[name].base`, or `.viewport` for "Textured", whose Base Color is linked to a texture.

**M5: Viewer and UI**
Everything in §5, built as a single HTML file.
*Accept:* `dist/blend-viewer.html` opens from `file://` in Firefox and Chromium on Arch with no network. Dropping any test file shows all 10 mesh objects in the right places and colours. "Hidden Torus" and "Eye-Hidden Ico" start hidden but can be toggled on. Clicking in the tree and in 3D selects the same object. A 200 MB file loads without freezing the UI.

**M6: Export (nice to have)**
GLB export preserving names and hierarchy, STL export (selected or all).
*Accept:* opening the exported GLB in another viewer (e.g. three.js editor, f3d) shows the same object names.

**M7: Collection instances (nice to have)**
*Accept:* the "Fasteners Instance" empty in the test files shows a second copy of Bolt.001 and Bolt.002 at the positions given in `_instances` in `ground_truth.json`.

---

## 7. Test material included

```
test-files/
  blender-4.2/   test_compressed.blend  test_uncompressed.blend  ground_truth.json   (legacy header, CustomData layout B)
  blender-5.0/   ...same three files...                                             (5.x header, AttributeStorage layout A)
  blender-5.3/   ...same three files...                                             (5.x header, layout A)
  rotation-modes-5.3/  drot.blend  ground_truth.json                                (Euler/quaternion/axis-angle + delta rotations)
reference/
  blendref.py    block/DNA/pointer reader (Python, numpy, zstandard)
  extract.py     objects, transforms, meshes, materials, collections — the algorithm in §4, runnable
  compare.py     checks extract.py's output against a ground_truth.json
  make_samples.py, drot_test.py, dump_gt.py   scripts that created the test files with real Blender (pip package `bpy`)
```

The **reference Python is the source of truth for the algorithm**. When the spec above is ambiguous, port what `extract.py` does. Run it with:
```
python -m venv .venv && .venv/bin/pip install numpy zstandard
.venv/bin/python reference/compare.py test-files/blender-5.3/test_compressed.blend test-files/blender-5.3/ground_truth.json
```

**What's in each test scene (14 objects, 10 of them meshes):**
- "Base Plate": cube, Euler rotation, non-uniform scale, 2 materials alternating per face.
- "Bolt.001": parented to Base Plate **with a non-identity `parentinv`**.
- "Bolt.002": shares Bolt.001's mesh, uses quaternion rotation, has an **object-level material override** (green).
- "Knob": smooth-shaded, ZXY Euler, delta location and scale, a Subdivision Surface modifier (must be listed as not applied), and a material whose colour comes from a texture link.
- "Group Empty" (axis-angle) → "Child Of Empty" → "Grandchild Grid": 3-level parenting.
- "Ngon Disc": a 7-sided n-gon.
- "Cable" (curve) and "Label" (text): non-mesh objects.
- "NoMaterial Monkey": no material slots.
- "Hidden Torus": in the viewport-disabled "Hidden Stuff" collection.
- "Eye-Hidden Ico": hidden with the eye icon.
- "Fasteners Instance": an empty instancing the "Fasteners" collection (offset 0.5, 0, 0).
- Collections: Scene Collection → Assembly → Fasteners; Scene Collection → Hidden Stuff (flag 1).

**Older-format files** (2.80, 2.90, 3.0, 3.5, 4.2, 5.2) are in the public repo `github.com/lukebitts/blend` under `examples/blend_files/`. The reference parser passed against Blender's readings of all of them (layout C for 2.80–3.5). Clone it for extra tests. Don't commit those files unless their licence allows it.

**Final check by the user:** they'll open their own `.blend` files. Ask them which Blender version(s) their files come from, if they know.

---

## 8. Gotcha checklist (each of these broke or nearly broke the reference implementation)

- [ ] Pointer addresses repeat across IDs → resolve within the ID's group first (§4.4).
- [ ] 5.x data is unaligned → copy before making typed-array views (§4.3).
- [ ] DNA section alignment is relative to the DNA block's start (§4.5).
- [ ] Use file DNA names (`size`, `dup_group`, `dupli_ofs`, `totpoly`…), not Python names (§4.6).
- [ ] `ID.name` has a 2-letter prefix (§4.6).
- [ ] World matrices aren't stored in 4.2+ → compute them, including delta transforms and `parentinv` (§4.8).
- [ ] Missing `sharp_face` means **smooth**, not flat (§4.11).
- [ ] `MVert` stride differs by version → always use the DNA size (§4.11).
- [ ] Material colours are linear (§4.12).
- [ ] Z-up vs Y-up (§4.8).
- [ ] zstd files are multi-frame → use a decoder that handles that (fzstd does) (§4.1).
