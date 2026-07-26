import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { openDb } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import type Database from 'better-sqlite3';

let db: Database.Database | undefined;
let dir: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-b2-'));
  const dbPath = path.join(dir, 't.db');
  db = openDb(dbPath);
});

afterEach(() => {
  db?.close();
  db = undefined;
  if (dir) {
    fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

function now(): number {
  return Date.now();
}

test('migrate is safe to call twice on the same DB', () => {
  expect(() => migrate(db!)).not.toThrow();
  expect(() => migrate(db!)).not.toThrow();
});

test('migrate creates the expected tables and the ux_live_name index', () => {
  migrate(db!);

  const names = db!
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')")
    .all()
    .map((r) => (r as { name: string }).name);

  expect(names).toContain('users');
  expect(names).toContain('nodes');
  expect(names).toContain('shares');
  expect(names).toContain('sessions');
  expect(names).toContain('ux_live_name');
});

test('ux_live_name enforces live-name uniqueness per parent, ignores trashed/root rows', () => {
  migrate(db!);

  const t = now();

  db!
    .prepare(
      `INSERT INTO users(id, username, password_hash, role, used_bytes, is_active, must_change_password, created_at, updated_at)
       VALUES (1, 'owner', 'x', 'user', 0, 1, 0, ?, ?)`
    )
    .run(t, t);

  // Two synthetic top-level nodes (parent_id IS NULL) sharing a name — allowed,
  // since the partial index only covers parent_id IS NOT NULL rows.
  db!
    .prepare(
      `INSERT INTO nodes(id, owner_id, parent_id, kind, name, created_at, updated_at)
       VALUES (1, 1, NULL, 'root', 'top', ?, ?)`
    )
    .run(t, t);
  expect(() =>
    db!
      .prepare(
        `INSERT INTO nodes(id, owner_id, parent_id, kind, name, created_at, updated_at)
         VALUES (2, 1, NULL, 'trash', 'top', ?, ?)`
      )
      .run(t, t)
  ).not.toThrow();

  // A folder under the root, to serve as parent for the live-name collision test.
  db!
    .prepare(
      `INSERT INTO nodes(id, owner_id, parent_id, kind, name, created_at, updated_at)
       VALUES (3, 1, 1, 'folder', 'Documents', ?, ?)`
    )
    .run(t, t);

  // First live child — OK.
  db!
    .prepare(
      `INSERT INTO nodes(id, owner_id, parent_id, kind, name, created_at, updated_at)
       VALUES (4, 1, 3, 'file', 'a.txt', ?, ?)`
    )
    .run(t, t);

  // Second live child with the same (parent_id, name) — must throw UNIQUE.
  expect(() =>
    db!
      .prepare(
        `INSERT INTO nodes(id, owner_id, parent_id, kind, name, created_at, updated_at)
         VALUES (5, 1, 3, 'file', 'a.txt', ?, ?)`
      )
      .run(t, t)
  ).toThrow(/UNIQUE/i);

  // Trash the first child, then the same name live again — OK.
  db!.prepare('UPDATE nodes SET trashed_at = ? WHERE id = 4').run(t);

  expect(() =>
    db!
      .prepare(
        `INSERT INTO nodes(id, owner_id, parent_id, kind, name, created_at, updated_at)
         VALUES (6, 1, 3, 'file', 'a.txt', ?, ?)`
      )
      .run(t, t)
  ).not.toThrow();
});
