import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';

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
