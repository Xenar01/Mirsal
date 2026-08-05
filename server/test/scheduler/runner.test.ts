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
       VALUES (?, 'x', 'user', 1, 0, ?, ?, ?)`,
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
       VALUES (@ownerId, @parentId, @kind, @name, @sizeBytes, @storagePath, @trashedAt, @autoDeleteAt, @purgeAfter, @t, @t)`,
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
  return db!.prepare('SELECT trashed_at, purge_after FROM nodes WHERE id = ?').get(id) as {
    trashed_at: number | null;
    purge_after: number | null;
  };
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

// --- atomicity: trashed_at + purge_after commit together ----------------------

test("auto-trash: if the purge_after stamp fails, trashNode's own change is rolled back too (never half-done)", async () => {
  const uid = seedUser();
  const now = Date.now();
  const id = insertNode({ ownerId: uid, parentId: null, name: 'due', autoDeleteAt: now - 1 });

  const originalPrepare = db!.prepare.bind(db!);

  (db as any).prepare = (sql: string) => {
    if (sql.includes('SET purge_after = @purgeAfter WHERE id = @id')) {
      throw new Error('boom-purge-after');
    }
    return originalPrepare(sql);
  };

  const result = await runTick(db!, now, cfg());

  (db as any).prepare = originalPrepare;

  expect(result).toEqual({ trashed: 0, purged: 0 });
  const node = readNode(id);
  // Rolled back atomically: NOT stranded half-trashed (trashed_at set but
  // purge_after still NULL, which would be invisible to both dueTrash and
  // duePurge forever). The node is left exactly as it was: fully live.
  expect(node.trashed_at).toBeNull();
  expect(node.purge_after).toBeNull();

  // Prove it isn't stranded: an ordinary subsequent tick fully trashes it.
  const result2 = await runTick(db!, now, cfg());
  expect(result2).toEqual({ trashed: 1, purged: 0 });
  const node2 = readNode(id);
  expect(node2.trashed_at).toBe(now);
  expect(node2.purge_after).toBe(now + TEST_GRACE_MS);
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

// --- blob-unlink fault tolerance -----------------------------------------------

test('a single non-ENOENT deleteBlob failure does not abort remaining unlinks, skip the orphan sweep, or reject runTick', async () => {
  const uid = seedUser();
  const now = Date.now();

  // A due-purge node whose "blob" is actually a directory on disk: unlinkSync
  // on a directory throws EISDIR — a non-ENOENT failure — simulating one bad
  // unlink among several collected paths.
  const badRel = `g2-bad-${blobSeq++}`;
  fs.mkdirSync(path.join(storageDir, badRel), { recursive: true });
  const badId = insertNode({
    ownerId: uid,
    parentId: null,
    name: 'bad',
    storagePath: badRel,
    trashedAt: now - 1000,
    purgeAfter: now - 1,
  });

  // A second, ordinary due-purge node with a real blob file.
  const goodRel = writeBlob();
  const goodId = insertNode({
    ownerId: uid,
    parentId: null,
    name: 'good',
    storagePath: goodRel,
    trashedAt: now - 1000,
    purgeAfter: now - 1,
  });

  // An unrelated orphan blob (no node row) — proves the orphan sweep still
  // runs after the earlier deleteBlob failure.
  const orphanRel = writeBlob();

  await expect(runTick(db!, now, cfg())).resolves.toEqual({ trashed: 0, purged: 2 });

  expect(nodeExists(badId)).toBe(false); // DB row purged regardless of unlink outcome
  expect(nodeExists(goodId)).toBe(false);
  expect(fs.existsSync(path.join(storageDir, badRel))).toBe(true); // failed unlink left in place, not fatal
  expect(blobExists(goodRel)).toBe(false); // remaining unlink still succeeded
  expect(blobExists(orphanRel)).toBe(false); // orphan sweep still ran to completion
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

// --- orphan sweep: batch cap + yielding -----------------------------------------

test('orphan sweep caps unlinks at the configured batch size per tick; the remainder is swept on later ticks', async () => {
  seedUser();
  const now = Date.now();
  const rels = [writeBlob(), writeBlob(), writeBlob(), writeBlob(), writeBlob()];
  const smallBatchCfg = { ...cfg(), ORPHAN_BATCH: 2 };

  await runTick(db!, now, smallBatchCfg);
  expect(rels.filter((r) => blobExists(r)).length).toBe(3); // only 2 of 5 removed

  await runTick(db!, now, smallBatchCfg);
  expect(rels.filter((r) => blobExists(r)).length).toBe(1); // 2 more removed

  await runTick(db!, now, smallBatchCfg);
  expect(rels.every((r) => !blobExists(r))).toBe(true); // last one removed
});

test('orphan sweep yields to the event loop between unlinks instead of running as one blocking synchronous burst', async () => {
  seedUser();
  const now = Date.now();
  const rels = [writeBlob(), writeBlob(), writeBlob()];

  const setImmediateSpy = vi.spyOn(global, 'setImmediate');
  const result = await runTick(db!, now, cfg());
  const yieldCalls = setImmediateSpy.mock.calls.length;
  setImmediateSpy.mockRestore();

  expect(result).toEqual({ trashed: 0, purged: 0 });
  expect(rels.every((r) => !blobExists(r))).toBe(true);
  // One explicit event-loop yield per swept orphan — proves the sweep
  // interleaves with other pending macrotasks instead of unlinking
  // everything in one unbroken synchronous pass.
  expect(yieldCalls).toBe(rels.length);
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

  (db as any).prepare = (...args: Parameters<typeof originalPrepare>) => {
    calls++;
    if (calls === 1) throw new Error('boom');
    return (originalPrepare as (...a: Parameters<typeof originalPrepare>) => ReturnType<typeof originalPrepare>)(
      ...args,
    );
  };

  startScheduler(db!, () => now, 1000);
  await vi.advanceTimersByTimeAsync(1000); // first tick: db.prepare throws inside dueTrash
  expect(readNode(id).trashed_at).toBeNull(); // tick failed before mutating anything

  (db as any).prepare = originalPrepare;

  await vi.advanceTimersByTimeAsync(1000); // second tick: interval survived, runs normally
  expect(readNode(id).trashed_at).not.toBeNull();

  stopScheduler();
});
