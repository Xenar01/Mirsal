import type Database from 'better-sqlite3';

/** Thrown by moveNode when the move would create a cycle (into itself or a descendant). */
export class CycleError extends Error {
  constructor(message = 'Cannot move a node into itself or one of its own descendants') {
    super(message);
    this.name = 'CycleError';
  }
}

/** Thrown by moveNode/renameNode when the destination already has a live node with that name. */
export class CollisionError extends Error {
  constructor(message = 'A live node with that name already exists in the destination') {
    super(message);
    this.name = 'CollisionError';
  }
}

/** True iff a raw SQLite error is a UNIQUE-constraint violation (`ux_live_name`). */
function isUniqueConstraintError(e: unknown): boolean {
  return (
    e instanceof Error &&
    ((e as NodeJS.ErrnoException).code === 'SQLITE_CONSTRAINT_UNIQUE' ||
      /UNIQUE constraint failed/i.test(e.message))
  );
}

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

/**
 * True iff `maybeAncestorId` is a proper ancestor of `nodeId` (walking up via
 * `parent_id`). `nodeId` is never its own ancestor. A recursive CTE collects
 * `nodeId`'s parent chain (id, parent_id) starting from `nodeId` itself; a
 * hit means some node on that chain has `parent_id = maybeAncestorId`.
 */
export function isAncestor(db: Database.Database, maybeAncestorId: number, nodeId: number): boolean {
  const row = db
    .prepare(
      `WITH RECURSIVE up(id, parent_id) AS (
         SELECT id, parent_id FROM nodes WHERE id = @nodeId
         UNION ALL SELECT n.id, n.parent_id FROM nodes n JOIN up ON n.id = up.parent_id
       )
       SELECT 1 FROM up WHERE parent_id = @maybeAncestorId LIMIT 1`
    )
    .get({ nodeId, maybeAncestorId });

  return row !== undefined;
}

/**
 * Moves `nodeId` (owned by `ownerId`) to become a child of `newParentId`.
 * Both nodes must exist and be owned by `ownerId`; `newParentId` must be a
 * `root` or `folder` (never a `file`). Guards against cycles *before*
 * touching the row: moving a node into itself, or into one of its own
 * descendants, throws `CycleError`. A live-name clash at the destination
 * (caught from the UPDATE's `ux_live_name` UNIQUE violation) throws
 * `CollisionError` instead of the raw SQLite error.
 */
export function moveNode(
  db: Database.Database,
  ownerId: number,
  nodeId: number,
  newParentId: number,
  now: number
): Node {
  const node = db.prepare('SELECT owner_id FROM nodes WHERE id = @nodeId').get({ nodeId }) as
    | { owner_id: number }
    | undefined;
  if (!node || node.owner_id !== ownerId) {
    throw new Error(`Invalid node for moveNode: ${nodeId}`);
  }

  const newParent = db
    .prepare('SELECT owner_id, kind FROM nodes WHERE id = @newParentId')
    .get({ newParentId }) as { owner_id: number; kind: Node['kind'] } | undefined;
  if (
    !newParent ||
    newParent.owner_id !== ownerId ||
    (newParent.kind !== 'root' && newParent.kind !== 'folder')
  ) {
    throw new Error(`Invalid destination for moveNode: ${newParentId}`);
  }

  if (nodeId === newParentId || isAncestor(db, nodeId, newParentId)) {
    throw new CycleError();
  }

  try {
    db.prepare(
      'UPDATE nodes SET parent_id = @newParentId, updated_at = @now WHERE id = @nodeId AND owner_id = @ownerId'
    ).run({ nodeId, newParentId, now, ownerId });
  } catch (e) {
    if (isUniqueConstraintError(e)) {
      throw new CollisionError();
    }
    throw e;
  }

  return db.prepare('SELECT * FROM nodes WHERE id = @nodeId').get({ nodeId }) as Node;
}

/**
 * Renames `nodeId` (owned by `ownerId`) to `newName`. The node must exist,
 * be owned by `ownerId`, and be a `folder` or `file` (root/trash can't be
 * renamed). A live-name clash under the same parent (`ux_live_name` UNIQUE
 * violation) throws `CollisionError` instead of the raw SQLite error.
 */
export function renameNode(
  db: Database.Database,
  ownerId: number,
  nodeId: number,
  newName: string,
  now: number
): Node {
  const node = db.prepare('SELECT owner_id, kind FROM nodes WHERE id = @nodeId').get({ nodeId }) as
    | { owner_id: number; kind: Node['kind'] }
    | undefined;
  if (
    !node ||
    node.owner_id !== ownerId ||
    (node.kind !== 'folder' && node.kind !== 'file')
  ) {
    throw new Error(`Invalid node for renameNode: ${nodeId}`);
  }

  try {
    db.prepare(
      'UPDATE nodes SET name = @newName, updated_at = @now WHERE id = @nodeId AND owner_id = @ownerId'
    ).run({ nodeId, newName, now, ownerId });
  } catch (e) {
    if (isUniqueConstraintError(e)) {
      throw new CollisionError();
    }
    throw e;
  }

  return db.prepare('SELECT * FROM nodes WHERE id = @nodeId').get({ nodeId }) as Node;
}
