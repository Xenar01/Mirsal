import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { ensureUserRoots } from '../../src/nodes/tree.js';
import { verifyPassword } from '../../src/auth/passwords.js';
import {
  createCollection,
  getCollection,
  collectionStatus,
  normalizeDepartments,
  listCollections,
  setCollectionState,
  deleteCollection,
} from '../../src/collections/collections.js';

let db: Database.Database | undefined;
let dir: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-col-'));
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
function seedFileNode(uid: number, now: number, trashedAt: number | null = null): number {
  const { rootId } = ensureUserRoots(db!, uid, now);
  const info = db!
    .prepare(
      `INSERT INTO nodes(owner_id, parent_id, kind, name, size_bytes, storage_path, trashed_at, created_at, updated_at)
       VALUES (@ownerId, @parentId, 'file', @name, 5, 'u/1', @trashedAt, @now, @now)`
    )
    .run({ ownerId: uid, parentId: rootId, name: `f-${Math.random()}`, trashedAt, now });
  return Number(info.lastInsertRowid);
}

// --- collectionStatus (pure) ---
test('collectionStatus: closed beats expired beats open', () => {
  const now = 1000;
  expect(collectionStatus({ is_active: 0, deadline_at: null }, now)).toBe('closed');
  expect(collectionStatus({ is_active: 0, deadline_at: 500 }, now)).toBe('closed'); // closed wins
  expect(collectionStatus({ is_active: 1, deadline_at: 500 }, now)).toBe('expired');
  expect(collectionStatus({ is_active: 1, deadline_at: 5000 }, now)).toBe('open');
  expect(collectionStatus({ is_active: 1, deadline_at: null }, now)).toBe('open');
});

// --- normalizeDepartments (pure) ---
test('normalizeDepartments trims, drops empties, dedupes, preserves order', () => {
  expect(normalizeDepartments([' HR ', 'HR', '', '  ', 'Finance', 'Finance'])).toEqual(['HR', 'Finance']);
});

// --- createCollection ---
test('createCollection: token >= 43, is_active=1, folder under root, departments positioned', async () => {
  const uid = seedUser();
  const now = 1_700_000_000_000;
  const { rootId } = ensureUserRoots(db!, uid, now);

  const c = await createCollection(db!, uid, { title: 'تقرير الربع الأول', departments: ['HR', 'Finance', 'IT'] }, now);

  expect(c.token.length).toBeGreaterThanOrEqual(43);
  expect(c.is_active).toBe(1);
  expect(c.password_hash).toBeNull();
  expect(c.deadline_at).toBeNull();
  expect(c.owner_id).toBe(uid);

  const folder = db!.prepare('SELECT parent_id, kind, name FROM nodes WHERE id = ?').get(c.folder_node_id) as
    { parent_id: number; kind: string; name: string };
  expect(folder.parent_id).toBe(rootId);
  expect(folder.kind).toBe('folder');
  expect(folder.name).toBe('طلب تجميع: تقرير الربع الأول');

  const depts = db!
    .prepare('SELECT name, position FROM collection_departments WHERE collection_id = ? ORDER BY position')
    .all(c.id) as { name: string; position: number }[];
  expect(depts).toEqual([
    { name: 'HR', position: 0 },
    { name: 'Finance', position: 1 },
    { name: 'IT', position: 2 },
  ]);
});

test('createCollection with a password: hashed and verifies; empty password => no hash', async () => {
  const uid = seedUser();
  const now = Date.now();
  const c = await createCollection(db!, uid, { title: 'T', departments: ['A'], password: 'secret' }, now);
  expect(c.password_hash).not.toBeNull();
  await expect(verifyPassword(c.password_hash!, 'secret')).resolves.toBe(true);

  const c2 = await createCollection(db!, uid, { title: 'U', departments: ['A'], password: '' }, now);
  expect(c2.password_hash).toBeNull();
});

test('createCollection accepts a valid template file; rejects foreign/trashed/folder', async () => {
  const uid = seedUser();
  const other = seedUser();
  const now = Date.now();
  const good = seedFileNode(uid, now);
  const c = await createCollection(db!, uid, { title: 'T', departments: ['A'], templateNodeId: good }, now);
  expect(c.template_node_id).toBe(good);

  const foreign = seedFileNode(other, now);
  await expect(createCollection(db!, uid, { title: 'T2', departments: ['A'], templateNodeId: foreign }, now))
    .rejects.toThrow('bad_template');

  const trashed = seedFileNode(uid, now, now);
  await expect(createCollection(db!, uid, { title: 'T3', departments: ['A'], templateNodeId: trashed }, now))
    .rejects.toThrow('bad_template');

  const { rootId } = ensureUserRoots(db!, uid, now); // a folder is not a file
  await expect(createCollection(db!, uid, { title: 'T4', departments: ['A'], templateNodeId: rootId }, now))
    .rejects.toThrow('bad_template');
});

test('createCollection rejects an all-empty department list', async () => {
  const uid = seedUser();
  await expect(createCollection(db!, uid, { title: 'T', departments: ['', '  '] }, Date.now()))
    .rejects.toThrow('no_departments');
});

test('createCollection dedupes duplicate department names', async () => {
  const uid = seedUser();
  const c = await createCollection(db!, uid, { title: 'T', departments: ['HR', 'HR', 'Finance'] }, Date.now());
  const count = db!.prepare('SELECT COUNT(*) c FROM collection_departments WHERE collection_id = ?').get(c.id) as { c: number };
  expect(count.c).toBe(2);
});

test('createCollection twice with the same title auto-suffixes the folder (no collision)', async () => {
  const uid = seedUser();
  const now = Date.now();
  const a = await createCollection(db!, uid, { title: 'Same', departments: ['A'] }, now);
  const b = await createCollection(db!, uid, { title: 'Same', departments: ['A'] }, now);
  const nameA = (db!.prepare('SELECT name FROM nodes WHERE id = ?').get(a.folder_node_id) as { name: string }).name;
  const nameB = (db!.prepare('SELECT name FROM nodes WHERE id = ?').get(b.folder_node_id) as { name: string }).name;
  expect(nameA).toBe('طلب تجميع: Same');
  expect(nameB).toBe('طلب تجميع: Same (1)');
});

// --- getCollection (owner-scoped) ---
test('getCollection is owner-scoped', async () => {
  const uid = seedUser();
  const other = seedUser();
  const c = await createCollection(db!, uid, { title: 'T', departments: ['A'] }, Date.now());
  expect(getCollection(db!, uid, c.id)?.id).toBe(c.id);
  expect(getCollection(db!, other, c.id)).toBeUndefined();
});

/** Seeds a department response: a subfolder under the collection folder holding `fileBytes` file. */
function seedResponse(collectionId: number, departmentId: number, collectionFolderId: number, uid: number, now: number, fileBytes = 10): number {
  const subInfo = db!
    .prepare(`INSERT INTO nodes(owner_id, parent_id, kind, name, size_bytes, created_at, updated_at)
              VALUES (@uid, @parent, 'folder', @name, 0, @now, @now)`)
    .run({ uid, parent: collectionFolderId, name: `dept-${departmentId}`, now });
  const subId = Number(subInfo.lastInsertRowid);
  db!.prepare(`INSERT INTO nodes(owner_id, parent_id, kind, name, size_bytes, storage_path, created_at, updated_at)
               VALUES (@uid, @parent, 'file', @name, @bytes, @sp, @now, @now)`)
    .run({ uid, parent: subId, name: `r-${Math.random()}`, bytes: fileBytes, sp: `${uid}/${Math.random()}`, now });
  db!.prepare(`INSERT INTO collection_responses(collection_id, department_id, folder_node_id, note, submitted_at)
               VALUES (?, ?, ?, NULL, ?)`).run(collectionId, departmentId, subId, now);
  return subId;
}

test('listCollections returns owner rows newest-first with department + responded counts', async () => {
  const uid = seedUser();
  const now = Date.now();
  const c = await createCollection(db!, uid, { title: 'T', departments: ['A', 'B', 'C'] }, now);
  const deptA = (db!.prepare('SELECT id FROM collection_departments WHERE collection_id=? ORDER BY position').get(c.id) as { id: number }).id;
  seedResponse(c.id, deptA, c.folder_node_id, uid, now);

  const rows = listCollections(db!, uid);
  expect(rows.length).toBe(1);
  expect(rows[0]).toMatchObject({ id: c.id, department_count: 3, responded_count: 1 });
});

test('listCollections orders newest-first by created_at (not insertion/id order) and is owner-scoped', async () => {
  const uid = seedUser();
  const other = seedUser();

  // c1 is created FIRST (lower id) but with a LATER `now`; c2 is created
  // SECOND (higher id) but with an EARLIER `now`. If the query ordered by
  // id/insertion order instead of created_at, this would come out reversed.
  const c1 = await createCollection(db!, uid, { title: 'Newer', departments: ['A'] }, 2000);
  const c2 = await createCollection(db!, uid, { title: 'Older', departments: ['A'] }, 1000);
  // A collection owned by a different user, with the latest `now` of all
  // three — if owner-scoping were broken it would leak into `uid`'s rows
  // (and would sort first, breaking the ordering assertion too).
  await createCollection(db!, other, { title: 'Foreign', departments: ['A'] }, 3000);

  const rows = listCollections(db!, uid);
  expect(rows.map((r) => r.id)).toEqual([c1.id, c2.id]);
  expect(rows.every((r) => r.owner_id === uid)).toBe(true);
});

test('setCollectionState updates title/isActive/deadline, clears password with null, bumps updated_at, owner-scoped', async () => {
  const uid = seedUser();
  const other = seedUser();
  const now = 1000;
  const c = await createCollection(db!, uid, { title: 'Old', departments: ['A'], password: 'pw' }, now);

  const u1 = await setCollectionState(db!, uid, c.id, { title: 'New', isActive: false, deadlineAt: 5000 }, 2000);
  expect(u1).toMatchObject({ title: 'New', is_active: 0, deadline_at: 5000 });
  expect(u1!.updated_at).toBe(2000);

  const u2 = await setCollectionState(db!, uid, c.id, { password: null }, 3000);
  expect(u2!.password_hash).toBeNull();

  const u2b = await setCollectionState(db!, uid, c.id, { deadlineAt: null }, 3500);
  expect(u2b!.deadline_at).toBeNull();

  // Foreign owner cannot touch it.
  const u3 = await setCollectionState(db!, other, c.id, { isActive: true }, 4000);
  expect(u3).toBeUndefined();
  expect((db!.prepare('SELECT is_active FROM collections WHERE id=?').get(c.id) as { is_active: number }).is_active).toBe(0);
});

test('deleteCollection removes the collection, its folder subtree, departments/responses, and returns blob paths', async () => {
  const uid = seedUser();
  const now = Date.now();
  const c = await createCollection(db!, uid, { title: 'T', departments: ['A'] }, now);
  const deptA = (db!.prepare('SELECT id FROM collection_departments WHERE collection_id=?').get(c.id) as { id: number }).id;
  seedResponse(c.id, deptA, c.folder_node_id, uid, now, 42);

  const res = deleteCollection(db!, uid, c.id);
  expect(res.deleted).toBe(true);
  expect(res.storagePaths.length).toBe(1);

  expect(db!.prepare('SELECT COUNT(*) c FROM collections WHERE id=?').get(c.id)).toMatchObject({ c: 0 });
  expect(db!.prepare('SELECT COUNT(*) c FROM collection_departments WHERE collection_id=?').get(c.id)).toMatchObject({ c: 0 });
  expect(db!.prepare('SELECT COUNT(*) c FROM collection_responses WHERE collection_id=?').get(c.id)).toMatchObject({ c: 0 });
  expect(db!.prepare('SELECT COUNT(*) c FROM nodes WHERE id=?').get(c.folder_node_id)).toMatchObject({ c: 0 });
});

test('deleteCollection on a foreign/missing collection returns deleted=false', () => {
  const uid = seedUser();
  expect(deleteCollection(db!, uid, 999999)).toEqual({ deleted: false, storagePaths: [] });
});

test('deleteCollection does not allow a non-owner to delete another user\'s real collection', async () => {
  const uid = seedUser();
  const other = seedUser();
  const now = Date.now();
  const c = await createCollection(db!, uid, { title: 'T', departments: ['A'] }, now);

  const res = deleteCollection(db!, other, c.id);
  expect(res).toEqual({ deleted: false, storagePaths: [] });

  // The collection row and its folder node must be untouched.
  expect(db!.prepare('SELECT COUNT(*) c FROM collections WHERE id=?').get(c.id)).toMatchObject({ c: 1 });
  expect(db!.prepare('SELECT COUNT(*) c FROM nodes WHERE id=?').get(c.folder_node_id)).toMatchObject({ c: 1 });
});
