import type Database from 'better-sqlite3';
import { listChildren, type Node } from '../nodes/tree.js';
import type { Share } from './shares.js';

/** Depth cap on the parent-chain walk in {@link resolveInSubtree} (loop-safety). */
const MAX_CHAIN_DEPTH = 10_000;

/**
 * Thrown by {@link resolveInSubtree}/{@link listPublic} for any node id that
 * is not addressable through the given share — junk input, a node outside
 * the shared subtree, a cross-owner node, or a trashed node anywhere in the
 * enclosed path. Deliberately generic (never distinguishes "doesn't exist"
 * from "not yours to see") so a caller can't use it to probe for existence.
 * Phase H maps this to a 403/404 HTTP response; that mapping is not this
 * module's job.
 */
export class ForbiddenError extends Error {
  constructor(message = 'Forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/** Coerces `value` to a positive integer node id, or returns null if it isn't one. */
function coercePositiveInt(value: unknown): number | null {
  let n: number;

  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    n = Number(value);
  } else {
    return null;
  }

  if (!Number.isInteger(n) || n <= 0) {
    return null;
  }

  return n;
}

/**
 * The only public addressing path for a share: resolves a client-supplied
 * `requestedNodeId` to a node row, or throws {@link ForbiddenError}.
 *
 * 1. Coerces/validates `requestedNodeId` to a positive integer — anything
 *    else (NaN, a non-existent row, string junk like `'../x'`) is rejected.
 * 2. Loads the requested node; missing -> forbidden.
 * 3. Requires `requestedNode.owner_id === share.owner_id`.
 * 4. Walks `parent_id` upward from the requested node (the requested node
 *    itself counts as the first step), checking at each step that the node
 *    is owned by `share.owner_id` and not trashed, until it reaches
 *    `share.node_id` — i.e. the shared node is the requested node itself or
 *    a proper ancestor of it (the containment check). If the walk runs out
 *    of chain (hits a synthetic root, a broken link, or the depth cap)
 *    without ever reaching `share.node_id`, the share does not contain the
 *    requested node -> forbidden.
 *
 * This naturally rejects a node that was later moved OUT of the shared
 * folder: its parent chain no longer includes `share.node_id`.
 */
export function resolveInSubtree(
  db: Database.Database,
  share: Pick<Share, 'node_id' | 'owner_id'>,
  requestedNodeId: unknown,
): Node {
  const id = coercePositiveInt(requestedNodeId);
  if (id === null) {
    throw new ForbiddenError();
  }

  const requested = db.prepare('SELECT * FROM nodes WHERE id = @id').get({ id }) as Node | undefined;
  if (!requested) {
    throw new ForbiddenError();
  }

  if (requested.owner_id !== share.owner_id) {
    throw new ForbiddenError();
  }

  let current: Node | undefined = requested;
  for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth++) {
    if (!current || current.owner_id !== share.owner_id || current.trashed_at !== null) {
      throw new ForbiddenError();
    }

    if (current.id === share.node_id) {
      return requested;
    }

    if (current.parent_id === null) {
      throw new ForbiddenError();
    }

    current = db.prepare('SELECT * FROM nodes WHERE id = @id').get({ id: current.parent_id }) as Node | undefined;
  }

  throw new ForbiddenError();
}

/**
 * Lists the live children of `folderId` within `share`'s subtree.
 * `resolveInSubtree` first (throws if `folderId` is outside the subtree).
 * If the resolved node is a `file`, it has no children: returns `[]` when
 * `folderId` is the shared node itself (a file share pointed at itself), or
 * throws {@link ForbiddenError} when it's some other file reached by
 * traversing into a folder share (nothing meaningful to list, and it isn't
 * the thing that was shared). Otherwise delegates to `listChildren` (E1),
 * which already excludes trashed rows — this function never invents a new
 * query that could bypass that filter.
 */
export function listPublic(
  db: Database.Database,
  share: Pick<Share, 'node_id' | 'owner_id'>,
  folderId: unknown,
): Node[] {
  const resolved = resolveInSubtree(db, share, folderId);

  if (resolved.kind === 'file') {
    if (resolved.id !== share.node_id) {
      throw new ForbiddenError();
    }
    return [];
  }

  return listChildren(db, share.owner_id, resolved.id);
}
