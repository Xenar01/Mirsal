/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
