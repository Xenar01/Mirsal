# Mirsal — Runbook

Operations for the running Mirsal deployment. See `deploy/install.md` for first
install and the go-live steps.

| Property      | Value                                                                           |
| ------------- | ------------------------------------------------------------------------------- |
| App           | Mirsal (مِرسال) — Arabic/RTL secure file-sharing                                |
| Domain        | `project4.system.mow.gov.sy` (host nginx → `127.0.0.1:8084`)                    |
| Runtime       | one Docker container `mirsal` (image `mirsal:local`), `restart: unless-stopped` |
| Compose dir   | `/var/www/projects/mirsal`                                                      |
| Data          | `./data` bind mount → `/app/data` (db, storage, backups, admin credential)      |
| Runs as       | uid 1000 (unprivileged) inside the container                                    |
| Env / secrets | `./.env` (gitignored, `0600`)                                                   |

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

**DB-only, on-box, no cloud — by design (2026-07-29).** Mirsal's uploaded files
are meant to be transient (shared, received, then gone), so we deliberately do
**not** back up the file blobs and do **not** ship anything off-box. Backing up
the blobs would keep copies of "deleted" files lingering in an archive, and any
off-box copy would put file-adjacent data on a remote — both contradict that
intent.

- Script: `deploy/backup-mirsal.sh` — consistent SQLite dump via `VACUUM INTO`
  (no downtime), into `./data/backups/`, keeping the newest 2. The DB holds
  accounts / share links / schedules / folder structure but **no file contents**.
  Log: `data/backups/backup.log`.
- Cron: `40 2 * * *`.
- If the disk dies you recover accounts + config from the DB snapshot; the
  (transient) files themselves are re-uploaded by users — they are not archived.
- `data/backups` is sensitive (lists user records + share tokens): keep it on-box.

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

# 2. DB restore (accounts/shares/config only — file blobs are NOT backed up):
docker compose down
gunzip -kc "$DUMP" > data/db/mirsal.db
rm -f data/db/mirsal.db-shm data/db/mirsal.db-wal      # drop stale WAL/shm
chown -R 1000:1000 data
docker compose up -d
# Note: restored node rows may reference blobs that no longer exist on disk
# (files are transient / not archived). Those shares simply 404 until re-uploaded.
```

Encrypted share passwords are hashes, not recoverable — unaffected by restore.

## Download limits (burn-after-download)

A share creator can cap how many times a **single file** can be downloaded
(default `1`); **folder shares are never capped**. When the cap is reached, the
creator's chosen terminal action fires — **stop** the link (file stays) or
**delete** the file (default). It composes with the other lifecycle controls
(expiry, start/stop, password, auto-delete date).

Operational notes:

- **POST-only counting.** The counted download is `POST /api/public/:token/download`.
  For a limited share, `GET /download` returns **`405`** — so a passive GET
  (link-preview unfurlers, URL/AV scanners, browser prefetch) can neither burn
  nor bypass the cap. **Unlimited** shares keep `GET /download` unchanged.
- **Only completed downloads count.** `download_count` increments on delivery
  completion, guarded so it can never exceed the limit. A mid-stream **abort
  leaves the count untouched** and the link live — the recipient can retry.
- **`delete` → Trash, not instant purge.** The file goes to Trash immediately
  (link dies at once) and is **auto-purged after 24h** (recoverable until then,
  via the existing scheduler; a restore clears `purge_after`). An owner who
  restores within 24h keeps the file, but downloads stay blocked until they
  raise or clear the limit.
- **Audit trail.** Terminal actions write `audit_log` rows with `actor_id = NULL`
  (system): `share_download_limit_deleted` (`{owner_id, node_id, limit}`) and
  `share_download_limit_stopped` (`{owner_id, limit}`). Visible only via the
  admin audit route — there is **no owner-facing "why did my file vanish" view**
  in v1; the owner sees the file in Trash. This is the place to look if an
  operator needs to explain an auto-deletion.
- **Concurrency is per-process.** In-flight downloads are bounded by an in-memory
  reservation map — authoritative because Mirsal runs as a single container.
  It resets on restart (a crash can never strand a reservation); the durable
  `download_count < download_limit` guard still caps _counted_ completions.

## Collections (طلب تجميع)

Distribute one file and collect a response set back from each of ~N departments via a
single public link `/c/<token>`.

- **Owner UI:** Collections nav → create (title, optional template, department list, optional
  password, optional deadline) → detail/roster (responded X/N; per-department files;
  **download a department's set as ZIP** or **the whole collection as ZIP**; open/close;
  add/remove department; edit title/password/deadline).
- **Storage:** responses land in the owner's Drive under a "طلب تجميع: <title>" folder with a
  per-department subfolder; they count against the owner's quota. **Latest-replaces** —
  a re-submit permanently deletes the department's previous set (not Trash).
- **ZIP downloads** reuse the authenticated `GET /api/nodes/:id/zip` (folder subtree,
  owner-scoped, concurrency-bounded); per-department = the department's response folder,
  whole-collection = the collection's root folder.
- **Bounds:** ≤100 MB/file, ≤10 files/response, one slot/department, owner-quota hard stop.
  Public routes are rate-limited (nginx `real_ip` gives the true client IP).
- **Deadline** closes the form at request-time (no scheduler). Owner open/close is manual.
- **Schema:** tables `collections`, `collection_departments`, `collection_responses`
  (migration v3→v4; live DB at v4). No Phase-4 schema change.

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
