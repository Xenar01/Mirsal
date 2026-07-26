import type Database from 'better-sqlite3';
import type { Node } from './tree.js';
import { nextSuffixedName } from './collisions.js';
import { subtract } from '../storage/quota.js';

/** Result of {@link permanentDelete}: what the caller must unlink after commit. */
export interface PermanentDeleteResult {
  freedBytes: number;
  storagePaths: string[];
}

/**
 * Moves `nodeId` (owned by `ownerId`) and its whole live subtree into the
 * trash. The node must exist, be owned by `ownerId`, not already be trashed,
 * and be a `folder` or `file` (the synthetic `root`/`trash` nodes can never
 * be trashed). In one transaction:
 *  - Every node in the live subtree (a recursive CTE walk down from `nodeId`,
 *    stopping at any branch that's already trashed) gets `trashed_at = now`.
 *  - `parent_id` is left untouched — the node still lives under the same
 *    parent physically. `ux_live_name` is a partial index on
 *    `trashed_at IS NULL`, so stamping `trashed_at` alone frees the name for
 *    reuse under that parent.
 *  - Only the top node also gets `original_parent_id = parent_id` (so
 *    {@link restoreNode} knows where to put it back) and `purge_after = NULL`
 *    (manual trash is never auto-purged by the scheduler).
 *  - `shares` are left untouched: the plan's request-time gate excludes
 *    trashed nodes, so an existing share simply reads as gone while trashed.
 */
export function trashNode(db: Database.Database, ownerId: number, nodeId: number, now: number): Node {
  const node = db
    .prepare('SELECT owner_id, kind, trashed_at FROM nodes WHERE id = @nodeId')
    .get({ nodeId }) as { owner_id: number; kind: Node['kind']; trashed_at: number | null } | undefined;

  if (
    !node ||
    node.owner_id !== ownerId ||
    node.trashed_at !== null ||
    (node.kind !== 'folder' && node.kind !== 'file')
  ) {
    throw new Error(`Invalid node for trashNode: ${nodeId}`);
  }

  const run = db.transaction((): Node => {
    db.prepare(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM nodes WHERE id = @nodeId
         UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id WHERE n.trashed_at IS NULL
       )
       UPDATE nodes SET trashed_at = @now WHERE id IN (SELECT id FROM sub)`
    ).run({ nodeId, now });

    db.prepare(
      'UPDATE nodes SET original_parent_id = parent_id, purge_after = NULL WHERE id = @nodeId'
    ).run({ nodeId });

    return db.prepare('SELECT * FROM nodes WHERE id = @nodeId').get({ nodeId }) as Node;
  });

  return run();
}

/**
 * Restores `nodeId` (owned by `ownerId`) and its subtree out of the trash.
 * The node must exist, be owned by `ownerId`, and currently be trashed. In
 * one transaction:
 *  - The destination parent is `original_parent_id` if that row still
 *    exists and is live; otherwise the user's root (`users.root_node_id`).
 *  - The top node's name is passed through {@link nextSuffixedName} against
 *    the destination — a no-op if the name is free there, otherwise it comes
 *    back auto-suffixed (`"F (1)"`, ...).
 *  - Every node in the subtree (walked structurally via `parent_id`,
 *    regardless of individual `trashed_at` state) gets `trashed_at = NULL`.
 *  - Only the top node also gets `parent_id = destParent`,
 *    `original_parent_id = NULL`, the resolved name, and `updated_at = now`.
 */
export function restoreNode(db: Database.Database, ownerId: number, nodeId: number, now: number): Node {
  const node = db
    .prepare('SELECT owner_id, trashed_at, name, original_parent_id FROM nodes WHERE id = @nodeId')
    .get({ nodeId }) as
    | { owner_id: number; trashed_at: number | null; name: string; original_parent_id: number | null }
    | undefined;

  if (!node || node.owner_id !== ownerId || node.trashed_at === null) {
    throw new Error(`Invalid node for restoreNode: ${nodeId}`);
  }

  const run = db.transaction((): Node => {
    let destParent: number | null = null;
    if (node.original_parent_id !== null) {
      const parentRow = db
        .prepare('SELECT id FROM nodes WHERE id = @id AND trashed_at IS NULL')
        .get({ id: node.original_parent_id }) as { id: number } | undefined;
      if (parentRow) {
        destParent = parentRow.id;
      }
    }
    if (destParent === null) {
      const user = db.prepare('SELECT root_node_id FROM users WHERE id = @ownerId').get({ ownerId }) as {
        root_node_id: number | null;
      };
      destParent = user.root_node_id;
    }
    if (destParent === null) {
      throw new Error(`No destination parent available for restoreNode: ${nodeId}`);
    }

    const finalName = nextSuffixedName(db, destParent, node.name);

    // Clear the descendants first, excluding the top node itself: the top
    // node's trashed_at, name, and parent_id must all flip together in one
    // statement below, or it would transiently go live under its old name
    // at its old parent and collide with whatever now occupies that slot.
    db.prepare(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM nodes WHERE id = @nodeId
         UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id
       )
       UPDATE nodes SET trashed_at = NULL WHERE id IN (SELECT id FROM sub) AND id != @nodeId`
    ).run({ nodeId });

    db.prepare(
      `UPDATE nodes
       SET trashed_at = NULL, parent_id = @destParent, original_parent_id = NULL,
           name = @finalName, updated_at = @now
       WHERE id = @nodeId`
    ).run({ nodeId, destParent, finalName, now });

    return db.prepare('SELECT * FROM nodes WHERE id = @nodeId').get({ nodeId }) as Node;
  });

  return run();
}

/**
 * Permanently deletes `nodeId` (owned by `ownerId`) and its whole subtree.
 * In one transaction:
 *  - The full subtree is collected structurally (a recursive CTE walk down
 *    via `parent_id`, including already-trashed rows).
 *  - Every `kind = 'file'` descendant with a non-NULL `storage_path`
 *    contributes its path to `storagePaths` and its `size_bytes` to
 *    `freedBytes`.
 *  - The top node row is deleted; `ON DELETE CASCADE` on `nodes.parent_id`
 *    and `shares.node_id` removes every descendant node and every share on
 *    any of them.
 *  - The owner's `used_bytes` is decremented by `freedBytes` via
 *    `subtract` (D2).
 * Returns `{ freedBytes, storagePaths }` — the caller unlinks the blobs
 * *after* this commits; this function never touches the filesystem, so a
 * rollback can never orphan a still-referenced blob.
 */
export function permanentDelete(
  db: Database.Database,
  ownerId: number,
  nodeId: number
): PermanentDeleteResult {
  const node = db.prepare('SELECT owner_id FROM nodes WHERE id = @nodeId').get({ nodeId }) as
    | { owner_id: number }
    | undefined;

  if (!node || node.owner_id !== ownerId) {
    throw new Error(`Invalid node for permanentDelete: ${nodeId}`);
  }

  const run = db.transaction((): PermanentDeleteResult => {
    const files = db
      .prepare(
        `WITH RECURSIVE sub(id) AS (
           SELECT id FROM nodes WHERE id = @nodeId
           UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id
         )
         SELECT storage_path, size_bytes FROM nodes
         WHERE id IN (SELECT id FROM sub) AND kind = 'file' AND storage_path IS NOT NULL`
      )
      .all({ nodeId }) as { storage_path: string; size_bytes: number }[];

    const storagePaths = files.map((f) => f.storage_path);
    const freedBytes = files.reduce((sum, f) => sum + f.size_bytes, 0);

    db.prepare('DELETE FROM nodes WHERE id = @nodeId').run({ nodeId });

    subtract(db, ownerId, freedBytes);

    return { freedBytes, storagePaths };
  });

  return run();
}
