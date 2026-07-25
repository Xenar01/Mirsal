import type Database from 'better-sqlite3';

/** Mirrors a row of the `nodes` table verbatim. */
export interface Node {
  id: number;
  owner_id: number;
  parent_id: number | null;
  kind: 'root' | 'trash' | 'folder' | 'file';
  name: string;
  size_bytes: number;
  mime_type: string | null;
  storage_path: string | null;
  trashed_at: number | null;
  original_parent_id: number | null;
  auto_delete_at: number | null;
  purge_after: number | null;
  created_at: number;
  updated_at: number;
}

export interface UserRoots {
  rootId: number;
  trashId: number;
}

/**
 * Ensures `userId` has synthetic `root` and `trash` nodes, creating them on
 * first call and returning the same ids on every subsequent call (idempotent).
 * Wrapped in a transaction: the read-then-maybe-insert-then-update sequence
 * is atomic, so concurrent callers can't create duplicate root/trash pairs.
 */
export function ensureUserRoots(db: Database.Database, userId: number, now: number): UserRoots {
  const run = db.transaction((): UserRoots => {
    const user = db
      .prepare('SELECT root_node_id, trash_node_id FROM users WHERE id = @userId')
      .get({ userId }) as { root_node_id: number | null; trash_node_id: number | null };

    if (user.root_node_id !== null && user.trash_node_id !== null) {
      return { rootId: user.root_node_id, trashId: user.trash_node_id };
    }

    const insertNode = db.prepare(
      `INSERT INTO nodes(owner_id, parent_id, kind, name, created_at, updated_at)
       VALUES (@userId, NULL, @kind, @kind, @now, @now)`
    );

    const rootId = Number(insertNode.run({ userId, kind: 'root', now }).lastInsertRowid);
    const trashId = Number(insertNode.run({ userId, kind: 'trash', now }).lastInsertRowid);

    db.prepare(
      'UPDATE users SET root_node_id = @rootId, trash_node_id = @trashId WHERE id = @userId'
    ).run({ rootId, trashId, userId });

    return { rootId, trashId };
  });

  return run();
}

/**
 * Creates a live folder under `parentId`, owned by `ownerId`. The parent
 * must exist, be owned by `ownerId`, and be a `root` or `folder` (never a
 * `file` or the synthetic `trash` node). A duplicate live name under the
 * same parent violates `ux_live_name` and is left to propagate as a raw
 * SQLite UNIQUE error — callers map it to a 409 (not this module's job).
 */
export function createFolder(
  db: Database.Database,
  ownerId: number,
  parentId: number,
  name: string,
  now: number
): Node {
  const parent = db
    .prepare('SELECT owner_id, kind FROM nodes WHERE id = @parentId')
    .get({ parentId }) as { owner_id: number; kind: Node['kind'] } | undefined;

  if (!parent || parent.owner_id !== ownerId || (parent.kind !== 'root' && parent.kind !== 'folder')) {
    throw new Error(`Invalid parent for createFolder: ${parentId}`);
  }

  const info = db
    .prepare(
      `INSERT INTO nodes(owner_id, parent_id, kind, name, size_bytes, created_at, updated_at)
       VALUES (@ownerId, @parentId, 'folder', @name, 0, @now, @now)`
    )
    .run({ ownerId, parentId, name, now });

  return db.prepare('SELECT * FROM nodes WHERE id = @id').get({ id: info.lastInsertRowid }) as Node;
}

/**
 * Lists the live (non-trashed) direct children of `parentId` owned by
 * `ownerId`, folders first, then name-sorted case-insensitively.
 */
export function listChildren(db: Database.Database, ownerId: number, parentId: number): Node[] {
  return db
    .prepare(
      `SELECT * FROM nodes
       WHERE owner_id = @ownerId AND parent_id = @parentId AND trashed_at IS NULL
       ORDER BY (kind = 'folder') DESC, name COLLATE NOCASE ASC`
    )
    .all({ ownerId, parentId }) as Node[];
}

/**
 * Sums `size_bytes` over every live `file` descendant of `nodeId` (a
 * recursive CTE walk of the subtree, excluding trashed nodes at every
 * level). Returns 0 for a node with no live file descendants.
 */
export function rollupSize(db: Database.Database, nodeId: number): number {
  const row = db
    .prepare(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM nodes WHERE id = @nodeId
         UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id WHERE n.trashed_at IS NULL
       )
       SELECT COALESCE(SUM(size_bytes), 0) AS total FROM nodes
       WHERE id IN (SELECT id FROM sub) AND kind = 'file' AND trashed_at IS NULL`
    )
    .get({ nodeId }) as { total: number };

  return row.total;
}
