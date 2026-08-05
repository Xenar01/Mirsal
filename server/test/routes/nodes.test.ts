import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { loadConfig, MAX_FILE_BYTES } from '../../src/config.js';
import { buildApp } from '../../src/app.js';
import { createPasswordService } from '../../src/auth/passwords.js';
import { ensureUserRoots } from '../../src/nodes/tree.js';

// Mock `nextSuffixedName` so a single test can force it to throw at exactly the
// post-reserve / post-writeStreamToTemp window in POST /api/nodes/upload, while
// EVERY other test in this file keeps the real naming behavior (toggle defaults
// off). `mapDbError` is preserved from the real module so the handler's error
// mapping is unchanged.
const collisionsState = vi.hoisted(() => ({ throwOnNextSuffixedName: false }));
const NEXT_SUFFIXED_FAILURE = 'simulated nextSuffixedName failure (SQLITE_BUSY)';

vi.mock('../../src/nodes/collisions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/nodes/collisions.js')>();
  return {
    ...actual,
    nextSuffixedName: (...args: Parameters<typeof actual.nextSuffixedName>): string => {
      if (collisionsState.throwOnNextSuffixedName) {
        const err = new Error(NEXT_SUFFIXED_FAILURE) as NodeJS.ErrnoException;
        err.code = 'SQLITE_BUSY';
        throw err;
      }
      return actual.nextSuffixedName(...args);
    },
  };
});

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
  collisionsState.throwOnNextSuffixedName = false;
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

test('create folder with omitted parent_id resolves to the root (brand-new empty account)', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);

  // A brand-new client can't know its concrete root node id (empty root has no
  // child to learn it from) — omitting parent_id must resolve to the root.
  const createRes = await built.inject({
    method: 'POST',
    url: '/api/nodes/folder',
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { name: 'Docs' },
  });
  expect(createRes.statusCode).toBe(201);
  expect(createRes.json()).toMatchObject({ kind: 'folder', name: 'Docs', parent_id: rootId });
});

test('create folder with null parent_id resolves to the root', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);

  const createRes = await built.inject({
    method: 'POST',
    url: '/api/nodes/folder',
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { parent_id: null, name: 'Docs' },
  });
  expect(createRes.statusCode).toBe(201);
  expect(createRes.json()).toMatchObject({ kind: 'folder', name: 'Docs', parent_id: rootId });
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

test('upload where the naming step throws after reserve+writeTemp -> quota released, temp blob unlinked, clean error (no leak)', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);

  // Fresh user: quota starts at 0.
  const before = db!.prepare('SELECT used_bytes FROM users WHERE id = ?').get(uid) as { used_bytes: number };
  expect(before.used_bytes).toBe(0);

  // Force nextSuffixedName to throw in the window AFTER reserve() has bumped
  // used_bytes and writeStreamToTemp() has written the `.tmp-*` blob.
  collisionsState.throwOnNextSuffixedName = true;

  const { statusCode, body } = await uploadFile(built, session, csrf, {
    parentId: rootId,
    filename: 'boom.txt',
    data: Buffer.from('this content was fully streamed to a temp blob'),
  });

  // --- The load-bearing assertions: cleanup MUST run on the throw ---

  // Quota released: used_bytes is back to its pre-upload value (0), not left
  // over-counted by the abandoned reserve().
  const after = db!.prepare('SELECT used_bytes FROM users WHERE id = ?').get(uid) as { used_bytes: number };
  expect(after.used_bytes).toBe(0);

  // No orphaned temp blob: the `.tmp-*` file was unlinked (the scheduler's
  // orphan sweep skips `.tmp-*`, so a leak here would never be reclaimed).
  const ownerDir = path.join(storageDir!, String(uid));
  const leftovers = fs.existsSync(ownerDir) ? fs.readdirSync(ownerDir) : [];
  expect(leftovers.filter((f) => f.startsWith('.tmp-'))).toEqual([]);
  expect(leftovers).toEqual([]);

  // No file row was committed.
  const rows = db!.prepare("SELECT * FROM nodes WHERE kind = 'file' AND owner_id = ?").all(uid);
  expect(rows).toEqual([]);

  // Clean, mapped error — never a 2xx, and the raw error message/stack must
  // not leak into the response body.
  expect(statusCode).not.toBe(200);
  expect(statusCode).toBeGreaterThanOrEqual(400);
  expect(JSON.stringify(body)).not.toContain(NEXT_SUFFIXED_FAILURE);
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

// ---------------------------------------------------------------------------
// Review fixes (H3 findings #1, #2/#4, #3, #5)
// ---------------------------------------------------------------------------

test('GET /api/nodes/trash reports the real size of a trashed folder that contains files (finding #1)', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);

  const folderRes = await built.inject({
    method: 'POST',
    url: '/api/nodes/folder',
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { parent_id: rootId, name: 'Docs' },
  });
  const folder = folderRes.json();

  await uploadFile(built, session, csrf, { parentId: folder.id, filename: 'a.txt', data: Buffer.from('hello') }); // 5 bytes

  const nestedRes = await built.inject({
    method: 'POST',
    url: '/api/nodes/folder',
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { parent_id: folder.id, name: 'Nested' },
  });
  const nested = nestedRes.json();

  await uploadFile(built, session, csrf, { parentId: nested.id, filename: 'b.txt', data: Buffer.from('world!!') }); // 7 bytes

  const trashRes = await built.inject({
    method: 'POST',
    url: `/api/nodes/${folder.id}/trash`,
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
  });
  expect(trashRes.statusCode).toBe(200);

  const trashListRes = await built.inject({
    method: 'GET',
    url: '/api/nodes/trash',
    cookies: { mirsal_session: session },
  });
  expect(trashListRes.statusCode).toBe(200);
  const trashList = trashListRes.json() as Array<{ name: string; size_bytes: number }>;
  const trashedDocs = trashList.find((n) => n.name === 'Docs');
  expect(trashedDocs).toBeDefined();
  expect(trashedDocs!.size_bytes).toBe(12); // 5 + 7, across two levels of trashed subtree
});

test('GET /api/nodes/trash lists only TOP-LEVEL trashed items, not files nested inside a trashed folder (no storage-meter double-count)', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);

  const folderRes = await built.inject({
    method: 'POST',
    url: '/api/nodes/folder',
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { parent_id: rootId, name: 'Box' },
  });
  const folder = folderRes.json();
  await uploadFile(built, session, csrf, { parentId: folder.id, filename: 'inside.txt', data: Buffer.from('hello') }); // 5 bytes

  // Trash the FOLDER — its child file is stamped trashed in the same operation.
  await built.inject({
    method: 'POST',
    url: `/api/nodes/${folder.id}/trash`,
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
  });

  const trashListRes = await built.inject({
    method: 'GET',
    url: '/api/nodes/trash',
    cookies: { mirsal_session: session },
  });
  const trashList = trashListRes.json() as Array<{ id: number; name: string; kind: string; size_bytes: number }>;

  // Only the folder is a top-level trash entry; the nested file must NOT appear
  // as its own row (that is what double-counted the storage meter — the folder
  // already rolls up its file's bytes).
  expect(trashList.map((n) => n.name).sort()).toEqual(['Box']);
  expect(trashList.find((n) => n.name === 'Box')!.size_bytes).toBe(5);
  expect(trashList.some((n) => n.name === 'inside.txt')).toBe(false);
});

test('PATCH move+rename in one request never spuriously 409s on an intermediate-state collision (findings #2/#4)', async () => {
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

  const bRes = await built.inject({
    method: 'POST',
    url: '/api/nodes/folder',
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { parent_id: rootId, name: 'B' },
  });
  const b = bRes.json();

  // An existing item in B named "shared", matching the target's OLD name —
  // the buggy two-step (moveNode-then-renameNode) implementation would
  // collide against THIS while still at the target's old name, even though
  // the final requested state (B + "unique") never collides with it.
  await built.inject({
    method: 'POST',
    url: '/api/nodes/folder',
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { parent_id: b.id, name: 'shared' },
  });

  const targetRes = await built.inject({
    method: 'POST',
    url: '/api/nodes/folder',
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { parent_id: a.id, name: 'shared' },
  });
  const target = targetRes.json();

  const patchRes = await built.inject({
    method: 'PATCH',
    url: `/api/nodes/${target.id}`,
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { parent_id: b.id, name: 'unique' },
  });

  expect(patchRes.statusCode).toBe(200);
  expect(patchRes.json()).toMatchObject({ parent_id: b.id, name: 'unique' });

  const bChildren = (
    await built.inject({ method: 'GET', url: `/api/nodes?parent=${b.id}`, cookies: { mirsal_session: session } })
  ).json() as Array<{ name: string }>;
  expect(bChildren.map((n) => n.name).sort()).toEqual(['shared', 'unique']);
});

test('upload larger than MAX_FILE_BYTES -> 413 file_too_large, not silently truncated to 200 (finding #3)', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);

  const oversized = Buffer.alloc(MAX_FILE_BYTES + 1024, 'a');
  const { statusCode, body } = await uploadFile(built, session, csrf, {
    parentId: rootId,
    filename: 'huge.bin',
    data: oversized,
  });

  expect(statusCode).toBe(413);
  expect(body).toMatchObject({ code: 'file_too_large' });

  const rows = db!.prepare("SELECT * FROM nodes WHERE kind = 'file' AND owner_id = ?").all(uid);
  expect(rows).toEqual([]);

  const user = db!.prepare('SELECT used_bytes FROM users WHERE id = ?').get(uid) as { used_bytes: number };
  expect(user.used_bytes).toBe(0);

  const ownerDir = path.join(storageDir!, String(uid));
  if (fs.existsSync(ownerDir)) {
    expect(fs.readdirSync(ownerDir)).toEqual([]);
  }
}, 20_000);

test('rollup size on a pathologically wide live folder is bounded, not an unbounded scan (finding #5)', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);

  const folderInfo = db!
    .prepare(
      `INSERT INTO nodes(owner_id, parent_id, kind, name, size_bytes, created_at, updated_at)
       VALUES (@uid, @rootId, 'folder', 'Wide', 0, @now, @now)`
    )
    .run({ uid, rootId, now: NOW });
  const folderId = Number(folderInfo.lastInsertRowid);

  const insertFile = db!.prepare(
    `INSERT INTO nodes(owner_id, parent_id, kind, name, size_bytes, created_at, updated_at)
     VALUES (@uid, @folderId, 'file', @name, 1, @now, @now)`
  );
  const insertMany = db!.transaction((count: number) => {
    for (let i = 0; i < count; i++) {
      insertFile.run({ uid, folderId, name: `f${i}.txt`, now: NOW });
    }
  });
  const totalFiles = 10_050;
  insertMany(totalFiles);

  const listRes = await built.inject({
    method: 'GET',
    url: `/api/nodes?parent=${rootId}`,
    cookies: { mirsal_session: session },
  });
  expect(listRes.statusCode).toBe(200);
  const wide = (listRes.json() as Array<{ name: string; size_bytes: number }>).find((n) => n.name === 'Wide');
  expect(wide).toBeDefined();

  // The real total would be `totalFiles` (one byte each) — bounded well
  // below that proves the recursive-CTE rollup can't be forced to scan an
  // unbounded number of rows.
  expect(wide!.size_bytes).toBeGreaterThan(0);
  expect(wide!.size_bytes).toBeLessThan(totalFiles);
});

test('POST /api/nodes/trash/empty permanently deletes all trashed nodes, frees quota, and unlinks blobs; leaves live nodes untouched', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);

  // A live file that must survive.
  const liveUp = await uploadFile(built, session, csrf, {
    parentId: rootId,
    filename: 'keep.txt',
    data: Buffer.from('keepme'),
  }); // 6 bytes
  const liveId = liveUp.body.id as number;

  // A folder with a nested file, plus a loose file — both trashed.
  const folderRes = await built.inject({
    method: 'POST',
    url: '/api/nodes/folder',
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { parent_id: rootId, name: 'Box' },
  });
  const folder = folderRes.json();
  const insideUp = await uploadFile(built, session, csrf, { parentId: folder.id, filename: 'inside.txt', data: Buffer.from('hello') }); // 5
  const insideId = insideUp.body.id as number;
  const looseUp = await uploadFile(built, session, csrf, {
    parentId: rootId,
    filename: 'loose.txt',
    data: Buffer.from('worldwide'),
  }); // 9

  await built.inject({ method: 'POST', url: `/api/nodes/${folder.id}/trash`, cookies: { mirsal_session: session }, headers: { 'x-csrf-token': csrf } });
  await built.inject({ method: 'POST', url: `/api/nodes/${looseUp.body.id}/trash`, cookies: { mirsal_session: session }, headers: { 'x-csrf-token': csrf } });

  const usedBefore = (db!.prepare('SELECT used_bytes FROM users WHERE id = ?').get(uid) as { used_bytes: number }).used_bytes;
  expect(usedBefore).toBe(6 + 5 + 9);

  const res = await built.inject({
    method: 'POST',
    url: '/api/nodes/trash/empty',
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().freedBytes).toBe(5 + 9); // the two trashed subtrees, not the live file

  // Trash now empty; live file still listed.
  const trashList = (await built.inject({ method: 'GET', url: '/api/nodes/trash', cookies: { mirsal_session: session } })).json();
  expect(trashList).toEqual([]);
  const rootList = (await built.inject({ method: 'GET', url: '/api/nodes', cookies: { mirsal_session: session } })).json() as Array<{ id: number }>;
  expect(rootList.some((n) => n.id === liveId)).toBe(true);

  // Quota dropped by exactly the trashed bytes; live file's blob still on disk.
  const usedAfter = (db!.prepare('SELECT used_bytes FROM users WHERE id = ?').get(uid) as { used_bytes: number }).used_bytes;
  expect(usedAfter).toBe(6);
  expect(fs.existsSync(path.join(storageDir!, String(uid), String(liveId)))).toBe(true);

  // Trashed blobs must be unlinked.
  expect(fs.existsSync(path.join(storageDir!, String(uid), String(insideId)))).toBe(false);
  expect(fs.existsSync(path.join(storageDir!, String(uid), String(looseUp.body.id)))).toBe(false);
});

test('POST /api/nodes/trash/empty is a no-op 200 on an already-empty trash', async () => {
  const built = await makeApp();
  await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');

  const res = await built.inject({
    method: 'POST',
    url: '/api/nodes/trash/empty',
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().freedBytes).toBe(0);
});

// ---------------------------------------------------------------------------
// ZIP (authenticated, owner-scoped folder subtree) — Collections Phase 4
// ---------------------------------------------------------------------------

test('GET /api/nodes/:id/zip zips an owned folder subtree', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);

  const folderRes = await built.inject({
    method: 'POST',
    url: '/api/nodes/folder',
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { parent_id: rootId, name: 'ZipMe' },
  });
  const folder = folderRes.json();

  await uploadFile(built, session, csrf, { parentId: folder.id, filename: 'a.txt', data: Buffer.from('hello') });
  await uploadFile(built, session, csrf, { parentId: folder.id, filename: 'b.txt', data: Buffer.from('world') });

  const res = await built.inject({
    method: 'GET',
    url: `/api/nodes/${folder.id}/zip`,
    cookies: { mirsal_session: session },
  });

  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('application/zip');
  expect(res.headers['content-disposition']).toMatch(/\.zip/);
});

test('GET /api/nodes/:id/zip on a folder owned by someone else -> 404 (no oracle)', async () => {
  const built = await makeApp();
  const uidA = await seedUser('alice', 'pw');
  await seedUser('bob', 'pw');
  const a = await login(built, 'alice', 'pw');
  const b = await login(built, 'bob', 'pw');
  const rootA = rootIdFor(uidA);

  const folderRes = await built.inject({
    method: 'POST',
    url: '/api/nodes/folder',
    cookies: { mirsal_session: a.session },
    headers: { 'x-csrf-token': a.csrf },
    payload: { parent_id: rootA, name: 'AlicesFolder' },
  });
  const folder = folderRes.json();

  const res = await built.inject({
    method: 'GET',
    url: `/api/nodes/${folder.id}/zip`,
    cookies: { mirsal_session: b.session },
  });
  expect(res.statusCode).toBe(404);
});

test('GET /api/nodes/:id/zip on a file (not a folder) -> 400 not_a_folder', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);

  const upload = await uploadFile(built, session, csrf, {
    parentId: rootId,
    filename: 'plain.txt',
    data: Buffer.from('just a file'),
  });
  const fileId = upload.body.id as number;

  const res = await built.inject({
    method: 'GET',
    url: `/api/nodes/${fileId}/zip`,
    cookies: { mirsal_session: session },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toEqual({ error: 'not_a_folder' });
});

test('GET /api/nodes/:id/zip with a non-integer id -> 404', async () => {
  const built = await makeApp();
  await seedUser('alice', 'pw');
  const { session } = await login(built, 'alice', 'pw');

  const res = await built.inject({
    method: 'GET',
    url: '/api/nodes/abc/zip',
    cookies: { mirsal_session: session },
  });
  expect(res.statusCode).toBe(404);
});

test('GET /api/nodes/:id/zip when a subtree blob is missing on disk -> 404, never hangs', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);

  const folderRes = await built.inject({
    method: 'POST',
    url: '/api/nodes/folder',
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { parent_id: rootId, name: 'ZipMe' },
  });
  const folder = folderRes.json();

  const upload = await uploadFile(built, session, csrf, { parentId: folder.id, filename: 'ghost.txt', data: Buffer.from('will vanish') });
  const nodeId = upload.body.id as number;
  // Reverse-orphan: the row exists but its blob is gone (the exact end state
  // Defect A could produce). /zip must fail cleanly like /download's ENOENT->404,
  // not hang on the archiver's never-surfaced source-stream ENOENT — a hang here
  // also strands a MAX_CONCURRENT_NODE_ZIPS slot forever (Defect B).
  fs.unlinkSync(path.join(storageDir!, String(uid), String(nodeId)));

  const res = await built.inject({
    method: 'GET',
    url: `/api/nodes/${folder.id}/zip`,
    cookies: { mirsal_session: session },
  });
  expect(res.statusCode).toBe(404);
  expect(res.json()).toEqual({ error: 'not_found' });
}, 10_000);

test('POST /api/nodes/trash/empty is owner-scoped — never touches another user\'s trash', async () => {
  const built = await makeApp();
  const aliceId = await seedUser('alice', 'pw');
  const bobId = await seedUser('bob', 'pw');
  const alice = await login(built, 'alice', 'pw');
  const bob = await login(built, 'bob', 'pw');

  // Bob trashes a file.
  const bobUp = await uploadFile(built, bob.session, bob.csrf, { parentId: rootIdFor(bobId), filename: 'b.txt', data: Buffer.from('bob') });
  await built.inject({ method: 'POST', url: `/api/nodes/${bobUp.body.id}/trash`, cookies: { mirsal_session: bob.session }, headers: { 'x-csrf-token': bob.csrf } });

  // Alice empties HER trash (empty) — Bob's trashed file must remain.
  const aliceEmptyRes = await built.inject({ method: 'POST', url: '/api/nodes/trash/empty', cookies: { mirsal_session: alice.session }, headers: { 'x-csrf-token': alice.csrf } });
  expect(aliceEmptyRes.statusCode).toBe(200);

  const bobTrash = (await built.inject({ method: 'GET', url: '/api/nodes/trash', cookies: { mirsal_session: bob.session } })).json() as Array<{ id: number }>;
  expect(bobTrash.some((n) => n.id === bobUp.body.id)).toBe(true);
  expect(aliceId).not.toBe(bobId);
});
