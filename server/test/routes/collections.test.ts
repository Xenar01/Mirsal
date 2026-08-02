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

// createCollection/setCollectionState hash passwords through the *bare*
// hashPassword export, which is bound to a default service built from
// loadConfig() on first use — so these env vars must be present. Mirrors
// test/routes/shares.test.ts.
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-h-collections-'));
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

/** Inserts a live file node directly under `uid`'s root and returns its id. */
function seedFileNode(uid: number): number {
  const { rootId } = ensureUserRoots(db!, uid, NOW);
  const info = db!
    .prepare(
      `INSERT INTO nodes(owner_id, parent_id, kind, name, size_bytes, storage_path, created_at, updated_at)
       VALUES (@ownerId, @parentId, 'file', @name, 5, 'u/1', @now, @now)`
    )
    .run({ ownerId: uid, parentId: rootId, name: `f-${Math.random()}`, now: NOW });
  return Number(info.lastInsertRowid);
}

/** Inserts a live file node owned by an arbitrary uid and returns its id. */
function seedFileNodeFor(uid: number): number {
  const { rootId } = ensureUserRoots(db!, uid, NOW);
  const info = db!
    .prepare(`INSERT INTO nodes(owner_id, parent_id, kind, name, size_bytes, storage_path, created_at, updated_at)
              VALUES (@uid, @rootId, 'file', @name, 5, 'u/1', @now, @now)`)
    .run({ uid, rootId, name: `f-${Math.random()}`, now: NOW });
  return Number(info.lastInsertRowid);
}

// ---------------------------------------------------------------------------

test('POST /api/collections -> 201 detail with /c/<token> url, open status, departments; GET lists it', async () => {
  const built = await makeApp();
  await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');

  const res = await built.inject({
    method: 'POST', url: '/api/collections',
    cookies: { mirsal_session: session }, headers: { 'x-csrf-token': csrf },
    payload: { title: 'Q1', departments: ['HR', 'Finance', 'IT'] },
  });
  expect(res.statusCode).toBe(201);
  const c = res.json();
  expect(c.url).toBe(`${PUBLIC_BASE_URL}/c/${c.token}`);
  expect(c.status).toBe('open');
  expect(c.has_password).toBe(false);
  expect(c.department_count).toBe(3);
  expect(c.responded_count).toBe(0);
  expect(c.departments.map((d: any) => d.name)).toEqual(['HR', 'Finance', 'IT']);
  expect(c.departments.every((d: any) => d.responded === false)).toBe(true);

  const list = (await built.inject({ method: 'GET', url: '/api/collections', cookies: { mirsal_session: session } })).json();
  expect(list.some((x: any) => x.id === c.id && x.department_count === 3)).toBe(true);
});

test('POST with a password -> has_password true, secret never echoed', async () => {
  const built = await makeApp();
  await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const res = await built.inject({
    method: 'POST', url: '/api/collections',
    cookies: { mirsal_session: session }, headers: { 'x-csrf-token': csrf },
    payload: { title: 'P', departments: ['A'], password: 'secret-pw' },
  });
  expect(res.statusCode).toBe(201);
  expect(res.json().has_password).toBe(true);
  expect(JSON.stringify(res.json())).not.toContain('secret-pw');
});

test('POST with a foreign/non-file template -> 400 bad_template', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  await seedUser('bob', 'pw');
  const bobId = (db!.prepare('SELECT id FROM users WHERE username=?').get('bob') as { id: number }).id;
  const { session, csrf } = await login(built, 'alice', 'pw');
  const foreign = seedFileNodeFor(bobId); // a file owned by bob (helper below)
  const res = await built.inject({
    method: 'POST', url: '/api/collections',
    cookies: { mirsal_session: session }, headers: { 'x-csrf-token': csrf },
    payload: { title: 'T', departments: ['A'], template_node_id: foreign },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toMatchObject({ code: 'bad_template' });
});

test('POST with only blank departments -> 400', async () => {
  const built = await makeApp();
  await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const res = await built.inject({
    method: 'POST', url: '/api/collections',
    cookies: { mirsal_session: session }, headers: { 'x-csrf-token': csrf },
    payload: { title: 'T', departments: ['', '  '] },
  });
  expect(res.statusCode).toBe(400);
});

test('POST /api/collections requires auth -> 401', async () => {
  const built = await makeApp();
  const res = await built.inject({ method: 'POST', url: '/api/collections', payload: { title: 'T', departments: ['A'] } });
  expect(res.statusCode).toBe(401);
});

test('GET /api/collections/:id is owner-scoped -> 404 for another user', async () => {
  const built = await makeApp();
  await seedUser('alice', 'pw');
  await seedUser('bob', 'pw');
  const a = await login(built, 'alice', 'pw');
  const b = await login(built, 'bob', 'pw');
  const c = (await built.inject({
    method: 'POST', url: '/api/collections',
    cookies: { mirsal_session: a.session }, headers: { 'x-csrf-token': a.csrf },
    payload: { title: 'T', departments: ['A'] },
  })).json();

  expect((await built.inject({ method: 'GET', url: `/api/collections/${c.id}`, cookies: { mirsal_session: a.session } })).statusCode).toBe(200);
  expect((await built.inject({ method: 'GET', url: `/api/collections/${c.id}`, cookies: { mirsal_session: b.session } })).statusCode).toBe(404);
});

async function mkCollection(built: FastifyInstance, session: string, csrf: string, payload: any) {
  return (await built.inject({
    method: 'POST', url: '/api/collections',
    cookies: { mirsal_session: session }, headers: { 'x-csrf-token': csrf }, payload,
  })).json();
}

test('PATCH is_active:false -> closed; past deadline -> expired; title updates', async () => {
  const built = await makeApp();
  await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const c = await mkCollection(built, session, csrf, { title: 'Old', departments: ['A'] });

  const stop = await built.inject({
    method: 'PATCH', url: `/api/collections/${c.id}`,
    cookies: { mirsal_session: session }, headers: { 'x-csrf-token': csrf },
    payload: { is_active: false, title: 'New' },
  });
  expect(stop.statusCode).toBe(200);
  expect(stop.json()).toMatchObject({ status: 'closed', title: 'New' });

  const exp = await built.inject({
    method: 'PATCH', url: `/api/collections/${c.id}`,
    cookies: { mirsal_session: session }, headers: { 'x-csrf-token': csrf },
    payload: { is_active: true, deadline_at: NOW - 1000 },
  });
  expect(exp.json()).toMatchObject({ status: 'expired' });
});

test('PATCH with an empty body -> 400; foreign collection -> 404', async () => {
  const built = await makeApp();
  await seedUser('alice', 'pw');
  await seedUser('bob', 'pw');
  const a = await login(built, 'alice', 'pw');
  const b = await login(built, 'bob', 'pw');
  const c = await mkCollection(built, a.session, a.csrf, { title: 'T', departments: ['A'] });

  expect((await built.inject({
    method: 'PATCH', url: `/api/collections/${c.id}`,
    cookies: { mirsal_session: a.session }, headers: { 'x-csrf-token': a.csrf }, payload: {},
  })).statusCode).toBe(400);

  expect((await built.inject({
    method: 'PATCH', url: `/api/collections/${c.id}`,
    cookies: { mirsal_session: b.session }, headers: { 'x-csrf-token': b.csrf }, payload: { is_active: false },
  })).statusCode).toBe(404);

  // Discriminating: the foreign PATCH attempt must not have touched the row.
  const untouched = await built.inject({ method: 'GET', url: `/api/collections/${c.id}`, cookies: { mirsal_session: a.session } });
  expect(untouched.json()).toMatchObject({ is_active: true, title: 'T' });
});

test('DELETE removes the collection (gone from list, folder node gone); 2nd DELETE -> 404', async () => {
  const built = await makeApp();
  await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const c = await mkCollection(built, session, csrf, { title: 'T', departments: ['A'] });
  const folderId = (db!.prepare('SELECT folder_node_id f FROM collections WHERE id=?').get(c.id) as { f: number }).f;

  const del = await built.inject({
    method: 'DELETE', url: `/api/collections/${c.id}`,
    cookies: { mirsal_session: session }, headers: { 'x-csrf-token': csrf },
  });
  expect(del.statusCode).toBe(200);
  expect(db!.prepare('SELECT COUNT(*) c FROM nodes WHERE id=?').get(folderId)).toMatchObject({ c: 0 });

  const list = (await built.inject({ method: 'GET', url: '/api/collections', cookies: { mirsal_session: session } })).json();
  expect(list.some((x: any) => x.id === c.id)).toBe(false);

  const again = await built.inject({
    method: 'DELETE', url: `/api/collections/${c.id}`,
    cookies: { mirsal_session: session }, headers: { 'x-csrf-token': csrf },
  });
  expect(again.statusCode).toBe(404);
});

test('DELETE is owner-scoped: a foreign DELETE -> 404 and the row/folder survive', async () => {
  const built = await makeApp();
  await seedUser('alice', 'pw');
  await seedUser('bob', 'pw');
  const a = await login(built, 'alice', 'pw');
  const b = await login(built, 'bob', 'pw');
  const c = await mkCollection(built, a.session, a.csrf, { title: 'T', departments: ['A'] });
  const folderId = (db!.prepare('SELECT folder_node_id f FROM collections WHERE id=?').get(c.id) as { f: number }).f;

  const foreignDel = await built.inject({
    method: 'DELETE', url: `/api/collections/${c.id}`,
    cookies: { mirsal_session: b.session }, headers: { 'x-csrf-token': b.csrf },
  });
  expect(foreignDel.statusCode).toBe(404);

  // Discriminating: bob's failed DELETE must not have removed alice's row.
  expect(db!.prepare('SELECT COUNT(*) c FROM collections WHERE id=?').get(c.id)).toMatchObject({ c: 1 });
  expect(db!.prepare('SELECT COUNT(*) c FROM nodes WHERE id=?').get(folderId)).toMatchObject({ c: 1 });
  const stillThere = await built.inject({ method: 'GET', url: `/api/collections/${c.id}`, cookies: { mirsal_session: a.session } });
  expect(stillThere.statusCode).toBe(200);
});
