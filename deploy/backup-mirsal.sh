#!/usr/bin/env bash
# Mirsal backup — consistent online snapshot of the SQLite DB + the blob store.
# Safe to run against the live container (no downtime): the DB snapshot uses
# SQLite `VACUUM INTO`, which takes only a read lock and writes a fresh,
# integrity-checked copy.
#
# Order matters: snapshot the blob STORAGE first, then the DB. A blob referenced
# by the DB snapshot is therefore always already present in the storage snapshot
# (the DB can only reference blobs that existed before it was captured).
#
# Off-box shipping is OPTIONAL and OFF unless an rclone remote is configured and
# named via MIRSAL_BACKUP_REMOTE (e.g. "b2backup:mybucket/mirsal"). rclone has no
# config on this box today (the ODK B2 remote left with that migration), so by
# default this keeps LOCAL backups only. SQLite dumps are plaintext — if you ship
# them off-box, prefer an encrypting remote or encrypt first.
#
# Usage: deploy/backup-mirsal.sh
# Cron (installed at "ship it"): 40 2 * * * /var/www/projects/mirsal/deploy/backup-mirsal.sh >> /var/www/projects/mirsal/data/backups/backup.log 2>&1
set -euo pipefail

cd "$(dirname "$0")/.."          # repo root (compose project dir)
TS="$(date -u +%Y%m%d-%H%M%S)"
BK_DIR="./data/backups"
KEEP="${MIRSAL_BACKUP_KEEP:-2}"  # local copies of each artifact to retain
mkdir -p "$BK_DIR"
# The container (uid 1000) writes the DB snapshot here via VACUUM INTO, so the
# dir must be owned by that uid; root (cron) can still write into it regardless.
chown 1000:1000 "$BK_DIR" 2>/dev/null || true

echo "[$(date -u +%FT%TZ)] backup start ($TS)"

# 1. Blob storage snapshot (tar+gzip of ./data/storage).
tar -czf "$BK_DIR/storage-$TS.tar.gz" -C ./data storage
echo "  storage -> storage-$TS.tar.gz ($(wc -c <"$BK_DIR/storage-$TS.tar.gz") bytes)"

# 2. Consistent DB snapshot via VACUUM INTO, inside the running container (which
#    has better-sqlite3). /app/data is the bind mount, so it lands in ./data.
docker compose exec -T -e BK_OUT="/app/data/backups/db-$TS.sqlite" mirsal \
  node --input-type=module -e \
  'import Database from "better-sqlite3"; const db=new Database(process.env.DB_PATH); db.exec("VACUUM INTO \x27"+process.env.BK_OUT+"\x27"); db.close();'
gzip -f "$BK_DIR/db-$TS.sqlite"
echo "  db -> db-$TS.sqlite.gz ($(wc -c <"$BK_DIR/db-$TS.sqlite.gz") bytes)"

# 3. Optional off-box copy.
if [ -n "${MIRSAL_BACKUP_REMOTE:-}" ]; then
  if rclone copy "$BK_DIR/db-$TS.sqlite.gz" "$MIRSAL_BACKUP_REMOTE/" \
     && rclone copy "$BK_DIR/storage-$TS.tar.gz" "$MIRSAL_BACKUP_REMOTE/"; then
    echo "  shipped to $MIRSAL_BACKUP_REMOTE"
  else
    echo "  WARNING: rclone off-box copy failed (local backup still kept)" >&2
  fi
fi

# 4. Local retention: keep the newest $KEEP of each artifact.
ls -1t "$BK_DIR"/db-*.sqlite.gz 2>/dev/null      | tail -n +$((KEEP+1)) | xargs -r rm -f
ls -1t "$BK_DIR"/storage-*.tar.gz 2>/dev/null    | tail -n +$((KEEP+1)) | xargs -r rm -f

echo "[$(date -u +%FT%TZ)] backup done"
