# Mirsal — مِرسال

Self-hosted, **Arabic-first / full-RTL secure file-sharing** app. Admin creates
users (no self-signup); each user gets a Google-Drive-like dashboard and can
share a file **or** a whole folder via `/s/<token>` with four independent
lifecycle controls (auto-delete date, manual delete, share on/off, scheduled
auto-stop-sharing) plus per-file download limits. Max file 100 MB. Design
identity: "Ink & Brass". UI language is **Arabic only**.

## Stack & layout

Single lean Docker container: **Fastify 5 + better-sqlite3** (server) · **React
19 + Vite + TanStack Query + react-i18next** (web) · **node-cron** scheduler.
npm-workspaces monorepo, **Node 20**, ESM (`"type": "module"`).

```
server/   @mirsal/server — Fastify API + SQLite. src/{routes,nodes,shares,scheduler,storage,auth,db}
web/      React SPA.        src/{features,components,i18n,lib}
deploy/   install.md (gateway-fronted) + fresh/ (public-VPS kit) + backup-mirsal.sh + nginx confs
docs/     RUNBOOK.md (ops/restore/troubleshooting)
data/     (gitignored) SQLite db + uploaded blobs + first-boot admin credential
docker-compose.yml · Dockerfile (node:20-slim, multi-stage)
```

## Working in this repo

Two workspaces; run commands **per workspace** (there is **no eslint / lint
script** — the gates are tests + typecheck):

```bash
# server
cd server && npx vitest run && npm run typecheck
# web
cd web   && npx vitest run && npm run typecheck
# both test suites from the root
npm test
# web dev server
cd web && npm run dev
```

- **TDD is the norm** — write the failing test first, then the implementation.
- **Web tests** use vitest + Testing Library (jsdom). Note both the desktop
  table and the mobile card list mount simultaneously in jsdom, so scope
  queries (e.g. `within(table)`) when a label appears in both.
- **i18n is Arabic-only**: add UI strings to `web/src/i18n/ar.json` only; never
  `en.json` (it's a fallback stub for the public share page). Keep it valid JSON.
- **Server data safety**: routes are owner-scoped + `requireAuth`; destructive
  ops re-validate ownership; blobs are unlinked _after_ the DB commit;
  `permanentDelete` opens its own transaction (better-sqlite3 forbids nesting —
  never wrap a loop of them in another `db.transaction`).
- **RTL/ledger UI conventions**: use `text-start`/`ps-*`/`pe-*` (never
  `text-left`/`pl-*`); wrap sizes/dates in `<bdi dir="ltr" class="font-mono">`.

## Running & deploying

The app listens on **`127.0.0.1:8084` only** (loopback); a host nginx vhost
terminates TLS and reverse-proxies to it. Config comes from `.env` (see
`.env.example`) — `SESSION_SECRET`/`CSRF_SECRET` (fresh per box), `PUBLIC_BASE_URL`
(the public HTTPS host — used for share links), `HOST=0.0.0.0`, `TRUST_PROXY`.

- **Fresh public-IP VPS** (nginx is the TLS edge → http→https redirect,
  `certbot --nginx`): follow **`deploy/fresh/README.md`** and its numbered
  scripts `01`–`05`. This is the portable, domain-agnostic path.
- **Behind a TLS-terminating gateway** (the original project4 box): use
  **`deploy/install.md`** — that variant has **no http→https redirect** (the
  gateway forwards inbound HTTPS to port 80, so a redirect loops) and trusts a
  specific gateway IP for `real_ip`. Do **not** copy those two quirks onto a
  normal public VPS.
- Build/run: `docker compose build && docker compose up -d`; health:
  `curl -s http://127.0.0.1:8084/api/health` → `{"ok":true}`.

## Conventions & gotchas

- **Secrets/data never in git**: `.env` and `data/` are gitignored; generate
  secrets per box (the `deploy/fresh` scripts do this) — never reuse another
  box's `SESSION_SECRET`/`CSRF_SECRET`.
- **Backups are DB-only, on-box** (`deploy/backup-mirsal.sh`, `VACUUM INTO`,
  keep 2). Uploaded blobs are **transient by design** and deliberately not
  archived; the DB holds accounts/shares/schedules but no file contents.
- **First-boot** seeds an `admin` user and writes a one-time password to
  `data/db/admin-credential.txt` (0600); the account is forced to change it on
  first login.
- **The public nginx flip is the one deliberately-gated "ship it" step.** Don't
  enable the vhost / expose the domain without intent.

Full ops/restore: `docs/RUNBOOK.md`. Release: **`v1.0.0`** (MVP + download-limit

- round-3 dashboard features + mobile/PWA + the `deploy/fresh` kit).
