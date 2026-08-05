import type Database from 'better-sqlite3';
import { reserve, subtract } from '../storage/quota.js';
import { nextSuffixedName } from '../nodes/collisions.js';
import { sanitizeNodeName } from '../util/names.js';

export interface StagedFile {
  name: string;
  tempPath: string;
  bytes: number;
  mimeType: string | null;
}
export interface CommittedFile {
  tempPath: string;
  nodeId: number;
}
export interface CommitResponseResult {
  removedStoragePaths: string[];
  committed: CommittedFile[];
  responseId: number;
}

/**
 * Thrown inside commitResponse's transaction when the owner's quota can't fit
 * the new set — the throw rolls the whole transaction back (so a failed replace
 * leaves the prior response fully intact).
 */
export class QuotaExceededError extends Error {
  constructor() {
    super('quota exceeded');
    this.name = 'QuotaExceededError';
  }
}

/**
 * Bytes the owner can still accept for THIS department's submission. Adds back
 * the department's CURRENT stored set, since latest-replaces frees it before
 * the new set lands — so a same-size re-submit never falsely trips. Returns
 * null when the owner's quota is unlimited.
 */
export function responseHeadroom(
  db: Database.Database,
  ownerId: number,
  collectionId: number,
  departmentId: number
): number | null {
  const u = db.prepare('SELECT quota_bytes, used_bytes FROM users WHERE id = @ownerId').get({ ownerId }) as {
    quota_bytes: number | null;
    used_bytes: number;
  };
  if (u.quota_bytes === null) return null;
  const prior = db
    .prepare(
      `SELECT COALESCE(SUM(n.size_bytes), 0) AS b
       FROM collection_responses r
       JOIN nodes n ON n.parent_id = r.folder_node_id AND n.kind = 'file'
       WHERE r.collection_id = @collectionId AND r.department_id = @departmentId`
    )
    .get({ collectionId, departmentId }) as { b: number };
  return Math.max(0, u.quota_bytes - u.used_bytes + prior.b);
}

/**
 * Records a department's response (first submission or latest-replaces) in ONE
 * synchronous transaction:
 *  1. If a prior response exists, collect its file blob paths + bytes, delete
 *     those file rows, and `subtract` the freed bytes from the owner. The
 *     department's response subfolder is REUSED (folder_node_id stays stable).
 *  2. `reserve` the new set's bytes against the owner's quota (checked AFTER
 *     the free in step 1, so the check reflects true post-replace usage). On
 *     failure, throw QuotaExceededError — the transaction rolls back.
 *  3. Insert the new file nodes (row-first: the row's final storage_path
 *     `${ownerId}/${nodeId}` is set before the caller renames the blob into
 *     place), de-duplicating names via nextSuffixedName.
 *  4. Upsert the collection_responses row (unique on (collection_id,
 *     department_id) via ux_collection_response_dept).
 * Returns the blob paths to unlink and the temp→final renames to perform AFTER
 * this commits — this function never touches the filesystem.
 */
export function commitResponse(
  db: Database.Database,
  ownerId: number,
  collection: { id: number; folder_node_id: number },
  department: { id: number; name: string },
  staged: StagedFile[],
  note: string | null,
  submittedIp: string | null,
  now: number
): CommitResponseResult {
  const totalBytes = staged.reduce((sum, f) => sum + f.bytes, 0);

  const run = db.transaction((): CommitResponseResult => {
    const prior = db
      .prepare('SELECT id, folder_node_id FROM collection_responses WHERE collection_id = @c AND department_id = @d')
      .get({ c: collection.id, d: department.id }) as { id: number; folder_node_id: number } | undefined;

    const removedStoragePaths: string[] = [];
    let subfolderId: number;

    if (prior) {
      const oldFiles = db
        .prepare("SELECT storage_path, size_bytes FROM nodes WHERE parent_id = @f AND kind = 'file'")
        .all({ f: prior.folder_node_id }) as { storage_path: string | null; size_bytes: number }[];
      let freed = 0;
      for (const of of oldFiles) {
        if (of.storage_path) removedStoragePaths.push(of.storage_path);
        freed += of.size_bytes;
      }
      db.prepare("DELETE FROM nodes WHERE parent_id = @f AND kind = 'file'").run({ f: prior.folder_node_id });
      subtract(db, ownerId, freed);
      subfolderId = prior.folder_node_id;
    } else {
      const folderName = nextSuffixedName(db, collection.folder_node_id, sanitizeNodeName(department.name) ?? 'قسم');
      const info = db
        .prepare(
          `INSERT INTO nodes(owner_id, parent_id, kind, name, size_bytes, created_at, updated_at)
           VALUES (@o, @p, 'folder', @n, 0, @now, @now)`
        )
        .run({ o: ownerId, p: collection.folder_node_id, n: folderName, now });
      subfolderId = Number(info.lastInsertRowid);
    }

    if (!reserve(db, ownerId, totalBytes, now)) {
      throw new QuotaExceededError();
    }

    const committed: CommittedFile[] = [];
    for (const f of staged) {
      const name = nextSuffixedName(db, subfolderId, sanitizeNodeName(f.name) ?? 'file');
      const info = db
        .prepare(
          `INSERT INTO nodes(owner_id, parent_id, kind, name, size_bytes, mime_type, storage_path, created_at, updated_at)
           VALUES (@o, @p, 'file', @n, @sz, @mt, NULL, @now, @now)`
        )
        .run({ o: ownerId, p: subfolderId, n: name, sz: f.bytes, mt: f.mimeType, now });
      const nodeId = Number(info.lastInsertRowid);
      db.prepare('UPDATE nodes SET storage_path = @sp WHERE id = @id').run({ sp: `${ownerId}/${nodeId}`, id: nodeId });
      committed.push({ tempPath: f.tempPath, nodeId });
    }

    const up = db
      .prepare(
        `INSERT INTO collection_responses(collection_id, department_id, folder_node_id, note, submitted_at, submitted_ip)
         VALUES (@c, @d, @f, @note, @now, @ip)
         ON CONFLICT(collection_id, department_id) DO UPDATE SET
           folder_node_id = excluded.folder_node_id, note = excluded.note,
           submitted_at = excluded.submitted_at, submitted_ip = excluded.submitted_ip
         RETURNING id`
      )
      .get({ c: collection.id, d: department.id, f: subfolderId, note, now, ip: submittedIp }) as { id: number };

    // Rowid reuse guard (Defect A): `nodes.id` is a plain INTEGER PRIMARY KEY
    // (no AUTOINCREMENT), so a replacement file can be handed the just-freed id
    // of a deleted old file — giving it the SAME storage_path
    // (`${ownerId}/${nodeId}`). The caller unlinks `removedStoragePaths` AFTER
    // moving the new blobs into place, so any path a committed new file now
    // occupies must be dropped from the unlink list, or that cleanup deletes the
    // blob it just wrote (silent data loss). Paths that were genuinely freed
    // (not reused) still get unlinked.
    const committedPaths = new Set(committed.map((cf) => `${ownerId}/${cf.nodeId}`));
    const safeRemovedStoragePaths = removedStoragePaths.filter((p) => !committedPaths.has(p));

    return { removedStoragePaths: safeRemovedStoragePaths, committed, responseId: up.id };
  });

  return run();
}
