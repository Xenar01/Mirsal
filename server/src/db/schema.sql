-- Mirsal data model. Table + index DDL only.
-- Connection PRAGMAs (foreign_keys, journal_mode, busy_timeout) live in openDb (connection.ts),
-- not here. Transcribed verbatim from spec §6.

CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','user')),
  quota_bytes INTEGER,                          -- NULL = unlimited
  used_bytes INTEGER NOT NULL DEFAULT 0,        -- maintained transactionally (quota)
  is_active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  root_node_id INTEGER,                          -- synthetic roots (created with the user); NOT a FK
  trash_node_id INTEGER,                         -- NOT a FK (avoids circular users<->nodes dependency)
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions(
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,               -- sha-256 of the cookie secret
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS nodes(
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES nodes(id) ON DELETE CASCADE,   -- NULL only for synthetic root/trash
  kind TEXT NOT NULL CHECK(kind IN ('root','trash','folder','file')),
  name TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,         -- files: blob size; folders: rolled up on read
  mime_type TEXT,
  storage_path TEXT,                             -- files only, relative under /data/storage
  trashed_at INTEGER,                            -- NULL = live; set = in Trash (subtree stamped)
  original_parent_id INTEGER,                    -- captured on trash, for restore
  auto_delete_at INTEGER,                        -- NULL = never; epoch-ms (must be future when set)
  purge_after INTEGER,                           -- set when auto-trashed: epoch-ms to hard-purge
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Live-namespace uniqueness only (fixes the NULL-root + trash-collision bugs):
CREATE UNIQUE INDEX IF NOT EXISTS ux_live_name ON nodes(parent_id, name)
  WHERE trashed_at IS NULL AND parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_nodes_owner_parent ON nodes(owner_id, parent_id);
CREATE INDEX IF NOT EXISTS ix_nodes_auto_delete ON nodes(auto_delete_at) WHERE auto_delete_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS shares(
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,                    -- 32-byte CSPRNG, URL-safe
  password_hash TEXT,                            -- NULL = no password
  is_active INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER,                            -- NULL = never
  allow_download INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  download_limit INTEGER CHECK(download_limit IS NULL OR download_limit >= 1),
  download_count INTEGER NOT NULL DEFAULT 0,
  on_exhaust TEXT NOT NULL DEFAULT 'delete' CHECK(on_exhaust IN ('stop','delete'))
);

CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER PRIMARY KEY,
  actor_id INTEGER,                              -- unconstrained: must survive user deletion
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS share_access_log(
  id INTEGER PRIMARY KEY,
  share_id INTEGER NOT NULL,
  ip TEXT,
  ua TEXT,
  accessed_at INTEGER NOT NULL
);
