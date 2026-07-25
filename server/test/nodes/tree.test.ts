import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { createFolder, ensureUserRoots, listChildren, rollupSize } from '../../src/nodes/tree.js';

let db: Database.Database | undefined;
let dir: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-e1-'));
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
      `INSERT INTO users(username, password_hash, role, is_active, must_change_password, created_at, updated_at)
       VALUES (?, 'x', 'user', 1, 0, ?, ?)`
    )
    .run(`user-${Math.random()}`, t, t);
  return Number(info.lastInsertRowid);
}

function insertNode(row: {
  ownerId: number;
  parentId: number | null;
  kind: 'root' | 'trash' | 'folder' | 'file';
  name: string;
  sizeBytes?: number;
  trashedAt?: number | null;
}): number {
  const t = Date.now();
  const info = db!
    .prepare(
      `INSERT INTO nodes(owner_id, parent_id, kind, name, size_bytes, trashed_at, created_at, updated_at)
       VALUES (@ownerId, @parentId, @kind, @name, @sizeBytes, @trashedAt, @t, @t)`
    )
    .run({
      ownerId: row.ownerId,
      parentId: row.parentId,
      kind: row.kind,
      name: row.name,
      sizeBytes: row.sizeBytes ?? 0,
      trashedAt: row.trashedAt ?? null,
      t,
    });
  return Number(info.lastInsertRowid);
}

test('ensureUserRoots is idempotent: calling twice returns identical ids and creates only 2 rows', () => {
  const uid = seedUser();
  const now = Date.now();

  const first = ensureUserRoots(db!, uid, now);
  const second = ensureUserRoots(db!, uid, now);

  expect(second).toEqual(first);
  expect(typeof first.rootId).toBe('number');
  expect(typeof first.trashId).toBe('number');

  const count = db!
    .prepare("SELECT COUNT(*) AS c FROM nodes WHERE owner_id = ? AND kind IN ('root','trash')")
    .get(uid) as { c: number };
  expect(count.c).toBe(2);

  const user = db!.prepare('SELECT root_node_id, trash_node_id FROM users WHERE id = ?').get(uid) as {
    root_node_id: number;
    trash_node_id: number;
  };
  expect(user.root_node_id).toBe(first.rootId);
  expect(user.trash_node_id).toBe(first.trashId);
});

test('createFolder creates a folder under root, and listChildren shows it', () => {
  const uid = seedUser();
  const now = Date.now();
  const { rootId } = ensureUserRoots(db!, uid, now);

  const folder = createFolder(db!, uid, rootId, 'docs', now);

  expect(folder.name).toBe('docs');
  expect(folder.kind).toBe('folder');
  expect(folder.owner_id).toBe(uid);
  expect(folder.parent_id).toBe(rootId);
  expect(folder.size_bytes).toBe(0);

  const children = listChildren(db!, uid, rootId);
  expect(children).toHaveLength(1);
  expect(children[0]?.id).toBe(folder.id);
  expect(children[0]?.name).toBe('docs');
});

test('createFolder with a duplicate live name under the same parent throws', () => {
  const uid = seedUser();
  const now = Date.now();
  const { rootId } = ensureUserRoots(db!, uid, now);

  createFolder(db!, uid, rootId, 'docs', now);

  expect(() => createFolder(db!, uid, rootId, 'docs', now)).toThrow(/UNIQUE/i);
});

test('rollupSize sums nested file descendants, ignoring folders and trashed files', () => {
  const uid = seedUser();
  const now = Date.now();
  const { rootId } = ensureUserRoots(db!, uid, now);

  const folderA = insertNode({ ownerId: uid, parentId: rootId, kind: 'folder', name: 'A' });
  insertNode({ ownerId: uid, parentId: folderA, kind: 'file', name: 'f1.txt', sizeBytes: 10 });
  insertNode({ ownerId: uid, parentId: folderA, kind: 'file', name: 'f2.txt', sizeBytes: 30 });

  const nested = insertNode({ ownerId: uid, parentId: folderA, kind: 'folder', name: 'nested' });
  insertNode({ ownerId: uid, parentId: nested, kind: 'file', name: 'f3.txt', sizeBytes: 5 });

  // A trashed file must not count toward the rollup.
  insertNode({
    ownerId: uid,
    parentId: folderA,
    kind: 'file',
    name: 'trashed.txt',
    sizeBytes: 999,
    trashedAt: now,
  });

  expect(rollupSize(db!, rootId)).toBe(45);
  expect(rollupSize(db!, folderA)).toBe(45);
});

test('listChildren orders folders before files, then by name (case-insensitive)', () => {
  const uid = seedUser();
  const now = Date.now();
  const { rootId } = ensureUserRoots(db!, uid, now);

  insertNode({ ownerId: uid, parentId: rootId, kind: 'file', name: 'banana.txt' });
  insertNode({ ownerId: uid, parentId: rootId, kind: 'folder', name: 'zeta' });
  insertNode({ ownerId: uid, parentId: rootId, kind: 'file', name: 'Apple.txt' });
  insertNode({ ownerId: uid, parentId: rootId, kind: 'folder', name: 'alpha' });

  const names = listChildren(db!, uid, rootId).map((n) => n.name);
  expect(names).toEqual(['alpha', 'zeta', 'Apple.txt', 'banana.txt']);
});

test('createFolder throws when the parent does not exist', () => {
  const uid = seedUser();
  const now = Date.now();

  expect(() => createFolder(db!, uid, 999999, 'docs', now)).toThrow();
});

test('createFolder throws when the parent is owned by a different user', () => {
  const uid = seedUser();
  const otherUid = seedUser();
  const now = Date.now();
  const { rootId } = ensureUserRoots(db!, uid, now);

  expect(() => createFolder(db!, otherUid, rootId, 'docs', now)).toThrow();
});

test('createFolder throws when the parent is the trash node', () => {
  const uid = seedUser();
  const now = Date.now();
  const { trashId } = ensureUserRoots(db!, uid, now);

  expect(() => createFolder(db!, uid, trashId, 'docs', now)).toThrow();
});
