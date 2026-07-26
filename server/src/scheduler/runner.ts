import type Database from 'better-sqlite3';
import type { Clock } from '../clock.js';
import { GRACE_MS as DEFAULT_GRACE_MS, loadConfig } from '../config.js';
import { permanentDelete, trashNode } from '../nodes/trash.js';
import { deleteBlob } from '../storage/blobs.js';
import { dueTrash, duePurge, orphanBlobs } from './selectors.js';

/** Max due rows processed per tick, per phase (auto-trash, purge). */
const BATCH = 500;

/** The subset of {@link import('../config.js').Config} the scheduler needs, injectable for tests. */
export interface SchedulerCfg {
  GRACE_MS: number;
  STORAGE_DIR: string;
}

export interface TickResult {
  trashed: number;
  purged: number;
}

function defaultCfg(): SchedulerCfg {
  return { GRACE_MS: DEFAULT_GRACE_MS, STORAGE_DIR: loadConfig().STORAGE_DIR };
}

/** Module-level reentrancy lock — see {@link runTick}. */
let running = false;

/**
 * Runs one cleanup pass: auto-trash due nodes, hard-purge due-trashed nodes,
 * then sweep orphaned blobs. Reentrant-safe: if a prior call is still in
 * flight, this returns `{trashed: 0, purged: 0}` immediately rather than
 * overlapping it — the lock is held across the whole tick, including the
 * async post-commit unlink phase, so two calls fired back-to-back over the
 * same due set result in exactly one of them doing the work.
 *
 * Ordering (crash-safety invariant: never unlink a blob whose row still
 * exists — DB rows are the source of truth):
 *  1. `dueTrash`: for each due live node, `trashNode` then stamp
 *     `purge_after = now + GRACE_MS` (auto-trash sets a purge deadline;
 *     manual trash leaves it NULL). A node that vanishes or is otherwise
 *     invalid by the time it's processed (e.g. cascaded away) is skipped,
 *     not fatal to the tick.
 *  2. `duePurge`: for each due node, `permanentDelete` (its own committed
 *     transaction) and collect the returned `storagePaths`. Same
 *     skip-on-error tolerance (a parent purged earlier in this batch can
 *     cascade a child row away before its own turn).
 *  3. Only after every `permanentDelete` transaction above has committed:
 *     unlink every collected blob path. `deleteBlob` is idempotent on
 *     ENOENT, so a double-unlink (e.g. a retried tick) is safe.
 *  4. Orphan sweep: unlink any blob under `STORAGE_DIR` with no matching
 *     `nodes.storage_path` row — reclaims a blob left behind by a
 *     crash between step 2's commit and step 3's unlink on a prior run.
 *
 * `cfg` (GRACE_MS/STORAGE_DIR) is optional and defaults to `loadConfig()` —
 * pass it explicitly in tests for an isolated temp STORAGE_DIR.
 */
export async function runTick(
  db: Database.Database,
  now: number,
  cfg?: SchedulerCfg
): Promise<TickResult> {
  if (running) {
    return { trashed: 0, purged: 0 };
  }
  running = true;
  try {
    const { GRACE_MS, STORAGE_DIR } = cfg ?? defaultCfg();

    let trashed = 0;
    for (const node of dueTrash(db, now, BATCH)) {
      try {
        trashNode(db, node.owner_id, node.id, now);
        db.prepare('UPDATE nodes SET purge_after = @purgeAfter WHERE id = @id').run({
          purgeAfter: now + GRACE_MS,
          id: node.id,
        });
        trashed++;
      } catch {
        // Node vanished or became invalid between select and trash — skip.
      }
    }

    let purged = 0;
    const allPaths: string[] = [];
    for (const node of duePurge(db, now, BATCH)) {
      try {
        const { storagePaths } = permanentDelete(db, node.owner_id, node.id);
        allPaths.push(...storagePaths);
        purged++;
      } catch {
        // Node vanished (e.g. cascaded away by an earlier purge this tick) — skip.
      }
    }

    // Post-commit unlink: every permanentDelete above has already committed.
    await Promise.all(allPaths.map((p) => deleteBlob(p)));

    // Orphan sweep: reclaims blobs left by a crash-after-commit on a prior tick.
    for (const rel of orphanBlobs(db, STORAGE_DIR)) {
      await deleteBlob(rel);
    }

    return { trashed, purged };
  } finally {
    running = false;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the 60s-by-default cleanup interval: calls `runTick(db, clock())`
 * on every tick, swallowing a rejection so a thrown tick never kills the
 * interval. Calling this again while already started is a no-op (call
 * {@link stopScheduler} first to change the schedule).
 */
export function startScheduler(db: Database.Database, clock: Clock, intervalMs = 60000): void {
  if (timer !== null) return;
  timer = setInterval(() => {
    runTick(db, clock()).catch(() => {
      // A thrown/rejected tick must never kill the interval — next tick still fires.
    });
  }, intervalMs);
}

/** Stops the cleanup interval started by {@link startScheduler}. Idempotent. */
export function stopScheduler(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
