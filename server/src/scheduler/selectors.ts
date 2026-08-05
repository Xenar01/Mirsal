import { opendirSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Node } from '../nodes/tree.js';

/**
 * Default number of directory entries {@link orphanBlobs} examines between
 * explicit event-loop yields. Bounds the longest uninterrupted synchronous
 * burst (streamed readdir batch reads + `hasNode.get()` DB lookups) to this
 * many, independent of how many files the walk ultimately visits.
 */
const DEFAULT_SCAN_YIELD_EVERY = 500;

/**
 * Yields control to the event loop for one macrotask turn. `setImmediate` (as
 * opposed to a bare microtask `await`) genuinely defers to the next loop turn,
 * letting pending I/O/timers interleave — and, unlike real fs async I/O, it is
 * driven by the timer subsystem so tests using fake timers still advance it.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Live nodes (`trashed_at IS NULL`) whose `auto_delete_at` has arrived
 * (non-NULL and `<= now`), oldest deadline first, capped at `limit`. These
 * are the nodes the scheduler is about to auto-trash. Pure read: no mutation.
 */
export function dueTrash(db: Database.Database, now: number, limit: number): Node[] {
  return db
    .prepare(
      `SELECT * FROM nodes
       WHERE auto_delete_at IS NOT NULL AND auto_delete_at <= @now AND trashed_at IS NULL
       ORDER BY auto_delete_at ASC
       LIMIT @limit`,
    )
    .all({ now, limit }) as Node[];
}

/**
 * Nodes whose `purge_after` deadline has elapsed (non-NULL and `<= now`),
 * oldest deadline first, capped at `limit`. Only auto-trashed top nodes ever
 * carry `purge_after` (manual trash leaves it NULL), so this never selects a
 * manually-trashed node. These are the nodes the scheduler is about to
 * hard-purge. Pure read: no mutation.
 */
export function duePurge(db: Database.Database, now: number, limit: number): Node[] {
  return db
    .prepare(
      `SELECT * FROM nodes
       WHERE purge_after IS NOT NULL AND purge_after <= @now
       ORDER BY purge_after ASC
       LIMIT @limit`,
    )
    .all({ now, limit }) as Node[];
}

/**
 * Lazily enumerates blob files under `storageDir`
 * (`<storageDir>/<ownerId>/<file>`) and yields the relative storage paths
 * (`"<ownerId>/<file>"`) that have no matching `nodes.storage_path` row —
 * candidates for G2's cleanup pass. Entries whose basename starts with
 * `.tmp-` are in-flight uploads (D1) and are never reported as orphans.
 * Non-directory entries directly under `storageDir` are skipped. A missing
 * `storageDir` is tolerated and yields nothing. Pure read: this never touches
 * the filesystem beyond listing it, and never deletes anything (G2 does the
 * unlinking).
 *
 * Non-blocking by construction — this is what stops a large `STORAGE_DIR`
 * from stalling the event loop for a duration proportional to the total
 * number of stored files, the way an eager `readdirSync` walk that returned
 * the whole list up front did:
 *  - Directories are streamed one entry at a time via `opendirSync` +
 *    `readSync` (which reads the underlying directory in small bounded
 *    batches), never materialising every entry of a huge directory into a
 *    single in-memory array.
 *  - `readSync`/`get` are synchronous, so after every `opts.yieldEvery`
 *    entries examined (default {@link DEFAULT_SCAN_YIELD_EVERY}) the walk
 *    explicitly yields a macrotask turn to the event loop, capping the
 *    longest uninterrupted synchronous run regardless of total file count.
 *  - Being a generator, the caller can stop early (e.g. after filling a
 *    per-tick batch) so the walk does no more work than the caller consumes.
 *    The `try/finally` blocks below close every open directory handle even
 *    when the consumer breaks out of iteration early (which invokes the
 *    generator's `return`, running these `finally`s).
 */
export async function* orphanBlobs(
  db: Database.Database,
  storageDir: string,
  opts?: { yieldEvery?: number },
): AsyncGenerator<string, void, unknown> {
  let ownerDir: import('node:fs').Dir;
  try {
    ownerDir = opendirSync(storageDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }

  const hasNode = db.prepare('SELECT 1 FROM nodes WHERE storage_path = @rel');
  const yieldEvery = opts?.yieldEvery ?? DEFAULT_SCAN_YIELD_EVERY;
  let examinedSinceYield = 0;

  try {
    let ownerEntry: import('node:fs').Dirent | null;
    while ((ownerEntry = ownerDir.readSync()) !== null) {
      if (!ownerEntry.isDirectory()) continue;
      const ownerName = ownerEntry.name;

      let fileDir: import('node:fs').Dir;
      try {
        fileDir = opendirSync(path.join(storageDir, ownerName));
      } catch (e) {
        // Owner directory vanished mid-walk (e.g. concurrently purged) — skip it.
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw e;
      }

      try {
        let fileEntry: import('node:fs').Dirent | null;
        while ((fileEntry = fileDir.readSync()) !== null) {
          // Bound the synchronous burst: after every `yieldEvery` entries
          // examined (each costs one DB lookup below) hand the event loop a
          // turn, so a large walk interleaves with pending I/O instead of
          // monopolising the loop for a duration proportional to the total
          // number of stored files.
          if (++examinedSinceYield >= yieldEvery) {
            examinedSinceYield = 0;
            await yieldToEventLoop();
          }

          if (fileEntry.name.startsWith('.tmp-')) continue;

          const rel = `${ownerName}/${fileEntry.name}`;
          if (hasNode.get({ rel }) === undefined) {
            yield rel;
          }
        }
      } finally {
        fileDir.closeSync();
      }
    }
  } finally {
    ownerDir.closeSync();
  }
}
