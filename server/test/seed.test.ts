import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { loadConfig, type Config } from '../src/config.js';
import { ensureAdmin } from '../src/seed.js';

let db: Database.Database | undefined;
let dir: string | undefined;
let testConfig: Config;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-h6-'));
  const dbDir = path.join(dir, 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 't.db');
  db = openDb(dbPath);
  migrate(db);

  testConfig = loadConfig({
    DB_PATH: dbPath,
    STORAGE_DIR: path.join(dir, 'storage'),
    SESSION_SECRET: 'a'.repeat(32),
    CSRF_SECRET: 'b'.repeat(32),
    PUBLIC_BASE_URL: 'https://mirsal.example.test',
  });
});

afterEach(() => {
  db?.close();
  db = undefined;
  if (dir) {
    fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

function credentialPath(): string {
  return path.join(path.dirname(testConfig.DB_PATH), 'admin-credential.txt');
}

test('ensureAdmin on an empty DB creates exactly one admin with roots and a 0600 credential file', async () => {
  await ensureAdmin(db!, testConfig, () => 1000);

  const admins = db!.prepare("SELECT * FROM users WHERE role = 'admin'").all() as Array<{
    username: string;
    must_change_password: number;
    is_active: number;
    root_node_id: number | null;
    trash_node_id: number | null;
  }>;
  expect(admins).toHaveLength(1);
  expect(admins[0].username).toBe('admin');
  expect(admins[0].must_change_password).toBe(1);
  expect(admins[0].is_active).toBe(1);
  expect(admins[0].root_node_id).not.toBeNull();
  expect(admins[0].trash_node_id).not.toBeNull();

  const p = credentialPath();
  expect(fs.existsSync(p)).toBe(true);
  const mode = fs.statSync(p).mode & 0o777;
  expect(mode).toBe(0o600);

  const content = fs.readFileSync(p, 'utf8');
  expect(content).toContain('admin');
  const passwordMatch = content.match(/password:\s*(\S+)/);
  expect(passwordMatch).not.toBeNull();
  expect(passwordMatch![1].length).toBeGreaterThan(0);
});

test('ensureAdmin is idempotent: a second call creates no second admin and leaves the credential file untouched', async () => {
  await ensureAdmin(db!, testConfig, () => 1000);

  const p = credentialPath();
  const before = fs.readFileSync(p, 'utf8');
  const statBefore = fs.statSync(p);

  await ensureAdmin(db!, testConfig, () => 2000);

  const count = db!.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as {
    n: number;
  };
  expect(count.n).toBe(1);

  const after = fs.readFileSync(p, 'utf8');
  expect(after).toBe(before);
  const statAfter = fs.statSync(p);
  expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
});
