import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { ensureUserRoots } from '../../src/nodes/tree.js';
import { trashNode } from '../../src/nodes/trash.js';
import { isShareLive } from '../../src/shares/gate.js';

let db: Database.Database | undefined;
let dir: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-f2-gate-'));
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

/** Creates a live file node owned by `uid` directly under their root. */
function seedFileNode(uid: number, now: number): number {
  const { rootId } = ensureUserRoots(db!, uid, now);
  const info = db!
    .prepare(
      `INSERT INTO nodes(owner_id, parent_id, kind, name, size_bytes, storage_path, created_at, updated_at)
       VALUES (@ownerId, @parentId, 'file', @name, 5, 'u/1', @now, @now)`
    )
    .run({ ownerId: uid, parentId: rootId, name: `f-${Math.random()}`, now });
  return Number(info.lastInsertRowid);
}

// --- isShareLive ---------------------------------------------------------------

test('isShareLive: fresh active share, no expiry -> ok', () => {
  const uid = seedUser();
  const now = Date.now();
  const nodeId = seedFileNode(uid, now);

  const result = isShareLive(db!, { is_active: 1, expires_at: null, node_id: nodeId }, now);

  expect(result).toEqual({ live: true, reason: 'ok' });
});

test('isShareLive: is_active=0 -> stopped', () => {
  const uid = seedUser();
  const now = Date.now();
  const nodeId = seedFileNode(uid, now);

  const result = isShareLive(db!, { is_active: 0, expires_at: null, node_id: nodeId }, now);

  expect(result).toEqual({ live: false, reason: 'stopped' });
});

test('isShareLive: expires_at in the past -> expired', () => {
  const uid = seedUser();
  const now = Date.now();
  const nodeId = seedFileNode(uid, now);

  const result = isShareLive(db!, { is_active: 1, expires_at: now - 1, node_id: nodeId }, now);

  expect(result).toEqual({ live: false, reason: 'expired' });
});

test('isShareLive: expires_at exactly now (boundary, <=) -> expired', () => {
  const uid = seedUser();
  const now = Date.now();
  const nodeId = seedFileNode(uid, now);

  const result = isShareLive(db!, { is_active: 1, expires_at: now, node_id: nodeId }, now);

  expect(result).toEqual({ live: false, reason: 'expired' });
});

test('isShareLive: stopped takes priority over expired (ordering)', () => {
  const uid = seedUser();
  const now = Date.now();
  const nodeId = seedFileNode(uid, now);

  const result = isShareLive(db!, { is_active: 0, expires_at: now - 1, node_id: nodeId }, now);

  expect(result).toEqual({ live: false, reason: 'stopped' });
});

test('isShareLive: shared node is trashed -> gone', () => {
  const uid = seedUser();
  const now = Date.now();
  const nodeId = seedFileNode(uid, now);
  trashNode(db!, uid, nodeId, now);

  const result = isShareLive(db!, { is_active: 1, expires_at: null, node_id: nodeId }, now);

  expect(result).toEqual({ live: false, reason: 'gone' });
});

test('isShareLive: shared node no longer exists -> gone', () => {
  const now = Date.now();
  const nonExistentNodeId = 999999;

  const result = isShareLive(db!, { is_active: 1, expires_at: null, node_id: nonExistentNodeId }, now);

  expect(result).toEqual({ live: false, reason: 'gone' });
});

test('isShareLive: shared node past auto_delete_at -> gone', () => {
  const uid = seedUser();
  const now = Date.now();
  const nodeId = seedFileNode(uid, now);
  db!.prepare('UPDATE nodes SET auto_delete_at = @autoDeleteAt WHERE id = @nodeId').run({
    autoDeleteAt: now - 1,
    nodeId,
  });

  const result = isShareLive(db!, { is_active: 1, expires_at: null, node_id: nodeId }, now);

  expect(result).toEqual({ live: false, reason: 'gone' });
});
