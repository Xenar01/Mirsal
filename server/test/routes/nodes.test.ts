import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-h3-'));
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

  const built = await buildApp({ db, config, now: clock });
  app = built;
  return built;
}

async function seedUser(
  username: string,
  password: string,
  overrides: Partial<{ role: string; quotaBytes: number | null }> = {}
): Promise<number> {
  const passwordService = createPasswordService(TEST_ARGON);
  const hash = await passwordService.hashPassword(password);
  const info = db!
    .prepare(
      `INSERT INTO users(username, password_hash, role, is_active, must_change_password, quota_bytes, created_at, updated_at)
       VALUES (?, ?, ?, 1, 0, ?, ?, ?)`
    )
    .run(username, hash, overrides.role ?? 'user', overrides.quotaBytes ?? null, NOW, NOW);
  return Number(info.lastInsertRowid);
}

function findCookie(cookies: InjectedCookie[], name: string): InjectedCookie | undefined {
  return cookies.find((c) => c.name === name);
}

async function login(
  built: FastifyInstance,
  username: string,
  password: string
): Promise<{ session: string; csrf: string }> {
  const res = await built.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
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
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`,
          'utf8'
        )
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

interface UploadOpts {
  parentId: number;
  filename: string;
  data: Buffer;
  contentType?: string;
}

async function uploadFile(
  built: FastifyInstance,
  session: string,
  csrf: string,
  opts: UploadOpts
): Promise<{ statusCode: number; body: any }> {
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
  return { statusCode: res.statusCode, body: res.json() };
}

// ---------------------------------------------------------------------------
// Folder creation + listing
// ---------------------------------------------------------------------------

test('create folder -> appears in GET /api/nodes', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);

  const createRes = await built.inject({
    method: 'POST',
    url: '/api/nodes/folder',
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { parent_id: rootId, name: 'Docs' },
  });
  expect(createRes.statusCode).toBe(201);
  const created = createRes.json();
  expect(created).toMatchObject({ kind: 'folder', name: 'Docs', parent_id: rootId });
  expect(created).not.toHaveProperty('storage_path');
  expect(created).not.toHaveProperty('owner_id');

  const listRes = await built.inject({
    method: 'GET',
    url: '/api/nodes',
    cookies: { mirsal_session: session },
  });
  expect(listRes.statusCode).toBe(200);
  const list = listRes.json() as Array<{ name: string }>;
  expect(list.some((n) => n.name === 'Docs')).toBe(true);
});

test('duplicate folder name under the same parent -> 409 name_conflict', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);

  await built.inject({
    method: 'POST',
    url: '/api/nodes/folder',
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { parent_id: rootId, name: 'Docs' },
  });
  const dupRes = await built.inject({
    method: 'POST',
    url: '/api/nodes/folder',
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { parent_id: rootId, name: 'Docs' },
  });

  expect(dupRes.statusCode).toBe(409);
  expect(dupRes.json()).toMatchObject({ code: 'name_conflict' });
});

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

test('upload a small file -> node listed, used_bytes rises', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);
  const content = Buffer.from('hello world');

  const { statusCode, body } = await uploadFile(built, session, csrf, {
    parentId: rootId,
    filename: 'hello.txt',
    data: content,
  });

  expect(statusCode).toBe(200);
  expect(body).toMatchObject({ kind: 'file', name: 'hello.txt', size_bytes: content.length, mime_type: 'text/plain' });
  expect(body).not.toHaveProperty('storage_path');

  const listRes = await built.inject({
    method: 'GET',
    url: '/api/nodes',
    cookies: { mirsal_session: session },
  });
  const list = listRes.json() as Array<{ name: string }>;
  expect(list.some((n) => n.name === 'hello.txt')).toBe(true);

  const user = db!.prepare('SELECT used_bytes FROM users WHERE id = ?').get(uid) as { used_bytes: number };
  expect(user.used_bytes).toBe(content.length);
});

test('upload duplicate name -> 200 auto-suffixed', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);

  const first = await uploadFile(built, session, csrf, {
    parentId: rootId,
    filename: 'dup.txt',
    data: Buffer.from('one'),
  });
  expect(first.statusCode).toBe(200);

  const second = await uploadFile(built, session, csrf, {
    parentId: rootId,
    filename: 'dup.txt',
    data: Buffer.from('two'),
  });
  expect(second.statusCode).toBe(200);
  expect(second.body.name).toBe('dup.txt (1)');
});

test('upload against a quota that is already exhausted -> 413 quota_exceeded, no row, no blob', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw', { quotaBytes: 5 });
  const { session, csrf } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);

  const { statusCode, body } = await uploadFile(built, session, csrf, {
    parentId: rootId,
    filename: 'toobig.txt',
    data: Buffer.from('this is way more than five bytes'),
  });

  expect(statusCode).toBe(413);
  expect(body).toMatchObject({ code: 'quota_exceeded' });

  const user = db!.prepare('SELECT used_bytes FROM users WHERE id = ?').get(uid) as { used_bytes: number };
  expect(user.used_bytes).toBe(0);

  const rows = db!.prepare("SELECT * FROM nodes WHERE kind = 'file' AND owner_id = ?").all(uid);
  expect(rows).toEqual([]);
});

// ---------------------------------------------------------------------------
// Cross-user isolation
// ---------------------------------------------------------------------------

test('cross-user isolation: foreign node reads as 404 on list/download/patch/delete, never 403', async () => {
  const built = await makeApp();
  const uidA = await seedUser('alice', 'pw');
  const uidB = await seedUser('bob', 'pw');
  const a = await login(built, 'alice', 'pw');
  const b = await login(built, 'bob', 'pw');
  const rootA = rootIdFor(uidA);

  const upload = await uploadFile(built, a.session, a.csrf, {
    parentId: rootA,
    filename: 'secret.txt',
    data: Buffer.from('shh'),
  });
  const nodeId = upload.body.id as number;

  const listRes = await built.inject({
    method: 'GET',
    url: `/api/nodes?parent=${rootA}`,
    cookies: { mirsal_session: b.session },
  });
  expect(listRes.statusCode).toBe(404);

  const downloadRes = await built.inject({
    method: 'GET',
    url: `/api/nodes/${nodeId}/download`,
    cookies: { mirsal_session: b.session },
  });
  expect(downloadRes.statusCode).toBe(404);

  const patchRes = await built.inject({
    method: 'PATCH',
    url: `/api/nodes/${nodeId}`,
    cookies: { mirsal_session: b.session },
    headers: { 'x-csrf-token': b.csrf },
    payload: { name: 'stolen.txt' },
  });
  expect(patchRes.statusCode).toBe(404);

  const deleteRes = await built.inject({
    method: 'DELETE',
    url: `/api/nodes/${nodeId}`,
    cookies: { mirsal_session: b.session },
    headers: { 'x-csrf-token': b.csrf },
  });
  expect(deleteRes.statusCode).toBe(404);

  // Sanity: A can still reach it fine.
  const okRes = await built.inject({
    method: 'GET',
    url: `/api/nodes/${nodeId}/download`,
    cookies: { mirsal_session: a.session },
  });
  expect(okRes.statusCode).toBe(200);
});

// ---------------------------------------------------------------------------
// Move / cycle guard
// ---------------------------------------------------------------------------

test('move a folder into its own descendant -> 409 cycle', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);

  const aRes = await built.inject({
    method: 'POST',
    url: '/api/nodes/folder',
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { parent_id: rootId, name: 'A' },
  });
  const a = aRes.json();

  const a1Res = await built.inject({
    method: 'POST',
    url: '/api/nodes/folder',
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { parent_id: a.id, name: 'A1' },
  });
  const a1 = a1Res.json();

  const moveRes = await built.inject({
    method: 'PATCH',
    url: `/api/nodes/${a.id}`,
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { parent_id: a1.id },
  });

  expect(moveRes.statusCode).toBe(409);
  expect(moveRes.json()).toMatchObject({ code: 'cycle' });
});

// ---------------------------------------------------------------------------
// Trash / restore
// ---------------------------------------------------------------------------

test('trash excludes from list; restore brings it back', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);

  const folderRes = await built.inject({
    method: 'POST',
    url: '/api/nodes/folder',
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { parent_id: rootId, name: 'ToTrash' },
  });
  const folder = folderRes.json();

  const trashRes = await built.inject({
    method: 'POST',
    url: `/api/nodes/${folder.id}/trash`,
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
  });
  expect(trashRes.statusCode).toBe(200);

  const listAfterTrash = (
    await built.inject({ method: 'GET', url: '/api/nodes', cookies: { mirsal_session: session } })
  ).json() as Array<{ name: string }>;
  expect(listAfterTrash.some((n) => n.name === 'ToTrash')).toBe(false);

  const trashListRes = await built.inject({
    method: 'GET',
    url: '/api/nodes/trash',
    cookies: { mirsal_session: session },
  });
  expect(trashListRes.statusCode).toBe(200);
  const trashList = trashListRes.json() as Array<{ name: string }>;
  expect(trashList.some((n) => n.name === 'ToTrash')).toBe(true);

  const restoreRes = await built.inject({
    method: 'POST',
    url: `/api/nodes/${folder.id}/restore`,
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
  });
  expect(restoreRes.statusCode).toBe(200);

  const listAfterRestore = (
    await built.inject({ method: 'GET', url: '/api/nodes', cookies: { mirsal_session: session } })
  ).json() as Array<{ name: string }>;
  expect(listAfterRestore.some((n) => n.name === 'ToTrash')).toBe(true);
});

// ---------------------------------------------------------------------------
// Permanent delete
// ---------------------------------------------------------------------------

test('permanent delete removes an uploaded file blob from disk', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);

  const upload = await uploadFile(built, session, csrf, {
    parentId: rootId,
    filename: 'to-delete.txt',
    data: Buffer.from('bye'),
  });
  const nodeId = upload.body.id as number;
  const blobPath = path.join(storageDir!, String(uid), String(nodeId));
  expect(fs.existsSync(blobPath)).toBe(true);

  const deleteRes = await built.inject({
    method: 'DELETE',
    url: `/api/nodes/${nodeId}`,
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
  });
  expect(deleteRes.statusCode).toBe(200);
  expect(deleteRes.json()).toMatchObject({ freedBytes: 3 });
  expect(fs.existsSync(blobPath)).toBe(false);

  const row = db!.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
  expect(row).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Download: Arabic filename + RFC 6266 + missing blob
// ---------------------------------------------------------------------------

test('download of an Arabic-named file -> RFC 6266 filename*=UTF-8\'\', no raw CR/LF, bytes round-trip', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);
  const content = Buffer.from('تقرير المحتوى السري');

  const upload = await uploadFile(built, session, csrf, {
    parentId: rootId,
    filename: 'تقرير.pdf',
    data: content,
    contentType: 'application/pdf',
  });
  expect(upload.statusCode).toBe(200);
  const nodeId = upload.body.id as number;

  const res = await built.inject({
    method: 'GET',
    url: `/api/nodes/${nodeId}/download`,
    cookies: { mirsal_session: session },
  });

  expect(res.statusCode).toBe(200);
  const disposition = res.headers['content-disposition'] as string;
  expect(disposition).toContain("filename*=UTF-8''");
  expect(disposition).toContain(encodeURIComponent('تقرير.pdf').replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`));
  expect(disposition).not.toMatch(/[\r\n]/);
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.rawPayload.equals(content)).toBe(true);
});

test('download when the blob is missing on disk (reverse-orphan) -> 404, never 500', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);

  const upload = await uploadFile(built, session, csrf, {
    parentId: rootId,
    filename: 'ghost.txt',
    data: Buffer.from('will vanish'),
  });
  const nodeId = upload.body.id as number;
  const blobPath = path.join(storageDir!, String(uid), String(nodeId));
  fs.unlinkSync(blobPath);

  const res = await built.inject({
    method: 'GET',
    url: `/api/nodes/${nodeId}/download`,
    cookies: { mirsal_session: session },
  });

  expect(res.statusCode).toBe(404);
});

// ---------------------------------------------------------------------------
// Auto-delete
// ---------------------------------------------------------------------------

test('auto-delete with a past timestamp -> 400 past_date; a future value -> 200 and column set', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);

  const folderRes = await built.inject({
    method: 'POST',
    url: '/api/nodes/folder',
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { parent_id: rootId, name: 'Ephemeral' },
  });
  const folder = folderRes.json();

  const pastRes = await built.inject({
    method: 'PATCH',
    url: `/api/nodes/${folder.id}/auto-delete`,
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { auto_delete_at: NOW - 1000 },
  });
  expect(pastRes.statusCode).toBe(400);
  expect(pastRes.json()).toMatchObject({ code: 'past_date' });

  const future = NOW + 1_000_000;
  const futureRes = await built.inject({
    method: 'PATCH',
    url: `/api/nodes/${folder.id}/auto-delete`,
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { auto_delete_at: future },
  });
  expect(futureRes.statusCode).toBe(200);
  expect(futureRes.json()).toMatchObject({ auto_delete_at: future });

  const row = db!.prepare('SELECT auto_delete_at FROM nodes WHERE id = ?').get(folder.id) as {
    auto_delete_at: number;
  };
  expect(row.auto_delete_at).toBe(future);
});
