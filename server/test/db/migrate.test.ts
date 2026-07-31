import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, test } from 'vitest';
import { openDb } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import Database from 'better-sqlite3';

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

/** The exact pre-v2 `shares` DDL (v1 baseline), used to simulate an old DB. */
const V1_SHARES = `CREATE TABLE shares(
  id INTEGER PRIMARY KEY, node_id INTEGER NOT NULL, owner_id INTEGER NOT NULL,
  token TEXT UNIQUE NOT NULL, password_hash TEXT, is_active INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER, allow_download INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, revoked_at INTEGER)`;

function cols(db: Database.Database): string[] {
  return (db.prepare(`PRAGMA table_info(shares)`).all() as { name: string }[]).map((r) => r.name);
}

describe('migrate v2 download-limit columns', () => {
  it('adds the 3 columns to a v1 DB and records version 2', () => {
    const db = new Database(':memory:');
    db.exec(V1_SHARES);
    db.exec('CREATE TABLE schema_version(version INTEGER NOT NULL, applied_at INTEGER NOT NULL)');
    db.prepare('INSERT INTO schema_version(version, applied_at) VALUES (1, 0)').run();
    migrate(db);
    expect(cols(db)).toEqual(expect.arrayContaining(['download_limit', 'download_count', 'on_exhaust']));
    expect((db.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }).v).toBe(2);
  });

  it('a fresh DB has the columns and lands at version 2', () => {
    const db = new Database(':memory:');
    migrate(db);
    expect(cols(db)).toEqual(expect.arrayContaining(['download_limit', 'download_count', 'on_exhaust']));
    expect((db.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }).v).toBe(2);
  });

  it('fresh and upgraded shares schemas converge (identical table_info)', () => {
    const fresh = new Database(':memory:'); migrate(fresh);
    const upgraded = new Database(':memory:');
    upgraded.exec(V1_SHARES);
    upgraded.exec('CREATE TABLE schema_version(version INTEGER NOT NULL, applied_at INTEGER NOT NULL)');
    upgraded.prepare('INSERT INTO schema_version(version, applied_at) VALUES (1, 0)').run();
    migrate(upgraded);
    expect(fresh.prepare('PRAGMA table_info(shares)').all()).toEqual(
      upgraded.prepare('PRAGMA table_info(shares)').all()
    );
  });

  it('is idempotent on repeated boots', () => {
    const db = new Database(':memory:'); migrate(db);
    expect(() => { migrate(db); migrate(db); }).not.toThrow();
    expect((db.prepare('SELECT COUNT(*) c FROM schema_version').get() as { c: number }).c).toBe(1);
  });

  it('tables present but no version row → runs the ALTERs (not the fresh path)', () => {
    const db = new Database(':memory:');
    db.exec(V1_SHARES); // tables exist, but no schema_version rows
    migrate(db);
    expect(cols(db)).toEqual(expect.arrayContaining(['download_limit']));
    expect((db.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }).v).toBe(2);
  });
});
