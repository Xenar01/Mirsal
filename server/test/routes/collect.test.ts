import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { loadConfig, MAX_FILE_BYTES } from '../../src/config.js';
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

// ── template ────────────────────────────────────────────────────────────────
/** Uploads a real file to the owner's Drive via the owner API; returns its node id. */
async function uploadOwnerFile(
  built: FastifyInstance,
  session: string,
  csrf: string,
  filename: string,
  content: string
): Promise<number> {
  const { rootId } = (await import('../../src/nodes/tree.js')).ensureUserRoots(
    db!,
    (db!.prepare('SELECT id FROM users WHERE username=?').get('alice') as { id: number }).id,
    NOW
  );
  const boundary = '----tmpl';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="parent_id"\r\n\r\n${rootId}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n`),
    Buffer.from(content),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const up = await built.inject({
    method: 'POST',
    url: '/api/nodes/upload',
    cookies: { mirsal_session: session },
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-csrf-token': csrf },
    payload: body,
  });
  expect(up.statusCode).toBe(200);
  return up.json().id;
}

test('GET template: streams the attached file; missing template -> 404', async () => {
  const built = await makeApp();
  await seedUser('alice');
  const { session, csrf } = await login(built, 'alice');
  const templateNodeId = await uploadOwnerFile(built, session, csrf, 'template.txt', 'HELLO-TEMPLATE');

  const c = await makeCollection(built, session, csrf, { title: 'T', departments: ['A'], template_node_id: templateNodeId });
  const res = await built.inject({ method: 'GET', url: `/api/collect/${c.token}/template` });
  expect(res.statusCode).toBe(200);
  expect(res.body).toBe('HELLO-TEMPLATE');
  expect(res.headers['content-disposition']).toContain('template.txt');

  const noTpl = await makeCollection(built, session, csrf, { title: 'NoTpl', departments: ['A'] });
  expect((await built.inject({ method: 'GET', url: `/api/collect/${noTpl.token}/template` })).statusCode).toBe(404);
});

test('GET template: password-protected + not unlocked -> 401', async () => {
  const built = await makeApp();
  await seedUser('alice');
  const { session, csrf } = await login(built, 'alice');
  const c = await makeCollection(built, session, csrf, { title: 'T', departments: ['A'], password: 'pw3' });
  const res = await built.inject({ method: 'GET', url: `/api/collect/${c.token}/template` });
  expect(res.statusCode).toBe(401);
  expect(res.json()).toMatchObject({ needsPassword: true });
});

// ── submit ──────────────────────────────────────────────────────────────────
interface MultipartPart {
  name: string;
  value?: string;
  filename?: string;
  contentType?: string;
  data?: Buffer;
}
function buildMultipart(parts: MultipartPart[]): { body: Buffer; contentType: string } {
  const boundary = `----mirsalCollect${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (part.filename !== undefined) {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`, 'utf8'));
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
async function submit(built: FastifyInstance, token: string, parts: MultipartPart[], cookies: Record<string, string> = {}) {
  const { body, contentType } = buildMultipart(parts);
  return built.inject({ method: 'POST', url: `/api/collect/${token}/submit`, headers: { 'content-type': contentType }, cookies, payload: body });
}
/** Reads the department rows for a collection straight from the DB. */
function deptIds(collectionId: number): { id: number; name: string }[] {
  return db!.prepare('SELECT id, name FROM collection_departments WHERE collection_id=? ORDER BY position').all(collectionId) as { id: number; name: string }[];
}

test('submit happy path: 1 file -> 200; response row + file node + used_bytes + audit(actor null)', async () => {
  const built = await makeApp();
  const owner = await seedUser('alice');
  const { session, csrf } = await login(built, 'alice');
  const c = await makeCollection(built, session, csrf, { title: 'T', departments: ['HR', 'Finance'] });
  const hr = deptIds(c.id).find((d) => d.name === 'HR')!;

  const res = await submit(built, c.token, [
    { name: 'departmentId', value: String(hr.id) },
    { name: 'note', value: 'here is our report' },
    { name: 'files', filename: 'report.txt', contentType: 'text/plain', data: Buffer.from('THE REPORT') },
  ]);
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ ok: true });

  const folderId = (db!.prepare('SELECT folder_node_id f FROM collections WHERE id=?').get(c.id) as { f: number }).f;
  const sub = db!.prepare("SELECT id, name FROM nodes WHERE parent_id=? AND kind='folder'").get(folderId) as { id: number; name: string };
  expect(sub.name).toBe('HR');
  const files = db!.prepare("SELECT name, storage_path, size_bytes FROM nodes WHERE parent_id=? AND kind='file'").all(sub.id) as { name: string; storage_path: string; size_bytes: number }[];
  expect(files).toHaveLength(1);
  expect(files[0].name).toBe('report.txt');
  expect(files[0].size_bytes).toBe(10);
  const nodeId = files[0].storage_path.split('/')[1];
  expect(fs.existsSync(path.join(dir!, 'storage', String(owner), nodeId))).toBe(true);
  expect((db!.prepare('SELECT used_bytes u FROM users WHERE id=?').get(owner) as { u: number }).u).toBe(10);
  const row = db!.prepare('SELECT note FROM collection_responses WHERE collection_id=? AND department_id=?').get(c.id, hr.id) as { note: string };
  expect(row.note).toBe('here is our report');
  const audit = db!.prepare("SELECT actor_id, detail FROM audit_log WHERE action='collection_response_submitted'").get() as { actor_id: number | null; detail: string };
  expect(audit.actor_id).toBeNull();
  expect(JSON.parse(audit.detail)).toMatchObject({ collection_id: c.id, department_id: hr.id, department_name: 'HR', file_count: 1 });
});

test('submit: 3 files land as 3 nodes under the department subfolder', async () => {
  const built = await makeApp();
  await seedUser('alice');
  const { session, csrf } = await login(built, 'alice');
  const c = await makeCollection(built, session, csrf, { title: 'T', departments: ['HR'] });
  const hr = deptIds(c.id)[0];
  const res = await submit(built, c.token, [
    { name: 'departmentId', value: String(hr.id) },
    { name: 'files', filename: 'a.txt', data: Buffer.from('a') },
    { name: 'files', filename: 'b.txt', data: Buffer.from('bb') },
    { name: 'files', filename: 'c.txt', data: Buffer.from('ccc') },
  ]);
  expect(res.statusCode).toBe(200);
  const folderId = (db!.prepare('SELECT folder_node_id f FROM collections WHERE id=?').get(c.id) as { f: number }).f;
  const sub = (db!.prepare("SELECT id FROM nodes WHERE parent_id=? AND kind='folder'").get(folderId) as { id: number }).id;
  expect((db!.prepare("SELECT COUNT(*) n FROM nodes WHERE parent_id=? AND kind='file'").get(sub) as { n: number }).n).toBe(3);
});

test('submit guards: 0 files -> 400 no_files; >10 files -> 400 too_many_files (nothing stored)', async () => {
  const built = await makeApp();
  const owner = await seedUser('alice');
  const { session, csrf } = await login(built, 'alice');
  const c = await makeCollection(built, session, csrf, { title: 'T', departments: ['HR'] });
  const hr = deptIds(c.id)[0];

  const none = await submit(built, c.token, [{ name: 'departmentId', value: String(hr.id) }]);
  expect(none.statusCode).toBe(400);
  expect(none.json()).toMatchObject({ error: 'no_files' });

  const many = await submit(built, c.token, [
    { name: 'departmentId', value: String(hr.id) },
    ...Array.from({ length: 11 }, (_, i) => ({ name: 'files', filename: `f${i}.txt`, data: Buffer.from('x') })),
  ]);
  expect(many.statusCode).toBe(400);
  expect(many.json()).toMatchObject({ error: 'too_many_files' });
  expect((db!.prepare("SELECT COUNT(*) n FROM nodes WHERE kind='file'").get() as { n: number }).n).toBe(0);
  expect((db!.prepare('SELECT used_bytes u FROM users WHERE id=?').get(owner) as { u: number }).u).toBe(0);
});

test('submit guard: a file over MAX_FILE_BYTES -> 413 file_too_large, nothing stored', async () => {
  const built = await makeApp();
  const owner = await seedUser('alice');
  const { session, csrf } = await login(built, 'alice');
  const c = await makeCollection(built, session, csrf, { title: 'T', departments: ['HR'] });
  const hr = deptIds(c.id)[0];
  const res = await submit(built, c.token, [
    { name: 'departmentId', value: String(hr.id) },
    { name: 'files', filename: 'big.bin', data: Buffer.alloc(MAX_FILE_BYTES + 1024, 'a') },
  ]);
  expect(res.statusCode).toBe(413);
  expect(res.json()).toMatchObject({ error: 'file_too_large' });
  expect((db!.prepare("SELECT COUNT(*) n FROM nodes WHERE kind='file'").get() as { n: number }).n).toBe(0);
  expect((db!.prepare('SELECT used_bytes u FROM users WHERE id=?').get(owner) as { u: number }).u).toBe(0);
});

test('submit over quota -> 413 quota_exceeded, nothing stored', async () => {
  const built = await makeApp();
  const owner = await seedUser('alice', 5); // 5-byte quota
  const { session, csrf } = await login(built, 'alice');
  const c = await makeCollection(built, session, csrf, { title: 'T', departments: ['HR'] });
  const hr = deptIds(c.id)[0];
  const res = await submit(built, c.token, [
    { name: 'departmentId', value: String(hr.id) },
    { name: 'files', filename: 'a.txt', data: Buffer.from('way too big') },
  ]);
  expect(res.statusCode).toBe(413);
  expect(res.json()).toMatchObject({ error: 'quota_exceeded' });
  expect((db!.prepare("SELECT COUNT(*) n FROM nodes WHERE kind='file'").get() as { n: number }).n).toBe(0);
  expect((db!.prepare('SELECT used_bytes u FROM users WHERE id=?').get(owner) as { u: number }).u).toBe(0);
});

test('submit latest-replaces: re-submit swaps the set and reclaims the old blob', async () => {
  const built = await makeApp();
  const owner = await seedUser('alice');
  const { session, csrf } = await login(built, 'alice');
  const c = await makeCollection(built, session, csrf, { title: 'T', departments: ['HR'] });
  const hr = deptIds(c.id)[0];

  await submit(built, c.token, [{ name: 'departmentId', value: String(hr.id) }, { name: 'files', filename: 'old.txt', data: Buffer.from('OLDDATA') }]);
  const folderId = (db!.prepare('SELECT folder_node_id f FROM collections WHERE id=?').get(c.id) as { f: number }).f;
  const sub = (db!.prepare("SELECT id FROM nodes WHERE parent_id=? AND kind='folder'").get(folderId) as { id: number }).id;
  const oldNode = db!.prepare("SELECT storage_path sp FROM nodes WHERE parent_id=? AND kind='file'").get(sub) as { sp: string };
  const oldBlob = path.join(dir!, 'storage', oldNode.sp);
  expect(fs.existsSync(oldBlob)).toBe(true);

  await submit(built, c.token, [{ name: 'departmentId', value: String(hr.id) }, { name: 'files', filename: 'new.txt', data: Buffer.from('NEW') }]);
  const files = db!.prepare("SELECT name FROM nodes WHERE parent_id=? AND kind='file'").all(sub) as { name: string }[];
  expect(files.map((f) => f.name)).toEqual(['new.txt']);
  expect(fs.existsSync(oldBlob)).toBe(false); // old blob unlinked
  expect((db!.prepare('SELECT used_bytes u FROM users WHERE id=?').get(owner) as { u: number }).u).toBe(3);
  expect((db!.prepare('SELECT COUNT(*) n FROM collection_responses WHERE department_id=?').get(hr.id) as { n: number }).n).toBe(1);
});

test('submit rejects: wrong department -> 404; closed -> 404; non-multipart -> 415; password locked -> 401', async () => {
  const built = await makeApp();
  await seedUser('alice');
  const { session, csrf } = await login(built, 'alice');
  const c = await makeCollection(built, session, csrf, { title: 'T', departments: ['HR'] });
  const hr = deptIds(c.id)[0];

  expect((await submit(built, c.token, [{ name: 'departmentId', value: '999999' }, { name: 'files', filename: 'f.txt', data: Buffer.from('x') }])).statusCode).toBe(404);

  const nonMultipart = await built.inject({ method: 'POST', url: `/api/collect/${c.token}/submit`, payload: { hi: 1 } });
  expect(nonMultipart.statusCode).toBe(415);

  const pw = await makeCollection(built, session, csrf, { title: 'P', departments: ['HR'], password: 'pw9' });
  const pwHr = deptIds(pw.id)[0];
  expect((await submit(built, pw.token, [{ name: 'departmentId', value: String(pwHr.id) }, { name: 'files', filename: 'f.txt', data: Buffer.from('x') }])).statusCode).toBe(401);

  await built.inject({ method: 'PATCH', url: `/api/collections/${c.id}`, cookies: { mirsal_session: session }, headers: { 'x-csrf-token': csrf }, payload: { is_active: false } });
  expect((await submit(built, c.token, [{ name: 'departmentId', value: String(hr.id) }, { name: 'files', filename: 'f.txt', data: Buffer.from('x') }])).statusCode).toBe(404);
  expect((await submit(built, 'unknown-token', [{ name: 'departmentId', value: '1' }, { name: 'files', filename: 'f.txt', data: Buffer.from('x') }])).statusCode).toBe(404);
});
