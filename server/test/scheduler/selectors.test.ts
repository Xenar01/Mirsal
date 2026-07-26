import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { dueTrash, duePurge, orphanBlobs } from '../../src/scheduler/selectors.js';

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
       VALUES (?, 'x', 'user', 1, 0, 0, ?, ?)`
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
       VALUES (@ownerId, @parentId, @kind, @name, @storagePath, @trashedAt, @autoDeleteAt, @purgeAfter, @t, @t)`
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

test('orphanBlobs returns blob files with no matching nodes.storage_path row, skipping .tmp- entries', () => {
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
    const result = orphanBlobs(db!, storageDir);
    expect(result).toEqual(['u1/n2']);
  } finally {
    fs.rmSync(storageDir, { recursive: true, force: true });
  }
});

test('orphanBlobs returns [] when nothing is orphaned', () => {
  const uid = seedUser();
  insertNode({ ownerId: uid, parentId: null, name: 'n1', storagePath: 'u1/n1' });

  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-g1-storage-'));
  const ownerDir = path.join(storageDir, 'u1');
  fs.mkdirSync(ownerDir, { recursive: true });
  fs.writeFileSync(path.join(ownerDir, 'n1'), 'matched');

  try {
    const result = orphanBlobs(db!, storageDir);
    expect(result).toEqual([]);
  } finally {
    fs.rmSync(storageDir, { recursive: true, force: true });
  }
});

test('orphanBlobs skips non-directory entries directly under storageDir', () => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-g1-storage-'));
  fs.writeFileSync(path.join(storageDir, 'stray-file'), 'not an owner dir');

  try {
    expect(() => orphanBlobs(db!, storageDir)).not.toThrow();
    expect(orphanBlobs(db!, storageDir)).toEqual([]);
  } finally {
    fs.rmSync(storageDir, { recursive: true, force: true });
  }
});

test('orphanBlobs tolerates a missing storageDir and returns []', () => {
  const missingDir = path.join(os.tmpdir(), `mirsal-g1-missing-${Math.random()}`);

  expect(orphanBlobs(db!, missingDir)).toEqual([]);
});
