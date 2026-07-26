import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { writeAudit } from '../src/audit.js';

let db: Database.Database | undefined;
let dir: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-h1-audit-'));
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

test('writeAudit inserts one row matching audit_log columns', () => {
  writeAudit(
    db!,
    { actorId: 7, action: 'login', target: 'user:7', detail: 'ok' },
    () => 1_700_000_000_000
  );

  const row = db!.prepare('SELECT * FROM audit_log').get() as Record<string, unknown>;

  expect(row).toMatchObject({
    actor_id: 7,
    action: 'login',
    target: 'user:7',
    detail: 'ok',
    created_at: 1_700_000_000_000,
  });
});

test('writeAudit allows a null actor_id (survives user deletion per schema)', () => {
  writeAudit(db!, { actorId: null, action: 'system.cleanup' }, () => 42);

  const row = db!.prepare('SELECT * FROM audit_log').get() as Record<string, unknown>;

  expect(row.actor_id).toBeNull();
  expect(row.action).toBe('system.cleanup');
  expect(row.target).toBeNull();
  expect(row.detail).toBeNull();
  expect(row.created_at).toBe(42);
});
