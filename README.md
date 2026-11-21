# Blend Viewer

Blend Viewer is one HTML file that opens Blender `.blend` files in the browser. You do not need Blender. The viewer shows each object with its real name, the collection tree and the material colours. The file stays on your computer: nothing is uploaded, and the page works offline from `file://`.

## Use the viewer

1. Open `dist/blend-viewer.html` in Firefox or Chromium. A double-click on the file is enough.
2. Drop a `.blend` file on the page, or click **Open .blend**.
3. Click an object in the outliner or in the 3D view to see its details in the info panel.

Mouse controls:

| Action | Result |
|---|---|
| Left drag | Orbit |
| Right drag, or Shift + left drag | Pan |
| Wheel | Zoom to the cursor |
| Click | Select (Ctrl+click adds or removes, Shift+click adds) |
| Double-click | Frame the object |

Keyboard shortcuts:

| Key | Action |
|---|---|
| Home | Frame all |
| F or Numpad . | Frame selected |
| Numpad 1, 3, 7 | Front, right, top view (with Ctrl: back, left, bottom) |
| Numpad 5 | Perspective or orthographic |
| Shift+Z, Alt+Z | Wireframe, X-ray |
| H, Shift+H, Alt+H | Hide selected, hide the others, show all |
| / | Isolate selected |
| Esc | Clear the selection |
| Ctrl+O | Open a file |

The viewer does not do these things:

- It does not apply modifiers or Geometry Nodes. Objects show their stored base mesh, and the info panel lists the modifiers that were skipped.
- It does not render textures or shader graphs. It uses one flat colour per material.
- It does not draw curves, text, surfaces or metaballs. Blender generates their geometry, so it is not in the file. These objects appear in the outliner only.
- It does not play animation, armatures or shape keys.

## Build

You need Node.js 20 or later and npm. The project was tested with Node.js 22.

```bash
npm install
```

```bash
npm run build
```

The build type-checks the code and writes one self-contained file, `dist/blend-viewer.html`. All JavaScript, CSS and the parser worker are inside it.

To work on the code with live reload, run `npm run dev` and open the URL that Vite prints.

## Test

The parser tests run in Node.js. They compare the parser output with `ground_truth.json` for each file in `blend-viewer-handoff/test-files/`.

```bash
npm test
```

The browser tests open `dist/blend-viewer.html` from `file://` in headless Chromium and Firefox. They load every test file and check object positions, colours, initial visibility, tree and 3D selection, collection instances, and GLB and STL export. Build the page first.

```bash
npm run build
```

```bash
npm run test:browser
```

The browser tests write screenshots and the exported files to `test-output/`.

To also load a 200 MB file and measure how long the page stalls, add `--big`. This step needs `python3` with `numpy`. The test makes the file in a temporary folder and deletes it after the run.

```bash
npm run test:browser -- --big
```

To compare the parser with the Python reference parser on your own `.blend` files, set `BLEND_EXTRA_DIR` to a folder of files. This step needs `python3` with `numpy` and `zstandard`.

```bash
BLEND_EXTRA_DIR=/path/to/blend/files npm test
```

These environment variables change where the tests look:

| Variable | Meaning |
|---|---|
| `BLEND_TEST_FILES` | Folder with the test files (default: `test-files/` or `blend-viewer-handoff/test-files/`) |
| `CHROMIUM_BIN` | Path to Chromium, Chrome or Brave (default: the first one found in `/usr/bin`) |
| `FIREFOX_BIN` | Path to Firefox (default: `/usr/bin/firefox`) |
| `BROWSERS` | `chromium`, `firefox`, or `chromium,firefox` (default) |
| `BIG_BLEND` | Path to an existing large `.blend` file for the stall test |
| `CHROMIUM_SOFTWARE` | Set to `1` to use software WebGL (SwiftShader) in Chromium instead of the GPU |

While the large file loads, no single main-thread stall can be longer than 250 ms, or the stall test fails. With software WebGL, GPU uploads block the page for seconds, so the test reports the stall but does not check it.

## Project layout

| Path | Content |
|---|---|
| `src/io/` | zstd and gzip detection and decompression |
| `src/blend/` | File header, block headers, DNA parsing, pointer resolution, typed field access |
| `src/scene/` | Objects and world matrices, collections, meshes, materials, instances, render buffers |
| `src/worker.ts`, `src/parseClient.ts` | Parsing in a Web Worker, with a fallback to the main thread |
| `src/viewer/` | three.js scene, camera tools, picking, selection outline |
| `src/ui/` | Outliner, info panel, toolbar, banner, stored preferences |
| `src/export/` | GLB and STL export |
| `test/` | Parser tests (Vitest) |
| `scripts/browser-test.mjs` | Browser acceptance tests (Puppeteer) |
| `scripts/make-big-blend.py` | Makes a large test file from a small one |
| `scripts/ref_dump.py` | Runs the Python reference parser for the cross-check test |

The parser in `src/blend/` and `src/scene/` does not import three.js, so the tests run it in Node.js.

## Design decisions

- Pointer addresses in Blender 5.x files are larger than 2^53. A JavaScript number cannot hold them exactly, and different addresses then become equal. The parser stores them as `BigInt`.
- If the object's Base in the first view layer has bit `0x02` set, the object starts visible. If the file has view layer data but the object has no Base, the object starts hidden. In that case its collection is excluded from the view layer, and the info panel says so. Without view layer data, all objects start visible.
- Objects that are in the file but not in the active scene appear under "Not in this scene" and start hidden.
- GLB export converts Z-up to Y-up the same way as Blender's glTF exporter. glTF node transforms cannot contain shear. A child of a non-uniformly scaled parent can need shear, so the exporter bakes that part into the child's vertices. Each object keeps its exact world position and its place in the hierarchy.
- The GLB file stores the exact Blender names. When three.js loads a file, it replaces spaces with `_` and removes dots, so the three.js editor shows changed names. Blender and f3d show the names unchanged.
- The built page has a Content-Security-Policy that blocks all network requests, so it cannot depend on the internet by accident.
