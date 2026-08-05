/**
 * THROWAWAY E2E sweep for Mirsal Collections Phase 4 (public collect-intake ->
 * owner ZIP download). Left in place intentionally (NOT deleted) because it
 * reproduces a REAL, deterministic defect — see the sweep report at
 * /var/www/projects/mirsal/.superpowers/sdd/2026-08-05-mirsal-collections-phase4/e2e-sweep-report.md
 *
 * Defect summary: `nodes.id` is a plain `INTEGER PRIMARY KEY` (no
 * AUTOINCREMENT), so SQLite is free to reuse a freed rowid. In the
 * "latest-replaces" submit path (src/routes/collect.ts +
 * src/collections/responses.ts), when a department's prior file rows happen
 * to hold the CURRENT highest ids in the whole `nodes` table, the
 * delete-then-insert (both inside one transaction) can hand the brand-new
 * replacement files the SAME ids as the just-deleted old files — which means
 * the same `storage_path` (`${ownerId}/${nodeId}`). The route then runs
 * `commitTemp` for the new files (rename temp blob into place) BEFORE
 * `deleteBlob` for `removedStoragePaths` (the OLD paths, captured
 * pre-insert) — so when the ids collide, the cleanup step deletes the blob
 * it just wrote. The DB ends up with correct-looking rows (right
 * `file_count`, right names) pointing at storage paths that no longer exist
 * on disk — a silent, invisible reverse-orphan every time a department
 * resubmits under ordinary, non-adversarial conditions (nothing exotic
 * required; see Test A below for the exact reproduction).
 *
 * Compounding bug: `GET /api/nodes/:id/zip` does not handle a missing blob
 * at all — unlike `/api/nodes/:id/download`, which explicitly maps ENOENT to
 * a clean 404 (see src/routes/nodes.ts around the `/download` handler), the
 * `/zip` handler's `archive.append(blobStore.readBlob(...), ...)` never
 * surfaces the source stream's ENOENT as the archiver's own 'error' event,
 * so the request hangs indefinitely instead of failing — see Test B below.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { createPasswordService } from '../src/auth/passwords.js';

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
  process.env.DB_PATH = '/tmp/mirsal-e2e-p4-test/db.sqlite';
  process.env.STORAGE_DIR = '/tmp/mirsal-e2e-p4-test/storage';
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

async function makeApp(): Promise<{ built: FastifyInstance; storageDir: string }> {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-e2e-p4-'));
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
  return { built: app, storageDir };
}

async function seedUser(username: string): Promise<number> {
  const hash = await createPasswordService(TEST_ARGON).hashPassword('pw');
  const info = db!
    .prepare(
      `INSERT INTO users(username,password_hash,role,is_active,must_change_password,quota_bytes,created_at,updated_at)
       VALUES (?, ?, 'user', 1, 0, NULL, ?, ?)`
    )
    .run(username, hash, NOW, NOW);
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

async function makeCollection(built: FastifyInstance, session: string, csrf: string, payload: Record<string, unknown>) {
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

async function getCollectionDetail(built: FastifyInstance, session: string, id: number) {
  const res = await built.inject({
    method: 'GET',
    url: `/api/collections/${id}`,
    cookies: { mirsal_session: session },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

interface MultipartPart {
  name: string;
  value?: string;
  filename?: string;
  contentType?: string;
  data?: Buffer;
}
function buildMultipart(parts: MultipartPart[]): { body: Buffer; contentType: string } {
  const boundary = `----mirsalE2E${Math.random().toString(16).slice(2)}`;
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
async function submit(built: FastifyInstance, token: string, parts: MultipartPart[]) {
  const { body, contentType } = buildMultipart(parts);
  return built.inject({ method: 'POST', url: `/api/collect/${token}/submit`, headers: { 'content-type': contentType }, payload: body });
}

function deptIds(collectionId: number): { id: number; name: string }[] {
  return db!.prepare('SELECT id, name FROM collection_departments WHERE collection_id=? ORDER BY position').all(collectionId) as { id: number; name: string }[];
}

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"

// ---------------------------------------------------------------------------
// Test A — root cause: latest-replaces destroys the blobs it just committed
// whenever SQLite reuses a freed rowid for one of the replacement files.
// Fails FAST (no hang) with a clear diagnostic.
// ---------------------------------------------------------------------------
test('BUG: collect-intake latest-replaces can delete the blobs it just wrote (rowid reuse collides storage_path)', async () => {
  const { built, storageDir } = await makeApp();
  await seedUser('alice');
  const ownerA = await login(built, 'alice');

  const c = await makeCollection(built, ownerA.session, ownerA.csrf, {
    title: 'Phase4 Repro', departments: ['Dept1', 'Dept2'],
  });
  const [dept1, dept2] = deptIds(c.id);

  // dept1 gets one file (keeps the table's max-id churn realistic).
  const s1 = await submit(built, c.token, [
    { name: 'departmentId', value: String(dept1.id) },
    { name: 'files', filename: 'a.txt', data: Buffer.from('AAA-dept1') },
  ]);
  expect(s1.statusCode).toBe(200);

  // dept2's FIRST submission: 3 files. These become the table's current
  // highest-numbered rows (nothing else creates a node afterward).
  const s3 = await submit(built, c.token, [
    { name: 'departmentId', value: String(dept2.id) },
    { name: 'files', filename: 'b1.txt', data: Buffer.from('BBB-1') },
    { name: 'files', filename: 'b2.txt', data: Buffer.from('BBB-2') },
    { name: 'files', filename: 'b3.txt', data: Buffer.from('BBB-3') },
  ]);
  expect(s3.statusCode).toBe(200);

  // dept2 RESUBMITS (latest-replaces) with 2 different files — the ordinary,
  // expected UX for a department correcting/updating its response.
  const replace = await submit(built, c.token, [
    { name: 'departmentId', value: String(dept2.id) },
    { name: 'files', filename: 'c1.txt', data: Buffer.from('CCC-1') },
    { name: 'files', filename: 'c2.txt', data: Buffer.from('CCC-2') },
  ]);
  expect(replace.statusCode).toBe(200); // API reports success...

  // ...but the DB's own storage_path for the CURRENT files may point at
  // blobs that were deleted out from under them. Check every file node the
  // DB currently claims to exist and assert its blob is actually on disk —
  // this is the load-bearing assertion. It is expected to FAIL, proving the
  // corruption directly (not via a hang).
  const currentFiles = db!.prepare("SELECT id, name, storage_path FROM nodes WHERE kind='file' AND storage_path IS NOT NULL").all() as {
    id: number; name: string; storage_path: string;
  }[];
  const missing = currentFiles.filter((f) => !fs.existsSync(path.join(storageDir, f.storage_path)));

  if (missing.length > 0) {
    console.error(
      `[BUG CONFIRMED] ${missing.length}/${currentFiles.length} live file node(s) have NO blob on disk after latest-replaces:`,
      JSON.stringify(missing)
    );
  }
  expect(missing).toEqual([]); // FAILS on the current code: c1.txt/c2.txt's blobs were deleted by the stale removedStoragePaths cleanup.
}, 15_000);

// ---------------------------------------------------------------------------
// Test B — compounding robustness bug: GET /api/nodes/:id/zip hangs
// indefinitely (never resolves) on a subtree file whose blob is missing,
// instead of 404ing like /api/nodes/:id/download does. Reproduced directly
// (fs.unlink the blob) so it doesn't depend on Test A's rowid-reuse timing.
// Bounded with Promise.race so a real defect reports in ~3s, not the full
// suite/global timeout.
// ---------------------------------------------------------------------------
test('BUG: GET /api/nodes/:id/zip hangs (never resolves) instead of 404ing when a subtree blob is missing', async () => {
  const { built, storageDir } = await makeApp();
  const uid = await seedUser('alice');
  const { session, csrf } = await login(built, 'alice');

  const rootRes = await built.inject({ method: 'GET', url: '/api/nodes', cookies: { mirsal_session: session } });
  expect(rootRes.statusCode).toBe(200);

  const folderRes = await built.inject({
    method: 'POST', url: '/api/nodes/folder',
    cookies: { mirsal_session: session }, headers: { 'x-csrf-token': csrf },
    payload: { name: 'ZipMe' },
  });
  const folder = folderRes.json();

  const boundary = '----orphan';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="parent_id"\r\n\r\n${folder.id}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ghost.txt"\r\nContent-Type: text/plain\r\n\r\n`),
    Buffer.from('will vanish'),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const upload = await built.inject({
    method: 'POST', url: '/api/nodes/upload',
    cookies: { mirsal_session: session }, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-csrf-token': csrf },
    payload: body,
  });
  expect(upload.statusCode).toBe(200);
  const nodeId = upload.json().id as number;

  // Simulate a reverse-orphan directly (this is exactly the end state Test A
  // proves the collect-intake replace flow can also produce on its own).
  fs.unlinkSync(path.join(storageDir, String(uid), String(nodeId)));

  const TIMEOUT_MS = 3000;
  let timedOut = false;
  const zipPromise = built.inject({ method: 'GET', url: `/api/nodes/${folder.id}/zip`, cookies: { mirsal_session: session } });
  const timeoutPromise = new Promise<'timeout'>((resolve) => setTimeout(() => { timedOut = true; resolve('timeout'); }, TIMEOUT_MS));
  const raced = await Promise.race([zipPromise, timeoutPromise]);
  // Swallow whatever the still-pending inject() eventually does (its temp
  // storage dir gets rmSync'd by afterEach while it may still be trying to
  // read from it — an expected, harmless side effect of racing it out).
  zipPromise.catch(() => {});

  if (timedOut) {
    console.error(`[BUG CONFIRMED] GET /api/nodes/:id/zip did not resolve within ${TIMEOUT_MS}ms for a folder with a missing blob (expected: fast 404, like /download).`);
  }
  expect(raced).not.toBe('timeout'); // FAILS on the current code: never resolves within the window.
}, 15_000);
