/**
 * Takes the README screenshot: opens dist/blend-viewer.html in a Chromium-based
 * browser, loads a test file, selects one object and saves a PNG.
 *
 * Usage:  npm run build && npm run screenshot [-- file.blend out.png "object name"]
 * Env:    CHROMIUM_BIN, CHROMIUM_SOFTWARE=1 (see scripts/browser-test.mjs)
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist', 'blend-viewer.html');
const [file = join(ROOT, 'blend-viewer-handoff', 'test-files', 'blender-5.3', 'test_compressed.blend'),
  out = join(ROOT, 'docs', 'screenshot.png'), select = 'Knob'] = process.argv.slice(2);

const bin = [process.env.CHROMIUM_BIN, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome', '/usr/bin/brave', '/usr/bin/brave-browser'].find((p) => p && existsSync(p));
if (!bin) { console.error('No Chromium-based browser found. Set CHROMIUM_BIN.'); process.exit(2); }
if (!existsSync(DIST)) { console.error('dist/blend-viewer.html is missing. Run npm run build first.'); process.exit(2); }
const gpu = !process.env.CHROMIUM_SOFTWARE && existsSync('/dev/dri') && readdirSync('/dev/dri').some((f) => f.startsWith('renderD'));
const gl = gpu ? ['--enable-gpu', '--use-angle=gl-egl', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

const userDataDir = mkdtempSync(join(tmpdir(), 'bv-shot-'));
const browser = await puppeteer.launch({ headless: true, userDataDir, executablePath: bin, args: [...gl, '--no-first-run'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 760, deviceScaleFactor: 2 });
  await page.goto(pathToFileURL(DIST).href);
  await page.waitForFunction(() => !!window.__blendViewer, { timeout: 15_000 });
  await (await page.$('#file-input')).uploadFile(resolve(file));
  await page.waitForFunction(() => { const s = window.__blendViewer.status(); return s.loaded || s.lastError; }, { timeout: 60_000, polling: 100 });
  const err = await page.evaluate(() => window.__blendViewer.status().lastError);
  if (err) throw new Error(err);

  // Hide the note bar, select one object, and fill the view with the scene.
  await page.evaluate(() => { document.getElementById('banner').hidden = true; window.dispatchEvent(new Event('resize')); });
  if (select && !(await page.evaluate((n) => window.__blendViewer.selectByName(n), select))) console.warn(`No object named "${select}".`);
  await page.evaluate(() => window.__blendViewer.frame());
  const box = await (await page.$('#viewport')).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 3; i++) { await page.mouse.wheel({ deltaY: -100 }); await new Promise((r) => setTimeout(r, 80)); }
  await page.evaluate(() => window.__blendViewer.renderNow());
  await new Promise((r) => setTimeout(r, 400));

  mkdirSync(dirname(out), { recursive: true });
  await page.screenshot({ path: out });
  console.log(`Saved ${out}`);
} finally {
  await browser.close();
  rmSync(userDataDir, { recursive: true, force: true });
}
