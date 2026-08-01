# Mirsal — Fresh-Server Deployment Guide

Deploy Mirsal (Arabic/RTL secure file-sharing) onto a **brand-new, standard
public-IP VPS** where **nginx is the TLS edge** — i.e. a normal cloud box
(Hetzner, DigitalOcean, Linode, Vultr, a plain VPS…), **not** behind a
corporate/IT gateway.

> If you are deploying *behind* a gateway that terminates TLS for you (like the
> original `project4` box), use `deploy/install.md` instead — that variant
> deliberately has **no** http→https redirect and trusts a specific gateway IP.
> This guide is the opposite: nginx here owns TLS and redirects http→https.

Everything is a single Docker container listening on `127.0.0.1:8084`; nginx
terminates HTTPS for your domain and reverse-proxies to it. No database server,
no external services.

---

## 0. What you need before you start

| Requirement | Notes |
|---|---|
| A VPS | Ubuntu 22.04 or 24.04 LTS, ≥ 1 vCPU / 1 GB RAM / 10 GB disk. 2 GB RAM makes the image build comfortable. |
| A domain (or subdomain) | e.g. `files.example.com`. You control its DNS. |
| SSH root (or sudo) access to the VPS | |
| An email address | For Let's Encrypt expiry notices. |
| Repo access | This repo is **private**. You'll need a GitHub PAT or an SSH deploy key on the box to `git clone`. |

**Point DNS first.** Create an **`A` record** (and `AAAA` if you have IPv6) for
your domain → the VPS's public IP. Wait until it resolves before requesting a
certificate:

```bash
dig +short files.example.com     # must return your VPS IP
```

---

## 1. Get the code onto the box

```bash
# as root (or a sudo user) on the fresh VPS
git clone https://github.com/Xenar01/Mirsal.git /opt/mirsal      # PAT prompted, or use an SSH URL
cd /opt/mirsal
```

You can put it anywhere; this guide uses `/opt/mirsal`. All scripts below are run
from the repo root and take the repo root as their working directory.

---

## 2. Run the numbered scripts (in order)

Each script is idempotent and prints what it does. Read them first — they're
short. Replace `files.example.com` and `you@example.com` with your real values.

```bash
cd /opt/mirsal

# 2.1  Install host prerequisites (Docker, nginx, certbot). Safe to re-run.
sudo bash deploy/fresh/01-bootstrap-host.sh

# 2.2  Generate .env with fresh, random SESSION/CSRF secrets + your domain.
sudo bash deploy/fresh/02-make-env.sh files.example.com

# 2.3  Build the image and start the container (loopback:8084). Prints the
#      one-time admin password when the DB seeds on first boot.
sudo bash deploy/fresh/03-build-run.sh

# 2.4  Install the nginx vhost and obtain a Let's Encrypt cert (adds the
#      443 server + http→https redirect). Needs DNS already pointing here.
sudo bash deploy/fresh/04-nginx-tls.sh files.example.com you@example.com

# 2.5  Install the nightly DB-backup cron (02:40).
sudo bash deploy/fresh/05-backup-cron.sh
```

That's the whole deployment. Visit `https://files.example.com`, log in as
`admin` with the one-time password from step 2.3, and set your own password
(the account is forced to change it on first login).

---

## 3. What each step does / how to verify

**2.1 host bootstrap** — installs Docker Engine + compose plugin, nginx, and
certbot (`python3-certbot-nginx`). It also installs (but does **not** enable) a
UFW ruleset — enabling a firewall over SSH can lock you out, so it prints the
exact `ufw` commands for you to run deliberately. Verify:

```bash
docker --version && docker compose version && nginx -v && certbot --version
```

**2.2 make-env** — writes `.env` (mode `600`) with:
- `SESSION_SECRET` / `CSRF_SECRET` = fresh `openssl rand -hex 32` each (never reused).
- `PUBLIC_BASE_URL=https://<your-domain>` (used to build absolute share links — **must** be correct or share links point at the wrong host).
- `HOST=0.0.0.0` (container binds all interfaces; the compose publish `127.0.0.1:8084:8084` is what keeps it off the public internet).
- `TRUST_PROXY=loopback,172.31.99.1/32` — trusts loopback + the pinned docker-gateway so the app reads the real client IP from nginx's `X-Forwarded-For` (per-IP login rate-limiting depends on this). It refuses to overwrite an existing `.env` unless you pass `--force`.

**2.3 build-run** — `docker compose build` (compiles better-sqlite3 + argon2
natively — a few minutes) then `docker compose up -d`. Waits for
`GET /api/health` → `{"ok":true}` and prints `data/db/admin-credential.txt`.
Verify:

```bash
curl -s http://127.0.0.1:8084/api/health      # {"ok":true}
```

**2.4 nginx-tls** — renders `deploy/fresh/mirsal-http.conf.template` with your
domain into `/etc/nginx/sites-available/mirsal`, enables it, then runs
`certbot --nginx -d <domain> --redirect`, which obtains the certificate over
port 80 and rewrites the vhost to add the `443 ssl` server **and** an
http→https redirect. certbot installs its own renewal timer. Verify:

```bash
curl -sI https://files.example.com/api/health          # HTTP/2 200
curl -sI http://files.example.com/api/health           # 301 -> https
sudo certbot certificates                              # cert present, ~90-day expiry, auto-renew
```

**2.5 backup-cron** — installs `40 2 * * *` → `deploy/backup-mirsal.sh`
(consistent SQLite snapshot via `VACUUM INTO`, keeps newest 2, on-box only, no
downtime). See `docs/RUNBOOK.md` for restore.

---

## 4. Security notes (public box)

- **The app port is loopback-only** (`127.0.0.1:8084`) — never expose 8084
  publicly. Only 80/443 (nginx) and your SSH port should be open.
- **Enable the firewall** after confirming SSH works (step 2.1 prints the
  commands). Allow your SSH port **first**, then `Nginx Full`, then `ufw enable`.
- **Secrets never leave the box.** `.env` and `data/` are gitignored; they are
  not in the repo and must be created per-box (the scripts do this).
- **Uploaded files are transient by design** and are **not** backed up (only the
  DB is). This is deliberate — see the note at the top of `deploy/backup-mirsal.sh`.
- **Behind Cloudflare?** If the domain is proxied (orange cloud), either
  temporarily grey-cloud it for the certbot http-01 challenge, or switch to a
  DNS-01 challenge. And add a `set_real_ip_from <cloudflare-ranges>` /
  `real_ip_header CF-Connecting-IP` block so per-IP limits key on the true
  client (otherwise every request looks like it came from Cloudflare).

---

## 5. Day-2 operations

| Task | Command (from repo root) |
|---|---|
| Update to latest code | `git pull && docker compose build && docker compose up -d` |
| Tail logs | `docker compose logs -f mirsal` |
| Restart | `docker compose restart mirsal` |
| Manual backup now | `sudo bash deploy/backup-mirsal.sh` |
| Reset admin password | see `docs/RUNBOOK.md` (or the recipe in the repo's admin-access notes) |
| Rollback the public route | `sudo rm /etc/nginx/sites-enabled/mirsal && sudo systemctl reload nginx` |

Full ops/restore/troubleshooting: **`docs/RUNBOOK.md`**.

---

## 6. Migrating existing data (optional)

A fresh deploy starts empty (new seeded admin, no users/files). To carry over
accounts + share definitions from another Mirsal box, copy that box's SQLite DB
into `data/db/mirsal.db` **before** step 2.3 (stop the container first, replace
the file, start it). The DB holds accounts/shares/schedules but **no file
contents** (blobs are transient and not migrated). Match the source box's
`schema_version` or let the app migrate it forward on boot.
