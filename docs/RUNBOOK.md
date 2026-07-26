# Mirsal — Runbook

Operations for the running Mirsal deployment. See `deploy/install.md` for first
install and the go-live steps.

| Property | Value |
|----------|-------|
| App | Mirsal (مِرسال) — Arabic/RTL secure file-sharing |
| Domain | `project4.system.mow.gov.sy` (host nginx → `127.0.0.1:8084`) |
| Runtime | one Docker container `mirsal` (image `mirsal:local`), `restart: unless-stopped` |
| Compose dir | `/var/www/projects/mirsal` |
| Data | `./data` bind mount → `/app/data` (db, storage, backups, admin credential) |
| Runs as | uid 1000 (unprivileged) inside the container |
| Env / secrets | `./.env` (gitignored, `0600`) |

## Everyday commands

```bash
cd /var/www/projects/mirsal
docker compose ps                 # status
docker compose logs -f            # follow logs
docker compose restart            # restart
docker compose up -d              # start (after edits / reboot)
docker compose down               # stop + remove container (data persists in ./data)
curl -s http://127.0.0.1:8084/api/health          # {"ok":true}
```

## Admin / first login

First boot seeds `admin` with a random password in `data/db/admin-credential.txt`
(`0600`), forced to change on first login. There is **no self-signup** — the
admin creates every other user from the in-app admin panel. If the admin
password is lost and no session remains, restore from a backup or (last resort)
stop the container, delete the `users` row for admin, and let a fresh boot
re-seed (only if no admin exists).

## Backups

- Script: `deploy/backup-mirsal.sh` — snapshots `./data/storage` (tar.gz) and a
  consistent SQLite dump via `VACUUM INTO` (no downtime), into `./data/backups/`,
  keeping the newest 2 of each. Log: `data/backups/backup.log`.
- Cron (installed at launch): `40 2 * * *`.
- Off-box: optional, set `MIRSAL_BACKUP_REMOTE=<rclone-remote:path>` (no rclone
  remote is configured on this box today; SQLite dumps are plaintext — use an
  encrypting remote if you ship them).

### Restore

A DB snapshot is a complete standalone SQLite file.

```bash
cd /var/www/projects/mirsal
# 1. verify a dump before trusting it (open read-only in a scratch process):
DUMP=$(ls -1t data/backups/db-*.sqlite.gz | head -1)
gunzip -kc "$DUMP" > data/backups/_rt.sqlite && chown 1000:1000 data/backups/_rt.sqlite
docker compose exec -T -e RT=/app/data/backups/_rt.sqlite mirsal node --input-type=module -e \
 'import D from "better-sqlite3"; const db=new D(process.env.RT,{readonly:true}); console.log("users="+db.prepare("SELECT COUNT(*) c FROM users").get().c); db.close();'
rm -f data/backups/_rt.sqlite

# 2. full restore (DB + storage):
docker compose down
gunzip -kc "$DUMP" > data/db/mirsal.db
rm -f data/db/mirsal.db-shm data/db/mirsal.db-wal      # drop stale WAL/shm
tar -xzf "$(ls -1t data/backups/storage-*.tar.gz | head -1)" -C data   # restores data/storage
chown -R 1000:1000 data
docker compose up -d
```

Encrypted share passwords are hashes, not recoverable — unaffected by restore.

## Troubleshooting

- **`address already in use` on `up`** — something else holds `127.0.0.1:8084`.
  Find it: `ss -ltnp | grep :8084`. If it's a stray host `node index.js` (e.g. a
  manual run), kill that pid; then `docker compose up -d`.
- **`SQLITE_CANTOPEN` writing a backup** — `data/backups` isn't owned by uid 1000.
  `chown 1000:1000 data/backups` (the backup script does this itself).
- **Container unhealthy / won't boot** — `docker compose logs`. Common: a missing
  or malformed `.env` var (config is zod-validated and fails loudly naming the
  field), or `data` not writable by uid 1000 (`chown -R 1000:1000 data`).
- **`ERR_TOO_MANY_REDIRECTS`** — never add an `http→https` redirect to the nginx
  vhost; the IT gateway forwards inbound HTTPS to port 80, so a redirect loops.
  The shipped `deploy/nginx-mirsal.conf` correctly has none.
- **Public share page blank / 404 at `/s/<token>`** — the server serves the SPA
  shell for `/s/*` with `Referrer-Policy: no-referrer`; if 404, the image
  predates that fix — rebuild (`docker compose build`).
- **Reachable locally but not externally** — the box can't reach its own public
  IP; test the local chain with `curl --resolve project4.system.mow.gov.sy:443:127.0.0.1`.
  If that's 200 but the outside can't reach it, ask IT to confirm the project4 route.

## Upgrades

```bash
cd /var/www/projects/mirsal
git pull                      # or update the working tree
docker compose build
docker compose up -d          # recreates the container; ./data (incl. secrets via .env) persists
```

Migrations are idempotent and run automatically at boot.
