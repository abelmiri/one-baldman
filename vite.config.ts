import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

// Precache the exact production build, including Rapier's WASM asset.
// A new worker waits for existing game windows to close before activating.
const offlineGame = () => ({
  name: 'offline-game',
  apply: 'build' as const,
  enforce: 'post' as const,
  generateBundle(_options: unknown, bundle: Record<string, { type: string; code?: string; source?: string | Uint8Array }>) {
    const publicFiles = ['favicon.svg', 'manifest.webmanifest', 'icons/icon-192.png',
      'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png']
    const files = [...Object.keys(bundle).filter(file => !file.endsWith('.map')), ...publicFiles]
    const hash = createHash('sha256')
    for (const file of Object.keys(bundle).sort()) {
      const entry = bundle[file]
      hash.update(file).update(entry.code ?? entry.source ?? '')
    }
    // Vite includes public assets in neither the bundle nor its hashes.
    for (const file of publicFiles) hash.update(readFileSync(new URL(`./public/${file}`, import.meta.url)))
    this.emitFile({ type: 'asset', fileName: 'sw.js', source: `
const PREFIX = 'coastal-city-';
const CACHE = PREFIX + '${hash.digest('hex').slice(0, 16)}';
const URLS = ${JSON.stringify(files)}.map(path => new URL(path, self.registration.scope).href);
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(URLS)));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(PREFIX) && name !== CACHE).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(caches.open(CACHE).then(async cache =>
      (await cache.match(new URL('index.html', self.registration.scope).href)) || fetch(event.request)));
  } else if (URLS.includes(url.href)) {
    // Same-origin build assets are identical across Origin headers (Vary: Origin).
    event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(event.request, { ignoreVary: true })) || fetch(event.request)));
  }
});
` })
  },
})

export default defineConfig({
  plugins: [react(), wasm(), offlineGame()],
  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three', 'three/addons/controls/OrbitControls.js', 'three/addons/geometries/RoundedBoxGeometry.js'],
          physics: ['@dimforge/rapier3d'],
        },
      },
    },
  },
  optimizeDeps: { exclude: ['@dimforge/rapier3d'] },
})
