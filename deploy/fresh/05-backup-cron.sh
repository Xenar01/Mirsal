#!/usr/bin/env bash
# Mirsal fresh-server deploy — step 5/5: install the nightly DB-backup cron.
#
# Installs a root cron entry that runs deploy/backup-mirsal.sh at 02:40 daily
# (consistent SQLite VACUUM INTO snapshot, keeps newest 2, on-box only, no
# downtime). Idempotent — re-running replaces the existing Mirsal cron line.
#
# Usage:  sudo bash deploy/fresh/05-backup-cron.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "This script needs root. Re-run with: sudo bash $0" >&2
  exit 1
fi

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="${REPO}/deploy/backup-mirsal.sh"
LOG="${REPO}/data/backups/backup.log"
[[ -f "$SCRIPT" ]] || { echo "Missing $SCRIPT" >&2; exit 1; }
chmod +x "$SCRIPT" 2>/dev/null || true
mkdir -p "${REPO}/data/backups"

LINE="40 2 * * * ${SCRIPT} >> ${LOG} 2>&1"
MARKER="deploy/backup-mirsal.sh"

# Replace any existing Mirsal backup line; keep everything else.
current="$(crontab -l 2>/dev/null || true)"
filtered="$(printf '%s\n' "$current" | grep -vF "$MARKER" || true)"
{ printf '%s\n' "$filtered" | sed '/^$/d'; echo "$LINE"; } | crontab -

echo "Installed cron:"
echo "  $LINE"
echo
echo "Verify:  sudo crontab -l"
echo "Deployment complete. Visit https://<your-domain> and log in as admin."
