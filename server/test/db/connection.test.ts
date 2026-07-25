import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openDb } from '../../src/db/connection.js';
import type Database from 'better-sqlite3';

let db: Database.Database | undefined;
let dir: string | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
  if (dir) {
    fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

test('openDb enables foreign_keys and WAL journal_mode', () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-b1-'));
  const dbPath = path.join(dir, 't.db');

  db = openDb(dbPath);

  expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  expect(String(db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
});
