import type Database from 'better-sqlite3';
import type { Clock } from '../clock.js';
import { GRACE_MS as DEFAULT_GRACE_MS, loadConfig } from '../config.js';
import { permanentDelete, trashNode } from '../nodes/trash.js';
import { deleteBlob } from '../storage/blobs.js';
import { dueTrash, duePurge, orphanBlobs } from './selectors.js';

/** Max due rows processed per tick, per phase (auto-trash, purge). */
const BATCH = 500;

/**
 * Max orphan blobs unlinked per tick — bounds the sweep the same way `BATCH`
 * bounds the dueTrash/duePurge phases. Any leftover orphans beyond this cap
 * are simply picked up by a later tick; this only spreads a large backlog
 * across ticks, it never loses one.
 */
const ORPHAN_BATCH = 500;

/** The subset of {@link import('../config.js').Config} the scheduler needs, injectable for tests. */
export interface SchedulerCfg {
  GRACE_MS: number;
  STORAGE_DIR: string;
  /** Test-only override of the orphan-sweep batch cap; defaults to {@link ORPHAN_BATCH}. */
  ORPHAN_BATCH?: number;
}

export interface TickResult {
  trashed: number;
  purged: number;
}

function defaultCfg(): SchedulerCfg {
  return { GRACE_MS: DEFAULT_GRACE_MS, STORAGE_DIR: loadConfig().STORAGE_DIR };
}

/**
 * Resolves after the event loop has processed at least one macrotask/I/O
 * callback ahead of us — unlike a bare microtask `await`, `setImmediate`
 * genuinely yields, which is what lets other pending work (new requests,
 * timers) interleave with a long synchronous sweep instead of it running as
 * one unbounded blocking burst.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
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
 *  1. `dueTrash`: for each due live node, `trashNode` and the
 *     `purge_after = now + GRACE_MS` stamp commit together in **one
 *     transaction** (auto-trash sets a purge deadline; manual trash leaves
 *     it NULL) — never two separate writes, so a crash can never strand a
 *     node trashed-but-never-purge-scheduled. A node that vanishes/becomes
 *     invalid by the time it's processed (e.g. cascaded away), or whose
 *     stamp fails, rolls the whole transaction back and is skipped — not
 *     fatal to the tick, and not left in a half-done state.
 *  2. `duePurge`: for each due node, `permanentDelete` (its own committed
 *     transaction) and collect the returned `storagePaths`. Same
 *     skip-on-error tolerance (a parent purged earlier in this batch can
 *     cascade a child row away before its own turn).
 *  3. Only after every `permanentDelete` transaction above has committed:
 *     unlink every collected blob path, one at a time with a per-item
 *     try/catch. `deleteBlob` is idempotent on ENOENT, so a double-unlink
 *     (e.g. a retried tick) is safe; a non-ENOENT failure on one path is
 *     swallowed and does not abort the rest, skip the orphan sweep, or
 *     reject the tick — the DB row is already gone, so a failed unlink here
 *     just leaves an orphan for a later sweep to retry.
 *  4. Orphan sweep: unlink blobs under `STORAGE_DIR` with no matching
 *     `nodes.storage_path` row — reclaims blobs left behind by a crash
 *     between step 2's commit and step 3's unlink on a prior run. Driven by
 *     the `orphanBlobs` async generator (streamed `opendirSync`/`readSync`
 *     enumeration with periodic event-loop yields), stopped at an orphan
 *     batch size per tick and yielding between every unlink, so neither the
 *     directory enumeration nor the unlinking blocks the loop for one
 *     unbounded burst on a large `STORAGE_DIR` — any excess orphans are
 *     swept on a later tick. Also per-item fault tolerant, same rationale as
 *     step 3.
 *
 * `cfg` (GRACE_MS/STORAGE_DIR/ORPHAN_BATCH) is optional and defaults to
 * `loadConfig()`/the module's batch constant — pass it explicitly in tests
 * for an isolated temp STORAGE_DIR or a small orphan-batch cap.
 */
export async function runTick(db: Database.Database, now: number, cfg?: SchedulerCfg): Promise<TickResult> {
  if (running) {
    return { trashed: 0, purged: 0 };
  }
  running = true;
  try {
    const { GRACE_MS, STORAGE_DIR, ORPHAN_BATCH: orphanBatchOverride } = cfg ?? defaultCfg();
    const orphanBatch = orphanBatchOverride ?? ORPHAN_BATCH;

    // Atomic auto-trash + purge-deadline stamp: both writes commit together
    // or neither does. Nested inside `runTick`'s own transaction usage
    // elsewhere is fine — better-sqlite3 nests via SAVEPOINT, so if the
    // purge_after UPDATE below throws, trashNode's own (already-committed
    // inner) changes are rolled back too, never leaving a node stranded
    // outside both dueTrash (already trashed_at-stamped) and duePurge
    // (purge_after never stamped) forever.
    const trashAndStampPurge = db.transaction((ownerId: number, nodeId: number) => {
      trashNode(db, ownerId, nodeId, now);
      db.prepare('UPDATE nodes SET purge_after = @purgeAfter WHERE id = @id').run({
        purgeAfter: now + GRACE_MS,
        id: nodeId,
      });
    });

    let trashed = 0;
    for (const node of dueTrash(db, now, BATCH)) {
      try {
        trashAndStampPurge(node.owner_id, node.id);
        trashed++;
      } catch {
        // Node vanished/became invalid, or the purge_after stamp failed —
        // either way the whole transaction rolled back, so the node is left
        // exactly as it was (still live, still due) for the next tick to retry.
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
    // Per-item fault tolerance (mirroring the DB phases above): a single
    // non-ENOENT deleteBlob failure must not abort the remaining unlinks,
    // must not skip the orphan sweep below, and must not reject runTick's
    // promise — the DB row is already gone (source of truth), so a failed
    // unlink here just leaves an orphan a later sweep will retry.
    for (const p of allPaths) {
      try {
        deleteBlob(p);
      } catch {
        // Best-effort — see rationale above.
      }
    }

    // Orphan sweep: reclaims blobs left by a crash-after-commit on a prior
    // tick. `orphanBlobs` is an async generator that streams the STORAGE_DIR
    // walk (opendirSync/readSync one entry at a time + periodic event-loop
    // yields), so neither the *enumeration* nor the *unlink* side blocks the
    // loop for one unbounded burst proportional to a large STORAGE_DIR (design
    // spec §9). We stop at `orphanBatch` per tick (breaking closes the
    // generator's dir handles and does no further enumeration — any excess is
    // swept on a later tick) and yield between unlinks. Per-item fault
    // tolerant, same rationale as the unlink loop above.
    let swept = 0;
    for await (const rel of orphanBlobs(db, STORAGE_DIR)) {
      if (swept >= orphanBatch) break;
      try {
        deleteBlob(rel);
      } catch {
        // Best-effort — see rationale above.
      }
      swept++;
      await yieldToEventLoop();
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
