import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { buildApp, findServerRoot } from '../src/app.js';

let db: Database.Database | undefined;
let dir: string | undefined;
let distDir: string | undefined;
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  db?.close();
  db = undefined;
  if (dir) {
    fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
  if (distDir) {
    fs.rmSync(distDir, { recursive: true, force: true });
    distDir = undefined;
  }
});

/**
 * `webDist` lets a test point the SPA-shell root at a throwaway temp dir it
 * controls, so the `distExists` branch of the not-found handler is exercised
 * deterministically — without depending on a real `web` build (the gitignored
 * `web/dist`) being present (or absent) on disk during server tests.
 */
async function makeApp(opts: { webDist?: string } = {}): Promise<FastifyInstance> {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-h1-'));
  const dbPath = path.join(dir, 't.db');
  db = openDb(dbPath);
  migrate(db);

  const config = loadConfig({
    DB_PATH: dbPath,
    STORAGE_DIR: path.join(dir, 'storage'),
    SESSION_SECRET: 'a-test-session-secret-16+',
    CSRF_SECRET: 'a-test-csrf-secret-16chars+',
    PUBLIC_BASE_URL: 'https://mirsal.example.test',
  });

  const built = await buildApp({ db, config, now: () => 1_700_000_000_000, webDist: opts.webDist });
  app = built;
  return built;
}

/** A throwaway `web/dist` containing a recognizable `index.html`, cleaned up in afterEach. */
const SPA_MARKER = '<!doctype html><title>mirsal-spa-shell</title>';
function makeDistDir(): string {
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-h1-dist-'));
  fs.writeFileSync(path.join(distDir, 'index.html'), SPA_MARKER);
  return distDir;
}

test('GET /api/health returns 200 {ok:true}', async () => {
  const built = await makeApp();

  const res = await built.inject({ method: 'GET', url: '/api/health' });

  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
});

test('response carries nosniff and a strict CSP header', async () => {
  const built = await makeApp();

  const res = await built.inject({ method: 'GET', url: '/api/health' });

  expect(res.headers['x-content-type-options']).toBe('nosniff');
  const csp = res.headers['content-security-policy'];
  expect(csp).toBeDefined();
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
});

test('GET /api/does-not-exist returns a JSON 404, not HTML', async () => {
  const built = await makeApp();

  const res = await built.inject({ method: 'GET', url: '/api/does-not-exist' });

  expect(res.statusCode).toBe(404);
  expect(res.headers['content-type']).toContain('application/json');
  const body = res.json();
  expect(body).toHaveProperty('error');
});

// `trustProxy` must be bounded to the one real proxy in front of this app
// (host nginx, reverse-proxying from 127.0.0.1) rather than `true` (which
// would trust the WHOLE X-Forwarded-For chain, letting any client spoof
// `req.ip` — the login rate-limiter's key, see routes/auth.ts — by simply
// setting the header themselves). These assert the actual `req.ip`
// resolution Fastify derives via `@fastify/proxy-addr`, using a throwaway
// route (this app has no route that echoes `req.ip` otherwise).
test('req.ip ignores a spoofed X-Forwarded-For from a non-loopback (untrusted) connection', async () => {
  const built = await makeApp();
  built.get('/__whoami', async (req) => ({ ip: req.ip }));

  const res = await built.inject({
    method: 'GET',
    url: '/__whoami',
    remoteAddress: '203.0.113.50', // a real, non-loopback peer — not our nginx
    headers: { 'x-forwarded-for': '9.9.9.9' }, // attacker-supplied, must be ignored
  });

  expect(res.json()).toEqual({ ip: '203.0.113.50' });
});

test('req.ip honors X-Forwarded-For appended by a loopback proxy (the real nginx setup)', async () => {
  const built = await makeApp();
  built.get('/__whoami', async (req) => ({ ip: req.ip }));

  const res = await built.inject({
    method: 'GET',
    url: '/__whoami',
    remoteAddress: '127.0.0.1', // our nginx, on loopback
    headers: { 'x-forwarded-for': '198.51.100.7' }, // the real client, as nginx reported it
  });

  expect(res.json()).toEqual({ ip: '198.51.100.7' });
});

test('req.ip ignores an attacker-prepended hop even when arriving via the trusted loopback proxy', async () => {
  const built = await makeApp();
  built.get('/__whoami', async (req) => ({ ip: req.ip }));

  const res = await built.inject({
    method: 'GET',
    url: '/__whoami',
    remoteAddress: '127.0.0.1',
    // The client sent their own fake `X-Forwarded-For: evil-fake-ip` value;
    // nginx appends the real peer address it saw, producing this 2-entry
    // chain. Only the entry nginx itself appended (closest to the trusted
    // hop) may be trusted — the attacker-supplied one further out must not.
    headers: { 'x-forwarded-for': 'evil-fake-ip, 198.51.100.7' },
  });

  expect(res.json()).toEqual({ ip: '198.51.100.7' });
});

// findServerRoot backs WEB_DIST's resolution of `web/dist`. It must find the
// same package root regardless of how many directory levels deep the calling
// module happens to live — e.g. `server/src/app.ts` (source, one level under
// the server root) vs. a `tsc`-compiled `server/dist/src/app.js` (two levels
// under the server root, per this project's own `rootDir: "."` / `outDir:
// "dist"` tsconfig). A hard-coded number of `..` hops breaks the second case
// silently; searching upward for the nearest `package.json` does not.
test('findServerRoot locates the package root from a source-depth path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-h1-root-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    const srcDir = path.join(root, 'src');
    fs.mkdirSync(srcDir);

    expect(findServerRoot(srcDir)).toBe(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findServerRoot locates the package root from a compiled dist/src-depth path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-h1-root-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    const distSrcDir = path.join(root, 'dist', 'src');
    fs.mkdirSync(distSrcDir, { recursive: true });

    expect(findServerRoot(distSrcDir)).toBe(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── §3.5: the public share page shell at /s/<token> ──────────────────────
// GET /s/<token> must serve the SPA shell (index.html) so the React public
// page is reachable at its own URL, and that HTML document must carry
// `Referrer-Policy: no-referrer` so the secret token never leaks via a
// `Referer` header on outbound navigations from the page.

test('GET /s/<token> (dist present) -> 200 HTML shell with Referrer-Policy: no-referrer', async () => {
  const built = await makeApp({ webDist: makeDistDir() });

  const res = await built.inject({ method: 'GET', url: '/s/anytoken123' });

  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toMatch(/text\/html/);
  expect(res.headers['referrer-policy']).toBe('no-referrer');
  expect(res.body).toBe(SPA_MARKER);
});

test('GET /c/<token> (dist present) -> 200 HTML shell with Referrer-Policy: no-referrer', async () => {
  const built = await makeApp({ webDist: makeDistDir() });

  const res = await built.inject({ method: 'GET', url: '/c/anycollecttoken123' });

  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toMatch(/text\/html/);
  expect(res.headers['referrer-policy']).toBe('no-referrer');
  expect(res.body).toBe(SPA_MARKER);
});

test('GET /s/<token> (dist ABSENT) -> JSON 404 (unchanged fallback when the SPA is not built)', async () => {
  // Point at a non-existent dist dir so `distExists` is false — as it is on a
  // box where the frontend was never built.
  const built = await makeApp({ webDist: path.join(os.tmpdir(), 'mirsal-h1-nope-does-not-exist') });

  const res = await built.inject({ method: 'GET', url: '/s/anytoken123' });

  expect(res.statusCode).toBe(404);
  expect(res.headers['content-type']).toContain('application/json');
  expect(res.json()).toHaveProperty('error');
});

test('regression: an unknown non-/s/ GET (dist present) still serves index.html (the SPA shell)', async () => {
  const built = await makeApp({ webDist: makeDistDir() });

  const res = await built.inject({ method: 'GET', url: '/some/spa/route' });

  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toMatch(/text\/html/);
  expect(res.body).toBe(SPA_MARKER);
  // NOTE: `@fastify/helmet` already applies `Referrer-Policy: no-referrer`
  // GLOBALLY (verified on /api/health), so the header is present on every
  // response, not just /s/*. The /s/* branch sets it explicitly anyway (per
  // spec §3.5, and to stay correct independent of helmet's defaults); it is
  // therefore not a distinguishing signal between /s/* and other GETs.
  expect(res.headers['referrer-policy']).toBe('no-referrer');
});

test('regression: /api/does-not-exist stays a JSON 404 even with the SPA built (never the shell)', async () => {
  const built = await makeApp({ webDist: makeDistDir() });

  const res = await built.inject({ method: 'GET', url: '/api/does-not-exist' });

  expect(res.statusCode).toBe(404);
  expect(res.headers['content-type']).toContain('application/json');
  expect(res.json()).toHaveProperty('error');
});
