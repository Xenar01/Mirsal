import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { commitActual, release, reserve, subtract } from '../../src/storage/quota.js';

let db: Database.Database | undefined;
let dir: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-d2-'));
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
function seedUser(
  overrides: Partial<{
    quotaBytes: number | null;
    usedBytes: number;
  }> = {}
): number {
  const t = Date.now();
  const { quotaBytes = null, usedBytes = 0 } = overrides;

  const info = db!
    .prepare(
      `INSERT INTO users(username, password_hash, role, is_active, must_change_password, quota_bytes, used_bytes, created_at, updated_at)
       VALUES (?, 'x', 'user', 1, 0, ?, ?, ?, ?)`
    )
    .run(`user-${Math.random()}`, quotaBytes, usedBytes, t, t);

  return Number(info.lastInsertRowid);
}

function usedBytesOf(uid: number): number {
  const row = db!.prepare('SELECT used_bytes FROM users WHERE id = ?').get(uid) as {
    used_bytes: number;
  };
  return row.used_bytes;
}

test('reserve within quota bumps used_bytes and returns true', () => {
  const uid = seedUser({ quotaBytes: 1000, usedBytes: 0 });
  const now = Date.now();

  const ok = reserve(db!, uid, 400, now);

  expect(ok).toBe(true);
  expect(usedBytesOf(uid)).toBe(400);
});

test('reserve over quota returns false and leaves used_bytes unchanged', () => {
  const uid = seedUser({ quotaBytes: 1000, usedBytes: 800 });
  const now = Date.now();

  const ok = reserve(db!, uid, 400, now);

  expect(ok).toBe(false);
  expect(usedBytesOf(uid)).toBe(800);
});

test('reserve exact fit (boundary <=) succeeds', () => {
  const uid = seedUser({ quotaBytes: 1000, usedBytes: 600 });
  const now = Date.now();

  const ok = reserve(db!, uid, 400, now);

  expect(ok).toBe(true);
  expect(usedBytesOf(uid)).toBe(1000);
});

test('reserve with NULL quota always succeeds, counter rises', () => {
  const uid = seedUser({ quotaBytes: null, usedBytes: 0 });
  const now = Date.now();

  const ok = reserve(db!, uid, 10_000_000, now);

  expect(ok).toBe(true);
  expect(usedBytesOf(uid)).toBe(10_000_000);
});

test('commitActual adjusts by the delta (actual smaller than reserved)', () => {
  const uid = seedUser({ quotaBytes: 1000, usedBytes: 0 });
  const now = Date.now();
  reserve(db!, uid, 100, now);

  commitActual(db!, uid, 100, 80);

  expect(usedBytesOf(uid)).toBe(80);
});

test('commitActual adjusts by the delta (actual larger than reserved)', () => {
  const uid = seedUser({ quotaBytes: 1000, usedBytes: 0 });
  const now = Date.now();
  reserve(db!, uid, 100, now);

  commitActual(db!, uid, 100, 130);

  expect(usedBytesOf(uid)).toBe(130);
});

test('release restores a reservation and floors at 0 on repeat', () => {
  const uid = seedUser({ quotaBytes: 1000, usedBytes: 0 });
  const now = Date.now();
  reserve(db!, uid, 400, now);

  release(db!, uid, 400);
  expect(usedBytesOf(uid)).toBe(0);

  release(db!, uid, 400);
  expect(usedBytesOf(uid)).toBe(0);
});

test('subtract floors used_bytes at 0, never negative', () => {
  const uid = seedUser({ quotaBytes: 1000, usedBytes: 50 });

  subtract(db!, uid, 80);

  expect(usedBytesOf(uid)).toBe(0);
});

test('commitActual floors at 0 rather than going negative', () => {
  const uid = seedUser({ quotaBytes: 1000, usedBytes: 20 });

  // Delta (actual - reserved) = -100, which on its own would drive
  // used_bytes to -80. Must clamp at 0 instead.
  commitActual(db!, uid, 100, 0);

  expect(usedBytesOf(uid)).toBe(0);
});

test('commitActual floors at 0 when interleaved with a concurrent release/subtract', () => {
  const uid = seedUser({ quotaBytes: 1000, usedBytes: 0 });
  const now = Date.now();
  reserve(db!, uid, 100, now); // used_bytes = 100

  // Simulate a concurrent release/subtract on the same user racing ahead
  // of commitActual (e.g. a separate cleanup path already dropped the
  // reservation before the real upload size was known).
  release(db!, uid, 100); // used_bytes = 0
  subtract(db!, uid, 0); // no-op, still 0

  // commitActual now applies its delta against the already-drained
  // counter. Without a floor this would go to -20.
  commitActual(db!, uid, 100, 80);

  expect(usedBytesOf(uid)).toBe(0);
});
