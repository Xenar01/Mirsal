import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { dueTrash, duePurge, orphanBlobs } from '../../src/scheduler/selectors.js';

/** Drains the `orphanBlobs` async generator into a sorted array of relative paths. */
async function collectOrphans(iter: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const rel of iter) out.push(rel);
  return out.sort();
}

let db: Database.Database | undefined;
let dir: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-g1-'));
  const dbPath = path.join(dir, 't.db');
  db = openDb(dbPath);
  migrate(db);
});

afterEach(() => {
  db?.close();
  db = undefined;
  if (dir) {
    fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

/** Inserts a user row directly, satisfying every NOT NULL column, and returns its id. */
function seedUser(): number {
  const t = Date.now();
  const info = db!
    .prepare(
      `INSERT INTO users(username, password_hash, role, is_active, must_change_password, used_bytes, created_at, updated_at)
       VALUES (?, 'x', 'user', 1, 0, 0, ?, ?)`,
    )
    .run(`user-${Math.random()}`, t, t);
  return Number(info.lastInsertRowid);
}

function insertNode(row: {
  ownerId: number;
  parentId: number | null;
  kind?: 'root' | 'trash' | 'folder' | 'file';
  name: string;
  storagePath?: string | null;
  trashedAt?: number | null;
  autoDeleteAt?: number | null;
  purgeAfter?: number | null;
}): number {
  const t = Date.now();
  const info = db!
    .prepare(
      `INSERT INTO nodes(owner_id, parent_id, kind, name, storage_path, trashed_at, auto_delete_at, purge_after, created_at, updated_at)
       VALUES (@ownerId, @parentId, @kind, @name, @storagePath, @trashedAt, @autoDeleteAt, @purgeAfter, @t, @t)`,
    )
    .run({
      ownerId: row.ownerId,
      parentId: row.parentId,
      kind: row.kind ?? 'file',
      name: row.name,
      storagePath: row.storagePath ?? null,
      trashedAt: row.trashedAt ?? null,
      autoDeleteAt: row.autoDeleteAt ?? null,
      purgeAfter: row.purgeAfter ?? null,
      t,
    });
  return Number(info.lastInsertRowid);
}

// --- dueTrash ---------------------------------------------------------------

test('dueTrash returns only live nodes whose auto_delete_at has arrived', () => {
  const uid = seedUser();
  const now = Date.now();

  const due = insertNode({ ownerId: uid, parentId: null, name: 'due', autoDeleteAt: now - 1 });
  insertNode({ ownerId: uid, parentId: null, name: 'not-due', autoDeleteAt: now + 1000 });
  insertNode({
    ownerId: uid,
    parentId: null,
    name: 'already-trashed',
    autoDeleteAt: now - 1,
    trashedAt: now - 500,
  });
  insertNode({ ownerId: uid, parentId: null, name: 'never', autoDeleteAt: null });

  const result = dueTrash(db!, now, 10);

  expect(result.map((n) => n.id)).toEqual([due]);
});

test('dueTrash respects limit over several due rows', () => {
  const uid = seedUser();
  const now = Date.now();

  insertNode({ ownerId: uid, parentId: null, name: 'due-1', autoDeleteAt: now - 3 });
  insertNode({ ownerId: uid, parentId: null, name: 'due-2', autoDeleteAt: now - 2 });
  insertNode({ ownerId: uid, parentId: null, name: 'due-3', autoDeleteAt: now - 1 });

  const result = dueTrash(db!, now, 1);

  expect(result).toHaveLength(1);
});

test('dueTrash returns full node rows', () => {
  const uid = seedUser();
  const now = Date.now();
  const due = insertNode({ ownerId: uid, parentId: null, name: 'due', autoDeleteAt: now - 1 });

  const result = dueTrash(db!, now, 10);

  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ id: due, name: 'due', owner_id: uid });
});

// --- duePurge ---------------------------------------------------------------

test('duePurge returns only trashed nodes whose purge_after has elapsed', () => {
  const uid = seedUser();
  const now = Date.now();

  const due = insertNode({
    ownerId: uid,
    parentId: null,
    name: 'due-purge',
    trashedAt: now - 1000,
    purgeAfter: now - 1,
  });
  insertNode({
    ownerId: uid,
    parentId: null,
    name: 'not-due-purge',
    trashedAt: now - 1000,
    purgeAfter: now + 1000,
  });
  insertNode({
    ownerId: uid,
    parentId: null,
    name: 'manual-trash',
    trashedAt: now - 1000,
    purgeAfter: null,
  });

  const result = duePurge(db!, now, 10);

  expect(result.map((n) => n.id)).toEqual([due]);
});

test('duePurge respects limit over several due rows', () => {
  const uid = seedUser();
  const now = Date.now();

  insertNode({ ownerId: uid, parentId: null, name: 'p-1', trashedAt: now - 1000, purgeAfter: now - 3 });
  insertNode({ ownerId: uid, parentId: null, name: 'p-2', trashedAt: now - 1000, purgeAfter: now - 2 });
  insertNode({ ownerId: uid, parentId: null, name: 'p-3', trashedAt: now - 1000, purgeAfter: now - 1 });

  const result = duePurge(db!, now, 1);

  expect(result).toHaveLength(1);
});

// --- orphanBlobs ---------------------------------------------------------------

test('orphanBlobs returns blob files with no matching nodes.storage_path row, skipping .tmp- entries', async () => {
  const uid = seedUser();
  insertNode({ ownerId: uid, parentId: null, name: 'n1', storagePath: 'u1/n1' });
  // No node row for u1/n2 → orphan.

  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-g1-storage-'));
  const ownerDir = path.join(storageDir, 'u1');
  fs.mkdirSync(ownerDir, { recursive: true });
  fs.writeFileSync(path.join(ownerDir, 'n1'), 'matched');
  fs.writeFileSync(path.join(ownerDir, 'n2'), 'orphan');
  fs.writeFileSync(path.join(ownerDir, '.tmp-abc'), 'in-flight upload');

  try {
    const result = await collectOrphans(orphanBlobs(db!, storageDir));
    expect(result).toEqual(['u1/n2']);
  } finally {
    fs.rmSync(storageDir, { recursive: true, force: true });
  }
});

test('orphanBlobs yields nothing when nothing is orphaned', async () => {
  const uid = seedUser();
  insertNode({ ownerId: uid, parentId: null, name: 'n1', storagePath: 'u1/n1' });

  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-g1-storage-'));
  const ownerDir = path.join(storageDir, 'u1');
  fs.mkdirSync(ownerDir, { recursive: true });
  fs.writeFileSync(path.join(ownerDir, 'n1'), 'matched');

  try {
    const result = await collectOrphans(orphanBlobs(db!, storageDir));
    expect(result).toEqual([]);
  } finally {
    fs.rmSync(storageDir, { recursive: true, force: true });
  }
});

test('orphanBlobs skips non-directory entries directly under storageDir', async () => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-g1-storage-'));
  fs.writeFileSync(path.join(storageDir, 'stray-file'), 'not an owner dir');

  try {
    await expect(collectOrphans(orphanBlobs(db!, storageDir))).resolves.toEqual([]);
  } finally {
    fs.rmSync(storageDir, { recursive: true, force: true });
  }
});

test('orphanBlobs tolerates a missing storageDir and yields nothing', async () => {
  const missingDir = path.join(os.tmpdir(), `mirsal-g1-missing-${Math.random()}`);

  expect(await collectOrphans(orphanBlobs(db!, missingDir))).toEqual([]);
});

test('orphanBlobs walks a large STORAGE_DIR without one unbroken synchronous burst — it yields to the event loop during enumeration and still finds every orphan', async () => {
  // Many more files than the injected yield window, so the walk is forced to
  // hand the event loop several turns *during enumeration* rather than
  // scanning every entry in one unbroken synchronous burst — the exact hazard
  // the original finding named: an uncapped readdirSync + per-file DB lookup
  // blocking the loop for a duration proportional to total stored files. None
  // of these files has a node row → all are orphans, so correctness (every
  // orphan still found) is asserted alongside the yielding.
  const FILE_COUNT = 250;
  const YIELD_EVERY = 50;

  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-g1-storage-'));
  const ownerDir = path.join(storageDir, 'u1');
  fs.mkdirSync(ownerDir, { recursive: true });
  const expected: string[] = [];
  for (let i = 0; i < FILE_COUNT; i++) {
    fs.writeFileSync(path.join(ownerDir, `f${i}`), 'orphan');
    expected.push(`u1/f${i}`);
  }

  const setImmediateSpy = vi.spyOn(global, 'setImmediate');
  try {
    const result = await collectOrphans(orphanBlobs(db!, storageDir, { yieldEvery: YIELD_EVERY }));

    expect(result).toEqual(expected.sort());
    // These setImmediate calls are the walk's own event-loop yields (nothing
    // else in this test schedules one): ~FILE_COUNT/YIELD_EVERY of them, so
    // the enumeration demonstrably broke into multiple yielded chunks rather
    // than running as one blocking pass. (`- 1` tolerates the final partial
    // window not reaching the threshold.)
    expect(setImmediateSpy.mock.calls.length).toBeGreaterThanOrEqual(Math.floor(FILE_COUNT / YIELD_EVERY) - 1);
  } finally {
    setImmediateSpy.mockRestore();
    fs.rmSync(storageDir, { recursive: true, force: true });
  }
});
