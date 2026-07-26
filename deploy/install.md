# Mirsal — install / deploy (project4)

Self-hosted Arabic/RTL secure file-sharing. Runs as a single Docker container on
`127.0.0.1:8084`, fronted by the host nginx vhost for
`project4.system.mow.gov.sy` (which reuses the existing Let's Encrypt cert).

Prereqs: Docker + compose, host nginx, the project4 cert already on disk at
`/etc/letsencrypt/live/project4.system.mow.gov.sy/`.

## 1. Configure secrets (`.env`)

`.env` is gitignored. Create it (already done on this box) with:

```
DB_PATH=/app/data/db/mirsal.db
STORAGE_DIR=/app/data/storage
SESSION_SECRET=<openssl rand -hex 32>
CSRF_SECRET=<openssl rand -hex 32>
PUBLIC_BASE_URL=https://project4.system.mow.gov.sy
HOST=0.0.0.0            # container binds all interfaces; the compose publish confines it to loopback
TZ=Asia/Damascus
# argon2 tuning (defaults are fine): ARGON_MEMORY_KIB=19456 ARGON_TIME=2 ARGON_PARALLELISM=1 ARGON_MAX_CONCURRENCY=2
```

`chmod 600 .env`.

## 2. Data dir (bind mount)

```
mkdir -p data/db data/storage
chown -R 1000:1000 data      # container runs as the unprivileged uid 1000 (node)
```

## 3. Build + run

```
docker compose build          # multi-stage; compiles better-sqlite3 + argon2 natively (needs a few min)
docker compose up -d
curl -s http://127.0.0.1:8084/api/health        # -> {"ok":true}
```

First boot migrates the DB and seeds the `admin` user, writing a one-time
password to `data/db/admin-credential.txt` (`0600`). Retrieve it, then log in and
change the password immediately (the account is forced to change on first login).

```
cat data/db/admin-credential.txt
```

## 4. Smoke test (optional, throwaway only)

`deploy/smoke.sh` rotates the admin password, so run it ONLY against a throwaway
instance, never the production container:

```
mkdir -p data-smoke/db data-smoke/storage && chown -R 1000:1000 data-smoke
docker run -d --name mirsal-smoke -p 127.0.0.1:18084:8084 \
  -e DB_PATH=/app/data/db/mirsal.db -e STORAGE_DIR=/app/data/storage -e HOST=0.0.0.0 \
  -e SESSION_SECRET=$(openssl rand -hex 32) -e CSRF_SECRET=$(openssl rand -hex 32) \
  -e PUBLIC_BASE_URL=https://project4.system.mow.gov.sy -e TZ=Asia/Damascus \
  -v "$PWD/data-smoke:/app/data" mirsal:local
deploy/smoke.sh http://127.0.0.1:18084 ./data-smoke/db/admin-credential.txt
docker rm -f mirsal-smoke && rm -rf data-smoke
```

## 5. Go live — the nginx vhost flip  ⚠️ "ship it" step

This is the one public-facing, deliberately-gated action. It makes Mirsal
reachable at `https://project4.system.mow.gov.sy`. Only do it when launch is
approved.

```
cp deploy/nginx-mirsal.conf /etc/nginx/sites-available/mirsal
ln -s /etc/nginx/sites-available/mirsal /etc/nginx/sites-enabled/mirsal
nginx -t                                   # must pass; does not touch other vhosts' certs
systemctl reload nginx
# verify the local chain (the box can't reach its own public IP — resolve to loopback):
curl -sI --resolve project4.system.mow.gov.sy:443:127.0.0.1 https://project4.system.mow.gov.sy/api/health
```

Expect `HTTP/1.1 200`. If project4 is unreachable *externally* afterwards, ask
IT to confirm the project4 gateway route is open (it was proven public by the
earlier ODK deploy).

Rollback (instant): `rm /etc/nginx/sites-enabled/mirsal && systemctl reload nginx`
→ project4 falls back to the nginx default; the container keeps running untouched.

## 6. Backups  ⚠️ cron install is part of "ship it"

`deploy/backup-mirsal.sh` snapshots blob storage + a consistent SQLite dump into
`data/backups/` (keeps the newest 2 of each; no downtime). Off-box shipping is
optional — set `MIRSAL_BACKUP_REMOTE` to a configured rclone remote (none exists
on this box today). Install the cron at launch:

```
( crontab -l 2>/dev/null; echo '40 2 * * * /var/www/projects/mirsal/deploy/backup-mirsal.sh >> /var/www/projects/mirsal/data/backups/backup.log 2>&1' ) | crontab -
```

See `docs/RUNBOOK.md` for operations, restore, and troubleshooting.
