import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';

export const LATEST_VERSION = 2;
/** Back-compat alias for any importer of the old single-shot constant. */
export const SCHEMA_VERSION = LATEST_VERSION;

interface MigrationStep { version: number; up(db: Database.Database): void; }

const STEPS: MigrationStep[] = [
  {
    version: 2,
    up(db) {
      db.exec(`
        ALTER TABLE shares ADD COLUMN download_limit INTEGER
          CHECK(download_limit IS NULL OR download_limit >= 1);
        ALTER TABLE shares ADD COLUMN download_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE shares ADD COLUMN on_exhaust TEXT NOT NULL DEFAULT 'delete'
          CHECK(on_exhaust IN ('stop','delete'));
      `);
    },
  },
];

/**
 * Applies pending migrations. "Fresh" = no core tables (probed via
 * sqlite_master) — a DB with tables but no version row is a pre-versioning v1
 * baseline (e.g. a restored dump), NOT fresh, so it gets the ALTER steps.
 */
export function migrate(db: Database.Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL, applied_at INTEGER NOT NULL)');
  let current = (db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as {
    version: number | null;
  }).version ?? 0;

  const hasCore =
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='shares'").get() !== undefined;

  if (current === 0 && !hasCore) {
    const schemaSql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
    db.transaction(() => {
      db.exec(schemaSql);
      db.prepare('INSERT INTO schema_version(version, applied_at) VALUES (?, ?)').run(LATEST_VERSION, Date.now());
    })();
    return;
  }
  if (current === 0 && hasCore) current = 1; // v1 baseline without a version row

  for (const step of STEPS) {
    if (step.version > current && step.version <= LATEST_VERSION) {
      db.transaction(() => {
        step.up(db);
        db.prepare('INSERT INTO schema_version(version, applied_at) VALUES (?, ?)').run(step.version, Date.now());
      })();
    }
  }
}
