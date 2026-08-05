import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { ensureUserRoots } from '../../src/nodes/tree.js';
import { applyExhaustion, EXHAUST_PURGE_GRACE_MS, type ExhaustibleShare } from '../../src/shares/exhaustion.js';

let db: Database.Database | undefined;
let dir: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-exhaustion-'));
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

/** Creates a file node owned by `uid` directly under their root. */
function seedFileNode(uid: number, now: number, overrides: { trashedAt?: number | null } = {}): number {
  const { rootId } = ensureUserRoots(db!, uid, now);
  const info = db!
    .prepare(
      `INSERT INTO nodes(owner_id, parent_id, kind, name, size_bytes, storage_path, trashed_at, created_at, updated_at)
       VALUES (@ownerId, @parentId, 'file', @name, 5, 'u/1', @trashedAt, @now, @now)`,
    )
    .run({
      ownerId: uid,
      parentId: rootId,
      name: `f-${Math.random()}`,
      trashedAt: overrides.trashedAt ?? null,
      now,
    });
  return Number(info.lastInsertRowid);
}

/** Inserts a real `shares` row and returns it shaped as `ExhaustibleShare`. */
function seedShare(opts: {
  ownerId: number;
  nodeId: number;
  onExhaust: 'stop' | 'delete';
  downloadLimit?: number | null;
}): ExhaustibleShare {
  const now = Date.now();
  const downloadLimit = opts.downloadLimit ?? 1;
  const info = db!
    .prepare(
      `INSERT INTO shares(node_id, owner_id, token, is_active, created_at, download_limit, download_count, on_exhaust)
       VALUES (@nodeId, @ownerId, @token, 1, @now, @downloadLimit, @downloadLimit, @onExhaust)`,
    )
    .run({
      nodeId: opts.nodeId,
      ownerId: opts.ownerId,
      token: `tok-${Math.random()}`,
      now,
      downloadLimit,
      onExhaust: opts.onExhaust,
    });
  return {
    id: Number(info.lastInsertRowid),
    owner_id: opts.ownerId,
    node_id: opts.nodeId,
    on_exhaust: opts.onExhaust,
    download_limit: downloadLimit,
  };
}

function readNode(id: number): { owner_id: number; trashed_at: number | null; purge_after: number | null } {
  return db!.prepare('SELECT owner_id, trashed_at, purge_after FROM nodes WHERE id = ?').get(id) as {
    owner_id: number;
    trashed_at: number | null;
    purge_after: number | null;
  };
}

function readShare(id: number): { is_active: number } {
  return db!.prepare('SELECT is_active FROM shares WHERE id = ?').get(id) as { is_active: number };
}

function auditRows(action: string): { actor_id: number | null; target: string | null; detail: string | null }[] {
  return db!.prepare('SELECT actor_id, target, detail FROM audit_log WHERE action = ? ORDER BY id').all(action) as {
    actor_id: number | null;
    target: string | null;
    detail: string | null;
  }[];
}

// --- stop ---------------------------------------------------------------

test('stop: sets is_active=0 and writes an audit row with actor_id NULL', () => {
  const uid = seedUser();
  const now = Date.now();
  const nodeId = seedFileNode(uid, now);
  const share = seedShare({ ownerId: uid, nodeId, onExhaust: 'stop', downloadLimit: 1 });

  applyExhaustion(db!, share, () => now);

  expect(readShare(share.id).is_active).toBe(0);

  const rows = auditRows('share_download_limit_stopped');
  expect(rows.length).toBe(1);
  expect(rows[0].actor_id).toBeNull();
  expect(rows[0].target).toBe(String(share.id));

  // A stop must never touch the underlying node.
  const node = readNode(nodeId);
  expect(node.trashed_at).toBeNull();
  expect(node.purge_after).toBeNull();
});

test('stop: idempotent — re-invoking leaves is_active=0, never throws, and does not duplicate the audit row', () => {
  const uid = seedUser();
  const now = Date.now();
  const nodeId = seedFileNode(uid, now);
  const share = seedShare({ ownerId: uid, nodeId, onExhaust: 'stop', downloadLimit: 1 });

  expect(() => applyExhaustion(db!, share, () => now)).not.toThrow();
  expect(readShare(share.id).is_active).toBe(0);
  expect(auditRows('share_download_limit_stopped').length).toBe(1);

  expect(() => applyExhaustion(db!, share, () => now + 1)).not.toThrow();
  expect(readShare(share.id).is_active).toBe(0);
  expect(auditRows('share_download_limit_stopped').length).toBe(1);
});

// --- delete ---------------------------------------------------------------

test('delete: trashes the node, stamps purge_after = now + EXHAUST_PURGE_GRACE_MS, and audits — one txn', () => {
  const uid = seedUser();
  const now = Date.now();
  const nodeId = seedFileNode(uid, now);
  const share = seedShare({ ownerId: uid, nodeId, onExhaust: 'delete', downloadLimit: 1 });

  applyExhaustion(db!, share, () => now);

  const node = readNode(nodeId);
  expect(node.trashed_at).toBe(now);
  expect(node.purge_after).toBe(now + EXHAUST_PURGE_GRACE_MS);

  const rows = auditRows('share_download_limit_deleted');
  expect(rows.length).toBe(1);
  expect(rows[0].actor_id).toBeNull();
  expect(rows[0].target).toBe(String(share.id));
});

test('delete: already-trashed node -> no-op, does not throw, no audit row', () => {
  const uid = seedUser();
  const earlier = Date.now() - 1000;
  const nodeId = seedFileNode(uid, earlier, { trashedAt: earlier });
  const share = seedShare({ ownerId: uid, nodeId, onExhaust: 'delete', downloadLimit: 1 });
  const now = Date.now();

  expect(() => applyExhaustion(db!, share, () => now)).not.toThrow();

  // trashed_at/purge_after untouched by the no-op (still the pre-existing state).
  const node = readNode(nodeId);
  expect(node.trashed_at).toBe(earlier);
  expect(node.purge_after).toBeNull();

  expect(auditRows('share_download_limit_deleted').length).toBe(0);
});

test('delete: missing node -> no-op, does not throw, no audit row', () => {
  const uid = seedUser();
  const now = Date.now();
  // No corresponding `nodes` row for this id at all — simulates the share
  // object being a stale in-memory snapshot from before a concurrent
  // permanent-delete cascaded the node (and its share) away.
  const share: ExhaustibleShare = {
    id: 999001,
    owner_id: uid,
    node_id: 999002,
    on_exhaust: 'delete',
    download_limit: 1,
  };

  expect(() => applyExhaustion(db!, share, () => now)).not.toThrow();

  expect(auditRows('share_download_limit_deleted').length).toBe(0);
});

test('delete: foreign node (owned by someone else) -> no-op, does not throw, no audit row', () => {
  const uid = seedUser();
  const otherUid = seedUser();
  const now = Date.now();
  const foreignNodeId = seedFileNode(otherUid, now);
  // share.owner_id deliberately does not match the node's actual owner_id.
  const share: ExhaustibleShare = {
    id: 999003,
    owner_id: uid,
    node_id: foreignNodeId,
    on_exhaust: 'delete',
    download_limit: 1,
  };

  expect(() => applyExhaustion(db!, share, () => now)).not.toThrow();

  const node = readNode(foreignNodeId);
  expect(node.trashed_at).toBeNull();
  expect(node.purge_after).toBeNull();
  expect(auditRows('share_download_limit_deleted').length).toBe(0);
});
