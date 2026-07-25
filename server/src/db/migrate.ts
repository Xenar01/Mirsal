import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';

export const SCHEMA_VERSION = 1;

/**
 * Applies schema.sql to `db` if it hasn't been applied yet, tracked via a
 * `schema_version` table. Safe to call repeatedly — a second (or later) call
 * on an already-migrated DB is a no-op and never throws.
 */
export function migrate(db: Database.Database): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL, applied_at INTEGER NOT NULL)'
  );

  const row = db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as {
    version: number | null;
  };
  const currentVersion = row.version ?? 0;

  if (currentVersion >= SCHEMA_VERSION) {
    return;
  }

  const schemaSql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

  const applyMigration = db.transaction(() => {
    db.exec(schemaSql);
    db.prepare('INSERT INTO schema_version(version, applied_at) VALUES (?, ?)').run(
      SCHEMA_VERSION,
      Date.now()
    );
  });

  applyMigration();
}
