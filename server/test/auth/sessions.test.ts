import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import {
  SESSION_TTL_MS,
  createSession,
  revokeAllForUser,
  revokeSession,
  validateSession,
} from '../../src/auth/sessions.js';

let db: Database.Database | undefined;
let dir: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-c2-'));
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
    username: string;
    role: string;
    isActive: number;
    mustChangePassword: number;
  }> = {},
): number {
  const t = Date.now();
  const { username = 'alice', role = 'user', isActive = 1, mustChangePassword = 0 } = overrides;

  const info = db!
    .prepare(
      `INSERT INTO users(username, password_hash, role, is_active, must_change_password, created_at, updated_at)
       VALUES (?, 'x', ?, ?, ?, ?, ?)`,
    )
    .run(username, role, isActive, mustChangePassword, t, t);

  return Number(info.lastInsertRowid);
}

test('createSession then validateSession resolves the user', () => {
  const uid = seedUser({ role: 'user', mustChangePassword: 0 });
  const now = Date.now();

  const { token } = createSession(db!, uid, now);
  const result = validateSession(db!, token, now);

  expect(result).toEqual({ userId: uid, role: 'user', mustChangePassword: false });
});

test('validateSession returns null for a deactivated user', () => {
  const uid = seedUser();
  const now = Date.now();
  const { token } = createSession(db!, uid, now);

  db!.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(uid);

  expect(validateSession(db!, token, now)).toBeNull();
});

test('revokeSession deletes the row so validateSession returns null next', () => {
  const uid = seedUser();
  const now = Date.now();
  const { token } = createSession(db!, uid, now);

  revokeSession(db!, token);

  expect(validateSession(db!, token, now)).toBeNull();
  const row = db!.prepare('SELECT * FROM sessions').get();
  expect(row).toBeUndefined();
});

test("revokeAllForUser deletes all of that user's sessions", () => {
  const uid = seedUser();
  const now = Date.now();
  const { token: t1 } = createSession(db!, uid, now);
  const { token: t2 } = createSession(db!, uid, now);

  revokeAllForUser(db!, uid);

  expect(validateSession(db!, t1, now)).toBeNull();
  expect(validateSession(db!, t2, now)).toBeNull();
});

test('expired session (now > expires_at) validates to null', () => {
  const uid = seedUser();
  const now = Date.now();
  const { token } = createSession(db!, uid, now);

  expect(validateSession(db!, token, now + SESSION_TTL_MS + 1)).toBeNull();
});

test('validateSession slides last_used_at/expires_at forward on success', () => {
  const uid = seedUser();
  const now = Date.now();
  const { token, id } = createSession(db!, uid, now);

  const later = now + 100;
  const result = validateSession(db!, token, later);

  expect(result).not.toBeNull();
  const row = db!.prepare('SELECT last_used_at, expires_at FROM sessions WHERE id = ?').get(id) as {
    last_used_at: number;
    expires_at: number;
  };
  expect(row.last_used_at).toBe(later);
  expect(row.expires_at).toBe(later + SESSION_TTL_MS);
});

test('createSession never stores the raw token — only its sha256 hash', () => {
  const uid = seedUser();
  const now = Date.now();
  const { token } = createSession(db!, uid, now);

  const row = db!.prepare('SELECT token_hash FROM sessions').get() as { token_hash: string };
  expect(row.token_hash).not.toBe(token);
  expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
});

test('validateSession returns null for an unknown token', () => {
  const now = Date.now();
  expect(validateSession(db!, 'not-a-real-token', now)).toBeNull();
});

test('mustChangePassword reflects the users row as a real boolean', () => {
  const uid = seedUser({ mustChangePassword: 1 });
  const now = Date.now();
  const { token } = createSession(db!, uid, now);

  const result = validateSession(db!, token, now);

  expect(result?.mustChangePassword).toBe(true);
});
