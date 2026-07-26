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

interface InjectedCookie {
  name: string;
  value: string;
}

let db: Database.Database | undefined;
let dir: string | undefined;
let storageDir: string | undefined;
let app: FastifyInstance | undefined;

// createShare hashes passwords through the *bare* hashPassword export (bound to
// a default service built from loadConfig() on first use) — env must be set.
const keys = ['DB_PATH', 'STORAGE_DIR', 'SESSION_SECRET', 'CSRF_SECRET', 'PUBLIC_BASE_URL'] as const;
const originals: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const key of keys) originals[key] = process.env[key];
  process.env.DB_PATH = '/tmp/mirsal-test/db.sqlite';
  process.env.STORAGE_DIR = '/tmp/mirsal-test/storage';
  process.env.SESSION_SECRET = 'a'.repeat(32);
  process.env.CSRF_SECRET = 'b'.repeat(32);
  process.env.PUBLIC_BASE_URL = 'https://mirsal.example.test';
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-h4-public-'));
  const dbPath = path.join(dir, 't.db');
  storageDir = path.join(dir, 'storage');
  db = openDb(dbPath);
  migrate(db);

  const config = loadConfig({
    DB_PATH: dbPath,
    STORAGE_DIR: storageDir,
    SESSION_SECRET: 'a-test-session-secret-16+',
    CSRF_SECRET: 'a-test-csrf-secret-16chars+',
    PUBLIC_BASE_URL: 'https://mirsal.example.test',
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

interface MultipartPart {
  name: string;
  value?: string;
  filename?: string;
  contentType?: string;
  data?: Buffer;
}

function buildMultipart(parts: MultipartPart[]): { body: Buffer; contentType: string } {
  const boundary = `----mirsalTestBoundary${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (part.filename !== undefined) {
      chunks.push(
        Buffer.from(`Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`, 'utf8')
      );
      chunks.push(Buffer.from(`Content-Type: ${part.contentType ?? 'application/octet-stream'}\r\n\r\n`));
      chunks.push(part.data ?? Buffer.alloc(0));
      chunks.push(Buffer.from('\r\n'));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n`));
      chunks.push(Buffer.from(`${part.value ?? ''}\r\n`));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function uploadFile(
  built: FastifyInstance,
  session: string,
  csrf: string,
  opts: { parentId: number; filename: string; data: Buffer; contentType?: string }
): Promise<any> {
  const { body, contentType } = buildMultipart([
    { name: 'parent_id', value: String(opts.parentId) },
    { name: 'file', filename: opts.filename, contentType: opts.contentType ?? 'text/plain', data: opts.data },
  ]);
  const res = await built.inject({
    method: 'POST',
    url: '/api/nodes/upload',
    cookies: { mirsal_session: session },
    headers: { 'content-type': contentType, 'x-csrf-token': csrf },
    payload: body,
  });
  return res.json();
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

async function createShare(
  built: FastifyInstance,
  session: string,
  csrf: string,
  body: { node_id: number; password?: string; expires_at?: number | null }
): Promise<any> {
  const res = await built.inject({
    method: 'POST',
    url: '/api/shares',
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: body,
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

// ---------------------------------------------------------------------------
// File share (no password)
// ---------------------------------------------------------------------------

test('file share: GET meta, download bytes match, share_access_log written, Referrer-Policy set', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);
  const content = Buffer.from('the quick brown fox');
  const file = await uploadFile(built, session, csrf, { parentId: rootId, filename: 'fox.txt', data: content });

  const share = await createShare(built, session, csrf, { node_id: file.id });

  const metaRes = await built.inject({ method: 'GET', url: `/api/public/${share.token}` });
  expect(metaRes.statusCode).toBe(200);
  expect(metaRes.headers['referrer-policy']).toBe('no-referrer');
  const meta = metaRes.json();
  expect(meta).toMatchObject({
    token: share.token,
    kind: 'file',
    name: 'fox.txt',
    size_bytes: content.length,
    isFolder: false,
    allow_download: true,
  });
  // A public file-share meta must never leak internal columns.
  expect(meta).not.toHaveProperty('storage_path');
  expect(meta).not.toHaveProperty('owner_id');

  const dlRes = await built.inject({ method: 'GET', url: `/api/public/${share.token}/download?node=${file.id}` });
  expect(dlRes.statusCode).toBe(200);
  expect(dlRes.headers['x-content-type-options']).toBe('nosniff');
  expect(dlRes.headers['referrer-policy']).toBe('no-referrer');
  expect((dlRes.headers['content-disposition'] as string)).toContain('attachment');
  expect(dlRes.rawPayload.equals(content)).toBe(true);

  const logCount = db!.prepare('SELECT COUNT(*) AS c FROM share_access_log WHERE share_id = ?').get(share.id) as { c: number };
  expect(logCount.c).toBe(1);
});

test('file-share download with no node param defaults to the shared node', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);
  const content = Buffer.from('default-node-download');
  const file = await uploadFile(built, session, csrf, { parentId: rootId, filename: 'd.txt', data: content });
  const share = await createShare(built, session, csrf, { node_id: file.id });

  const dlRes = await built.inject({ method: 'GET', url: `/api/public/${share.token}/download` });
  expect(dlRes.statusCode).toBe(200);
  expect(dlRes.rawPayload.equals(content)).toBe(true);
});

test('unknown token -> generic 404 (no oracle), still Referrer-Policy: no-referrer', async () => {
  const built = await makeApp();
  const res = await built.inject({ method: 'GET', url: '/api/public/does-not-exist-token' });
  expect(res.statusCode).toBe(404);
  expect(res.headers['referrer-policy']).toBe('no-referrer');
});

// ---------------------------------------------------------------------------
// Folder share
// ---------------------------------------------------------------------------

test('folder share: list children, download a descendant; sibling-outside + moved-out -> 403 forbidden', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);

  const folder = await makeFolder(built, session, csrf, rootId, 'Album');
  const inside = await uploadFile(built, session, csrf, { parentId: folder.id, filename: 'inside.txt', data: Buffer.from('IN') });
  const sub = await makeFolder(built, session, csrf, folder.id, 'Sub');
  const deep = await uploadFile(built, session, csrf, { parentId: sub.id, filename: 'deep.txt', data: Buffer.from('DEEP') });
  const outside = await uploadFile(built, session, csrf, { parentId: rootId, filename: 'outside.txt', data: Buffer.from('OUT') });
  const mover = await uploadFile(built, session, csrf, { parentId: folder.id, filename: 'mover.txt', data: Buffer.from('MOVE') });

  const share = await createShare(built, session, csrf, { node_id: folder.id });

  // list top-level children of the shared folder
  const listRes = await built.inject({ method: 'GET', url: `/api/public/${share.token}/list` });
  expect(listRes.statusCode).toBe(200);
  const list = listRes.json() as Array<{ id: number; kind: string; name: string }>;
  expect(list.map((n) => n.name).sort()).toEqual(['Sub', 'inside.txt', 'mover.txt']);
  // public DTO omits internal columns
  for (const n of list) {
    expect(n).not.toHaveProperty('storage_path');
    expect(n).not.toHaveProperty('owner_id');
    expect(n).not.toHaveProperty('auto_delete_at');
  }

  // download a descendant two levels deep
  const deepRes = await built.inject({ method: 'GET', url: `/api/public/${share.token}/download?node=${deep.id}` });
  expect(deepRes.statusCode).toBe(200);
  expect(deepRes.rawPayload.equals(Buffer.from('DEEP'))).toBe(true);

  // sibling outside the shared subtree -> 403 forbidden (constant shape)
  const sibRes = await built.inject({ method: 'GET', url: `/api/public/${share.token}/download?node=${outside.id}` });
  expect(sibRes.statusCode).toBe(403);
  expect(sibRes.json()).toEqual({ error: 'forbidden' });

  // junk id -> same 403 forbidden shape (no existence oracle)
  const junkRes = await built.inject({ method: 'GET', url: `/api/public/${share.token}/download?node=999999` });
  expect(junkRes.statusCode).toBe(403);
  expect(junkRes.json()).toEqual({ error: 'forbidden' });

  // move a node OUT of the shared folder, then request it -> 403
  const moveRes = await built.inject({
    method: 'PATCH',
    url: `/api/nodes/${mover.id}`,
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { parent_id: rootId },
  });
  expect(moveRes.statusCode).toBe(200);

  const movedRes = await built.inject({ method: 'GET', url: `/api/public/${share.token}/download?node=${mover.id}` });
  expect(movedRes.statusCode).toBe(403);
  expect(movedRes.json()).toEqual({ error: 'forbidden' });

  // sanity: `inside` still downloads fine
  const insideRes = await built.inject({ method: 'GET', url: `/api/public/${share.token}/download?node=${inside.id}` });
  expect(insideRes.statusCode).toBe(200);
});

test('folder share: /zip streams a zip of the subtree with real entries', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);

  const folder = await makeFolder(built, session, csrf, rootId, 'Bundle');
  await uploadFile(built, session, csrf, { parentId: folder.id, filename: 'one.txt', data: Buffer.from('ONE') });
  const sub = await makeFolder(built, session, csrf, folder.id, 'Nested');
  await uploadFile(built, session, csrf, { parentId: sub.id, filename: 'two.txt', data: Buffer.from('TWO') });

  const share = await createShare(built, session, csrf, { node_id: folder.id });

  const zipRes = await built.inject({ method: 'GET', url: `/api/public/${share.token}/zip` });
  expect(zipRes.statusCode).toBe(200);
  expect(zipRes.headers['content-type']).toContain('zip');
  expect(zipRes.headers['content-disposition']).toContain('.zip');
  expect(zipRes.rawPayload.length).toBeGreaterThan(0);
  // Each entry carries a local-file-header signature "PK\x03\x04". Two files -> >= 2.
  const sig = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  let count = 0;
  for (let i = 0; i + 4 <= zipRes.rawPayload.length; i++) {
    if (zipRes.rawPayload.subarray(i, i + 4).equals(sig)) count++;
  }
  expect(count).toBeGreaterThanOrEqual(2);
});

// ---------------------------------------------------------------------------
// Password share
// ---------------------------------------------------------------------------

test('password share: pre-unlock meta reveals no name/size/kind; correct pw unlocks download', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);
  const content = Buffer.from('classified');
  const file = await uploadFile(built, session, csrf, { parentId: rootId, filename: 'secret.txt', data: content });
  const share = await createShare(built, session, csrf, { node_id: file.id, password: 'open-sesame' });

  // pre-unlock meta: 401 needsPassword, no metadata leak
  const preRes = await built.inject({ method: 'GET', url: `/api/public/${share.token}` });
  expect(preRes.statusCode).toBe(401);
  const preBody = preRes.json();
  expect(preBody).toEqual({ needsPassword: true });
  expect(JSON.stringify(preBody)).not.toContain('secret.txt');
  expect(preBody).not.toHaveProperty('name');
  expect(preBody).not.toHaveProperty('size_bytes');
  expect(preBody).not.toHaveProperty('kind');

  // download without unlock -> not allowed
  const dlLocked = await built.inject({ method: 'GET', url: `/api/public/${share.token}/download?node=${file.id}` });
  expect(dlLocked.statusCode).toBe(401);

  // correct password -> 200 + unlock cookie
  const unlockRes = await built.inject({
    method: 'POST',
    url: `/api/public/${share.token}/unlock`,
    payload: { password: 'open-sesame' },
  });
  expect(unlockRes.statusCode).toBe(200);
  expect(unlockRes.json()).toEqual({ ok: true });
  const unlockCookie = findCookie(unlockRes.cookies as InjectedCookie[], 'mirsal_unlock');
  expect(unlockCookie).toBeDefined();

  // meta now visible with the cookie
  const metaRes = await built.inject({
    method: 'GET',
    url: `/api/public/${share.token}`,
    cookies: { mirsal_unlock: unlockCookie!.value },
  });
  expect(metaRes.statusCode).toBe(200);
  expect(metaRes.json()).toMatchObject({ kind: 'file', name: 'secret.txt' });

  // download now works with the cookie
  const dlRes = await built.inject({
    method: 'GET',
    url: `/api/public/${share.token}/download?node=${file.id}`,
    cookies: { mirsal_unlock: unlockCookie!.value },
  });
  expect(dlRes.statusCode).toBe(200);
  expect(dlRes.rawPayload.equals(content)).toBe(true);
});

test('password share: wrong password is 401, and repeated attempts get rate-limited to 429', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);
  const file = await uploadFile(built, session, csrf, { parentId: rootId, filename: 'v.txt', data: Buffer.from('x') });
  const share = await createShare(built, session, csrf, { node_id: file.id, password: 'right' });

  const codes: number[] = [];
  for (let i = 0; i < 6; i++) {
    const res = await built.inject({
      method: 'POST',
      url: `/api/public/${share.token}/unlock`,
      payload: { password: 'wrong' },
    });
    codes.push(res.statusCode);
  }
  // First attempts are wrong-password 401s; once the per-token cap is hit, 429.
  expect(codes.filter((c) => c === 401).length).toBeGreaterThanOrEqual(1);
  expect(codes).toContain(429);
  expect(codes[codes.length - 1]).toBe(429);

  // an unlock failure was audited
  const audit = db!
    .prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'share_unlock_failure'")
    .get() as { c: number };
  expect(audit.c).toBeGreaterThanOrEqual(1);
}, 20_000);

// ---------------------------------------------------------------------------
// Lifecycle: stopped / expired / revoked
// ---------------------------------------------------------------------------

test('lifecycle: stopped -> 410, expired (past) -> 410 without a tick, revoked -> 404', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);
  const file = await uploadFile(built, session, csrf, { parentId: rootId, filename: 'life.txt', data: Buffer.from('L') });
  const share = await createShare(built, session, csrf, { node_id: file.id });

  // live to start
  expect((await built.inject({ method: 'GET', url: `/api/public/${share.token}` })).statusCode).toBe(200);

  // stop sharing -> 410
  await built.inject({
    method: 'PATCH',
    url: `/api/shares/${share.id}`,
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { is_active: false },
  });
  const stoppedRes = await built.inject({ method: 'GET', url: `/api/public/${share.token}` });
  expect(stoppedRes.statusCode).toBe(410);

  // reactivate + set expiry in the past -> 410 (evaluated at request time, no scheduler tick)
  await built.inject({
    method: 'PATCH',
    url: `/api/shares/${share.id}`,
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { is_active: true, expires_at: NOW - 1000 },
  });
  const expiredRes = await built.inject({ method: 'GET', url: `/api/public/${share.token}` });
  expect(expiredRes.statusCode).toBe(410);

  // revoke -> token gone -> 404
  await built.inject({
    method: 'DELETE',
    url: `/api/shares/${share.id}`,
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
  });
  const revokedRes = await built.inject({ method: 'GET', url: `/api/public/${share.token}` });
  expect(revokedRes.statusCode).toBe(404);
});

test('download is refused when allow_download is off -> 403', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);
  const file = await uploadFile(built, session, csrf, { parentId: rootId, filename: 'noview.txt', data: Buffer.from('N') });
  const share = await createShare(built, session, csrf, { node_id: file.id });

  // allow_download isn't exposed through the owner API in this phase; flip it directly.
  db!.prepare('UPDATE shares SET allow_download = 0 WHERE id = ?').run(share.id);

  const dlRes = await built.inject({ method: 'GET', url: `/api/public/${share.token}/download?node=${file.id}` });
  expect(dlRes.statusCode).toBe(403);
  expect(dlRes.json()).toEqual({ error: 'forbidden' });

  // meta still readable (only downloading is blocked)
  expect((await built.inject({ method: 'GET', url: `/api/public/${share.token}` })).statusCode).toBe(200);
});
