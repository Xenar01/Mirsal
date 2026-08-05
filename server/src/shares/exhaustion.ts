import type Database from 'better-sqlite3';
import type { Clock } from '../clock.js';
import { trashNode } from '../nodes/trash.js';
import { writeAudit } from '../audit.js';

/** Trash grace for a burn-deleted file (distinct from the 7-day manual-trash grace). */
export const EXHAUST_PURGE_GRACE_MS = 24 * 60 * 60 * 1000;

export interface ExhaustibleShare {
  id: number;
  owner_id: number;
  node_id: number;
  on_exhaust: 'stop' | 'delete';
  download_limit: number | null;
}

/**
 * Runs the terminal action for a share whose download limit was just reached.
 * Idempotent and tolerant of an already-trashed/foreign node, so it can run
 * inside a raw response 'close' handler without ever throwing. All writes,
 * including the audit row, commit in one transaction. `actorId` is NULL (system).
 */
export function applyExhaustion(db: Database.Database, share: ExhaustibleShare, now: Clock): void {
  if (share.on_exhaust === 'stop') {
    db.transaction(() => {
      // Guard on is_active = 1 and only audit when this call actually flipped
      // it: a second invocation on an already-stopped share does zero row
      // changes and writes no duplicate audit row (true side-effect
      // idempotency, not just converging state).
      const info = db.prepare('UPDATE shares SET is_active = 0 WHERE id = @id AND is_active = 1').run({ id: share.id });
      if (info.changes === 1) {
        writeAudit(
          db,
          {
            actorId: null,
            action: 'share_download_limit_stopped',
            target: String(share.id),
            detail: JSON.stringify({ owner_id: share.owner_id, limit: share.download_limit }),
          },
          now,
        );
      }
    })();
    return;
  }

  const node = db.prepare('SELECT owner_id, trashed_at FROM nodes WHERE id = @id').get({ id: share.node_id }) as
    { owner_id: number; trashed_at: number | null } | undefined;
  if (!node || node.owner_id !== share.owner_id || node.trashed_at !== null) {
    return; // already trashed / foreign / gone — nothing to do
  }

  const nowMs = now();
  db.transaction(() => {
    // trashNode sets purge_after = NULL, so stamp AFTER it (mirrors the scheduler's
    // trashAndStampPurge). trashNode throws on an already-trashed/foreign node, but
    // we re-checked liveness above inside this synchronous txn.
    trashNode(db, share.owner_id, share.node_id, nowMs);
    db.prepare('UPDATE nodes SET purge_after = @deadline WHERE id = @id').run({
      deadline: nowMs + EXHAUST_PURGE_GRACE_MS,
      id: share.node_id,
    });
    writeAudit(
      db,
      {
        actorId: null,
        action: 'share_download_limit_deleted',
        target: String(share.id),
        detail: JSON.stringify({ owner_id: share.owner_id, node_id: share.node_id, limit: share.download_limit }),
      },
      now,
    );
  })();
}
