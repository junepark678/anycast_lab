import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const serviceWorkerSource = fileURLToPath(new URL('./pwa/service-worker.js', import.meta.url));
const publicDirectory = new URL('./public/', import.meta.url);
const pwaPublicFiles = [
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-maskable.svg',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
] as const;

/**
 * Emit a versioned service worker without adding a PWA framework to the lab.
 * Vite's hashed output files become the exact app-shell precache list, while
 * the multi-megabyte native VM bundle in public/runtime remains network-only.
 */
function anycastLabPwa(): Plugin {
  return {
    name: 'anycast-lab-pwa',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const outputs = Object.values(bundle).sort((left, right) => left.fileName.localeCompare(right.fileName));
      const buildHash = createHash('sha256');
      const workerTemplate = readFileSync(serviceWorkerSource, 'utf8');

      buildHash.update(workerTemplate);
      for (const output of outputs) {
        buildHash.update(output.fileName);
        buildHash.update(output.type === 'chunk' ? output.code : output.source);
      }
      for (const fileName of pwaPublicFiles) {
        buildHash.update(fileName);
        buildHash.update(readFileSync(new URL(fileName, publicDirectory)));
      }

      const buildId = buildHash.digest('hex').slice(0, 16);
      const precacheFiles = [
        '',
        'index.html',
        ...pwaPublicFiles,
        ...outputs.map((output) => output.fileName),
      ].filter((fileName, index, files) => files.indexOf(fileName) === index);

      const worker = workerTemplate
        .replace('__ANYCAST_LAB_BUILD_ID__', buildId)
        .replace("JSON.parse('__ANYCAST_LAB_PRECACHE_URLS__')", JSON.stringify(precacheFiles));

      if (worker.includes('__ANYCAST_LAB_BUILD_ID__') || worker.includes('__ANYCAST_LAB_PRECACHE_URLS__')) {
        this.error('Failed to populate the Anycast Lab service worker template');
      }

      this.emitFile({ type: 'asset', fileName: 'sw.js', source: worker });
    },
  };
}

export default defineConfig({
  plugins: [react(), anycastLabPwa()],
  base: '/lab/',
  server: {
    // Buildroot expands hundreds of thousands of files beside the app. They
    // are runtime artifacts, never Vite inputs, and watching them can exhaust
    // the host's inotify limit while an appliance image is compiling.
    watch: { ignored: ['**/appliances/v86/.work/**', '**/appliances/v86/dist/**'] },
  },
  worker: { format: 'es' },
});
