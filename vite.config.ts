import { defineConfig, type Plugin } from 'vitest/config';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * The built page needs no network at all. This Content-Security-Policy makes the
 * browser block any request that is not inline, blob: or data:, so an accidental
 * remote load fails loudly instead of silently needing the internet.
 * Build only: the dev server needs its own scripts and websocket.
 */
const offlineCsp = (): Plugin => ({
  name: 'offline-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace(
      '<meta charset="utf-8">',
      `<meta charset="utf-8">\n  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob: data:; worker-src blob: data:; style-src 'unsafe-inline'; img-src data: blob:; connect-src blob: data:">`,
    ),
});

export default defineConfig({
  // Relative base so the built file works when opened from file://.
  base: './',
  plugins: [offlineCsp(), viteSingleFile({ removeViteModuleLoader: true })],
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
    rollupOptions: { input: 'blend-viewer.html' },
  },
  worker: { format: 'iife' },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
  },
});
