#!/usr/bin/env bash
# Mirsal fresh-server deploy — step 3/5: build the image and start the app.
#
# Builds the container (compiles better-sqlite3 + argon2 natively — a few min),
# starts it on 127.0.0.1:8084, waits for the health check, and prints the
# one-time admin credential seeded on first boot.
#
# Usage:  sudo bash deploy/fresh/03-build-run.sh
set -euo pipefail

cd "$(dirname "$0")/../.."   # repo root

[[ -f .env ]] || { echo "No .env — run deploy/fresh/02-make-env.sh <domain> first." >&2; exit 1; }

# The container runs as uid 1000 (node) and writes the DB + blobs here.
echo "==> Preparing data dir (owned by container uid 1000)"
mkdir -p data/db data/storage data/backups
chown -R 1000:1000 data

echo "==> Building image (this compiles native modules — grab a coffee)"
docker compose build

echo "==> Starting the container"
docker compose up -d

echo -n "==> Waiting for health"
ok=0
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8084/api/health >/dev/null 2>&1; then ok=1; break; fi
  echo -n "."; sleep 2
done
echo
if [[ $ok -ne 1 ]]; then
  echo "Health check never passed. Recent logs:" >&2
  docker compose logs --tail=40 mirsal >&2
  exit 1
fi
echo "==> Health OK: $(curl -s http://127.0.0.1:8084/api/health)"

CRED="data/db/admin-credential.txt"
if [[ -f "$CRED" ]]; then
  echo
  echo "=============================================================="
  echo " First-boot admin credential (change it on first login):"
  echo "--------------------------------------------------------------"
  cat "$CRED"
  echo "=============================================================="
  echo " Stored at: $(pwd)/$CRED (mode 600)"
else
  echo "NOTE: no admin-credential.txt found — the DB may already have been seeded"
  echo "      on a previous run. Existing admin login is unchanged."
fi

echo
echo "Next: sudo bash deploy/fresh/04-nginx-tls.sh <your-domain> <you@example.com>"
