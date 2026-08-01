/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Installable PWA (§P1). Everything is self-hosted so the strict CSP
    // (`default-src 'self'`, `script-src 'self'`, no `unsafe-inline`; see
    // server/src/app.ts) holds: the manifest + `/sw.js` are same-origin (CSP's
    // `manifest-src`/`worker-src` fall back to `default-src`/`script-src` =
    // 'self'), and registration is a BUNDLED import (`virtual:pwa-register` in
    // main.tsx), never an injected inline script — hence `injectRegister: null`.
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: null,
      // Precache the icons/favicon that live in public/ (outside the JS module
      // graph) so the install + home-screen icon also work offline.
      includeAssets: [
        'favicon.svg',
        'apple-touch-icon.png',
        'icons/icon-192.png',
        'icons/icon-512.png',
        'icons/icon-maskable-512.png',
      ],
      manifest: {
        name: 'مِرسال',
        short_name: 'مِرسال',
        description: 'مِرسال — منصة مشاركة الملفات الآمنة',
        lang: 'ar',
        dir: 'rtl',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        background_color: '#F4F5F3',
        theme_color: '#12212F',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: '/icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // SPA history fallback for navigations — but NEVER for the API or the
        // public share pages: `/api/*` must always hit the network (auth), and
        // `/s/<token>` must reach the server for its `Referrer-Policy:
        // no-referrer` header + a fresh shell (the secret token must not be
        // served from a cached document).
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/s\//],
        // Precache the built same-origin assets only. Deliberately NO
        // run-time caching entries whatsoever: nothing under /api or /s is ever
        // cached (session cookies + secret share tokens must not be persisted
        // by the SW).
        globPatterns: ['**/*.{js,css,html,svg,png,woff,woff2}'],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  build: {
    // Vite's default modulepreload polyfill is injected as an inline
    // `<script>` with a body, which would violate the server's strict CSP
    // (`script-src 'self'`, no `unsafe-inline`, no nonce — see
    // server/src/app.ts). The target browsers support native modulepreload,
    // so the polyfill is unnecessary; disabling it keeps every emitted
    // `<script>` tag an external `type="module" src="...">` reference.
    modulePreload: { polyfill: false },
    // Vite's default assetsInlineLimit (4KB) base64-inlines small assets as
    // `data:` URIs directly in the built CSS. Several of the @fontsource
    // woff/woff2 files (narrow Unicode-range subsets) fall under that
    // threshold, which would inline them as `url(data:font/woff2;...)` in
    // index.css — but the server's CSP is `font-src 'self'` (no `data:`),
    // so the browser would silently block exactly those font faces. Setting
    // this to 0 forces every asset, fonts included, to be emitted as its
    // own hashed same-origin file under `dist/assets/`.
    assetsInlineLimit: 0,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
  },
});
