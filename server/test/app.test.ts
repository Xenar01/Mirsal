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
});

async function makeApp(): Promise<FastifyInstance> {
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

  const built = await buildApp({ db, config, now: () => 1_700_000_000_000 });
  app = built;
  return built;
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
