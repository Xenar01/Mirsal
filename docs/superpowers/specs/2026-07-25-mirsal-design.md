# Mirsal — مِرسال — Secure File-Sharing Platform — Design Spec

> Status: **Draft for review** · Date: 2026-07-25 · Author: Claude Code (VPS agent)
> Domain: `project4.system.mow.gov.sy` · Stack: Node (Fastify) + SQLite + React (Vite) · Arabic-first RTL

---

## 1. Overview

Mirsal (مِرسال — "envoy / one who sends") is a self-hosted file-sharing platform for this VPS.
An **admin** creates user accounts. Each **user** gets a Google-Drive-like dashboard to organize
folders and files, and can **share** any file or folder via a public link with fine-grained
lifecycle control:

- **Auto-delete date** — the file/folder self-destructs at a chosen time.
- **Manual delete** — trash, then permanent delete.
- **Start / stop sharing** — instant on/off toggle for a share link.
- **Scheduled stop-sharing** — a link auto-expires at a chosen time (the *file remains*).

The two lifecycle axes are **independent**: deleting the file vs. expiring the share.

### Goals
- Admin control panel: create/manage users, quotas, see usage, audit trail.
- Per-user Drive-like dashboard: folders, files, upload/download, move/rename/trash.
- Public share links for files and whole folders, with password option, expiry, and on/off toggle.
- Two independent scheduled behaviors: auto-delete (file) and auto-unshare (link).
- Runs lean on a memory-constrained box (single container, SQLite, ~250 MB RAM).
- Arabic-first, full RTL; distinctive "sealed dispatch" visual identity.

### Non-goals (v1 — YAGNI)
- No real-time collaborative editing / document preview-editing.
- No self-service signup (admin provisions all accounts).
- No file versioning / history.
- No S3/object-storage backend (local disk only; 119 GB free).
- No app-level at-rest encryption in v1 (relies on disk perms + access control + optional share
  passwords). Noted as a possible v2 add-on; see Risks.
- No chunked/resumable uploads (max file size is 100 MB → simple direct upload is sufficient).

---

## 2. Personas & roles

| Role | Can |
|------|-----|
| **admin** | Everything a user can, **plus**: create/disable/delete users, set quotas, reset passwords, view every user's storage usage, view audit log, view/revoke any share globally. |
| **user** | Manage only their own files/folders; create shares of their own items; set auto-delete and share-expiry on their own items. Cannot see other users' content. |
| **public recipient** | Anonymous visitor holding a share URL. Can view/browse (read-only) and download the shared item **iff** the share is active, unexpired, and (if set) the correct password is supplied. |

---

## 3. Functional requirements

### 3.1 Admin control panel
- List users (username, role, active, storage used / quota, created).
- Create user: username, initial password (generated or typed), role, optional quota (bytes; blank = unlimited).
- Actions: deactivate/reactivate, reset password, delete user (with confirmation; deletes their nodes+blobs+shares).
- Global storage overview and per-user usage.
- Global shares list (who shared what, status, expiry) with force-revoke.
- Audit log view (paginated).

### 3.2 User dashboard (Drive-like)
- **Navigation:** My Files (tree + breadcrumb), Shared (items I've shared), Trash.
- **Browse:** grid or list; sort by name/size/date; folder open via double-click/enter.
- **Create:** new folder; upload files (drag-drop + picker; ≤100 MB each; multiple).
- **Manipulate:** rename, move (to another folder), copy (optional v1.1), download, trash → restore → permanent delete.
- **Storage meter:** shows used vs quota.

### 3.3 Sharing (per file or per folder)
- Create share → generates `/s/<token>` (32-char URL-safe random token).
- **Active toggle** (`is_active`): start/stop sharing instantly without deleting the link.
- **Password** (optional): argon2-hashed; rate-limited attempts on the public page.
- **Expiry** (optional `expires_at`): scheduled auto-stop-sharing; link 410s after.
- **allow_download**: default true (v1 always allows download; flag reserved for view-only later).
- Copy-link, show status (active / stopped / expired), revoke (hard delete share).
- Folder shares are browsable read-only (recipient navigates the subtree, downloads any file).

### 3.4 Lifecycle scheduling
- **Auto-delete** (`nodes.auto_delete_at`): set/clear a date-time on any file/folder. When it passes,
  the item (and, for folders, the whole subtree + blobs) is permanently deleted. Its shares die with it.
- **Auto-unshare** (`shares.expires_at`): set/clear on any share. When it passes, the share flips inactive.
- A background scheduler (node-cron, every 60 s) enforces both, using an **injectable clock** so the
  logic is unit-testable without waiting real time.

### 3.5 Public share page `/s/<token>`
- Bilingual (Arabic + English) so external recipients cope.
- Shows the shared file (name, size, type, brass "sealed dispatch" framing) or folder (read-only browser).
- Download button (streams the blob with `Content-Disposition: attachment`).
- Password prompt if protected; friendly 410 page if stopped/expired; 404 if unknown token.
- Never exposes owner identity beyond an optional display label; never lists sibling/parent nodes
  outside the shared subtree.

---

## 4. Visual design system ("Ink & Brass" — sealed dispatch)

Grounded in the subject: *Mirsal = envoy/dispatch*. Draws on official Arabic correspondence — the
**seal (ختم)**, Kufic inscription, dispatch register. Deliberately avoids the three generic AI-design
defaults (cream+serif+terracotta / near-black+acid-green / broadsheet hairlines).

### 4.1 Color tokens
Light (working surfaces):
```
--paper       #F4F5F3   app background (cool paper — not warm cream)
--surface     #FFFFFF   cards / panels
--ink         #0F1C2E   primary text, brand dark, header
--ink-2       #45566A   secondary text
--line        #E2E5E1   hairlines / borders
--brass       #C0913C   SIGNATURE accent: seals, active-share, primary CTA
--brass-deep  #9E7328   hover / pressed brass
--teal        #14707C   links, info, selected
--emerald     #2E7D5B   success / active status
--clay        #B4462F   destructive / expiry / stop-sharing
```
Dark:
```
--paper #0C1622  --surface #12212F  --ink #EAF0F2  --ink-2 #93A4B5
--line #23384B   --brass #D2A24C    --teal #3AA7B0  --clay #D06A54
```

### 4.2 Typography (all self-hosted woff2 — no external CDN, offline-safe, CSP-clean)
- **Display / brand:** **Reem Kufi** (Kufic; official Arabic character) — restrained: brand, page
  titles, the dispatch moments only.
- **Body / UI:** **IBM Plex Sans Arabic** — all interface text (AR + Latin).
- **Mono / data:** **IBM Plex Mono** — share tokens, file sizes, timestamps, IDs.
- Scale (rem): 0.75 · 0.875 · 1 · 1.125 · 1.375 · 1.75 · 2.25 · 3. Weights: Kufi 500/700; Plex Sans 400/500/600; Plex Mono 400/500.

### 4.3 Layout
- **RTL two-pane app shell.** Nav rail at the start side (right, in RTL): brand seal, nav (ملفاتي /
  المُشارَك / المهملات), storage meter pinned bottom. Main: sticky top bar (breadcrumb · search ·
  upload · new-folder · account), content grid/list, right-hand details drawer.
- Radius 10px cards / 8px controls / circular seal (not zero-radius). Subtle single soft shadow;
  lean on hairlines + spacing.

### 4.4 Signature element — the brass seal (ختم)
- Actively-shared items wear a small circular brass seal badge.
- Creating/starting a share plays one brief "stamp" press (scale→settle) — the single orchestrated
  motion. Disabled under `prefers-reduced-motion`.
- Public `/s/<token>` is styled as receiving a **sealed dispatch**: centered card, brass seal,
  "وصلك ملف عبر مِرسال / A file was sent to you via Mirsal", the file, a download action, and a
  "صالح حتى / valid until" stamp when an expiry exists.

### 4.5 Quality floor
Responsive to mobile · visible keyboard focus · `prefers-reduced-motion` respected · light + dark ·
copy written from the user's side (active voice, sentence case, errors say what to do).

---

## 5. Architecture

```
Internet ─HTTPS→ IT gateway ─→ host nginx (project4 cert, :443)
                                  │ reverse proxy · client_max_body_size 120M · no http→https redirect
                                  ▼
                        app container (127.0.0.1:8084, docker, unless-stopped)
                        ├── Fastify: REST API + serves built React SPA (static)
                        ├── Auth: argon2 hashes · JWT in httpOnly+SameSite cookie · CSRF token
                        ├── Scheduler: node-cron (60s) → auto-delete + auto-unshare (injectable clock)
                        ├── better-sqlite3 → /data/db/app.db   (bind-mounted)
                        └── blobs         → /data/storage/<owner_id>/<node_id>  (bind-mounted)
```
- **One** Docker service. Data bind-mounted to `/var/www/projects/mirsal/data/` (survives rebuilds).
- Port **127.0.0.1:8084** (verified free). Only nginx faces the internet.
- Rationale: SQLite + single Node process keeps RAM ~250 MB on a box with ~4 GB usable and swap already in use.

### Module boundaries (each independently testable)
- `db/` — schema + migrations + typed query helpers (better-sqlite3).
- `auth/` — password hashing, login, session cookie, CSRF, requireAuth/requireAdmin guards.
- `storage/` — blob read/write/delete by node-id; quota accounting; never trusts user names for paths.
- `nodes/` — folder/file tree CRUD, move, trash, recursive delete, size roll-ups.
- `shares/` — create/toggle/expire/revoke; token gen; password check; public resolution.
- `scheduler/` — pure functions `dueDeletions(now)` / `dueExpirations(now)` + a runner (clock injected).
- `routes/` — HTTP layer mapping to the above; input validation (zod).
- `web/` — React SPA (admin, dashboard, public share).

---

## 6. Data model (SQLite)

```sql
users(
  id INTEGER PK, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','user')),
  quota_bytes INTEGER,                       -- NULL = unlimited
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
)

nodes(
  id INTEGER PK, owner_id INTEGER NOT NULL REFERENCES users(id),
  parent_id INTEGER REFERENCES nodes(id),    -- NULL = user root
  type TEXT NOT NULL CHECK(type IN ('folder','file')),
  name TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,      -- files: blob size; folders: 0 (computed on read)
  mime_type TEXT,
  storage_path TEXT,                          -- files only, relative under /data/storage
  trashed INTEGER NOT NULL DEFAULT 0,
  auto_delete_at TEXT,                        -- NULL = never; else ISO-8601 UTC
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(owner_id, parent_id, name, trashed)  -- no dup names in a folder (per trash-state)
)

shares(
  id INTEGER PK, node_id INTEGER NOT NULL REFERENCES nodes(id),
  owner_id INTEGER NOT NULL REFERENCES users(id),
  token TEXT UNIQUE NOT NULL,                 -- 32-char URL-safe random
  password_hash TEXT,                         -- NULL = no password
  is_active INTEGER NOT NULL DEFAULT 1,       -- start/stop toggle
  expires_at TEXT,                            -- NULL = never; else scheduled auto-unshare
  allow_download INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, revoked_at TEXT
)

audit_log(
  id INTEGER PK, actor_id INTEGER, action TEXT NOT NULL,
  target TEXT, detail TEXT, created_at TEXT NOT NULL
)

share_access_log(                            -- optional, lightweight
  id INTEGER PK, share_id INTEGER NOT NULL, ip TEXT, ua TEXT, accessed_at TEXT NOT NULL
)
```
Timestamps stored as ISO-8601 UTC strings; UI renders in Asia/Damascus.

---

## 7. API surface (representative)

```
Auth
  POST   /api/auth/login            {username,password} → sets cookie
  POST   /api/auth/logout
  GET    /api/auth/me
  POST   /api/auth/password         {current,new}

Admin (requireAdmin)
  GET    /api/admin/users
  POST   /api/admin/users           {username,password,role,quota_bytes?}
  PATCH  /api/admin/users/:id       {is_active?, role?, quota_bytes?}
  POST   /api/admin/users/:id/password
  DELETE /api/admin/users/:id
  GET    /api/admin/shares
  DELETE /api/admin/shares/:id
  GET    /api/admin/audit

Nodes (requireAuth, owner-scoped)
  GET    /api/nodes?parent=:id                 list a folder
  POST   /api/nodes/folder          {parent_id,name}
  POST   /api/nodes/upload          multipart (parent_id + file[s])   ≤100MB
  PATCH  /api/nodes/:id             {name?, parent_id?}               rename / move
  POST   /api/nodes/:id/trash | /restore
  DELETE /api/nodes/:id                          permanent
  PATCH  /api/nodes/:id/auto-delete {auto_delete_at|null}
  GET    /api/nodes/:id/download

Shares (requireAuth, owner-scoped)
  GET    /api/shares
  POST   /api/shares                {node_id,password?,expires_at?}
  PATCH  /api/shares/:id            {is_active?, password?|null, expires_at?|null}
  DELETE /api/shares/:id

Public (no auth)
  GET    /api/public/:token                     metadata (or 401 needs-password / 410 / 404)
  POST   /api/public/:token/unlock  {password}  → short-lived scoped cookie
  GET    /api/public/:token/list?path=          folder browse (subtree only)
  GET    /api/public/:token/download?node=      stream (subtree only)
```

---

## 8. Security

- **Passwords:** argon2id. **Sessions:** JWT (short exp + refresh) in `httpOnly; Secure; SameSite=Lax` cookie.
- **CSRF:** double-submit token on all mutating requests (cookie auth).
- **Isolation:** every node/share query is scoped by `owner_id`; admin overrides are explicit, audited.
- **Share tokens:** 32 chars from CSPRNG; constant-time compare; password attempts rate-limited per token+IP.
- **Downloads:** always `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`; never serve
  uploaded content as inline HTML/JS (prevents stored-XSS via uploaded files).
- **Path safety:** blob filenames are node IDs under owner dirs; user-supplied names never touch the FS path.
- **Public subtree confinement:** folder shares resolve requested paths and reject anything not a
  descendant of the shared node (no `..`, no absolute, no cross-owner).
- **Headers:** Helmet (CSP allowing only self; frame-ancestors none), HSTS via nginx.
- **Limits:** nginx `client_max_body_size 120M`; app rejects >100 MB; per-request multipart caps.
- **nginx:** single 80+443 block, **no http→https redirect** (the IT gateway forwards inbound HTTPS to
  port 80 — a redirect causes ERR_TOO_MANY_REDIRECTS, the bug that hit Tirhal).
- **Quota:** enforced transactionally on upload (reject over-quota before committing the blob).

---

## 9. Deployment

- **Path:** `/var/www/projects/mirsal/` (git repo). `data/` git-ignored.
- **Image:** multi-stage Dockerfile — stage 1 builds the React SPA; stage 2 Node 20 slim runtime with
  the server + built static assets. `better-sqlite3` native build handled in-image.
- **Compose:** one service `mirsal`, `restart: unless-stopped`, publishes `127.0.0.1:8084`, bind-mounts
  `./data`. Env: `JWT_SECRET`, `COOKIE_SECRET`, `PUBLIC_BASE_URL`, `TZ=Asia/Damascus`.
- **nginx vhost `mirsal`** → `proxy_pass http://127.0.0.1:8084`; reuse
  `/etc/letsencrypt/live/project4.system.mow.gov.sy/`; `client_max_body_size 120M`; long
  `proxy_read_timeout`/`send_timeout` for uploads; websocket upgrade not needed (no WS in v1).
- **First-boot seed:** creates one **admin** account with a generated strong password, printed once to
  the container log / handed to the user. Idempotent (skips if any admin exists).
- **Backups:** nightly `sqlite3 .backup` + tar of `data/storage` → gzip in `data/backups/` (14-day
  retention); documented restore recipe. (Wire a cron like the ODK/Freepik jobs.)

---

## 10. Testing strategy ("keep testing until launch")

- **Unit:** scheduler pure functions (`dueDeletions`/`dueExpirations` with a fake clock); token gen;
  quota math; path-confinement resolver; argon2 verify.
- **Integration (API, better-sqlite3 in a temp file):**
  - auth: login/logout/me/password; bad creds; inactive user blocked.
  - **cross-user isolation:** user A cannot read/patch/delete/download user B's nodes or shares (expect 403/404).
  - nodes: folder CRUD, upload, rename, move, trash/restore, recursive permanent delete, quota rejection.
  - shares: create → public metadata → download; password gate (wrong→429 after N, right→unlock);
    toggle off → 410; expiry passed → 410; revoke → 404; folder-share subtree confinement (reject `..`).
  - scheduler run: due auto-delete removes blob+rows+shares; due expiry flips inactive.
- **E2E smoke (curl against the running container):** login → create folder → upload → share → fetch
  `/s/<token>` metadata → download via public link → stop sharing → confirm 410.
- **Local chain check:** `curl --resolve project4.system.mow.gov.sy:443:127.0.0.1 https://project4.system.mow.gov.sy/`
  to verify nginx→app before declaring live (box can't reach its own public IP).
- **Manual UI pass:** admin creates a user; that user uploads/organizes/shares; recipient downloads;
  RTL + dark-mode + mobile + reduced-motion spot-checks.

Gate: no "launched" claim until integration + E2E green and the local chain returns the app.

---

## 11. What the user provides
1. Approve this spec (or edit).
2. Confirm brand name (default **Mirsal / مِرسال**).
3. Nothing else to unblock launch — project4 cert + public route are ready; agent verifies local chain
   and flags if IT needs to re-confirm the public route.

At launch the agent hands over: admin URL + generated admin credentials, a short runbook, and the
backup/restore recipe.

---

## 12. Risks & mitigations
- **Memory pressure** (box already swapping): single lean container, SQLite not Postgres, Node slim,
  stream uploads/downloads (no full-buffer). Monitor RSS after launch.
- **No at-rest encryption v1:** acceptable for the stated use (internal + link-sharing); documented as
  v2 option. Share passwords + HTTPS cover in-transit + link secrecy.
- **Large-folder recursive delete cost:** do it in a single SQLite transaction + batched blob unlink;
  cap depth; log slow deletes.
- **Public route uncertainty:** project4 proven for ODK, but re-verify; if blocked, ask IT to confirm
  the project4 route (per the networking memory).
- **Clock/timezone bugs:** store UTC, compare UTC, render Damascus; scheduler uses injected clock.
```
