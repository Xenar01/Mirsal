import type Database from 'better-sqlite3';
import { randomToken } from '../util/ids.js';
import { hashPassword } from '../auth/passwords.js';

/** Mirrors a row of the `shares` table verbatim. */
export interface Share {
  id: number;
  node_id: number;
  owner_id: number;
  token: string;
  password_hash: string | null;
  is_active: number;
  expires_at: number | null;
  allow_download: number;
  created_at: number;
  revoked_at: number | null;
  download_limit: number | null;
  download_count: number;
  on_exhaust: 'stop' | 'delete';
}

export interface CreateShareOptions {
  /** Non-empty string to protect the share with a password; omitted/empty = no password. */
  password?: string;
  /** epoch-ms deadline; omitted/undefined = never expires. */
  expiresAt?: number | null;
}

/**
 * Tri-state patch for {@link setShareState}: a key that is **omitted**
 * (`undefined`) leaves that column unchanged; an explicit `null` clears it
 * (`password_hash`/`expires_at`/`downloadLimit` only — `isActive` and
 * `onExhaust` are plain non-null values, no null state); a value sets it.
 */
export interface SetShareStatePatch {
  isActive?: boolean;
  password?: string | null;
  expiresAt?: number | null;
  downloadLimit?: number | null;
  onExhaust?: 'stop' | 'delete';
}

/**
 * Creates a share for `nodeId`, owned by `ownerId`. The node must exist, be
 * owned by `ownerId`, and not be trashed (`trashed_at IS NULL`) — otherwise
 * throws. Generates a plaintext `token` via `randomToken(32)` (this token IS
 * the public URL — looked up directly, never hashed, unlike session tokens).
 * If `options.password` is a non-empty string, it is hashed via the shared
 * `hashPassword` service (module-level, semaphore-bound — never a second
 * instance) and stored as `password_hash`; otherwise `password_hash` is
 * NULL. Returns the freshly inserted row. Async: awaits `hashPassword` when
 * a password is supplied.
 *
 * The initial existence/ownership/trashed check runs before the
 * `hashPassword` await, so it is re-verified a second time, atomically with
 * the INSERT (a single synchronous INSERT...SELECT against the current
 * `nodes` row) — otherwise a node trashed (or re-owned) during that await
 * gap could still get a share row inserted for it.
 */
export async function createShare(
  db: Database.Database,
  ownerId: number,
  nodeId: number,
  options: CreateShareOptions,
  now: number,
): Promise<Share> {
  const node = db.prepare('SELECT owner_id, trashed_at FROM nodes WHERE id = @nodeId').get({ nodeId }) as
    { owner_id: number; trashed_at: number | null } | undefined;

  if (!node || node.owner_id !== ownerId || node.trashed_at !== null) {
    throw new Error(`Invalid node for createShare: ${nodeId}`);
  }

  const token = randomToken(32);
  const passwordHash = options.password ? await hashPassword(options.password) : null;
  const expiresAt = options.expiresAt ?? null;

  // The ownership/trashed guard above ran before the `await hashPassword`
  // gap, so the node could have been trashed (or its ownership changed)
  // while we awaited. Re-verify atomically as part of the INSERT itself
  // (an INSERT...SELECT with the same guard in its WHERE clause) so no
  // other JS can run between the check and the write — closing that race.
  const info = db
    .prepare(
      `INSERT INTO shares(node_id, owner_id, token, password_hash, is_active, expires_at, allow_download, created_at, revoked_at)
       SELECT @nodeId, @ownerId, @token, @passwordHash, 1, @expiresAt, 1, @now, NULL
       FROM nodes
       WHERE id = @nodeId AND owner_id = @ownerId AND trashed_at IS NULL`,
    )
    .run({ nodeId, ownerId, token, passwordHash, expiresAt, now });

  if (info.changes === 0) {
    throw new Error(`Invalid node for createShare: ${nodeId}`);
  }

  return db.prepare('SELECT * FROM shares WHERE id = @id').get({ id: info.lastInsertRowid }) as Share;
}

/**
 * Applies `patch` to the share `shareId`, scoped to `ownerId` (both the
 * UPDATE and the returned re-SELECT filter on `owner_id`, so a share owned
 * by a different user is left untouched and `undefined` is returned). Only
 * the keys present in `patch` are written — see {@link SetShareStatePatch}
 * for the tri-state semantics of `password`/`expiresAt`/`downloadLimit`. A
 * string `password` is hashed via the shared `hashPassword` service before
 * storage. Setting or clearing `downloadLimit` also resets `download_count`
 * to 0 in the same atomic UPDATE (a fresh budget starts the moment the limit
 * changes). Returns the updated row, or `undefined` if no row matched.
 */
export async function setShareState(
  db: Database.Database,
  ownerId: number,
  shareId: number,
  patch: SetShareStatePatch,
): Promise<Share | undefined> {
  const sets: string[] = [];
  const params: Record<string, unknown> = { shareId, ownerId };

  if (patch.isActive !== undefined) {
    sets.push('is_active = @isActive');
    params.isActive = patch.isActive ? 1 : 0;
  }
  if (patch.password !== undefined) {
    sets.push('password_hash = @passwordHash');
    params.passwordHash = patch.password === null ? null : await hashPassword(patch.password);
  }
  if (patch.expiresAt !== undefined) {
    sets.push('expires_at = @expiresAt');
    params.expiresAt = patch.expiresAt;
  }
  if (patch.downloadLimit !== undefined) {
    // Setting (or clearing) the limit starts a fresh budget — one atomic UPDATE.
    sets.push('download_limit = @downloadLimit', 'download_count = 0');
    params.downloadLimit = patch.downloadLimit;
  }
  if (patch.onExhaust !== undefined) {
    sets.push('on_exhaust = @onExhaust');
    params.onExhaust = patch.onExhaust;
  }

  if (sets.length > 0) {
    db.prepare(`UPDATE shares SET ${sets.join(', ')} WHERE id = @shareId AND owner_id = @ownerId`).run(params);
  }

  return db.prepare('SELECT * FROM shares WHERE id = @shareId AND owner_id = @ownerId').get({
    shareId,
    ownerId,
  }) as Share | undefined;
}

/** Deletes the share (hard-delete — plan chose this over a `revoked_at` flag), scoped to `ownerId`. */
export function revokeShare(db: Database.Database, ownerId: number, shareId: number): void {
  db.prepare('DELETE FROM shares WHERE id = @shareId AND owner_id = @ownerId').run({ shareId, ownerId });
}

/**
 * Pure status derivation for a share row: `is_active = 0` → `'stopped'`
 * (checked first); else an exhausted download limit (`download_limit` set
 * and `download_count` has reached it) → `'exhausted'`; else a past
 * `expires_at` → `'expired'`; else `'active'`.
 */
export function ownerStatus(
  share: Pick<Share, 'is_active' | 'expires_at' | 'download_limit' | 'download_count'>,
  now: number,
): 'active' | 'stopped' | 'expired' | 'exhausted' {
  if (!share.is_active) return 'stopped';
  if (share.download_limit != null && share.download_count >= share.download_limit) return 'exhausted';
  if (share.expires_at != null && share.expires_at < now) return 'expired';
  return 'active';
}
