import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { loadConfig } from '../../src/config.js';
import { buildApp } from '../../src/app.js';
import { createPasswordService } from '../../src/auth/passwords.js';

const NOW = 1_700_000_000_000;
const clock = () => NOW;
const TEST_ARGON = { ARGON_MEMORY_KIB: 19456, ARGON_TIME: 2, ARGON_PARALLELISM: 1, ARGON_MAX_CONCURRENCY: 2 };
const PUBLIC_BASE_URL = 'https://mirsal.example.test';

interface InjectedCookie {
  name: string;
  value: string;
}

let db: Database.Database | undefined;
let dir: string | undefined;
let app: FastifyInstance | undefined;

const keys = ['DB_PATH', 'STORAGE_DIR', 'SESSION_SECRET', 'CSRF_SECRET', 'PUBLIC_BASE_URL'] as const;
const originals: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of keys) originals[k] = process.env[k];
  process.env.DB_PATH = '/tmp/mirsal-collect-test/db.sqlite';
  process.env.STORAGE_DIR = '/tmp/mirsal-collect-test/storage';
  process.env.SESSION_SECRET = 'a'.repeat(32);
  process.env.CSRF_SECRET = 'b'.repeat(32);
  process.env.PUBLIC_BASE_URL = PUBLIC_BASE_URL;
});
afterAll(() => {
  for (const k of keys) {
    if (originals[k] === undefined) delete process.env[k];
    else process.env[k] = originals[k];
  }
});
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-collect-'));
  const dbPath = path.join(dir, 't.db');
  const storageDir = path.join(dir, 'storage');
  db = openDb(dbPath);
  migrate(db);
  const config = loadConfig({
    DB_PATH: dbPath,
    STORAGE_DIR: storageDir,
    SESSION_SECRET: 'a-test-session-secret-16+',
    CSRF_SECRET: 'a-test-csrf-secret-16chars+',
    PUBLIC_BASE_URL,
  });
  app = await buildApp({ db, config, now: clock });
  return app;
}

async function seedUser(username: string, quotaBytes: number | null = null): Promise<number> {
  const hash = await createPasswordService(TEST_ARGON).hashPassword('pw');
  const info = db!
    .prepare(
      `INSERT INTO users(username,password_hash,role,is_active,must_change_password,quota_bytes,created_at,updated_at)
       VALUES (?, ?, 'user', 1, 0, ?, ?, ?)`
    )
    .run(username, hash, quotaBytes, NOW, NOW);
  return Number(info.lastInsertRowid);
}
function findCookie(cookies: InjectedCookie[], name: string) {
  return cookies.find((c) => c.name === name);
}
async function login(built: FastifyInstance, username: string): Promise<{ session: string; csrf: string }> {
  const res = await built.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'pw' } });
  return {
    session: findCookie(res.cookies as InjectedCookie[], 'mirsal_session')!.value,
    csrf: findCookie(res.cookies as InjectedCookie[], 'mirsal_csrf')!.value,
  };
}
/** Owner-creates a collection via the Phase-1 owner API; returns its detail DTO. */
async function makeCollection(
  built: FastifyInstance,
  session: string,
  csrf: string,
  payload: Record<string, unknown>
) {
  const res = await built.inject({
    method: 'POST',
    url: '/api/collections',
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload,
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

// ── meta ──────────────────────────────────────────────────────────────────
test('GET meta unknown token -> 404, with no-store + no-referrer', async () => {
  const built = await makeApp();
  const res = await built.inject({ method: 'GET', url: '/api/collect/does-not-exist' });
  expect(res.statusCode).toBe(404);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.headers['referrer-policy']).toBe('no-referrer');
});

test('GET meta open, no password -> title + departments + isOpen', async () => {
  const built = await makeApp();
  await seedUser('alice');
  const { session, csrf } = await login(built, 'alice');
  const c = await makeCollection(built, session, csrf, { title: 'Q1 census', departments: ['HR', 'Finance'] });

  const res = await built.inject({ method: 'GET', url: `/api/collect/${c.token}` });
  expect(res.statusCode).toBe(200);
  const meta = res.json();
  expect(meta).toMatchObject({ isOpen: true, needsPassword: false, title: 'Q1 census', hasTemplate: false });
  expect(meta.departments.map((d: any) => d.name)).toEqual(['HR', 'Finance']);
  expect(meta.departments.every((d: any) => typeof d.id === 'number')).toBe(true);
  // Never leaks response status / owner.
  expect(JSON.stringify(meta)).not.toContain('owner');
  expect(JSON.stringify(meta)).not.toContain('responded');
});

test('GET meta closed -> {isOpen:false}, nothing else', async () => {
  const built = await makeApp();
  await seedUser('alice');
  const { session, csrf } = await login(built, 'alice');
  const c = await makeCollection(built, session, csrf, { title: 'T', departments: ['A'] });
  await built.inject({
    method: 'PATCH',
    url: `/api/collections/${c.id}`,
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { is_active: false },
  });
  const res = await built.inject({ method: 'GET', url: `/api/collect/${c.token}` });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ isOpen: false });
});

test('GET meta open + password + no cookie -> {isOpen:true, needsPassword:true} (title/departments withheld)', async () => {
  const built = await makeApp();
  await seedUser('alice');
  const { session, csrf } = await login(built, 'alice');
  const c = await makeCollection(built, session, csrf, { title: 'Secret', departments: ['A'], password: 'hunter2' });
  const res = await built.inject({ method: 'GET', url: `/api/collect/${c.token}` });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ isOpen: true, needsPassword: true });
});

// ── unlock ──────────────────────────────────────────────────────────────────
test('POST unlock: wrong pw -> 401 + audit; correct pw -> 200 + cookie; meta then reveals full', async () => {
  const built = await makeApp();
  await seedUser('alice');
  const { session, csrf } = await login(built, 'alice');
  const c = await makeCollection(built, session, csrf, { title: 'Secret', departments: ['A', 'B'], password: 'hunter2' });

  const wrong = await built.inject({ method: 'POST', url: `/api/collect/${c.token}/unlock`, payload: { password: 'nope' } });
  expect(wrong.statusCode).toBe(401);
  expect(wrong.json()).toMatchObject({ error: 'invalid_password' });
  const audit = db!.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='collection_unlock_failure'").get() as { n: number };
  expect(audit.n).toBe(1);

  const ok = await built.inject({ method: 'POST', url: `/api/collect/${c.token}/unlock`, payload: { password: 'hunter2' } });
  expect(ok.statusCode).toBe(200);
  const setCookie = (ok.cookies as InjectedCookie[]).find((k) => k.name === 'mirsal_collect_unlock');
  expect(setCookie).toBeDefined();

  const meta = await built.inject({
    method: 'GET',
    url: `/api/collect/${c.token}`,
    cookies: { mirsal_collect_unlock: setCookie!.value },
  });
  expect(meta.json()).toMatchObject({ isOpen: true, needsPassword: true, title: 'Secret' });
  expect(meta.json().departments.map((d: any) => d.name)).toEqual(['A', 'B']);
});

test('POST unlock: no-password collection -> 400 no_password; closed -> 404; bad body -> 400', async () => {
  const built = await makeApp();
  await seedUser('alice');
  const { session, csrf } = await login(built, 'alice');
  const open = await makeCollection(built, session, csrf, { title: 'T', departments: ['A'] });
  expect((await built.inject({ method: 'POST', url: `/api/collect/${open.token}/unlock`, payload: { password: 'x' } })).statusCode).toBe(400);
  expect((await built.inject({ method: 'POST', url: `/api/collect/${open.token}/unlock`, payload: {} })).statusCode).toBe(400);

  const withPw = await makeCollection(built, session, csrf, { title: 'P', departments: ['A'], password: 'pw2' });
  await built.inject({
    method: 'PATCH',
    url: `/api/collections/${withPw.id}`,
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { is_active: false },
  });
  expect((await built.inject({ method: 'POST', url: `/api/collect/${withPw.token}/unlock`, payload: { password: 'pw2' } })).statusCode).toBe(404);
});
