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
import { ensureUserRoots } from '../../src/nodes/tree.js';

const NOW = 1_700_000_000_000;
const clock = () => NOW;

const TEST_ARGON = {
  ARGON_MEMORY_KIB: 19456,
  ARGON_TIME: 2,
  ARGON_PARALLELISM: 1,
  ARGON_MAX_CONCURRENCY: 2,
};

const PUBLIC_BASE_URL = 'https://mirsal.example.test';

interface InjectedCookie {
  name: string;
  value: string;
}

let db: Database.Database | undefined;
let dir: string | undefined;
let app: FastifyInstance | undefined;

// createShare/setShareState hash passwords through the *bare* hashPassword
// export, which is bound to a default service built from loadConfig() on first
// use — so these env vars must be present. Mirrors test/shares/shares.test.ts.
const keys = ['DB_PATH', 'STORAGE_DIR', 'SESSION_SECRET', 'CSRF_SECRET', 'PUBLIC_BASE_URL'] as const;
const originals: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const key of keys) originals[key] = process.env[key];
  process.env.DB_PATH = '/tmp/mirsal-test/db.sqlite';
  process.env.STORAGE_DIR = '/tmp/mirsal-test/storage';
  process.env.SESSION_SECRET = 'a'.repeat(32);
  process.env.CSRF_SECRET = 'b'.repeat(32);
  process.env.PUBLIC_BASE_URL = PUBLIC_BASE_URL;
});

afterAll(() => {
  for (const key of keys) {
    if (originals[key] === undefined) delete process.env[key];
    else process.env[key] = originals[key];
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-h4-shares-'));
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

async function seedUser(username: string, password: string): Promise<number> {
  const passwordService = createPasswordService(TEST_ARGON);
  const hash = await passwordService.hashPassword(password);
  const info = db!
    .prepare(
      `INSERT INTO users(username, password_hash, role, is_active, must_change_password, quota_bytes, created_at, updated_at)
       VALUES (?, ?, 'user', 1, 0, NULL, ?, ?)`
    )
    .run(username, hash, NOW, NOW);
  return Number(info.lastInsertRowid);
}

function findCookie(cookies: InjectedCookie[], name: string): InjectedCookie | undefined {
  return cookies.find((c) => c.name === name);
}

async function login(built: FastifyInstance, username: string, password: string): Promise<{ session: string; csrf: string }> {
  const res = await built.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  const session = findCookie(res.cookies as InjectedCookie[], 'mirsal_session')!.value;
  const csrf = findCookie(res.cookies as InjectedCookie[], 'mirsal_csrf')!.value;
  return { session, csrf };
}

function rootIdFor(uid: number): number {
  return ensureUserRoots(db!, uid, NOW).rootId;
}

function trashIdFor(uid: number): number {
  return ensureUserRoots(db!, uid, NOW).trashId;
}

async function makeFolder(built: FastifyInstance, session: string, csrf: string, parentId: number, name: string): Promise<any> {
  const res = await built.inject({
    method: 'POST',
    url: '/api/nodes/folder',
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { parent_id: parentId, name },
  });
  return res.json();
}

// ---------------------------------------------------------------------------

test('POST /api/shares on a folder -> 201 with public url + active status; GET lists it; password never echoed', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);
  const folder = await makeFolder(built, session, csrf, rootId, 'Shared');

  const createRes = await built.inject({
    method: 'POST',
    url: '/api/shares',
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { node_id: folder.id, password: 'secret-pw' },
  });
  expect(createRes.statusCode).toBe(201);
  const share = createRes.json();
  expect(share.node_id).toBe(folder.id);
  expect(share.status).toBe('active');
  expect(typeof share.token).toBe('string');
  expect(share.url).toBe(`${PUBLIC_BASE_URL}/s/${share.token}`);
  // Password must never be echoed back, in any form.
  expect(JSON.stringify(share)).not.toContain('secret-pw');
  expect(share).not.toHaveProperty('password_hash');
  expect(share.has_password).toBe(true);

  const listRes = await built.inject({ method: 'GET', url: '/api/shares', cookies: { mirsal_session: session } });
  expect(listRes.statusCode).toBe(200);
  const list = listRes.json() as Array<{ id: number; url: string; status: string }>;
  expect(list.some((s) => s.id === share.id && s.status === 'active' && s.url.endsWith(`/s/${share.token}`))).toBe(true);
});

test('POST /api/shares refuses the synthetic root node -> 400 unshareable', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);

  const res = await built.inject({
    method: 'POST',
    url: '/api/shares',
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { node_id: rootId },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toMatchObject({ code: 'unshareable' });

  // No share row was created.
  const count = db!.prepare('SELECT COUNT(*) AS c FROM shares').get() as { c: number };
  expect(count.c).toBe(0);
});

test('POST /api/shares refuses the synthetic trash node -> 400 unshareable', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const trashId = trashIdFor(uid);

  const res = await built.inject({
    method: 'POST',
    url: '/api/shares',
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { node_id: trashId },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toMatchObject({ code: 'unshareable' });
});

test('PATCH is_active:false -> status stopped; PATCH expires_at past -> status expired', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);
  const folder = await makeFolder(built, session, csrf, rootId, 'Lifecycle');

  const share = (
    await built.inject({
      method: 'POST',
      url: '/api/shares',
      cookies: { mirsal_session: session },
      headers: { 'x-csrf-token': csrf },
      payload: { node_id: folder.id },
    })
  ).json();

  const stopRes = await built.inject({
    method: 'PATCH',
    url: `/api/shares/${share.id}`,
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { is_active: false },
  });
  expect(stopRes.statusCode).toBe(200);
  expect(stopRes.json()).toMatchObject({ status: 'stopped' });

  // Re-activate + set a past expiry -> expired.
  const expireRes = await built.inject({
    method: 'PATCH',
    url: `/api/shares/${share.id}`,
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { is_active: true, expires_at: NOW - 1000 },
  });
  expect(expireRes.statusCode).toBe(200);
  expect(expireRes.json()).toMatchObject({ status: 'expired' });
});

test('DELETE /api/shares/:id revokes it; a second DELETE -> 404', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);
  const folder = await makeFolder(built, session, csrf, rootId, 'Doomed');

  const share = (
    await built.inject({
      method: 'POST',
      url: '/api/shares',
      cookies: { mirsal_session: session },
      headers: { 'x-csrf-token': csrf },
      payload: { node_id: folder.id },
    })
  ).json();

  const delRes = await built.inject({
    method: 'DELETE',
    url: `/api/shares/${share.id}`,
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
  });
  expect(delRes.statusCode).toBe(200);

  const list = (
    await built.inject({ method: 'GET', url: '/api/shares', cookies: { mirsal_session: session } })
  ).json() as Array<{ id: number }>;
  expect(list.some((s) => s.id === share.id)).toBe(false);

  const delAgain = await built.inject({
    method: 'DELETE',
    url: `/api/shares/${share.id}`,
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
  });
  expect(delAgain.statusCode).toBe(404);
});

test('a share owned by another user cannot be patched or deleted -> 404 (owner-scoped)', async () => {
  const built = await makeApp();
  const uidA = await seedUser('alice', 'pw');
  await seedUser('bob', 'pw');
  const a = await login(built, 'alice', 'pw');
  const b = await login(built, 'bob', 'pw');
  const rootA = rootIdFor(uidA);
  const folder = await makeFolder(built, a.session, a.csrf, rootA, 'AliceOnly');

  const share = (
    await built.inject({
      method: 'POST',
      url: '/api/shares',
      cookies: { mirsal_session: a.session },
      headers: { 'x-csrf-token': a.csrf },
      payload: { node_id: folder.id },
    })
  ).json();

  const patchRes = await built.inject({
    method: 'PATCH',
    url: `/api/shares/${share.id}`,
    cookies: { mirsal_session: b.session },
    headers: { 'x-csrf-token': b.csrf },
    payload: { is_active: false },
  });
  expect(patchRes.statusCode).toBe(404);

  const delRes = await built.inject({
    method: 'DELETE',
    url: `/api/shares/${share.id}`,
    cookies: { mirsal_session: b.session },
    headers: { 'x-csrf-token': b.csrf },
  });
  expect(delRes.statusCode).toBe(404);

  // Alice's share is untouched.
  const stillThere = db!.prepare('SELECT is_active FROM shares WHERE id = ?').get(share.id) as { is_active: number };
  expect(stillThere.is_active).toBe(1);
});

test('POST /api/shares requires auth -> 401 without a session', async () => {
  const built = await makeApp();
  const res = await built.inject({ method: 'POST', url: '/api/shares', payload: { node_id: 1 } });
  expect(res.statusCode).toBe(401);
});

test('PATCH password:"" is rejected (400), never hashed into an unrecoverable password', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);
  const folder = await makeFolder(built, session, csrf, rootId, 'NoLockout');

  const share = (
    await built.inject({
      method: 'POST',
      url: '/api/shares',
      cookies: { mirsal_session: session },
      headers: { 'x-csrf-token': csrf },
      payload: { node_id: folder.id },
    })
  ).json();
  expect(share.has_password).toBe(false);

  // '' is a "set" value per the tri-state schema (only `null` clears), and
  // setShareState hashes whatever string it's given — so accepting '' here
  // would store a real password_hash for an empty password. /unlock's schema
  // requires a non-empty password, so that hash could never be resubmitted:
  // the share would be permanently locked. The schema must reject it instead.
  const patchRes = await built.inject({
    method: 'PATCH',
    url: `/api/shares/${share.id}`,
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { password: '' },
  });
  expect(patchRes.statusCode).toBe(400);

  // The share is untouched — still no password_hash was ever written.
  const row = db!.prepare('SELECT password_hash FROM shares WHERE id = ?').get(share.id) as {
    password_hash: string | null;
  };
  expect(row.password_hash).toBeNull();

  // A real (non-empty) password still sets one, and `null` still clears it —
  // confirms the fix is scoped to the empty-string case only.
  const setRes = await built.inject({
    method: 'PATCH',
    url: `/api/shares/${share.id}`,
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { password: 'a-real-password' },
  });
  expect(setRes.statusCode).toBe(200);
  expect(setRes.json()).toMatchObject({ has_password: true });

  const clearRes = await built.inject({
    method: 'PATCH',
    url: `/api/shares/${share.id}`,
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { password: null },
  });
  expect(clearRes.statusCode).toBe(200);
  expect(clearRes.json()).toMatchObject({ has_password: false });
});

test('GET /api/shares exposes download-limit fields and an exhausted status', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);
  const folder = await makeFolder(built, session, csrf, rootId, 'Exhausted');

  const share = (
    await built.inject({
      method: 'POST',
      url: '/api/shares',
      cookies: { mirsal_session: session },
      headers: { 'x-csrf-token': csrf },
      payload: { node_id: folder.id },
    })
  ).json();

  db!
    .prepare('UPDATE shares SET download_limit = 1, download_count = 1, is_active = 1 WHERE id = ?')
    .run(share.id);

  const listRes = await built.inject({ method: 'GET', url: '/api/shares', cookies: { mirsal_session: session } });
  expect(listRes.statusCode).toBe(200);
  const list = listRes.json() as Array<{
    id: number;
    download_limit: number | null;
    download_count: number;
    on_exhaust: string;
    status: string;
  }>;
  const found = list.find((s) => s.id === share.id);
  expect(found).toMatchObject({
    download_limit: 1,
    download_count: 1,
    on_exhaust: 'delete',
    status: 'exhausted',
  });
});
