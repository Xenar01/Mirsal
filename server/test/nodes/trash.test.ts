import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { createFolder, ensureUserRoots } from '../../src/nodes/tree.js';
import { permanentDelete, restoreNode, trashNode } from '../../src/nodes/trash.js';

let db: Database.Database | undefined;
let dir: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-e3-'));
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
  kind: 'root' | 'trash' | 'folder' | 'file';
  name: string;
  sizeBytes?: number;
  storagePath?: string | null;
  trashedAt?: number | null;
}): number {
  const t = Date.now();
  const info = db!
    .prepare(
      `INSERT INTO nodes(owner_id, parent_id, kind, name, size_bytes, storage_path, trashed_at, created_at, updated_at)
       VALUES (@ownerId, @parentId, @kind, @name, @sizeBytes, @storagePath, @trashedAt, @t, @t)`
    )
    .run({
      ownerId: row.ownerId,
      parentId: row.parentId,
      kind: row.kind,
      name: row.name,
      sizeBytes: row.sizeBytes ?? 0,
      storagePath: row.storagePath ?? null,
      trashedAt: row.trashedAt ?? null,
      t,
    });
  return Number(info.lastInsertRowid);
}

function readNode(id: number): {
  trashed_at: number | null;
  original_parent_id: number | null;
  purge_after: number | null;
  parent_id: number | null;
  name: string;
} {
  return db!
    .prepare(
      'SELECT trashed_at, original_parent_id, purge_after, parent_id, name FROM nodes WHERE id = ?'
    )
    .get(id) as {
    trashed_at: number | null;
    original_parent_id: number | null;
    purge_after: number | null;
    parent_id: number | null;
    name: string;
  };
}

function usedBytesOf(uid: number): number {
  const row = db!.prepare('SELECT used_bytes FROM users WHERE id = ?').get(uid) as {
    used_bytes: number;
  };
  return row.used_bytes;
}

/** Builds root -> F -> {a (file, 10 bytes), sub -> b (file, 20 bytes)}. */
function buildTree(uid: number, now: number) {
  const { rootId } = ensureUserRoots(db!, uid, now);
  const f = createFolder(db!, uid, rootId, 'F', now);
  const a = insertNode({
    ownerId: uid,
    parentId: f.id,
    kind: 'file',
    name: 'a',
    sizeBytes: 10,
    storagePath: 'u/1',
  });
  const sub = createFolder(db!, uid, f.id, 'sub', now);
  const b = insertNode({
    ownerId: uid,
    parentId: sub.id,
    kind: 'file',
    name: 'b',
    sizeBytes: 20,
    storagePath: 'u/2',
  });
  return { rootId, f, a, sub, b };
}

// --- trashNode ---------------------------------------------------------------

test('trashNode stamps the whole subtree, captures original_parent_id + clears purge_after on the top node only, and frees the live name', () => {
  const uid = seedUser(30);
  const now = Date.now();
  const { rootId, f, a, sub, b } = buildTree(uid, now);

  trashNode(db!, uid, f.id, now);

  for (const id of [f.id, a, sub.id, b]) {
    expect(readNode(id).trashed_at).toBe(now);
  }
  const top = readNode(f.id);
  expect(top.original_parent_id).toBe(rootId);
  expect(top.purge_after).toBeNull();

  // Name freed: a brand-new live folder named 'F' under root now succeeds.
  const f2 = createFolder(db!, uid, rootId, 'F', now);
  expect(f2.name).toBe('F');

  // Re-trashing the new F under the same freed name is also fine.
  expect(() => trashNode(db!, uid, f2.id, now)).not.toThrow();
  expect(readNode(f2.id).trashed_at).toBe(now);
});

test('trashNode throws when the node is not owned by ownerId (IDOR guard)', () => {
  const uid = seedUser();
  const otherUid = seedUser();
  const now = Date.now();
  const { f } = buildTree(uid, now);

  expect(() => trashNode(db!, otherUid, f.id, now)).toThrow();
  expect(readNode(f.id).trashed_at).toBeNull();
});

test('trashNode throws when the node is already trashed', () => {
  const uid = seedUser();
  const now = Date.now();
  const { f } = buildTree(uid, now);

  trashNode(db!, uid, f.id, now);

  expect(() => trashNode(db!, uid, f.id, now + 1)).toThrow();
});

test('trashNode throws when the node is the synthetic root or trash node', () => {
  const uid = seedUser();
  const now = Date.now();
  const { rootId } = ensureUserRoots(db!, uid, now);
  const { trashId } = ensureUserRoots(db!, uid, now);

  expect(() => trashNode(db!, uid, rootId, now)).toThrow();
  expect(() => trashNode(db!, uid, trashId, now)).toThrow();
});

// --- restoreNode ---------------------------------------------------------------

test('restoreNode clears trashed_at across the subtree and restores the top node under its original parent', () => {
  const uid = seedUser();
  const now = Date.now();
  const { rootId, f, a, sub, b } = buildTree(uid, now);

  trashNode(db!, uid, f.id, now);
  restoreNode(db!, uid, f.id, now + 1);

  for (const id of [f.id, a, sub.id, b]) {
    expect(readNode(id).trashed_at).toBeNull();
  }
  const top = readNode(f.id);
  expect(top.parent_id).toBe(rootId);
  expect(top.original_parent_id).toBeNull();
  expect(top.name).toBe('F');
});

test('restoreNode auto-suffixes the top node on a live-name collision at the destination', () => {
  const uid = seedUser();
  const now = Date.now();
  const { rootId, f } = buildTree(uid, now);

  trashNode(db!, uid, f.id, now);
  // A new live folder now occupies the freed name 'F' under root.
  createFolder(db!, uid, rootId, 'F', now);

  restoreNode(db!, uid, f.id, now + 1);

  expect(readNode(f.id).name).toBe('F (1)');
  expect(readNode(f.id).trashed_at).toBeNull();
  expect(readNode(f.id).parent_id).toBe(rootId);
});

test('restoreNode falls back to the user root when the original parent no longer exists', () => {
  const uid = seedUser();
  const now = Date.now();
  const { rootId } = ensureUserRoots(db!, uid, now);
  const orphanParent = createFolder(db!, uid, rootId, 'gone-parent', now);
  const child = insertNode({ ownerId: uid, parentId: orphanParent.id, kind: 'folder', name: 'child' });

  trashNode(db!, uid, child, now);
  // Simulate the captured original parent having vanished by the time of restore
  // (e.g. a future admin path) without disturbing the still-live parent_id link
  // that the cascade FK depends on.
  db!.prepare('UPDATE nodes SET original_parent_id = 999999 WHERE id = ?').run(child);

  restoreNode(db!, uid, child, now + 1);

  expect(readNode(child).parent_id).toBe(rootId);
  expect(readNode(child).trashed_at).toBeNull();
});

test('restoreNode throws when the node is not currently trashed', () => {
  const uid = seedUser();
  const now = Date.now();
  const { f } = buildTree(uid, now);

  expect(() => restoreNode(db!, uid, f.id, now)).toThrow();
});

test('restoreNode throws when the node is not owned by ownerId (IDOR guard)', () => {
  const uid = seedUser();
  const otherUid = seedUser();
  const now = Date.now();
  const { f } = buildTree(uid, now);
  trashNode(db!, uid, f.id, now);

  expect(() => restoreNode(db!, otherUid, f.id, now + 1)).toThrow();
});

// --- permanentDelete ---------------------------------------------------------------

test('permanentDelete returns freed bytes + storage paths for the full subtree, cascades to zero rows, and decrements used_bytes', () => {
  const uid = seedUser(30);
  const now = Date.now();
  const { f, a, sub, b } = buildTree(uid, now);

  const result = permanentDelete(db!, uid, f.id);

  expect(result.freedBytes).toBe(30);
  expect([...result.storagePaths].sort()).toEqual(['u/1', 'u/2']);

  const remaining = db!
    .prepare(
      `SELECT COUNT(*) AS c FROM nodes WHERE id IN (${[f.id, a, sub.id, b].join(',')})`
    )
    .get() as { c: number };
  expect(remaining.c).toBe(0);

  expect(usedBytesOf(uid)).toBe(0);
});

test('permanentDelete cascades to remove shares on descendant nodes too', () => {
  const uid = seedUser(30);
  const now = Date.now();
  const { f, a } = buildTree(uid, now);

  db!
    .prepare(
      `INSERT INTO shares(node_id, owner_id, token, created_at) VALUES (@nodeId, @ownerId, @token, @now)`
    )
    .run({ nodeId: a, ownerId: uid, token: `tok-${Math.random()}`, now });

  permanentDelete(db!, uid, f.id);

  const shareCount = db!.prepare('SELECT COUNT(*) AS c FROM shares WHERE node_id = ?').get(a) as {
    c: number;
  };
  expect(shareCount.c).toBe(0);
});

test('permanentDelete works on an already-trashed subtree (includes trashed rows)', () => {
  const uid = seedUser(30);
  const now = Date.now();
  const { f, a, sub, b } = buildTree(uid, now);
  trashNode(db!, uid, f.id, now);

  const result = permanentDelete(db!, uid, f.id);

  expect(result.freedBytes).toBe(30);
  expect([...result.storagePaths].sort()).toEqual(['u/1', 'u/2']);
  const remaining = db!
    .prepare(
      `SELECT COUNT(*) AS c FROM nodes WHERE id IN (${[f.id, a, sub.id, b].join(',')})`
    )
    .get() as { c: number };
  expect(remaining.c).toBe(0);
});

test('permanentDelete throws when the node is not owned by ownerId (IDOR guard)', () => {
  const uid = seedUser();
  const otherUid = seedUser();
  const now = Date.now();
  const { f } = buildTree(uid, now);

  expect(() => permanentDelete(db!, otherUid, f.id)).toThrow();
  expect(readNode(f.id)).toBeTruthy();
});
