import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * PWA scaffolding guard (§P1). The service worker + manifest are emitted by the
 * build (verified separately by `npm run build`), so jsdom can't exercise them.
 * What IS worth guarding here are the hand-maintained, security-relevant pieces
 * that a future edit could silently drop: the index.html head tags that
 * vite-plugin-pwa does NOT inject, and the SW's navigation denylist that keeps
 * authenticated (/api) and secret-token (/s) responses from ever being cached.
 * Mirrors the on-disk read pattern already used for tokens.css in shell.test.
 */

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = fs.readFileSync(path.join(WEB_ROOT, 'index.html'), 'utf-8');
const viteConfig = fs.readFileSync(path.join(WEB_ROOT, 'vite.config.ts'), 'utf-8');

describe('PWA — index.html head (§P1)', () => {
  test('links the iOS home-screen icon', () => {
    expect(indexHtml).toMatch(/rel="apple-touch-icon"\s+href="\/apple-touch-icon\.png"/);
  });

  test('declares a light + dark theme-color pair', () => {
    expect(indexHtml).toMatch(/name="theme-color"\s+content="#F4F5F3"\s+media="\(prefers-color-scheme:\s*light\)"/);
    expect(indexHtml).toMatch(/name="theme-color"\s+content="#12212F"\s+media="\(prefers-color-scheme:\s*dark\)"/);
  });

  test("carries no inline service-worker registration (would violate script-src 'self')", () => {
    // Registration is a bundled import in main.tsx (injectRegister:null), so the
    // HTML must never contain an inline `navigator.serviceWorker.register(...)`.
    expect(indexHtml).not.toMatch(/navigator\.serviceWorker/);
  });
});

describe('PWA — vite config (§P1, security-critical)', () => {
  test('the SW navigation fallback denylists /api and /s', () => {
    // Without these, the SW could serve a cached index.html for an /api or
    // /s/<token> navigation — leaking a stale shell for auth/secret paths.
    expect(viteConfig).toContain('navigateFallbackDenylist');
    expect(viteConfig).toContain('/^\\/api\\//');
    expect(viteConfig).toContain('/^\\/s\\//');
  });

  test('does not enable any runtimeCaching (nothing under /api or /s is ever cached)', () => {
    expect(viteConfig).not.toContain('runtimeCaching');
  });

  test('registration is a bundled import, not an injected inline script', () => {
    expect(viteConfig).toMatch(/injectRegister:\s*null/);
  });

  test('the manifest is Arabic, RTL, and standalone', () => {
    expect(viteConfig).toMatch(/dir:\s*'rtl'/);
    expect(viteConfig).toMatch(/lang:\s*'ar'/);
    expect(viteConfig).toMatch(/display:\s*'standalone'/);
  });
});
