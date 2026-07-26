import { readdirSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Node } from '../nodes/tree.js';

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
       LIMIT @limit`
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
       LIMIT @limit`
    )
    .all({ now, limit }) as Node[];
}

/**
 * Enumerates blob files under `storageDir` (`<storageDir>/<ownerId>/<file>`)
 * and returns the relative storage paths (`"<ownerId>/<file>"`) that have no
 * matching `nodes.storage_path` row — candidates for G2's cleanup pass.
 * Entries whose basename starts with `.tmp-` are in-flight uploads (D1) and
 * are never reported as orphans. Non-directory entries directly under
 * `storageDir` are skipped. A missing `storageDir` is tolerated and yields
 * `[]`. Pure read: this never touches the filesystem beyond listing it, and
 * never deletes anything (G2 does the unlinking).
 */
export function orphanBlobs(db: Database.Database, storageDir: string): string[] {
  let ownerEntries: import('node:fs').Dirent[];
  try {
    ownerEntries = readdirSync(storageDir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }

  const hasNode = db.prepare('SELECT 1 FROM nodes WHERE storage_path = @rel');
  const orphans: string[] = [];

  for (const ownerEntry of ownerEntries) {
    if (!ownerEntry.isDirectory()) continue;
    const ownerName = ownerEntry.name;

    const fileEntries = readdirSync(path.join(storageDir, ownerName), { withFileTypes: true });
    for (const fileEntry of fileEntries) {
      if (fileEntry.name.startsWith('.tmp-')) continue;

      const rel = `${ownerName}/${fileEntry.name}`;
      if (hasNode.get({ rel }) === undefined) {
        orphans.push(rel);
      }
    }
  }

  return orphans;
}
