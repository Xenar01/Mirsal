import type Database from 'better-sqlite3';
import { CollisionError } from './tree.js';

/** The shape routes (Phase H) use to turn a caught error into an HTTP response. */
export interface MappedError {
  http: number;
  code: string;
}

/**
 * Maps a caught error to an HTTP status + stable error code. `CollisionError`
 * instances and raw SQLite UNIQUE-constraint errors (either
 * `code === 'SQLITE_CONSTRAINT_UNIQUE'` or a message containing "UNIQUE
 * constraint failed") both map to 409 `name_conflict` — the same live-name
 * clash, whether or not the caller already wrapped it. Anything else falls
 * through to a generic 500 `internal`.
 */
export function mapDbError(e: unknown): MappedError {
  if (e instanceof CollisionError) {
    return { http: 409, code: 'name_conflict' };
  }

  if (e instanceof Error) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/i.test(e.message)) {
      return { http: 409, code: 'name_conflict' };
    }
  }

  return { http: 500, code: 'internal' };
}

/**
 * Given a desired `base` name under `parentId`, returns the first name not
 * already taken among `parentId`'s *live* children: `base` itself if free,
 * else `"base (1)"`, `"base (2)"`, ... skipping any that are already taken.
 */
export function nextSuffixedName(db: Database.Database, parentId: number, base: string): string {
  const rows = db
    .prepare('SELECT name FROM nodes WHERE parent_id = @parentId AND trashed_at IS NULL')
    .all({ parentId }) as { name: string }[];
  const taken = new Set(rows.map((r) => r.name));

  if (!taken.has(base)) {
    return base;
  }

  let n = 1;
  while (taken.has(`${base} (${n})`)) {
    n += 1;
  }
  return `${base} (${n})`;
}
