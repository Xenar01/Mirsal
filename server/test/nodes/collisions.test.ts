import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { CollisionError, ensureUserRoots } from '../../src/nodes/tree.js';
import { mapDbError, nextSuffixedName } from '../../src/nodes/collisions.js';

let db: Database.Database | undefined;
let dir: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-e2-'));
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

function insertNode(row: {
  ownerId: number;
  parentId: number | null;
  kind: 'root' | 'trash' | 'folder' | 'file';
  name: string;
  trashedAt?: number | null;
}): number {
  const t = Date.now();
  const info = db!
    .prepare(
      `INSERT INTO nodes(owner_id, parent_id, kind, name, size_bytes, trashed_at, created_at, updated_at)
       VALUES (@ownerId, @parentId, @kind, @name, 0, @trashedAt, @t, @t)`,
    )
    .run({
      ownerId: row.ownerId,
      parentId: row.parentId,
      kind: row.kind,
      name: row.name,
      trashedAt: row.trashedAt ?? null,
      t,
    });
  return Number(info.lastInsertRowid);
}

// --- mapDbError --------------------------------------------------------------

test('mapDbError maps a CollisionError to 409 name_conflict', () => {
  expect(mapDbError(new CollisionError())).toEqual({ http: 409, code: 'name_conflict' });
});

test('mapDbError maps a raw SQLite UNIQUE-constraint error to 409 name_conflict', () => {
  const uid = seedUser();
  const now = Date.now();
  const { rootId } = ensureUserRoots(db!, uid, now);
  insertNode({ ownerId: uid, parentId: rootId, kind: 'folder', name: 'dup' });

  let caught: unknown;
  try {
    insertNode({ ownerId: uid, parentId: rootId, kind: 'folder', name: 'dup' });
  } catch (e) {
    caught = e;
  }

  expect(caught).toBeDefined();
  expect(mapDbError(caught)).toEqual({ http: 409, code: 'name_conflict' });
});

test('mapDbError falls through to 500 internal for an unrelated error', () => {
  expect(mapDbError(new Error('something else went wrong'))).toEqual({
    http: 500,
    code: 'internal',
  });
});

// --- nextSuffixedName --------------------------------------------------------

test('nextSuffixedName returns the base name when it is free', () => {
  const uid = seedUser();
  const now = Date.now();
  const { rootId } = ensureUserRoots(db!, uid, now);

  expect(nextSuffixedName(db!, rootId, 'report')).toBe('report');
});

test('nextSuffixedName returns "base (1)" when only the base is taken', () => {
  const uid = seedUser();
  const now = Date.now();
  const { rootId } = ensureUserRoots(db!, uid, now);
  insertNode({ ownerId: uid, parentId: rootId, kind: 'folder', name: 'report' });

  expect(nextSuffixedName(db!, rootId, 'report')).toBe('report (1)');
});

test('nextSuffixedName returns "base (2)" when base and base (1) are both taken', () => {
  const uid = seedUser();
  const now = Date.now();
  const { rootId } = ensureUserRoots(db!, uid, now);
  insertNode({ ownerId: uid, parentId: rootId, kind: 'folder', name: 'report' });
  insertNode({ ownerId: uid, parentId: rootId, kind: 'folder', name: 'report (1)' });

  expect(nextSuffixedName(db!, rootId, 'report')).toBe('report (2)');
});

test('nextSuffixedName ignores trashed nodes with the same name', () => {
  const uid = seedUser();
  const now = Date.now();
  const { rootId } = ensureUserRoots(db!, uid, now);
  insertNode({ ownerId: uid, parentId: rootId, kind: 'folder', name: 'report', trashedAt: now });

  expect(nextSuffixedName(db!, rootId, 'report')).toBe('report');
});
