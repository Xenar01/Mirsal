import type Database from 'better-sqlite3';
import type { Share } from './shares.js';

/** The FIRST failing reason from {@link isShareLive}'s evaluation order. */
export type ShareLiveReason = 'ok' | 'stopped' | 'expired' | 'gone';

export interface ShareLiveResult {
  live: boolean;
  reason: ShareLiveReason;
}

/**
 * Request-time liveness check for a share (evaluated fresh on every public
 * request — no cached/derived flag). Checks run in this exact order and stop
 * at the FIRST failing one:
 *  1. `!share.is_active` -> `{live:false, reason:'stopped'}`.
 *  2. `share.expires_at != null && share.expires_at <= now` -> `{live:false, reason:'expired'}`.
 *  3. The shared node (`share.node_id`) doesn't exist, or is trashed
 *     (`trashed_at != null`) -> `{live:false, reason:'gone'}`.
 *  4. `node.auto_delete_at != null && node.auto_delete_at <= now` -> `{live:false, reason:'gone'}`.
 *  5. else `{live:true, reason:'ok'}`.
 * The owner sees the real reason; the public route (Phase H) collapses every
 * non-`ok` reason to a generic 404-style response.
 */
export function isShareLive(
  db: Database.Database,
  share: Pick<Share, 'is_active' | 'expires_at' | 'node_id'>,
  now: number,
): ShareLiveResult {
  if (!share.is_active) {
    return { live: false, reason: 'stopped' };
  }

  if (share.expires_at != null && share.expires_at <= now) {
    return { live: false, reason: 'expired' };
  }

  const node = db
    .prepare('SELECT trashed_at, auto_delete_at FROM nodes WHERE id = @nodeId')
    .get({ nodeId: share.node_id }) as { trashed_at: number | null; auto_delete_at: number | null } | undefined;

  if (!node || node.trashed_at !== null) {
    return { live: false, reason: 'gone' };
  }

  if (node.auto_delete_at != null && node.auto_delete_at <= now) {
    return { live: false, reason: 'gone' };
  }

  return { live: true, reason: 'ok' };
}
