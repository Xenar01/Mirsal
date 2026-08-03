import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { ensureUserRoots } from '../../src/nodes/tree.js';
import { commitResponse, responseHeadroom, QuotaExceededError, type StagedFile } from '../../src/collections/responses.js';

const NOW = 1_700_000_000_000;
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

function fresh(): Database.Database {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-resp-'));
  db = openDb(path.join(dir, 't.db'));
  migrate(db);
  return db;
}
function seedOwner(quota: number | null): number {
  const info = db!
    .prepare(
      `INSERT INTO users(username,password_hash,role,is_active,must_change_password,quota_bytes,used_bytes,created_at,updated_at)
       VALUES (?, 'h', 'user', 1, 0, ?, 0, ?, ?)`
    )
    .run(`o-${Math.random()}`, quota, NOW, NOW);
  return Number(info.lastInsertRowid);
}
/** Seeds a collection folder + one department; returns the ids the model needs. */
function seedCollection(ownerId: number): { collectionId: number; folderNodeId: number; deptId: number } {
  const { rootId } = ensureUserRoots(db!, ownerId, NOW);
  const folderNodeId = Number(
    db!
      .prepare(`INSERT INTO nodes(owner_id,parent_id,kind,name,size_bytes,created_at,updated_at)
                VALUES (?,?,'folder',?,0,?,?)`)
      .run(ownerId, rootId, `طلب تجميع: ${Math.random()}`, NOW, NOW).lastInsertRowid
  );
  const collectionId = Number(
    db!
      .prepare(`INSERT INTO collections(owner_id,token,title,template_node_id,folder_node_id,password_hash,is_active,deadline_at,created_at,updated_at)
                VALUES (?,?,?,NULL,?,NULL,1,NULL,?,?)`)
      .run(ownerId, `tok-${Math.random()}`, 'T', folderNodeId, NOW, NOW).lastInsertRowid
  );
  const deptId = Number(
    db!
      .prepare(`INSERT INTO collection_departments(collection_id,name,position,created_at) VALUES (?,?,0,?)`)
      .run(collectionId, 'HR', NOW).lastInsertRowid
  );
  return { collectionId, folderNodeId, deptId };
}
function staged(name: string, bytes: number): StagedFile {
  return { name, tempPath: `/tmp/fake-${name}-${Math.random()}`, bytes, mimeType: 'application/octet-stream' };
}

test('first submission: creates the dept subfolder + file nodes; response row + used_bytes', () => {
  const database = fresh();
  const owner = seedOwner(null);
  const { collectionId, folderNodeId, deptId } = seedCollection(owner);

  const res = commitResponse(
    database,
    owner,
    { id: collectionId, folder_node_id: folderNodeId },
    { id: deptId, name: 'HR' },
    [staged('a.txt', 100), staged('b.txt', 50)],
    'my note',
    '1.2.3.4',
    NOW
  );

  expect(res.committed).toHaveLength(2);
  expect(res.removedStoragePaths).toEqual([]);
  const sub = database.prepare("SELECT id FROM nodes WHERE parent_id=? AND kind='folder'").get(folderNodeId) as { id: number };
  const files = database
    .prepare("SELECT name, storage_path, size_bytes FROM nodes WHERE parent_id=? AND kind='file' ORDER BY name")
    .all(sub.id) as { name: string; storage_path: string; size_bytes: number }[];
  expect(files.map((f) => f.name)).toEqual(['a.txt', 'b.txt']);
  expect(files.every((f) => f.storage_path.startsWith(`${owner}/`))).toBe(true);
  const row = database.prepare('SELECT * FROM collection_responses WHERE collection_id=? AND department_id=?').get(collectionId, deptId) as any;
  expect(row.folder_node_id).toBe(sub.id);
  expect(row.note).toBe('my note');
  expect(row.submitted_ip).toBe('1.2.3.4');
  const used = database.prepare('SELECT used_bytes FROM users WHERE id=?').get(owner) as { used_bytes: number };
  expect(used.used_bytes).toBe(150);
});

test('latest-replaces: second submit removes the prior set, reclaims quota, keeps one row/slot', () => {
  const database = fresh();
  const owner = seedOwner(null);
  const { collectionId, folderNodeId, deptId } = seedCollection(owner);

  const first = commitResponse(database, owner, { id: collectionId, folder_node_id: folderNodeId }, { id: deptId, name: 'HR' }, [staged('old.txt', 200)], null, null, NOW);
  const second = commitResponse(database, owner, { id: collectionId, folder_node_id: folderNodeId }, { id: deptId, name: 'HR' }, [staged('new.txt', 30)], 'updated', null, NOW + 1);

  // The prior file's storage_path is reported for the caller to unlink.
  expect(second.removedStoragePaths).toEqual([`${owner}/${first.committed[0].nodeId}`]);
  const rows = database.prepare('SELECT COUNT(*) n FROM collection_responses WHERE collection_id=? AND department_id=?').get(collectionId, deptId) as { n: number };
  expect(rows.n).toBe(1);
  const sub = (database.prepare('SELECT folder_node_id f FROM collection_responses WHERE collection_id=? AND department_id=?').get(collectionId, deptId) as { f: number }).f;
  const files = database.prepare("SELECT name FROM nodes WHERE parent_id=? AND kind='file'").all(sub) as { name: string }[];
  expect(files.map((f) => f.name)).toEqual(['new.txt']);
  const used = database.prepare('SELECT used_bytes FROM users WHERE id=?').get(owner) as { used_bytes: number };
  expect(used.used_bytes).toBe(30);
});

test('over quota: throws QuotaExceededError and rolls back (no new nodes, used_bytes unchanged)', () => {
  const database = fresh();
  const owner = seedOwner(100); // 100-byte quota
  const { collectionId, folderNodeId, deptId } = seedCollection(owner);

  expect(() =>
    commitResponse(database, owner, { id: collectionId, folder_node_id: folderNodeId }, { id: deptId, name: 'HR' }, [staged('big.bin', 500)], null, null, NOW)
  ).toThrow(QuotaExceededError);

  expect((database.prepare("SELECT COUNT(*) n FROM nodes WHERE kind='file'").get() as { n: number }).n).toBe(0);
  expect((database.prepare('SELECT used_bytes FROM users WHERE id=?').get(owner) as { used_bytes: number }).used_bytes).toBe(0);
  expect((database.prepare('SELECT COUNT(*) n FROM collection_responses').get() as { n: number }).n).toBe(0);
});

test('over quota on REPLACE rolls back and preserves the prior response', () => {
  const database = fresh();
  const owner = seedOwner(250);
  const { collectionId, folderNodeId, deptId } = seedCollection(owner);
  commitResponse(database, owner, { id: collectionId, folder_node_id: folderNodeId }, { id: deptId, name: 'HR' }, [staged('a', 200)], null, null, NOW);
  // Replacing 200 with 300: post-free headroom = 250 - 200 + 200 = 250 < 300 -> reject, keep old.
  expect(() =>
    commitResponse(database, owner, { id: collectionId, folder_node_id: folderNodeId }, { id: deptId, name: 'HR' }, [staged('b', 300)], null, null, NOW + 1)
  ).toThrow(QuotaExceededError);
  const sub = (database.prepare('SELECT folder_node_id f FROM collection_responses WHERE collection_id=? AND department_id=?').get(collectionId, deptId) as { f: number }).f;
  const files = database.prepare("SELECT name, size_bytes FROM nodes WHERE parent_id=? AND kind='file'").all(sub) as { name: string; size_bytes: number }[];
  expect(files).toHaveLength(1);
  expect(files[0].name).toBe('a');
  expect((database.prepare('SELECT used_bytes FROM users WHERE id=?').get(owner) as { used_bytes: number }).used_bytes).toBe(200);
});

test('responseHeadroom: unlimited -> null; bounded accounts for the prior set', () => {
  const database = fresh();
  const owner = seedOwner(null);
  const c1 = seedCollection(owner);
  expect(responseHeadroom(database, owner, c1.collectionId, c1.deptId)).toBeNull();

  const owner2 = seedOwner(1000);
  const c2 = seedCollection(owner2);
  commitResponse(database, owner2, { id: c2.collectionId, folder_node_id: c2.folderNodeId }, { id: c2.deptId, name: 'HR' }, [staged('x', 400)], null, null, NOW);
  // used=400, quota=1000, prior set=400 -> headroom = 1000 - 400 + 400 = 1000.
  expect(responseHeadroom(database, owner2, c2.collectionId, c2.deptId)).toBe(1000);
  // A different department with no prior response: headroom = 1000 - 400 + 0 = 600.
  const otherDept = Number(
    database.prepare(`INSERT INTO collection_departments(collection_id,name,position,created_at) VALUES (?, 'Finance', 1, ?)`).run(c2.collectionId, NOW).lastInsertRowid
  );
  expect(responseHeadroom(database, owner2, c2.collectionId, otherDept)).toBe(600);
});
