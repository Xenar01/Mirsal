import type Database from 'better-sqlite3';

/**
 * Atomically reserves `bytes` against `userId`'s quota. Single UPDATE — no
 * read-then-write race: the WHERE clause itself enforces the quota check, so
 * concurrent reserves against the same row serialize through SQLite's
 * per-row write lock instead of racing on a separate SELECT.
 * Returns true iff the row was updated (i.e. it fit within quota, or
 * quota_bytes is NULL = unlimited). `bytes` is assumed >= 0.
 */
export function reserve(db: Database.Database, userId: number, bytes: number, now: number): boolean {
  const info = db
    .prepare(
      `UPDATE users
       SET used_bytes = used_bytes + @bytes, updated_at = @now
       WHERE id = @userId AND (quota_bytes IS NULL OR used_bytes + @bytes <= quota_bytes)`
    )
    .run({ userId, bytes, now });

  return info.changes === 1;
}

/**
 * Adjusts `used_bytes` by the delta between the real byte count (`actual`)
 * and what was reserved up front (`reserved`), once an upload completes.
 * The delta may be negative (upload came in smaller than reserved). Floors
 * at 0 — used_bytes never goes negative, even if a concurrent release/
 * subtract on the same user already dropped it below `reserved` by the
 * time this runs (otherwise the delta could drive the counter negative,
 * corrupting the quota ledger for that user going forward).
 * Matches the plan's 4-arg signature exactly — does not touch updated_at.
 */
export function commitActual(
  db: Database.Database,
  userId: number,
  reserved: number,
  actual: number
): void {
  db.prepare(
    'UPDATE users SET used_bytes = MAX(0, used_bytes + (@actual - @reserved)) WHERE id = @userId'
  ).run({ userId, reserved, actual });
}

/**
 * Undoes a reservation (e.g. upload failed after reserve). Floors at 0 —
 * used_bytes never goes negative.
 */
export function release(db: Database.Database, userId: number, reserved: number): void {
  db.prepare('UPDATE users SET used_bytes = MAX(0, used_bytes - @reserved) WHERE id = @userId').run({
    userId,
    reserved,
  });
}

/**
 * Permanently reduces `used_bytes` by `bytes` (e.g. a file was deleted for
 * good). Floors at 0 — used_bytes never goes negative.
 */
export function subtract(db: Database.Database, userId: number, bytes: number): void {
  db.prepare('UPDATE users SET used_bytes = MAX(0, used_bytes - @bytes) WHERE id = @userId').run({
    userId,
    bytes,
  });
}
