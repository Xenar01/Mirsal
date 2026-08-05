import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { createFolder, ensureUserRoots, moveNode, type Node } from '../../src/nodes/tree.js';
import { trashNode } from '../../src/nodes/trash.js';
import { ForbiddenError, listPublic, resolveInSubtree } from '../../src/shares/resolver.js';

let db: Database.Database | undefined;
let dir: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-f2-resolver-'));
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
       VALUES (?, 'x', 'user', 1, 0, ?, ?)`,
    )
    .run(`user-${Math.random()}`, t, t);
  return Number(info.lastInsertRowid);
}

/** Creates a live file node owned by `ownerId`, under `parentId`, with a given `name`. */
function insertFile(ownerId: number, parentId: number, name: string, now: number): Node {
  const info = db!
    .prepare(
      `INSERT INTO nodes(owner_id, parent_id, kind, name, size_bytes, storage_path, created_at, updated_at)
       VALUES (@ownerId, @parentId, 'file', @name, 5, 'u/1', @now, @now)`,
    )
    .run({ ownerId, parentId, name, now });
  return db!.prepare('SELECT * FROM nodes WHERE id = @id').get({ id: info.lastInsertRowid }) as Node;
}

/**
 * Builds owner U's tree: root -> F(folder) -> G(folder) -> x(file);
 * root -> S(file), a sibling of F outside its subtree.
 */
function buildTree(uid: number, now: number) {
  const { rootId } = ensureUserRoots(db!, uid, now);
  const f = createFolder(db!, uid, rootId, 'F', now);
  const g = createFolder(db!, uid, f.id, 'G', now);
  const x = insertFile(uid, g.id, 'x', now);
  const s = insertFile(uid, rootId, 'S', now);
  return { rootId, f, g, x, s };
}

// --- resolveInSubtree: file share ---------------------------------------------------------------

test('resolveInSubtree: file share of x, requesting x.id, returns x', () => {
  const uid = seedUser();
  const now = Date.now();
  const { x } = buildTree(uid, now);
  const shareX = { node_id: x.id, owner_id: uid };

  const resolved = resolveInSubtree(db!, shareX, x.id);

  expect(resolved.id).toBe(x.id);
});

test('resolveInSubtree: file share of x, requesting a sibling id outside the subtree -> ForbiddenError', () => {
  const uid = seedUser();
  const now = Date.now();
  const { x, s } = buildTree(uid, now);
  const shareX = { node_id: x.id, owner_id: uid };

  expect(() => resolveInSubtree(db!, shareX, s.id)).toThrow(ForbiddenError);
});

test('resolveInSubtree: file share of x, requesting an ancestor (not the file itself) -> ForbiddenError', () => {
  const uid = seedUser();
  const now = Date.now();
  const { x, g } = buildTree(uid, now);
  const shareX = { node_id: x.id, owner_id: uid };

  expect(() => resolveInSubtree(db!, shareX, g.id)).toThrow(ForbiddenError);
});

// --- resolveInSubtree: folder share ---------------------------------------------------------------

test('resolveInSubtree: folder share of F, requesting a descendant (x) -> OK', () => {
  const uid = seedUser();
  const now = Date.now();
  const { f, x } = buildTree(uid, now);
  const shareF = { node_id: f.id, owner_id: uid };

  const resolved = resolveInSubtree(db!, shareF, x.id);

  expect(resolved.id).toBe(x.id);
});

test('resolveInSubtree: folder share of F, requesting the sibling S -> ForbiddenError', () => {
  const uid = seedUser();
  const now = Date.now();
  const { f, s } = buildTree(uid, now);
  const shareF = { node_id: f.id, owner_id: uid };

  expect(() => resolveInSubtree(db!, shareF, s.id)).toThrow(ForbiddenError);
});

test('resolveInSubtree: folder share of F, x moved OUT of F afterward -> ForbiddenError (chain no longer contains F)', () => {
  const uid = seedUser();
  const now = Date.now();
  const { rootId, f, x } = buildTree(uid, now);
  const shareF = { node_id: f.id, owner_id: uid };

  // Sanity: still resolves before the move.
  expect(resolveInSubtree(db!, shareF, x.id).id).toBe(x.id);

  moveNode(db!, uid, x.id, rootId, now + 1);

  expect(() => resolveInSubtree(db!, shareF, x.id)).toThrow(ForbiddenError);
});

// --- resolveInSubtree: junk ids ---------------------------------------------------------------

test('resolveInSubtree: junk requestedNodeId (0, -1, 999999, NaN, string junk) all -> ForbiddenError', () => {
  const uid = seedUser();
  const now = Date.now();
  const { f } = buildTree(uid, now);
  const shareF = { node_id: f.id, owner_id: uid };

  expect(() => resolveInSubtree(db!, shareF, 0)).toThrow(ForbiddenError);
  expect(() => resolveInSubtree(db!, shareF, -1)).toThrow(ForbiddenError);
  expect(() => resolveInSubtree(db!, shareF, 999999)).toThrow(ForbiddenError);
  expect(() => resolveInSubtree(db!, shareF, NaN)).toThrow(ForbiddenError);
  expect(() => resolveInSubtree(db!, shareF, '../x')).toThrow(ForbiddenError);
});

// --- resolveInSubtree: cross-owner ---------------------------------------------------------------

test('resolveInSubtree: a node owned by a different user than the share -> ForbiddenError (cross-owner)', () => {
  const uid = seedUser();
  const otherUid = seedUser();
  const now = Date.now();
  const { f } = buildTree(uid, now);
  const { rootId: otherRoot } = ensureUserRoots(db!, otherUid, now);
  const otherFile = insertFile(otherUid, otherRoot, 'other', now);
  const shareF = { node_id: f.id, owner_id: uid };

  expect(() => resolveInSubtree(db!, shareF, otherFile.id)).toThrow(ForbiddenError);
});

// --- resolveInSubtree: trashed ancestor ---------------------------------------------------------------

test('resolveInSubtree: trashed ancestor (F trashed) -> ForbiddenError', () => {
  const uid = seedUser();
  const now = Date.now();
  const { f, x } = buildTree(uid, now);
  const shareF = { node_id: f.id, owner_id: uid };

  trashNode(db!, uid, f.id, now);

  expect(() => resolveInSubtree(db!, shareF, x.id)).toThrow(ForbiddenError);
});

// --- listPublic ---------------------------------------------------------------

test('listPublic: folder share of F, listing F itself, returns its live children [G]', () => {
  const uid = seedUser();
  const now = Date.now();
  const { f, g } = buildTree(uid, now);
  const shareF = { node_id: f.id, owner_id: uid };

  const children = listPublic(db!, shareF, f.id);

  expect(children.map((n) => n.id)).toEqual([g.id]);
});

test('listPublic: folder share of F, listing descendant folder G, returns its live children [x]', () => {
  const uid = seedUser();
  const now = Date.now();
  const { f, g, x } = buildTree(uid, now);
  const shareF = { node_id: f.id, owner_id: uid };

  const children = listPublic(db!, shareF, g.id);

  expect(children.map((n) => n.id)).toEqual([x.id]);
});

test('listPublic: folder share of F, listing outside the subtree (S) -> ForbiddenError', () => {
  const uid = seedUser();
  const now = Date.now();
  const { f, s } = buildTree(uid, now);
  const shareF = { node_id: f.id, owner_id: uid };

  expect(() => listPublic(db!, shareF, s.id)).toThrow(ForbiddenError);
});

test('listPublic: folder share of F, listing a descendant FILE (x) -> ForbiddenError (a file has no children)', () => {
  const uid = seedUser();
  const now = Date.now();
  const { f, x } = buildTree(uid, now);
  const shareF = { node_id: f.id, owner_id: uid };

  expect(() => listPublic(db!, shareF, x.id)).toThrow(ForbiddenError);
});

test('listPublic: file share of x, listing x itself, returns [] (no throw)', () => {
  const uid = seedUser();
  const now = Date.now();
  const { x } = buildTree(uid, now);
  const shareX = { node_id: x.id, owner_id: uid };

  const children = listPublic(db!, shareX, x.id);

  expect(children).toEqual([]);
});

test('listPublic: excludes trashed children (delegates to listChildren)', () => {
  const uid = seedUser();
  const now = Date.now();
  const { f, g } = buildTree(uid, now);
  const shareF = { node_id: f.id, owner_id: uid };

  trashNode(db!, uid, g.id, now);

  const children = listPublic(db!, shareF, f.id);

  expect(children).toEqual([]);
});
