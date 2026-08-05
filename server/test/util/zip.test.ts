import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { createFolder, ensureUserRoots, type Node } from '../../src/nodes/tree.js';
import { collectSubtreeFiles, MAX_ZIP_ENTRIES, zipFileName } from '../../src/util/zip.js';

describe('zipFileName', () => {
  it('sanitizes name, strips separators/CRLF, appends .zip', () => {
    expect(zipFileName('طلب تجميع: تقرير')).toMatch(/\.zip$/);
    expect(zipFileName('a/b\\c\r\nd')).not.toMatch(/[/\\\r\n]/);
    expect(zipFileName('')).toBe('download.zip');
  });
});

describe('collectSubtreeFiles', () => {
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

  /** Inserts a user row directly, satisfying every NOT NULL column, and returns its id. Mirrors test/shares/resolver.test.ts's seedUser. */
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

  /** Creates a live file node owned by `ownerId`, under `parentId`. Mirrors test/shares/resolver.test.ts's insertFile. */
  function insertFile(ownerId: number, parentId: number, name: string, now: number): Node {
    const info = db!
      .prepare(
        `INSERT INTO nodes(owner_id, parent_id, kind, name, size_bytes, storage_path, created_at, updated_at)
         VALUES (@ownerId, @parentId, 'file', @name, 5, @storagePath, @now, @now)`
      )
      .run({ ownerId, parentId, name, storagePath: `${ownerId}/${name}`, now });
    return db!.prepare('SELECT * FROM nodes WHERE id = @id').get({ id: info.lastInsertRowid }) as Node;
  }

  it('walks a folder subtree and prefixes nested paths, excluding the root folder name', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-zip-util-'));
    const dbPath = path.join(dir, 't.db');
    db = openDb(dbPath);
    migrate(db);

    const ownerId = seedUser();
    const now = Date.now();
    const { rootId } = ensureUserRoots(db, ownerId, now);

    // root/ (folder) -> a.txt, sub/ (folder) -> b.txt
    const bundle = createFolder(db, ownerId, rootId, 'Bundle', now);
    insertFile(ownerId, bundle.id, 'a.txt', now);
    const sub = createFolder(db, ownerId, bundle.id, 'sub', now);
    insertFile(ownerId, sub.id, 'b.txt', now);

    const files = collectSubtreeFiles(db, ownerId, bundle);
    expect(files.map((f) => f.name).sort()).toEqual(['a.txt', 'sub/b.txt']);

    // guards the constant survived the move
    expect(MAX_ZIP_ENTRIES).toBe(10_000);
  });
});
