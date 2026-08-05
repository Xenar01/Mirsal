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
       VALUES (1, 'owner', 'x', 'user', 0, 1, 0, ?, ?)`,
    )
    .run(t, t);

  // Two synthetic top-level nodes (parent_id IS NULL) sharing a name — allowed,
  // since the partial index only covers parent_id IS NOT NULL rows.
  db!
    .prepare(
      `INSERT INTO nodes(id, owner_id, parent_id, kind, name, created_at, updated_at)
       VALUES (1, 1, NULL, 'root', 'top', ?, ?)`,
    )
    .run(t, t);
  expect(() =>
    db!
      .prepare(
        `INSERT INTO nodes(id, owner_id, parent_id, kind, name, created_at, updated_at)
         VALUES (2, 1, NULL, 'trash', 'top', ?, ?)`,
      )
      .run(t, t),
  ).not.toThrow();

  // A folder under the root, to serve as parent for the live-name collision test.
  db!
    .prepare(
      `INSERT INTO nodes(id, owner_id, parent_id, kind, name, created_at, updated_at)
       VALUES (3, 1, 1, 'folder', 'Documents', ?, ?)`,
    )
    .run(t, t);

  // First live child — OK.
  db!
    .prepare(
      `INSERT INTO nodes(id, owner_id, parent_id, kind, name, created_at, updated_at)
       VALUES (4, 1, 3, 'file', 'a.txt', ?, ?)`,
    )
    .run(t, t);

  // Second live child with the same (parent_id, name) — must throw UNIQUE.
  expect(() =>
    db!
      .prepare(
        `INSERT INTO nodes(id, owner_id, parent_id, kind, name, created_at, updated_at)
         VALUES (5, 1, 3, 'file', 'a.txt', ?, ?)`,
      )
      .run(t, t),
  ).toThrow(/UNIQUE/i);

  // Trash the first child, then the same name live again — OK.
  db!.prepare('UPDATE nodes SET trashed_at = ? WHERE id = 4').run(t);

  expect(() =>
    db!
      .prepare(
        `INSERT INTO nodes(id, owner_id, parent_id, kind, name, created_at, updated_at)
         VALUES (6, 1, 3, 'file', 'a.txt', ?, ?)`,
      )
      .run(t, t),
  ).not.toThrow();
});

/** The exact pre-v2 `shares` DDL (v1 baseline), used to simulate an old DB. */
const V1_SHARES = `CREATE TABLE shares(
  id INTEGER PRIMARY KEY, node_id INTEGER NOT NULL, owner_id INTEGER NOT NULL,
  token TEXT UNIQUE NOT NULL, password_hash TEXT, is_active INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER, allow_download INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, revoked_at INTEGER)`;

/**
 * The `users` table as it existed at the v1 baseline (unchanged by the v2
 * shares-columns migration). These v1/v2 fixtures build a DB with only a
 * `shares` table by design (to test that migration in isolation), but a
 * cumulative migrate() run now also applies the v3 step, which ALTERs
 * `users` — so that table must exist here too, just as it always does on a
 * real v1 DB.
 */
const V1_USERS = `CREATE TABLE users(
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','user')),
  quota_bytes INTEGER,
  used_bytes INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  root_node_id INTEGER,
  trash_node_id INTEGER,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL)`;

function cols(db: Database.Database): string[] {
  return (db.prepare(`PRAGMA table_info(shares)`).all() as { name: string }[]).map((r) => r.name);
}

describe('migrate v2 download-limit columns', () => {
  it('adds the 3 columns to a v1 DB and records the latest version', () => {
    const db = new Database(':memory:');
    db.exec(V1_SHARES);
    db.exec(V1_USERS);
    db.exec('CREATE TABLE schema_version(version INTEGER NOT NULL, applied_at INTEGER NOT NULL)');
    db.prepare('INSERT INTO schema_version(version, applied_at) VALUES (1, 0)').run();
    migrate(db);
    expect(cols(db)).toEqual(expect.arrayContaining(['download_limit', 'download_count', 'on_exhaust']));
    expect((db.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }).v).toBe(4);
  });

  it('a fresh DB has the columns and lands at the latest version', () => {
    const db = new Database(':memory:');
    migrate(db);
    expect(cols(db)).toEqual(expect.arrayContaining(['download_limit', 'download_count', 'on_exhaust']));
    expect((db.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }).v).toBe(4);
  });

  it('fresh and upgraded shares schemas converge (identical table_info)', () => {
    const fresh = new Database(':memory:');
    migrate(fresh);
    const upgraded = new Database(':memory:');
    upgraded.exec(V1_SHARES);
    upgraded.exec(V1_USERS);
    upgraded.exec('CREATE TABLE schema_version(version INTEGER NOT NULL, applied_at INTEGER NOT NULL)');
    upgraded.prepare('INSERT INTO schema_version(version, applied_at) VALUES (1, 0)').run();
    migrate(upgraded);
    expect(fresh.prepare('PRAGMA table_info(shares)').all()).toEqual(
      upgraded.prepare('PRAGMA table_info(shares)').all(),
    );
  });

  it('is idempotent on repeated boots', () => {
    const db = new Database(':memory:');
    migrate(db);
    expect(() => {
      migrate(db);
      migrate(db);
    }).not.toThrow();
    expect((db.prepare('SELECT COUNT(*) c FROM schema_version').get() as { c: number }).c).toBe(1);
  });

  it('tables present but no version row → runs the ALTERs (not the fresh path)', () => {
    const db = new Database(':memory:');
    db.exec(V1_SHARES); // tables exist, but no schema_version rows
    db.exec(V1_USERS);
    migrate(db);
    expect(cols(db)).toEqual(expect.arrayContaining(['download_limit']));
    expect((db.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }).v).toBe(4);
  });
});

/** The exact pre-v3 `users` DDL (v2 baseline), used to simulate an old DB for the display_name migration. */
const V2_USERS = `CREATE TABLE users(
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','user')),
  quota_bytes INTEGER,
  used_bytes INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  root_node_id INTEGER,
  trash_node_id INTEGER,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL)`;

function userCols(db: Database.Database): string[] {
  return (db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[]).map((r) => r.name);
}

describe('migrate v3 users.display_name column', () => {
  it('a fresh DB has display_name and lands at version 3', () => {
    const db = new Database(':memory:');
    migrate(db);
    expect(userCols(db)).toContain('display_name');
    expect((db.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }).v).toBe(4);
  });

  it('adds display_name to a v2 DB and records version 3', () => {
    const db = new Database(':memory:');
    db.exec(V2_USERS);
    db.exec('CREATE TABLE schema_version(version INTEGER NOT NULL, applied_at INTEGER NOT NULL)');
    db.prepare('INSERT INTO schema_version(version, applied_at) VALUES (2, 0)').run();
    migrate(db);
    expect(userCols(db)).toContain('display_name');
    expect((db.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }).v).toBe(4);
  });

  it('fresh and upgraded users schemas converge (identical table_info)', () => {
    const fresh = new Database(':memory:');
    migrate(fresh);
    const upgraded = new Database(':memory:');
    upgraded.exec(V2_USERS);
    upgraded.exec('CREATE TABLE schema_version(version INTEGER NOT NULL, applied_at INTEGER NOT NULL)');
    upgraded.prepare('INSERT INTO schema_version(version, applied_at) VALUES (2, 0)').run();
    migrate(upgraded);
    expect(fresh.prepare('PRAGMA table_info(users)').all()).toEqual(upgraded.prepare('PRAGMA table_info(users)').all());
  });

  it('is idempotent across repeated boots at v3', () => {
    const db = new Database(':memory:');
    migrate(db);
    expect(() => {
      migrate(db);
      migrate(db);
    }).not.toThrow();
    expect((db.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }).v).toBe(4);
  });
});

function tableNames(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
    (r) => r.name,
  );
}

describe('migrate v4 collections tables', () => {
  it('a fresh DB has the three collections tables and lands at version 4', () => {
    const db = new Database(':memory:');
    migrate(db);
    const names = tableNames(db);
    expect(names).toEqual(expect.arrayContaining(['collections', 'collection_departments', 'collection_responses']));
    expect((db.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }).v).toBe(4);
  });

  it('adds the three tables to a v3 DB and records version 4', () => {
    const db = new Database(':memory:');
    // v3 baseline: has users (+display_name) and shares, version row = 3.
    db.exec(V1_SHARES);
    db.exec(V2_USERS);
    db.exec('ALTER TABLE users ADD COLUMN display_name TEXT');
    db.exec('ALTER TABLE shares ADD COLUMN download_limit INTEGER');
    db.exec('ALTER TABLE shares ADD COLUMN download_count INTEGER NOT NULL DEFAULT 0');
    db.exec("ALTER TABLE shares ADD COLUMN on_exhaust TEXT NOT NULL DEFAULT 'delete'");
    db.exec('CREATE TABLE schema_version(version INTEGER NOT NULL, applied_at INTEGER NOT NULL)');
    db.prepare('INSERT INTO schema_version(version, applied_at) VALUES (3, 0)').run();
    migrate(db);
    expect(tableNames(db)).toEqual(
      expect.arrayContaining(['collections', 'collection_departments', 'collection_responses']),
    );
    expect((db.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }).v).toBe(4);
  });

  it('fresh and upgraded collections schemas converge (identical sqlite_master DDL)', () => {
    const fresh = new Database(':memory:');
    migrate(fresh);
    const upgraded = new Database(':memory:');
    upgraded.exec(V1_SHARES);
    upgraded.exec(V1_USERS);
    upgraded.exec('CREATE TABLE schema_version(version INTEGER NOT NULL, applied_at INTEGER NOT NULL)');
    upgraded.prepare('INSERT INTO schema_version(version, applied_at) VALUES (1, 0)').run();
    migrate(upgraded);
    const ddl = (db: Database.Database) =>
      (
        db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE name IN ('collections','collection_departments','collection_responses') ORDER BY name",
          )
          .all() as { sql: string }[]
      ).map((r) => r.sql);
    expect(ddl(fresh)).toEqual(ddl(upgraded));
  });

  it('is idempotent at v4', () => {
    const db = new Database(':memory:');
    migrate(db);
    expect(() => {
      migrate(db);
      migrate(db);
    }).not.toThrow();
    expect((db.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }).v).toBe(4);
  });
});
