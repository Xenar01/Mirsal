import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { GRACE_MS as REAL_GRACE_MS } from '../../src/config.js';
import { runTick, startScheduler, stopScheduler } from '../../src/scheduler/runner.js';

let db: Database.Database | undefined;
let dbDir: string | undefined;
let storageDir: string;

// Distinct from the real 7-day GRACE_MS constant so purge_after math in
// tests is easy to assert without colliding with the module's own default.
const TEST_GRACE_MS = 1000 * 60 * 60;
const cfg = () => ({ GRACE_MS: TEST_GRACE_MS, STORAGE_DIR: storageDir });

// The bare `deleteBlob` import inside runner.ts resolves against a
// lazily-initialized default BlobStore built from loadConfig() on first use
// (src/storage/blobs.ts), and that default store is cached for the lifetime
// of this test file's module registry. So every test in this file must agree
// on one physical STORAGE_DIR (set via process.env before any test runs, and
// also passed as the injected cfg.STORAGE_DIR), even though each test still
// gets its own fresh temp DB.
const envKeys = ['DB_PATH', 'STORAGE_DIR', 'SESSION_SECRET', 'CSRF_SECRET', 'PUBLIC_BASE_URL'] as const;
const originalEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const key of envKeys) originalEnv[key] = process.env[key];
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-g2-storage-'));
  process.env.DB_PATH = '/tmp/mirsal-g2-test/db.sqlite';
  process.env.STORAGE_DIR = storageDir;
  process.env.SESSION_SECRET = 'a'.repeat(32);
  process.env.CSRF_SECRET = 'b'.repeat(32);
  process.env.PUBLIC_BASE_URL = 'https://mirsal.example.com';
});

afterAll(() => {
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  fs.rmSync(storageDir, { recursive: true, force: true });
});

beforeEach(() => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-g2-db-'));
  const dbPath = path.join(dbDir, 't.db');
  db = openDb(dbPath);
  migrate(db);
});

afterEach(() => {
  stopScheduler();
  vi.useRealTimers();
  db?.close();
  db = undefined;
  if (dbDir) {
    fs.rmSync(dbDir, { recursive: true, force: true });
    dbDir = undefined;
  }
});

/** Inserts a user row directly, satisfying every NOT NULL column, and returns its id. */
function seedUser(usedBytes = 0): number {
  const t = Date.now();
  const info = db!
    .prepare(
      `INSERT INTO users(username, password_hash, role, is_active, must_change_password, used_bytes, created_at, updated_at)
       VALUES (?, 'x', 'user', 1, 0, ?, ?, ?)`
    )
    .run(`user-${Math.random()}`, usedBytes, t, t);
  return Number(info.lastInsertRowid);
}

function insertNode(row: {
  ownerId: number;
  parentId: number | null;
  kind?: 'root' | 'trash' | 'folder' | 'file';
  name: string;
  sizeBytes?: number;
  storagePath?: string | null;
  trashedAt?: number | null;
  autoDeleteAt?: number | null;
  purgeAfter?: number | null;
}): number {
  const t = Date.now();
  const info = db!
    .prepare(
      `INSERT INTO nodes(owner_id, parent_id, kind, name, size_bytes, storage_path, trashed_at, auto_delete_at, purge_after, created_at, updated_at)
       VALUES (@ownerId, @parentId, @kind, @name, @sizeBytes, @storagePath, @trashedAt, @autoDeleteAt, @purgeAfter, @t, @t)`
    )
    .run({
      ownerId: row.ownerId,
      parentId: row.parentId,
      kind: row.kind ?? 'file',
      name: row.name,
      sizeBytes: row.sizeBytes ?? 0,
      storagePath: row.storagePath ?? null,
      trashedAt: row.trashedAt ?? null,
      autoDeleteAt: row.autoDeleteAt ?? null,
      purgeAfter: row.purgeAfter ?? null,
      t,
    });
  return Number(info.lastInsertRowid);
}

function readNode(id: number): { trashed_at: number | null; purge_after: number | null } {
  return db!
    .prepare('SELECT trashed_at, purge_after FROM nodes WHERE id = ?')
    .get(id) as { trashed_at: number | null; purge_after: number | null };
}

function nodeExists(id: number): boolean {
  return db!.prepare('SELECT 1 FROM nodes WHERE id = ?').get(id) !== undefined;
}

function usedBytesOf(uid: number): number {
  const row = db!.prepare('SELECT used_bytes FROM users WHERE id = ?').get(uid) as {
    used_bytes: number;
  };
  return row.used_bytes;
}

let blobSeq = 0;
/** Writes a real blob file under the shared test STORAGE_DIR at a unique relative path. */
function writeBlob(content = 'x'): string {
  const rel = `g2-${blobSeq++}/1`;
  const abs = path.join(storageDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return rel;
}

function blobExists(rel: string): boolean {
  return fs.existsSync(path.join(storageDir, rel));
}

// --- auto-trash --------------------------------------------------------------

test('runTick trashes a due live node and stamps purge_after = now + GRACE_MS', async () => {
  const uid = seedUser();
  const now = Date.now();
  const id = insertNode({ ownerId: uid, parentId: null, name: 'due', autoDeleteAt: now - 1 });

  const result = await runTick(db!, now, cfg());

  expect(result).toEqual({ trashed: 1, purged: 0 });
  const node = readNode(id);
  expect(node.trashed_at).toBe(now);
  expect(node.purge_after).toBe(now + TEST_GRACE_MS);
});

// --- purge + blob removal ------------------------------------------------------

test('runTick purges a due-trashed node: rows gone, blob unlinked, used_bytes decremented', async () => {
  const uid = seedUser(50);
  const now = Date.now();
  const rel = writeBlob('x'.repeat(50));
  const id = insertNode({
    ownerId: uid,
    parentId: null,
    name: 'stale',
    sizeBytes: 50,
    storagePath: rel,
    trashedAt: now - 1000,
    purgeAfter: now - 1,
  });

  const result = await runTick(db!, now, cfg());

  expect(result).toEqual({ trashed: 0, purged: 1 });
  expect(nodeExists(id)).toBe(false);
  expect(blobExists(rel)).toBe(false);
  expect(usedBytesOf(uid)).toBe(0);
});

// --- reentrancy ---------------------------------------------------------------

test('two overlapping runTick calls over the same due set: exactly one performs the deletion', async () => {
  const uid = seedUser(10);
  const now = Date.now();
  const rel = writeBlob();
  const id = insertNode({
    ownerId: uid,
    parentId: null,
    name: 'stale',
    sizeBytes: 10,
    storagePath: rel,
    trashedAt: now - 1000,
    purgeAfter: now - 1,
  });

  const a = runTick(db!, now, cfg());
  const b = runTick(db!, now, cfg());
  const results = await Promise.all([a, b]);

  expect(results).toContainEqual({ trashed: 0, purged: 1 });
  expect(results).toContainEqual({ trashed: 0, purged: 0 });
  expect(nodeExists(id)).toBe(false);
  expect(blobExists(rel)).toBe(false);
});

// --- crash-after-commit sim ----------------------------------------------------

test('a blob left behind by a crash-after-commit is reclaimed by the orphan sweep', async () => {
  const uid = seedUser();
  const now = Date.now();
  const rel = writeBlob();
  const id = insertNode({ ownerId: uid, parentId: null, name: 'ghost', storagePath: rel });
  // Simulate a crash between the permanentDelete commit and the blob unlink:
  // the row is gone but the blob file is still on disk.
  db!.prepare('DELETE FROM nodes WHERE id = ?').run(id);
  expect(blobExists(rel)).toBe(true);

  const result = await runTick(db!, now, cfg());

  expect(result).toEqual({ trashed: 0, purged: 0 });
  expect(blobExists(rel)).toBe(false);
});

// --- 2-arg lazy default cfg ----------------------------------------------------

test('runTick falls back to loadConfig()/the real GRACE_MS when no cfg is passed', async () => {
  const uid = seedUser();
  const now = Date.now();
  const id = insertNode({ ownerId: uid, parentId: null, name: 'due', autoDeleteAt: now - 1 });

  const result = await runTick(db!, now);

  expect(result).toEqual({ trashed: 1, purged: 0 });
  expect(readNode(id).purge_after).toBe(now + REAL_GRACE_MS);
});

// --- startScheduler / stopScheduler --------------------------------------------

test('startScheduler ticks on each interval; stopScheduler halts further ticks (idempotent)', async () => {
  vi.useFakeTimers();
  const uid = seedUser();
  const now = Date.now();
  const id = insertNode({ ownerId: uid, parentId: null, name: 'due', autoDeleteAt: now - 1 });

  startScheduler(db!, () => now, 1000);
  await vi.advanceTimersByTimeAsync(1000);

  expect(readNode(id).trashed_at).not.toBeNull();

  stopScheduler();
  const stateAfterStop = readNode(id);
  await vi.advanceTimersByTimeAsync(5000);
  expect(readNode(id)).toEqual(stateAfterStop);

  expect(() => stopScheduler()).not.toThrow(); // idempotent
});

test('a tick that throws does not kill the interval — the next tick still runs', async () => {
  vi.useFakeTimers();
  const uid = seedUser();
  const now = Date.now();
  const id = insertNode({ ownerId: uid, parentId: null, name: 'due', autoDeleteAt: now - 1 });

  const originalPrepare = db!.prepare.bind(db!);
  let calls = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).prepare = (...args: Parameters<typeof originalPrepare>) => {
    calls++;
    if (calls === 1) throw new Error('boom');
    return (originalPrepare as (...a: Parameters<typeof originalPrepare>) => ReturnType<typeof originalPrepare>)(
      ...args
    );
  };

  startScheduler(db!, () => now, 1000);
  await vi.advanceTimersByTimeAsync(1000); // first tick: db.prepare throws inside dueTrash
  expect(readNode(id).trashed_at).toBeNull(); // tick failed before mutating anything

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).prepare = originalPrepare;

  await vi.advanceTimersByTimeAsync(1000); // second tick: interval survived, runs normally
  expect(readNode(id).trashed_at).not.toBeNull();

  stopScheduler();
});
