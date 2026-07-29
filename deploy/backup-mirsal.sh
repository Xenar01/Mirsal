#!/usr/bin/env bash
# Mirsal backup — DB-ONLY consistent online snapshot of the SQLite database.
# Safe to run against the live container (no downtime): the snapshot uses
# SQLite `VACUUM INTO`, which takes only a read lock and writes a fresh,
# integrity-checked copy.
#
# DESIGN DECISION (2026-07-29): we back up ONLY the database (user accounts,
# share links, schedules, folder structure). We deliberately DO NOT back up the
# uploaded file blobs, and we NEVER ship anything off-box / to the cloud.
# Rationale: Mirsal's files are meant to be transient (shared, received, then
# gone). Tarring the blobs would keep copies of "deleted" files lingering in an
# archive, contradicting that intent. The DB holds NO file contents, so a
# DB-only snapshot lets accounts/config survive a disk failure without hoarding
# any file data. If the disk dies, users re-upload their (transient) files.
#
# The snapshot stays on-box only. It contains no file contents, but it does list
# user records and share tokens — treat data/backups as sensitive (it is 0700-ish
# via the container uid) and do not copy it off the box.
#
# Usage: deploy/backup-mirsal.sh
# Cron: 40 2 * * * /var/www/projects/mirsal/deploy/backup-mirsal.sh >> /var/www/projects/mirsal/data/backups/backup.log 2>&1
set -euo pipefail

cd "$(dirname "$0")/.."          # repo root (compose project dir)
TS="$(date -u +%Y%m%d-%H%M%S)"
BK_DIR="./data/backups"
KEEP="${MIRSAL_BACKUP_KEEP:-2}"  # local DB copies to retain
mkdir -p "$BK_DIR"
# The container (uid 1000) writes the DB snapshot here via VACUUM INTO, so the
# dir must be owned by that uid; root (cron) can still write into it regardless.
chown 1000:1000 "$BK_DIR" 2>/dev/null || true

echo "[$(date -u +%FT%TZ)] backup start ($TS)"

# Consistent DB snapshot via VACUUM INTO, inside the running container (which has
# better-sqlite3). /app/data is the bind mount, so it lands in ./data.
docker compose exec -T -e BK_OUT="/app/data/backups/db-$TS.sqlite" mirsal \
  node --input-type=module -e \
  'import Database from "better-sqlite3"; const db=new Database(process.env.DB_PATH); db.exec("VACUUM INTO \x27"+process.env.BK_OUT+"\x27"); db.close();'
gzip -f "$BK_DIR/db-$TS.sqlite"
echo "  db -> db-$TS.sqlite.gz ($(wc -c <"$BK_DIR/db-$TS.sqlite.gz") bytes)"

# Local retention: keep the newest $KEEP DB snapshots. We do NOT keep file-blob
# tarballs at all (see design note above), so nothing here holds file contents.
ls -1t "$BK_DIR"/db-*.sqlite.gz 2>/dev/null | tail -n +$((KEEP+1)) | xargs -r rm -f

echo "[$(date -u +%FT%TZ)] backup done"
