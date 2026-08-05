import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';

export const LATEST_VERSION = 4;
/** Back-compat alias for any importer of the old single-shot constant. */
export const SCHEMA_VERSION = LATEST_VERSION;

interface MigrationStep {
  version: number;
  up(db: Database.Database): void;
}

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
  {
    version: 3,
    up(db) {
      db.exec(`ALTER TABLE users ADD COLUMN display_name TEXT;`);
    },
  },
  {
    version: 4,
    // NOTE: sqlite_master.sql stores each CREATE TABLE body verbatim (byte-for-byte,
    // including comments/whitespace, only stripping "IF NOT EXISTS"). The three table
    // bodies below are therefore indented/commented to match schema.sql EXACTLY so the
    // fresh-DB path (which execs schema.sql directly) and this upgrade path converge.
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS collections(
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,                    -- 32-byte CSPRNG, URL-safe (public URL)
  title TEXT NOT NULL,
  template_node_id INTEGER REFERENCES nodes(id) ON DELETE SET NULL,  -- NULL = no template
  folder_node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, -- the collection's Drive folder
  password_hash TEXT,                            -- NULL = no password
  is_active INTEGER NOT NULL DEFAULT 1,          -- owner open/close toggle
  deadline_at INTEGER,                           -- NULL = no deadline; <= now => closed (request-time)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
        CREATE INDEX IF NOT EXISTS ix_collections_owner ON collections(owner_id);
        CREATE TABLE IF NOT EXISTS collection_departments(
  id INTEGER PRIMARY KEY,
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(collection_id, name)
);
        CREATE TABLE IF NOT EXISTS collection_responses(
  id INTEGER PRIMARY KEY,
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  department_id INTEGER NOT NULL REFERENCES collection_departments(id) ON DELETE CASCADE,
  folder_node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, -- the department's response subfolder
  note TEXT,
  submitted_at INTEGER NOT NULL,
  submitted_ip TEXT
);
        CREATE UNIQUE INDEX IF NOT EXISTS ux_collection_response_dept ON collection_responses(collection_id, department_id);
        CREATE INDEX IF NOT EXISTS ix_collection_responses_collection ON collection_responses(collection_id);
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
  let current =
    (
      db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as {
        version: number | null;
      }
    ).version ?? 0;

  const hasCore = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='shares'").get() !== undefined;

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
