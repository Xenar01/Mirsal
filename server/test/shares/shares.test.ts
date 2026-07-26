import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { ensureUserRoots } from '../../src/nodes/tree.js';
import { verifyPassword } from '../../src/auth/passwords.js';
import { createShare, ownerStatus, revokeShare, setShareState, type Share } from '../../src/shares/shares.js';

let db: Database.Database | undefined;
let dir: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-f1-'));
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

// hashPassword/verifyPassword's bare exports are bound to a lazily-initialized
// default service built from loadConfig() on first use, which requires these
// env vars to be present. Provisioned here for the duration of this file and
// restored afterwards (mirrors auth/passwords.test.ts).
const keys = ['DB_PATH', 'STORAGE_DIR', 'SESSION_SECRET', 'CSRF_SECRET', 'PUBLIC_BASE_URL'] as const;
const originals: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const key of keys) {
    originals[key] = process.env[key];
  }
  process.env.DB_PATH = '/tmp/mirsal-test/db.sqlite';
  process.env.STORAGE_DIR = '/tmp/mirsal-test/storage';
  process.env.SESSION_SECRET = 'a'.repeat(32);
  process.env.CSRF_SECRET = 'b'.repeat(32);
  process.env.PUBLIC_BASE_URL = 'https://mirsal.example.com';
});

afterAll(() => {
  for (const key of keys) {
    if (originals[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originals[key];
    }
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
function seedFileNode(uid: number, now: number, overrides: { trashedAt?: number | null } = {}): number {
  const { rootId } = ensureUserRoots(db!, uid, now);
  const info = db!
    .prepare(
      `INSERT INTO nodes(owner_id, parent_id, kind, name, size_bytes, storage_path, trashed_at, created_at, updated_at)
       VALUES (@ownerId, @parentId, 'file', @name, 5, 'u/1', @trashedAt, @now, @now)`
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

function rawShare(shareId: number): Share | undefined {
  return db!.prepare('SELECT * FROM shares WHERE id = ?').get(shareId) as Share | undefined;
}

// --- createShare ---------------------------------------------------------------

test('createShare with no options: token >= 43 chars, is_active=1, no password', async () => {
  const uid = seedUser();
  const now = Date.now();
  const nodeId = seedFileNode(uid, now);

  const share = await createShare(db!, uid, nodeId, {}, now);

  expect(share.token.length).toBeGreaterThanOrEqual(43);
  expect(share.is_active).toBe(1);
  expect(share.password_hash).toBeNull();
  expect(share.node_id).toBe(nodeId);
  expect(share.owner_id).toBe(uid);
  expect(share.expires_at).toBeNull();
  expect(share.allow_download).toBe(1);
});

test('createShare with a password: password_hash is set and verifies', async () => {
  const uid = seedUser();
  const now = Date.now();
  const nodeId = seedFileNode(uid, now);

  const share = await createShare(db!, uid, nodeId, { password: 'secret' }, now);

  expect(share.password_hash).not.toBeNull();
  await expect(verifyPassword(share.password_hash!, 'secret')).resolves.toBe(true);
});

test('createShare throws when the node is not owned by ownerId (IDOR guard)', async () => {
  const uid = seedUser();
  const otherUid = seedUser();
  const now = Date.now();
  const nodeId = seedFileNode(uid, now);

  await expect(createShare(db!, otherUid, nodeId, {}, now)).rejects.toThrow();
  const count = db!.prepare('SELECT COUNT(*) AS c FROM shares').get() as { c: number };
  expect(count.c).toBe(0);
});

test('createShare throws when the node is trashed', async () => {
  const uid = seedUser();
  const now = Date.now();
  const nodeId = seedFileNode(uid, now, { trashedAt: now });

  await expect(createShare(db!, uid, nodeId, {}, now)).rejects.toThrow();
});

// --- setShareState ---------------------------------------------------------------

test('setShareState({isActive:false}) flips is_active to 0 and ownerStatus becomes stopped', async () => {
  const uid = seedUser();
  const now = Date.now();
  const nodeId = seedFileNode(uid, now);
  const share = await createShare(db!, uid, nodeId, {}, now);

  const updated = await setShareState(db!, uid, share.id, { isActive: false });

  expect(updated!.is_active).toBe(0);
  expect(ownerStatus(updated!, now)).toBe('stopped');
});

test('setShareState({password:null}) clears an existing password_hash', async () => {
  const uid = seedUser();
  const now = Date.now();
  const nodeId = seedFileNode(uid, now);
  const share = await createShare(db!, uid, nodeId, { password: 'secret' }, now);
  expect(share.password_hash).not.toBeNull();

  const updated = await setShareState(db!, uid, share.id, { password: null });

  expect(updated!.password_hash).toBeNull();
});

test('setShareState omitting a key leaves that field unchanged', async () => {
  const uid = seedUser();
  const now = Date.now();
  const nodeId = seedFileNode(uid, now);
  const share = await createShare(db!, uid, nodeId, { password: 'secret' }, now);

  const updated = await setShareState(db!, uid, share.id, { isActive: false });

  // password untouched by an isActive-only patch
  expect(updated!.password_hash).toBe(share.password_hash);
});

test('setShareState with a string password hashes it (verifiable, not stored plaintext)', async () => {
  const uid = seedUser();
  const now = Date.now();
  const nodeId = seedFileNode(uid, now);
  const share = await createShare(db!, uid, nodeId, {}, now);

  const updated = await setShareState(db!, uid, share.id, { password: 'newpass' });

  expect(updated!.password_hash).not.toBe('newpass');
  await expect(verifyPassword(updated!.password_hash!, 'newpass')).resolves.toBe(true);
});

test('stopped-before-expired ordering: re-activate then set past expiry yields expired', async () => {
  const uid = seedUser();
  const now = Date.now();
  const nodeId = seedFileNode(uid, now);
  const share = await createShare(db!, uid, nodeId, {}, now);

  await setShareState(db!, uid, share.id, { isActive: false });
  await setShareState(db!, uid, share.id, { isActive: true });
  const updated = await setShareState(db!, uid, share.id, { expiresAt: now - 1 });

  expect(ownerStatus(updated!, now)).toBe('expired');
});

test('setShareState does not modify a share owned by a different user (IDOR guard)', async () => {
  const uid = seedUser();
  const otherUid = seedUser();
  const now = Date.now();
  const nodeId = seedFileNode(uid, now);
  const share = await createShare(db!, uid, nodeId, {}, now);

  const result = await setShareState(db!, otherUid, share.id, { isActive: false });

  expect(result).toBeUndefined();
  expect(rawShare(share.id)!.is_active).toBe(1);
});

// --- ownerStatus (pure) ---------------------------------------------------------------

test('ownerStatus: is_active=0 -> stopped', () => {
  expect(ownerStatus({ is_active: 0, expires_at: null }, Date.now())).toBe('stopped');
});

test('ownerStatus: is_active=1 and expires_at in the past -> expired', () => {
  const now = Date.now();
  expect(ownerStatus({ is_active: 1, expires_at: now - 1 }, now)).toBe('expired');
});

test('ownerStatus: is_active=1 and expires_at=null -> active', () => {
  expect(ownerStatus({ is_active: 1, expires_at: null }, Date.now())).toBe('active');
});

// --- revokeShare ---------------------------------------------------------------

test('revokeShare deletes the row', async () => {
  const uid = seedUser();
  const now = Date.now();
  const nodeId = seedFileNode(uid, now);
  const share = await createShare(db!, uid, nodeId, {}, now);

  revokeShare(db!, uid, share.id);

  expect(rawShare(share.id)).toBeUndefined();
});

test('revokeShare owned by a different user does not delete it (IDOR guard)', async () => {
  const uid = seedUser();
  const otherUid = seedUser();
  const now = Date.now();
  const nodeId = seedFileNode(uid, now);
  const share = await createShare(db!, uid, nodeId, {}, now);

  revokeShare(db!, otherUid, share.id);

  expect(rawShare(share.id)).toBeTruthy();
});
