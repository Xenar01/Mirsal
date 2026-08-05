import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { createCollection } from '../../src/collections/collections.js';
import {
  addDepartment, removeDepartment, listDepartments, getRoster, DuplicateDepartmentError,
} from '../../src/collections/departments.js';

let db: Database.Database | undefined;
let dir: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-dept-'));
  db = openDb(path.join(dir, 't.db'));
  migrate(db);
});
afterEach(() => {
  db?.close(); db = undefined;
  if (dir) { fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; }
});

const keys = ['DB_PATH', 'STORAGE_DIR', 'SESSION_SECRET', 'CSRF_SECRET', 'PUBLIC_BASE_URL'] as const;
const originals: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of keys) originals[k] = process.env[k];
  process.env.DB_PATH = '/tmp/mirsal-test/db.sqlite';
  process.env.STORAGE_DIR = '/tmp/mirsal-test/storage';
  process.env.SESSION_SECRET = 'a'.repeat(32);
  process.env.CSRF_SECRET = 'b'.repeat(32);
  process.env.PUBLIC_BASE_URL = 'https://mirsal.example.com';
});
afterAll(() => {
  for (const k of keys) originals[k] === undefined ? delete process.env[k] : (process.env[k] = originals[k]!);
});

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

async function mkCollection(uid: number, depts: string[], now = Date.now()) {
  return createCollection(db!, uid, { title: 'T', departments: depts }, now);
}

test('addDepartment appends with the next position; duplicate name throws DuplicateDepartmentError', async () => {
  const uid = seedUser();
  const c = await mkCollection(uid, ['A', 'B']);
  const d = addDepartment(db!, uid, c.id, ' C ', Date.now());
  expect(d).toMatchObject({ name: 'C', position: 2 });
  expect(() => addDepartment(db!, uid, c.id, 'A', Date.now())).toThrow(DuplicateDepartmentError);
});

test('addDepartment on a foreign collection throws not_found; blank name throws invalid_name', async () => {
  const uid = seedUser();
  const other = seedUser();
  const c = await mkCollection(uid, ['A']);
  expect(() => addDepartment(db!, other, c.id, 'X', Date.now())).toThrow('not_found');
  expect(() => addDepartment(db!, uid, c.id, '   ', Date.now())).toThrow('invalid_name');
});

test('removeDepartment removes a response-less department; foreign => not_found', async () => {
  const uid = seedUser();
  const other = seedUser();
  const c = await mkCollection(uid, ['A', 'B']);
  const b = listDepartments(db!, c.id).find((d) => d.name === 'B')!;
  expect(removeDepartment(db!, other, c.id, b.id)).toBe('not_found');
  expect(removeDepartment(db!, uid, c.id, b.id)).toBe('removed');
  expect(listDepartments(db!, c.id).some((d) => d.name === 'B')).toBe(false);
});

test('removeDepartment refuses a department that already has a response', async () => {
  const uid = seedUser();
  const now = Date.now();
  const c = await mkCollection(uid, ['A']);
  const a = listDepartments(db!, c.id)[0];
  // seed a response subfolder + row for dept A
  const sub = Number(db!.prepare(`INSERT INTO nodes(owner_id,parent_id,kind,name,size_bytes,created_at,updated_at)
    VALUES (?,?,'folder','A',0,?,?)`).run(uid, c.folder_node_id, now, now).lastInsertRowid);
  db!.prepare(`INSERT INTO collection_responses(collection_id,department_id,folder_node_id,note,submitted_at)
    VALUES (?,?,?,NULL,?)`).run(c.id, a.id, sub, now);
  expect(removeDepartment(db!, uid, c.id, a.id)).toBe('has_response');
});

test('getRoster lists every department, marks responded + file_count, ordered by position', async () => {
  const uid = seedUser();
  const now = Date.now();
  const c = await mkCollection(uid, ['A', 'B']);
  const [a] = listDepartments(db!, c.id);
  // dept A responds with 2 files under its subfolder; B stays missing.
  const sub = Number(db!.prepare(`INSERT INTO nodes(owner_id,parent_id,kind,name,size_bytes,created_at,updated_at)
    VALUES (?,?,'folder','A',0,?,?)`).run(uid, c.folder_node_id, now, now).lastInsertRowid);
  for (let i = 0; i < 2; i++)
    db!.prepare(`INSERT INTO nodes(owner_id,parent_id,kind,name,size_bytes,storage_path,created_at,updated_at)
      VALUES (?,?,'file',?,3,?,?,?)`).run(uid, sub, `f${i}`, `${uid}/${i}`, now, now);
  db!.prepare(`INSERT INTO collection_responses(collection_id,department_id,folder_node_id,note,submitted_at)
    VALUES (?,?,?,'hi',?)`).run(c.id, a.id, sub, now);

  const roster = getRoster(db!, c.id);
  expect(roster.map((r) => r.name)).toEqual(['A', 'B']);
  expect(roster[0]).toMatchObject({ responded: true, file_count: 2, note: 'hi', folder_node_id: sub });
  expect(roster[1]).toMatchObject({ responded: false, file_count: 0, note: null, folder_node_id: null });
});
