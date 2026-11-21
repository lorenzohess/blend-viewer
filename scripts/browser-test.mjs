/**
 * Browser acceptance test for dist/blend-viewer.html (HANDOFF.md M5, M6, M7).
 *
 * Opens the built file from file:// in headless Chromium (or a Chromium-based browser such as Brave)
 * and in Firefox, loads every test file, and checks:
 *   - all mesh objects are drawn at the ground-truth world matrices, in the right colours
 *   - "Hidden Torus" and "Eye-Hidden Ico" start hidden and can be shown with the outliner eye
 *   - clicking a row in the tree and clicking the object in 3D select the same object
 *   - collection instances sit at the ground-truth matrices (M7)
 *   - GLB export keeps names, hierarchy and world positions; STL export has the right triangle count (M6)
 *   - no network request is made
 *   - optional: a ~200 MB file loads while the page stays responsive (--big, or BIG_BLEND=path)
 *
 * Usage:  npm run build && npm run test:browser [-- --big] [-- --headful]
 * Env:    CHROMIUM_BIN, FIREFOX_BIN, BROWSERS=chromium,firefox, BLEND_TEST_FILES, BIG_BLEND
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist', 'blend-viewer.html');
const TEST_FILES = resolve(process.env.BLEND_TEST_FILES ?? (existsSync(join(ROOT, 'test-files')) ? join(ROOT, 'test-files') : join(ROOT, 'blend-viewer-handoff', 'test-files')));
const OUT = join(ROOT, 'test-output');
const argv = new Set(process.argv.slice(2));
const HEADFUL = argv.has('--headful');
/** "Does not freeze": no single main-thread stall longer than this while a big file loads. */
const STALL_LIMIT_MS = 250;

let failures = 0, passes = 0;
const ok = (cond, msg) => {
  if (cond) { passes++; return true; }
  failures++;
  console.log(`    FAIL ${msg}`);
  return false;
};
const log = (...a) => console.log(...a);

// ------------------------------------------------------------------ helpers
const fromRows = (rows) => { const m = []; for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) m.push(rows[r][c]); return m; };
const maxDiff = (a, b) => (a.length !== b.length ? Infinity : Math.max(...a.map((x, i) => Math.abs(x - b[i]))));

function loadCases() {
  const out = [];
  for (const dir of readdirSync(TEST_FILES).sort()) {
    const gtPath = join(TEST_FILES, dir, 'ground_truth.json');
    if (!existsSync(gtPath)) continue;
    const raw = JSON.parse(readFileSync(gtPath, 'utf8'));
    const gt = { objects: {}, materials: raw._materials, instances: raw._instances };
    for (const [k, v] of Object.entries(raw)) if (!k.startsWith('_')) gt.objects[k] = v;
    for (const f of readdirSync(join(TEST_FILES, dir)).sort()) if (f.endsWith('.blend')) out.push({ dir, file: f, path: join(TEST_FILES, dir, f), gt });
  }
  return out;
}

function findBrowsers() {
  const want = (process.env.BROWSERS ?? 'chromium,firefox').split(',');
  const first = (list) => list.find((p) => p && existsSync(p));
  const out = [];
  if (want.includes('chromium')) {
    const bin = first([process.env.CHROMIUM_BIN, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/brave', '/usr/bin/brave-browser']);
    // Use the real GPU when there is a render node; software rendering (SwiftShader) blocks GPU uploads
    // and makes the stall measurement meaningless. Set CHROMIUM_SOFTWARE=1 to force SwiftShader.
    const gpu = !process.env.CHROMIUM_SOFTWARE && existsSync('/dev/dri') && readdirSync('/dev/dri').some((f) => f.startsWith('renderD'));
    const gl = gpu ? ['--enable-gpu', '--use-angle=gl-egl', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
    if (bin) out.push({ name: 'chromium', label: bin.split('/').pop(), opts: { executablePath: bin, args: [...gl, '--no-first-run', '--no-default-browser-check'] } });
    else log('! No Chromium-based browser found (set CHROMIUM_BIN). Skipping.');
  }
  if (want.includes('firefox')) {
    const bin = first([process.env.FIREFOX_BIN, '/usr/bin/firefox']);
    if (bin) out.push({ name: 'firefox', label: 'firefox', opts: { browser: 'firefox', executablePath: bin } });
    else log('! Firefox not found (set FIREFOX_BIN). Skipping.');
  }
  return out;
}

const state = (page) => page.evaluate(() => window.__blendViewer.state());

async function loadFile(page, path, timeout = 60_000, opts = {}) {
  const before = await page.evaluate(() => window.__blendViewer.status().loadCount);
  const input = await page.$('#file-input');
  await input.uploadFile(path);
  await page.waitForFunction((n) => { const s = window.__blendViewer.status(); return (s.loadCount > n && s.loaded) || s.lastError; }, { timeout, polling: 100 }, before);
  return opts.light ? null : state(page);
}

/** Center of an element, for real mouse clicks. */
async function centerOf(page, selector, text) {
  return page.evaluate((sel, txt) => {
    const el = [...document.querySelectorAll(sel)].find((e) => (txt === null ? true : e.closest('.row')?.querySelector('.label')?.textContent === txt));
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, selector, text ?? null);
}

function expectedColors(gtObj, gt, materials, n) {
  const slots = gtObj.slots ?? [];
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = slots.length ? slots[Math.min(i, slots.length - 1)] : null;
    if (!s || !s[1]) { out.push([0.8, 0.8, 0.8]); continue; }
    const m = gt.materials?.[s[1]];
    const linked = materials[s[1]]?.source.includes('linked');
    out.push((linked ? m.viewport : m.base).slice(0, 3));
  }
  return out;
}

// ------------------------------------------------------------- per file
async function checkFile(page, c, browser) {
  const s = await loadFile(page, c.path);
  ok(!s.lastError, `${c.file}: load error ${s.lastError}`);
  if (s.lastError) return s;
  const meshNames = Object.entries(c.gt.objects).filter(([, o]) => o.type === 'MESH').map(([n]) => n).sort();
  const nodes = s.viewer.nodes.filter((n) => n.kind === 'mesh');
  ok(JSON.stringify(nodes.map((n) => n.name).sort()) === JSON.stringify(meshNames), `${c.file}: mesh objects drawn ${nodes.map((n) => n.name)}`);
  const hiddenExpected = new Set(['Hidden Torus', 'Eye-Hidden Ico'].filter((n) => c.gt.objects[n]));
  for (const n of nodes) {
    const g = c.gt.objects[n.name];
    if (!g) continue;
    ok(maxDiff(n.matrix, fromRows(g.matrix_world)) < 1e-4, `${c.file}: ${n.name} placed at the ground-truth matrix`);
    const exp = expectedColors(g, c.gt, s.materials, n.colors.length);
    ok(n.colors.every((col, i) => maxDiff(col, exp[i]) < 1e-4), `${c.file}: ${n.name} colours ${JSON.stringify(n.colors)} vs ${JSON.stringify(exp)}`);
    ok(n.visible === !hiddenExpected.has(n.name), `${c.file}: ${n.name} initial visibility ${n.visible}`);
  }
  // Hidden objects can be shown with the eye in the outliner.
  for (const name of hiddenExpected) {
    const p = await centerOf(page, '.row .eye', name);
    if (!ok(p, `${c.file}: outliner row for ${name}`)) continue;
    await page.mouse.click(p.x, p.y);
    const after = await state(page);
    ok(after.viewer.nodes.find((n) => n.name === name)?.visible === true, `${c.file}: ${name} shown after clicking its eye`);
  }
  if (hiddenExpected.has('Hidden Torus')) {
    const checked = await page.evaluate(() => [...document.querySelectorAll('.row')].find((r) => r.querySelector('.label')?.textContent === 'Hidden Stuff')?.querySelector('input')?.checked);
    ok(checked === true, `${c.file}: "Hidden Stuff" checkbox follows its contents`);
  }
  // Tree click selects the object in 3D.
  const treeTarget = meshNames.includes('Knob') ? 'Knob' : meshNames[0];
  const p = await centerOf(page, '.row .label', treeTarget);
  await page.mouse.click(p.x, p.y);
  let st = await state(page);
  const idOf = (name) => st.objects.find((o) => o.name === name).id;
  ok(JSON.stringify(st.selected) === JSON.stringify([idOf(treeTarget)]) && JSON.stringify(st.viewer.selected) === JSON.stringify([idOf(treeTarget)]),
    `${c.file}: tree click selects ${treeTarget} (got ${st.selected})`);
  // 3D click selects the same object in the tree.
  await page.evaluate(() => { window.__blendViewer.frame(); window.__blendViewer.renderNow(); });
  let clicked = 0;
  for (const name of meshNames) {
    if (clicked >= 2) break;
    const sp = await page.evaluate((n) => window.__blendViewer.screenPoint(n), name);
    if (!sp) continue;
    const under = await page.evaluate((x, y) => window.__blendViewer.pickAt(x, y), sp.x, sp.y);
    if (under !== name) continue;
    await page.mouse.click(sp.x, sp.y);
    st = await state(page);
    const rowSelected = await page.evaluate((n) => [...document.querySelectorAll('.row.selected .label')].map((l) => l.textContent).includes(n), name);
    const infoName = await page.evaluate(() => document.querySelector('#info h2')?.textContent);
    ok(JSON.stringify(st.selected) === JSON.stringify([idOf(name)]) && rowSelected && infoName === name, `${c.file}: 3D click on ${name} selects it in the tree (selected ${st.selected}, row ${rowSelected}, info ${infoName})`);
    clicked++;
  }
  ok(clicked > 0, `${c.file}: found an unobstructed object to click in 3D`);
  // Collection instances (M7).
  if (c.gt.instances) {
    const exp = c.gt.instances.filter((i) => c.gt.objects[i.parent]?.type !== 'FONT');
    for (const e of exp) {
      const got = st.viewer.instances.find((i) => st.objects[i.of].name === e.obj && st.objects[i.instancer].name === e.parent);
      ok(got && maxDiff(got.matrix, fromRows(e.matrix_world)) < 1e-4, `${c.file}: instance of ${e.obj} under ${e.parent}`);
    }
  }
  await page.screenshot({ path: join(OUT, `${browser}-${c.dir}-${c.file.replace('.blend', '')}.png`) });
  return st;
}

// ---------------------------------------------------------------- export
const C = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);

/** World box of a node's own geometry. A multi-material glTF mesh loads as a Group of primitive meshes. */
function primitivesOf(node) {
  if (node.isMesh) return [node];
  return node.children.filter((c) => c.isMesh && c.userData?.name === undefined);
}
function ownBox(node) {
  const box = new THREE.Box3(), v = new THREE.Vector3();
  for (const m of primitivesOf(node)) {
    const pos = m.geometry.attributes.position;
    m.updateWorldMatrix(true, false);
    for (let i = 0; i < pos.count; i++) box.expandByPoint(v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld));
  }
  return box;
}

async function checkExport(page, c, browser) {
  await page.evaluate(() => window.__blendViewer.selectByName('Knob'));
  const glb = await page.evaluate(() => window.__blendViewer.exportBase64('glb-visible'));
  const buf = Buffer.from(glb.base64, 'base64');
  writeFileSync(join(OUT, `${browser}-${glb.name}`), buf);
  ok(buf.readUInt32LE(0) === 0x46546c67, 'GLB magic');
  const gltf = await new Promise((res, rej) => new GLTFLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), '', res, rej));
  // GLTFLoader sanitises names for animation binding ("Bolt.001" -> "Bolt001") and keeps the original in userData.name.
  const realName = (o) => o.userData?.name ?? o.name;
  const byName = new Map();
  gltf.scene.traverse((o) => { if (realName(o) && !o.userData?.instanceOf && !byName.has(realName(o))) byName.set(realName(o), o); });
  // The names stored in the file itself (glTF JSON chunk) must be the exact Blender names.
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  const fileNames = new Set(json.nodes.map((n) => n.name));
  const st = await state(page);
  const visible = st.objects.filter((o) => o.visible);
  for (const o of visible) ok(byName.has(o.name) && fileNames.has(o.name), `GLB contains node "${o.name}"`);
  ok(realName(byName.get('Bolt.001')?.parent ?? {}) === 'Base Plate', 'GLB keeps hierarchy: Bolt.001 under Base Plate');
  ok(realName(byName.get('Grandchild Grid')?.parent ?? {}) === 'Child Of Empty' && realName(byName.get('Child Of Empty')?.parent ?? {}) === 'Group Empty', 'GLB keeps 3-level hierarchy');
  // World-space vertex boxes match the viewer (converted Z-up -> Y-up like Blender's exporter).
  for (const o of visible.filter((x) => x.mesh)) {
    const node = byName.get(o.name);
    if (!node || !primitivesOf(node).length) { ok(false, `GLB node ${o.name} has mesh geometry`); continue; }
    // Compare the exported node's own world-space vertex box with the viewer's box for the object.
    const viewerBox = await page.evaluate((n) => window.__blendViewer.worldBox(n), o.name);
    const exp = new THREE.Box3(new THREE.Vector3(...viewerBox.min), new THREE.Vector3(...viewerBox.max)).applyMatrix4(C);
    const got = ownBox(node);
    ok(got.min.distanceTo(exp.min) < 1e-3 && got.max.distanceTo(exp.max) < 1e-3, `GLB ${o.name} world box ${got.min.toArray()} vs ${exp.min.toArray()}`);
  }
  const instanceNodes = [];
  gltf.scene.traverse((o) => { if (o.userData?.instanceOf) instanceNodes.push(`${realName(o.parent)}/${realName(o)}`); });
  if (c.gt.instances) ok(instanceNodes.sort().join() === 'Fasteners Instance/Bolt.001,Fasteners Instance/Bolt.002', `GLB instances ${instanceNodes}`);

  const stl = await page.evaluate(() => window.__blendViewer.exportBase64('stl-visible'));
  const sb = Buffer.from(stl.base64, 'base64');
  const tris = sb.readUInt32LE(80);
  const expected = await page.evaluate(() => window.__blendViewer.visibleTriangles());
  ok(tris === expected && sb.length === 84 + tris * 50, `STL visible: ${tris} triangles (expected ${expected})`);
  const one = await page.evaluate(() => window.__blendViewer.exportBase64('stl-selected'));
  ok(Buffer.from(one.base64, 'base64').readUInt32LE(80) === c.gt.objects.Knob.ntris, `STL selected (Knob): ${c.gt.objects.Knob.ntris} triangles`);
}

// -------------------------------------------------------------- big file
async function checkBig(page, path) {
  await page.evaluate(() => {
    const hb = (window.__hb = { max: 0, last: performance.now(), samples: 0, over100: 0 });
    hb.timer = setInterval(() => {
      const now = performance.now(), gap = now - hb.last - 20;
      if (gap > hb.max) hb.max = gap;
      if (gap > 100) { hb.over100++; (hb.stalls ??= []).push([Math.round(hb.last), Math.round(gap)]); }
      hb.last = now; hb.samples++;
    }, 20);
  });
  const t0 = Date.now();
  await loadFile(page, path, 300_000, { light: true });
  const wall = Date.now() - t0;
  // Stop the stall timer before reading the full (large) state, which is test overhead.
  const hb = await page.evaluate(() => { clearInterval(window.__hb.timer); return window.__hb; });
  const s = await state(page);
  ok(!s.lastError, `big file loads (${s.lastError ?? 'ok'})`);
  log(`    big file: ${s.objects.length} objects, ${s.status}`);
  log(`    wall ${wall} ms, parse (worker) ${Math.round(s.timings.parseMs)} ms, scene build ${Math.round(s.timings.buildMs)} ms, worker=${s.timings.usedWorker}`);
  log(`    longest main-thread stall during load: ${Math.round(hb.max)} ms; stalls over 100 ms: ${hb.over100} of ${hb.samples} samples`);
  const ph = s.timings.phases;
  if (ph && hb.stalls?.length) {
    const rel = (x) => Math.round(x - ph.start);
    log(`    phases (ms): received ${rel(ph.received)}, 3D view ${rel(ph.viewBuilt)}, outliner ${rel(ph.treeBuilt)}, info ${rel(ph.infoBuilt)}; stalls [start, ms]: ${JSON.stringify(hb.stalls.map(([t, g]) => [rel(t), g]))}`);
  }
  ok(s.timings.usedWorker, 'big file parsed in the worker');
  const software = /swiftshader|llvmpipe|softpipe/i.test(s.glRenderer);
  if (software) log(`    note: software WebGL (${s.glRenderer}); the stall limit is not checked`);
  else ok(hb.max < STALL_LIMIT_MS, `big file: longest main-thread stall ${Math.round(hb.max)} ms is under ${STALL_LIMIT_MS} ms`);
  return { stall: hb.max, wall };
}

// ------------------------------------------------------------------ main
async function main() {
  if (!existsSync(DIST)) { console.error(`Missing ${DIST}. Run "npm run build" first.`); process.exit(2); }
  mkdirSync(OUT, { recursive: true });
  const cases = loadCases();
  log(`Test files: ${cases.length} in ${TEST_FILES}`);
  let bigPath = process.env.BIG_BLEND ?? null;
  let bigTmp = null;
  if (!bigPath && argv.has('--big')) {
    bigTmp = mkdtempSync(join(tmpdir(), 'blend-big-'));
    bigPath = join(bigTmp, 'big200.blend');
    log('Generating a ~200 MB test file (needs python3 with numpy)...');
    execFileSync('python3', ['-I', join(ROOT, 'scripts', 'make-big-blend.py'), join(TEST_FILES, 'blender-5.3', 'test_uncompressed.blend'), bigPath, '--mb', '200'], { stdio: 'inherit' });
  }
  const browsers = findBrowsers();
  if (!browsers.length) { console.error('No browsers found.'); process.exit(2); }
  const summary = [];
  try {
    for (const b of browsers) {
      log(`\n== ${b.name} (${b.label}) ==`);
      const userDataDir = mkdtempSync(join(tmpdir(), `bv-${b.name}-`));
      const browser = await puppeteer.launch({ headless: !HEADFUL, userDataDir, ...b.opts });
      try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1400, height: 900 });
        const errors = [], requests = [];
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
        page.on('request', (r) => requests.push(r.url()));
        try { await page.setOfflineMode(true); } catch { /* not supported over WebDriver BiDi */ }
        await page.goto(pathToFileURL(DIST).href);
        await page.waitForFunction(() => !!window.__blendViewer, { timeout: 15_000 });
        log(`  WebGL: ${(await state(page)).glRenderer}`);
        // A file that is not a .blend gives a clear message and no crash.
        const bad = join(tmpdir(), 'not-a-blend.blend');
        writeFileSync(bad, 'this is not a blend file');
        const badState = await loadFile(page, bad);
        ok(/not a \.blend file/.test(badState.lastError ?? '') && /not a \.blend file/.test(badState.banner ?? ''), `non-.blend file gives a clear message (${badState.lastError})`);
        rmSync(bad, { force: true });
        const before = failures;
        for (const c of cases) {
          const f0 = failures;
          await checkFile(page, c, b.name);
          log(`  ${failures === f0 ? 'ok  ' : 'FAIL'} ${c.dir}/${c.file}`);
        }
        const main = cases.find((c) => c.gt.objects['Base Plate'] && c.dir === 'blender-5.3') ?? cases.find((c) => c.gt.objects['Base Plate']);
        if (main) {
          await loadFile(page, main.path);
          const f0 = failures;
          await checkExport(page, main, b.name);
          log(`  ${failures === f0 ? 'ok  ' : 'FAIL'} export GLB/STL (${main.dir})`);
        }
        let big = null;
        if (bigPath) {
          const f0 = failures;
          big = await checkBig(page, bigPath);
          log(`  ${failures === f0 ? 'ok  ' : 'FAIL'} big file`);
          await page.screenshot({ path: join(OUT, `${b.name}-big.png`) });
        }
        const external = requests.filter((u) => !/^(file|blob|data):/.test(u));
        ok(external.length === 0, `no network requests (saw ${external.slice(0, 5)})`);
        ok(errors.length === 0, `no page errors (${errors.slice(0, 5).join(' | ')})`);
        summary.push({ browser: b.name, failures: failures - before, big });
      } finally {
        await browser.close();
        rmSync(userDataDir, { recursive: true, force: true });
      }
    }
  } finally {
    if (bigTmp) rmSync(bigTmp, { recursive: true, force: true });
  }
  log('\nSummary:');
  for (const s of summary) log(`  ${s.browser}: ${s.failures ? `${s.failures} failures` : 'all checks passed'}${s.big ? `, big file stall max ${Math.round(s.big.stall)} ms, load ${s.big.wall} ms` : ''}`);
  log(`${passes} checks passed, ${failures} failed. Screenshots and exports in ${OUT}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
