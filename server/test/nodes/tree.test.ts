import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import {
  CollisionError,
  CycleError,
  createFolder,
  ensureUserRoots,
  isAncestor,
  listChildren,
  moveNode,
  renameNode,
  rollupSize,
} from '../../src/nodes/tree.js';

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

// --- isAncestor -----------------------------------------------------------

test('isAncestor is true for the direct parent', () => {
  const uid = seedUser();
  const now = Date.now();
  const { rootId } = ensureUserRoots(db!, uid, now);
  const a = createFolder(db!, uid, rootId, 'A', now);

  expect(isAncestor(db!, rootId, a.id)).toBe(true);
});

test('isAncestor is true transitively for a grandparent', () => {
  const uid = seedUser();
  const now = Date.now();
  const { rootId } = ensureUserRoots(db!, uid, now);
  const a = createFolder(db!, uid, rootId, 'A', now);
  const a1 = createFolder(db!, uid, a.id, 'A1', now);

  expect(isAncestor(db!, rootId, a1.id)).toBe(true);
  expect(isAncestor(db!, a.id, a1.id)).toBe(true);
});

test('isAncestor is false for an unrelated sibling', () => {
  const uid = seedUser();
  const now = Date.now();
  const { rootId } = ensureUserRoots(db!, uid, now);
  const a = createFolder(db!, uid, rootId, 'A', now);
  const b = createFolder(db!, uid, rootId, 'B', now);

  expect(isAncestor(db!, a.id, b.id)).toBe(false);
});

test('isAncestor is false for a node against itself (not its own ancestor)', () => {
  const uid = seedUser();
  const now = Date.now();
  const { rootId } = ensureUserRoots(db!, uid, now);
  const a = createFolder(db!, uid, rootId, 'A', now);

  expect(isAncestor(db!, a.id, a.id)).toBe(false);
});

// --- moveNode --------------------------------------------------------------

test('moveNode into itself throws CycleError', () => {
  const uid = seedUser();
  const now = Date.now();
  const { rootId } = ensureUserRoots(db!, uid, now);
  const a = createFolder(db!, uid, rootId, 'A', now);

  expect(() => moveNode(db!, uid, a.id, a.id, now)).toThrow(CycleError);
});

test('moveNode into its own child throws CycleError', () => {
  const uid = seedUser();
  const now = Date.now();
  const { rootId } = ensureUserRoots(db!, uid, now);
  const a = createFolder(db!, uid, rootId, 'A', now);
  const a1 = createFolder(db!, uid, a.id, 'A1', now);

  expect(() => moveNode(db!, uid, a.id, a1.id, now)).toThrow(CycleError);
});

test('moveNode into a sibling succeeds', () => {
  const uid = seedUser();
  const now = Date.now();
  const { rootId } = ensureUserRoots(db!, uid, now);
  const a = createFolder(db!, uid, rootId, 'A', now);
  const b = createFolder(db!, uid, rootId, 'B', now);

  const moved = moveNode(db!, uid, a.id, b.id, now);

  expect(moved.parent_id).toBe(b.id);
  const reread = db!.prepare('SELECT parent_id FROM nodes WHERE id = ?').get(a.id) as {
    parent_id: number;
  };
  expect(reread.parent_id).toBe(b.id);
});

test('moveNode onto an occupied name throws CollisionError', () => {
  const uid = seedUser();
  const now = Date.now();
  const { rootId } = ensureUserRoots(db!, uid, now);
  const a = createFolder(db!, uid, rootId, 'A', now);
  createFolder(db!, uid, rootId, 'X', now);
  const aX = createFolder(db!, uid, a.id, 'X', now);

  expect(() => moveNode(db!, uid, aX.id, rootId, now)).toThrow(CollisionError);
});

test('moveNode throws when the node is not owned by ownerId (IDOR guard)', () => {
  const uid = seedUser();
  const otherUid = seedUser();
  const now = Date.now();
  const { rootId } = ensureUserRoots(db!, uid, now);
  const { rootId: otherRootId } = ensureUserRoots(db!, otherUid, now);
  const a = createFolder(db!, uid, rootId, 'A', now);

  expect(() => moveNode(db!, otherUid, a.id, otherRootId, now)).toThrow();
});

test('moveNode throws when the destination is a file, not a folder/root', () => {
  const uid = seedUser();
  const now = Date.now();
  const { rootId } = ensureUserRoots(db!, uid, now);
  const a = createFolder(db!, uid, rootId, 'A', now);
  const fileId = insertNode({ ownerId: uid, parentId: rootId, kind: 'file', name: 'f.txt' });

  expect(() => moveNode(db!, uid, a.id, fileId, now)).toThrow();
});

// --- renameNode --------------------------------------------------------------

test('renameNode renames a live folder', () => {
  const uid = seedUser();
  const now = Date.now();
  const { rootId } = ensureUserRoots(db!, uid, now);
  const a = createFolder(db!, uid, rootId, 'A', now);

  const renamed = renameNode(db!, uid, a.id, 'A-renamed', now);

  expect(renamed.name).toBe('A-renamed');
  const reread = db!.prepare('SELECT name FROM nodes WHERE id = ?').get(a.id) as { name: string };
  expect(reread.name).toBe('A-renamed');
});

test('renameNode onto an occupied name throws CollisionError', () => {
  const uid = seedUser();
  const now = Date.now();
  const { rootId } = ensureUserRoots(db!, uid, now);
  createFolder(db!, uid, rootId, 'A', now);
  const b = createFolder(db!, uid, rootId, 'B', now);

  expect(() => renameNode(db!, uid, b.id, 'A', now)).toThrow(CollisionError);
});

test('renameNode throws when the node is root or trash', () => {
  const uid = seedUser();
  const now = Date.now();
  const { rootId, trashId } = ensureUserRoots(db!, uid, now);

  expect(() => renameNode(db!, uid, rootId, 'nope', now)).toThrow();
  expect(() => renameNode(db!, uid, trashId, 'nope', now)).toThrow();
});

test('renameNode throws when the node is not owned by ownerId (IDOR guard)', () => {
  const uid = seedUser();
  const otherUid = seedUser();
  const now = Date.now();
  const { rootId } = ensureUserRoots(db!, uid, now);
  const a = createFolder(db!, uid, rootId, 'A', now);

  expect(() => renameNode(db!, otherUid, a.id, 'nope', now)).toThrow();
});
