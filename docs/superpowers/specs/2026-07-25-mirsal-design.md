# Mirsal — مِرسال — Secure File-Sharing Platform — Design Spec

> Status: **Draft v2 (post deep-review)** · Date: 2026-07-25 · Author: Claude Code (VPS agent)
> Domain: `project4.system.mow.gov.sy` · Stack: Node (Fastify) + SQLite + React (Vite) · Arabic-first RTL
> v2 resolves all 10 must-fix and the should-fix cluster from the multi-lens design review.

---

## 1. Overview

Mirsal (مِرسال — "envoy / one who sends") is a self-hosted file-sharing platform for this VPS.
An **admin** creates user accounts. Each **user** gets a Google-Drive-like dashboard to organize
folders and files, and can **share** any file or folder via a public link with fine-grained
lifecycle control:

- **Auto-delete date** — the file/folder self-destructs at a chosen time.
- **Manual delete** — trash → restore, then permanent delete.
- **Start / stop sharing** — instant on/off toggle for a share link.
- **Scheduled stop-sharing** — a link auto-expires at a chosen time (the *file remains*).

The two lifecycle axes are **independent**: deleting the file vs. expiring the share.

### Goals
- Admin control panel: create/manage users, optional quotas, usage visibility, audit trail.
- Per-user Drive-like dashboard: folders, files, upload/download, move/rename/trash.
- Public share links for files and whole folders, with password option, expiry, and on/off toggle.
- Two independent scheduled behaviors: auto-delete (file) and auto-unshare (link).
- Runs lean on a memory-constrained box (single container, SQLite, ~250 MB runtime RAM).
- Arabic-first, full RTL; distinctive "sealed dispatch" visual identity.

### Confirmed product decisions (see §13 for the ones awaiting user OK)
- **Admin cannot read user file contents.** Admin manages users/quotas/shares and sees metadata
  (names, sizes, dates, share status) only — never opens/downloads another user's file. *(default; confirm)*
- **Auto-delete routes through Trash with a grace window**, not an instant irreversible purge: at
  `auto_delete_at` the item is trashed (removed from the user's live view, its shares 410) and its blob
  is purged after a **7-day grace**. This keeps the "self-destruct" promise recoverable. *(default; confirm)*
- **Quotas are optional per user** (blank = unlimited) with usage always visible. *(default; confirm)*
- **Folder shares offer a streamed "Download all as ZIP"** plus per-file download.

### Non-goals (v1 — YAGNI)
- No real-time collaborative editing / in-browser document editing.
- No self-service signup (admin provisions all accounts).
- No file versioning / history.
- No S3/object-storage backend (local disk only; 119 GB free).
- No app-level at-rest encryption in v1 (relies on disk perms + access control + optional share
  passwords + HTTPS). Possible v2 add-on; see Risks.
- No chunked/resumable uploads (max file 100 MB → single streamed upload suffices).

---

## 2. Personas & roles

| Role | Can |
|------|-----|
| **admin** | Everything a user can with their OWN files, **plus**: create/disable/delete users, set optional quotas, reset passwords, view every user's storage usage + file *metadata* (not contents), view audit log, view/force-revoke any share. **Cannot** open/download another user's file contents. |
| **user** | Manage only their own files/folders/shares; set auto-delete and share-expiry on their own items. Cannot see other users' content. |
| **public recipient** | Anonymous holder of a share URL. Views/browses (read-only) and downloads **iff** the share is live (see §9 gate) and, if set, the correct password is supplied. |

**Invariant (§3.1):** the system always retains ≥1 active admin; an admin cannot demote/deactivate/delete
themselves or the last active admin.

---

## 3. Functional requirements

### 3.1 Admin control panel
- List users (username, role, active, used / quota, created).
- Create user: username, initial password (generated), role, optional quota. New users are seeded
  `must_change_password=1`.
- Actions: deactivate/reactivate, reset password, delete user (confirm; cascades their nodes+blobs+shares;
  audit rows preserved with nullable actor). **Last-admin guard** enforced on every mutation.
- Global storage overview + per-user usage; global shares list with force-revoke.
- Audit log (paginated). Audited actions: login success/failure, user create/disable/delete, password
  reset, quota change, share force-revoke, admin-any cross-user metadata access.

### 3.2 User dashboard (Drive-like)
- **Nav:** My Files (tree + breadcrumb), Shared (items I've shared), Trash.
- **Browse:** grid or list; sort by name/size/date; open folder.
- **Create:** new folder; upload files (drag-drop + picker; ≤100 MB each; multiple).
- **Manipulate:** rename, move, download, trash → restore → permanent delete.
- **Name-collision policy (uniform, §7):** interactive rename/move → **409** with machine-readable code
  (UI prompts); upload/restore → **auto-suffix** `name (1)`, `name (2)`. The SQLite UNIQUE error maps to
  these responses; never a raw 500.
- **Permanent delete of a folder** recursively removes descendant nodes, their blobs, and any shares
  pointing into the subtree, in one transaction (blob unlink after commit — §9).
- **Storage meter:** shows used vs quota; Trash size shown separately (trashed bytes still count until
  permanent delete).

### 3.3 Sharing (per file or per folder)
- Create share → `/s/<token>` (32-byte CSPRNG, URL-safe).
- **Active toggle** (`is_active`): start/stop instantly without deleting the link.
- **Password** (optional): argon2id-hashed; rate-limited (per-IP **and** per-token global) on the public page.
- **Expiry** (optional `expires_at`): scheduled auto-stop-sharing.
- **Owner-facing status is distinct:** *active* / *stopped* (is_active=0) / *expired* (expires_at≤now).
  "Restart sharing" on an expired link requires setting a new future expiry (or clearing it), else it
  stays expired.
- Copy-link, revoke (hard delete). Folder shares: read-only browse of the **current non-trashed** subtree,
  per-file download, and "Download all as ZIP" (streamed).

### 3.4 Lifecycle scheduling
- **Auto-delete** (`nodes.auto_delete_at`, epoch-ms, must be future when set): at the time it passes the
  item is **trashed** (subtree stamped atomically), its shares go 410; the blob is purged after a 7-day
  grace. Applies even to items already in Trash (self-destruct honored). Clearable.
- **Auto-unshare** (`shares.expires_at`): when it passes the share is treated as expired (access gate is
  evaluated at request time — §9 — so it stops serving immediately, not on the next tick).
- Scheduler (§9) is **cleanup/UX only**, never the access gate.

### 3.5 Public share page `/s/<token>`
- Bilingual (AR default; **AR/EN toggle** that flips `dir` to LTR for English; Accept-Language seeds default).
- Live file: sealed-dispatch framing, name, size, type, **Download** as the unambiguous primary action.
- Live folder: read-only subtree browser + per-file + "Download all as ZIP".
- **Password gate:** the pre-unlock response reveals only "password required" + branding — **no** name,
  size, type, or listing. After unlock (§9) it issues a short-lived scoped cookie.
- **410** distinguishes *stopped* vs *expired* with different copy; **404** for unknown token; wrong
  password shows attempts-remaining. `Referrer-Policy: no-referrer` on these responses.

---

## 4. Visual design system ("Ink & Brass" — sealed dispatch)

Grounded in the subject: *Mirsal = envoy/dispatch* — the **seal (ختم)**, Kufic inscription, dispatch
register. Avoids the three generic AI-design defaults (cream+serif+terracotta / near-black+acid-green /
broadsheet hairlines). The theme carries the **primary working surface**, not just the public page (§4.6).

### 4.1 Color tokens + **contrast contract** (WCAG: text ≥4.5:1, non-text ≥3:1)
Light:
```
--paper       #F4F5F3   app background (cool paper — not warm cream)
--surface     #FFFFFF   cards / panels
--ink         #0F1C2E   primary text / brand           ink on paper  ≈ 15.4:1 ✓
--ink-2       #45566A   secondary text                 on paper      ≈  6.8:1 ✓
--line        #E2E5E1   hairlines
--brass       #C0913C   BRAND fill / seal body / large decorative ONLY (never text/icon fg on light)
--brass-ink   #0F1C2E   label ON brass fill            ink on brass  ≈  5.5:1 ✓ (primary CTA = brass fill + ink label)
--brass-ring  #7A5A20   seal ring / brass outline      on paper      ≈  4.8:1 ✓ (gives the seal its 3:1)
--teal        #0E5A63   links / selected / focusable    on paper      ≈  5.1:1 ✓ (darkened from #14707C for AA)
--emerald     #24694B   success / "active" text+icon    on paper      ≈  5.4:1 ✓
--clay        #A13D28   destructive / expiry            on paper      ≈  5.6:1 ✓
--focus       #0E5A63   focus ring (2px + 2px offset; clears 3:1 on paper, brass, teal)
```
Dark:
```
--paper #0C1622  --surface #12212F  --ink #EAF0F2  --ink-2 #93A4B5  --line #23384B
--brass #D2A24C (fill/decorative)  --brass-ink #0C1622  --teal #6FC5CE  --emerald #5FBF92  --clay #E08A74
```
**Rule:** primary CTA = brass fill + `--brass-ink` label (never white-on-brass). Brass is never the
foreground of essential text or a standalone icon on paper/white; the seal always has a `--brass-ring`.

### 4.2 Typography (self-hosted woff2 — no CDN, offline-safe, CSP-clean)
- **Display / brand:** **Reem Kufi** (Kufic) — restrained: brand, page titles, dispatch moments.
- **Body / UI:** **IBM Plex Sans Arabic** — all interface text (AR + Latin). Also carries any Arabic-Indic
  digits if ever used.
- **Mono / data:** **IBM Plex Mono** — tokens, sizes, timestamps, IDs. **ASCII/Latin only** (§4.5 numerals).
- Scale (rem): 0.75 · 0.875 · 1 · 1.125 · 1.375 · 1.75 · 2.25 · 3. Weights: Kufi 500/700; Sans 400/500/600; Mono 400/500.

### 4.3 Layout — **logical properties only** (correct RTL)
- Root `dir="rtl"`. **Nav rail = inline-start** (visually right in RTL); **details drawer = inline-end**
  (visually left) — never the same edge. All spacing/positioning uses `margin/padding/inset-inline`,
  `border-inline-start`, `text-align:start`. No physical `left/right` in layout CSS.
- **Bidi isolation:** every Latin/mono run (tokens, "100 MB", ISO dates, IDs, URLs) wrapped in `<bdi>`
  / `unicode-bidi:isolate` `dir="ltr"` so it doesn't scramble inside Arabic.
- Radius 10px cards / 8px controls / circular seal. Subtle single soft shadow; lean on hairlines + spacing.

### 4.4 Signature — the brass seal (ختم), specified
- **Concrete artifact:** a circular seal — outer `--brass-ring` ring (2px), brass body, carrying a **Kufic
  "م" / مِرسال** monogram. One built reference component; two sizes: **badge** (18px, on shared items in
  lists) and **dispatch seal** (72px, public page + share-created moment).
- Motion: creating/starting a share plays one **stamp press** (110ms scale 0.9→1 + settle, ease-out). The
  only orchestrated motion. Reduced-motion fallback: seal simply appears + a toast; no scale.
- **Status is never color-only:** shared/active/expired each pair the color with a text label + icon
  (disambiguates brass-seal "shared" vs emerald "active").

### 4.5 Localization details
- **Numerals: Western 0–9 everywhere** (safest for mixed audience + mono + public links). Plex Mono only
  ever carries Latin digits. (Arabic-Indic digits, if ever wanted in the Arabic UI, render in Plex Sans, not mono.)
- Dates render in Asia/Damascus; the public EN view renders dates in an EN-readable form.

### 4.6 Working-surface theme — "dispatch register"
The file list is styled as a **dispatch register**: monospace ledger columns for size/date/(share token),
a **status/stamp column** (seal badge when shared), Kufic section headers. This carries the identity on the
screen users spend ~95% of their time on — not just `/s/<token>`.

### 4.7 Icon system
Restrained custom line-icons matching ink/brass stroke weight + corner treatment; brand-critical glyphs are
subject-grounded: **folder = dispatch dossier**, **share = seal/send**, **active-share = stamp**,
**auto-delete = hourglass**, **expiry = calendar-stamp**. Named set + these customizations (no stock Lucide look).

### 4.8 Quality floor
Responsive to mobile (§ mobile rules below) · visible keyboard focus (`--focus` token) · `prefers-reduced-motion`
respected · light + dark · contrast contract §4.1 · status never color-only.

**Mobile (RTL):** nav rail → off-canvas from **inline-start (right)** with a scrim; details drawer → bottom
sheet; storage meter → inside the nav drawer; top bar collapses search/actions into a menu but keeps **Upload**
primary; picker is the mobile upload path.

### 4.9 Copy inventory (authored, MSA voice; AR+EN on public pages)
Every empty/error state has authored copy, active voice, next-step guidance (not mood). Representative set
(full strings live in i18n during build):

| State | AR (voice) | EN (public only) |
|---|---|---|
| Empty root | "لا ملفات بعد. ارفع أول ملف أو أنشئ مجلدًا." | — |
| Empty Trash | "المهملات فارغة." | — |
| Empty Shared | "لم تُشارك أي عنصر بعد." | — |
| Upload >100MB | "الحد الأقصى ١٠٠ ميغابايت للملف. قسّم الملف أو اضغطه." | — |
| Quota exceeded | "لا تتوفر مساحة كافية. احذف عناصر أو راجع المشرف." | — |
| Upload failed | "تعذّر رفع الملف. تحقق من الاتصال وحاول مجددًا." | — |
| Public 404 | "هذا الرابط غير موجود." | "This link doesn't exist." |
| Public 410 stopped | "أوقف المُرسِل مشاركة هذا الملف." | "The sender turned this link off." |
| Public 410 expired | "انتهت صلاحية هذا الرابط في <date>." | "This link expired on <date>." |
| Password gate | "هذا الملف محمي بكلمة مرور." | "This file is password-protected." |
| Wrong password | "كلمة مرور غير صحيحة. المحاولات المتبقية: <n>." | "Incorrect password. <n> attempts left." |

---

## 5. Architecture

```
Internet ─HTTPS→ IT gateway (terminates TLS) ─HTTP→ host nginx :80/:443
                                  │ sets X-Forwarded-Proto https, -For, -Host
                                  │ reverse proxy · client_max_body_size 120M
                                  │ proxy_request_buffering OFF on /api/nodes/upload
                                  │ NO http→https redirect (gateway forwards HTTPS→:80; redirect = loop)
                                  ▼
                        app container (127.0.0.1:8084, docker, unless-stopped, pinned UID)
                        ├── Fastify (trustProxy on) — REST API + serves built React SPA
                        ├── Auth: opaque server-side sessions (see §6/§8), argon2id, CSRF token
                        ├── Scheduler: node-cron (60s), reentrancy-locked, batched (§9)
                        ├── better-sqlite3 (WAL, busy_timeout, foreign_keys=ON) → /data/db/app.db
                        └── blobs → /data/storage/<owner_id>/<node_id>   (bind-mounted)
```
- **One** Docker service; data bind-mounted to `/var/www/projects/mirsal/data/` (survives rebuilds).
- **Sessions over JWT:** an opaque 32-byte session token in an `httpOnly; Secure; SameSite=Lax` cookie,
  hashed in a `sessions` table, **validated on every request** (cheap SQLite lookup joining `users`,
  checking `is_active`). Revocation is real: logout deletes the row; deactivate/reset deletes all the
  user's sessions. (No stateless-JWT revocation gap — resolves must-fix M1 simply.)

### Module boundaries (each independently testable)
`db/` (schema, migrations, PRAGMAs, typed queries) · `auth/` (argon2, sessions, CSRF, guards) ·
`storage/` (streamed blob write/read/delete by id; temp-file + rename; quota reserve/commit) ·
`nodes/` (tree CRUD, move w/ cycle guard, trash subtree, recursive delete, roll-ups) ·
`shares/` (create/toggle/expire/revoke; token; password; **canonical subtree resolver**) ·
`scheduler/` (pure `dueTrash(now)`/`duePurge(now)`/`orphanGC()` + locked runner, clock injected) ·
`routes/` (HTTP, zod validation) · `web/` (React SPA).

---

## 6. Data model (SQLite; timestamps = **epoch-millis INTEGER** for unambiguous comparison)

```sql
PRAGMA foreign_keys = ON;   -- set on EVERY connection (better-sqlite3 does not by default)
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

users(
  id INTEGER PK, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','user')),
  quota_bytes INTEGER,                         -- NULL = unlimited
  used_bytes INTEGER NOT NULL DEFAULT 0,       -- maintained transactionally (quota)
  is_active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  root_node_id INTEGER, trash_node_id INTEGER, -- synthetic roots (created with the user)
  created_by INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
)

sessions(
  id INTEGER PK,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,             -- sha-256 of the cookie secret
  created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, revoked_at INTEGER
)

nodes(
  id INTEGER PK,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES nodes(id) ON DELETE CASCADE,   -- NULL only for synthetic root/trash
  kind TEXT NOT NULL CHECK(kind IN ('root','trash','folder','file')),
  name TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,       -- files: blob size; folders: rolled up on read
  mime_type TEXT,
  storage_path TEXT,                           -- files only, relative under /data/storage
  trashed_at INTEGER,                          -- NULL = live; set = in Trash (subtree stamped)
  original_parent_id INTEGER,                  -- captured on trash, for restore
  auto_delete_at INTEGER,                      -- NULL = never; epoch-ms (must be future when set)
  purge_after INTEGER,                         -- set when auto-trashed: epoch-ms to hard-purge
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
)
-- Live-namespace uniqueness only (fixes the NULL-root + trash-collision bugs):
CREATE UNIQUE INDEX ux_live_name ON nodes(parent_id, name)
  WHERE trashed_at IS NULL AND parent_id IS NOT NULL;
CREATE INDEX ix_nodes_owner_parent ON nodes(owner_id, parent_id);
CREATE INDEX ix_nodes_auto_delete ON nodes(auto_delete_at) WHERE auto_delete_at IS NOT NULL;

shares(
  id INTEGER PK,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,                  -- 32-byte CSPRNG, URL-safe
  password_hash TEXT,                          -- NULL = no password
  is_active INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER,                          -- NULL = never
  allow_download INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, revoked_at INTEGER
)

audit_log(id INTEGER PK, actor_id INTEGER, action TEXT NOT NULL, target TEXT, detail TEXT, created_at INTEGER NOT NULL)
share_access_log(id INTEGER PK, share_id INTEGER NOT NULL, ip TEXT, ua TEXT, accessed_at INTEGER NOT NULL)
```
Delete order (documented, top of every cascade): shares → child nodes depth-first → parent node → blobs
(after commit) → empty storage dirs. FKs `ON DELETE CASCADE` back this up; app performs it explicitly and
in order so blob unlink happens post-commit. `audit_log.actor_id` intentionally unconstrained (survives user delete).

---

## 7. API surface (representative)

```
Auth
  POST   /api/auth/login            {username,password}  (rate-limited per-user & per-IP) → session cookie
  POST   /api/auth/logout           (delete this session)
  POST   /api/auth/logout-all       (delete all my sessions)
  GET    /api/auth/me
  POST   /api/auth/password         {current,new}        (clears must_change_password; keeps session)

Admin (requireAdmin; last-admin guard; audited)
  GET    /api/admin/users
  POST   /api/admin/users           {username,password,role,quota_bytes?}
  PATCH  /api/admin/users/:id       {is_active?, role?, quota_bytes?}   → on deactivate: delete their sessions
  POST   /api/admin/users/:id/password                                  → delete their sessions
  DELETE /api/admin/users/:id
  GET    /api/admin/users/:id/nodes   (metadata only — no content/download)
  GET    /api/admin/shares            ·  DELETE /api/admin/shares/:id
  GET    /api/admin/audit

Nodes (requireAuth, owner-scoped)
  GET    /api/nodes?parent=:id                 list a folder (trashed_at IS NULL)
  GET    /api/nodes/trash                       list Trash
  POST   /api/nodes/folder          {parent_id,name}
  POST   /api/nodes/upload          multipart, proxy-buffering off, streamed to temp, ≤100MB, quota reserve/commit
  PATCH  /api/nodes/:id             {name?, parent_id?}    rename/move (cycle guard; 409 on live collision)
  POST   /api/nodes/:id/trash | /restore                   (subtree stamp; restore auto-suffixes on collision)
  DELETE /api/nodes/:id                          permanent (recursive; blob unlink after commit)
  PATCH  /api/nodes/:id/auto-delete {auto_delete_at|null}  (must be future)
  GET    /api/nodes/:id/download                 (Content-Disposition RFC 6266, §8)

Shares (requireAuth, owner-scoped)
  GET    /api/shares  ·  POST /api/shares {node_id,password?,expires_at?}
  PATCH  /api/shares/:id {is_active?, password?|null, expires_at?|null}  ·  DELETE /api/shares/:id

Public (no auth; access gate §9; Referrer-Policy: no-referrer)
  GET    /api/public/:token                     → live meta | 401 needs-password (NO metadata leak) | 410 stopped|expired | 404
  POST   /api/public/:token/unlock  {password}  (per-IP + per-token global rate limit) → short-lived scoped cookie
  GET    /api/public/:token/list?path=          folder browse via canonical resolver (subtree only)
  GET    /api/public/:token/download?node=      stream one file via canonical resolver (subtree only)
  GET    /api/public/:token/zip                 streamed ZIP of the shared subtree (archiver, no buffering)
```

**Canonical subtree resolver (single code path for public list + download + zip):** given a requested
node id, walk `parent_id` upward; require the share's `node_id` as an ancestor **and** same `owner_id`;
reject trashed nodes and anything not a descendant → 403. No path strings from the client are trusted.

---

## 8. Security

- **Passwords:** argon2id with **pinned, box-benchmarked** memoryCost/timeCost/parallelism; a **semaphore
  caps concurrent argon2 ops** so total argon2 memory is bounded (protects the ~250 MB container from a
  flood of public `/unlock` hashes). Share-password verification uses a lower memory tier.
- **Sessions:** opaque token, `httpOnly; Secure; SameSite=Lax`; server-side row; validated every request;
  sliding expiry; real revocation (§5). `must_change_password` forces a change before other actions.
- **CSRF:** signed (HMAC, session-bound) double-submit token on all mutating requests; CSRF cookie is
  non-httpOnly, session cookie is httpOnly.
- **Login brute-force:** per-username + per-IP rate limit / backoff / temporary lockout; failures audited
  (host fail2ban can't see per-account failures behind the :80 proxy).
- **Proxy trust:** Fastify `trustProxy`; nginx sends `X-Forwarded-Proto https`; all absolute URLs
  (`PUBLIC_BASE_URL`, share links) built from forwarded proto/host → always `https://`. Verified in the
  local-chain curl check.
- **Isolation:** every node/share query scoped by `owner_id`. Admin has **no** content path; admin
  cross-user metadata access is audited.
- **Public folder shares:** canonical subtree resolver (§7) is the *only* addressing; blocks the
  cross-subtree IDOR. Pre-unlock response leaks nothing identifying.
- **Share tokens:** 32-byte CSPRNG, constant-time compare; per-IP **and** per-token global attempt caps.
- **Downloads:** always `Content-Disposition: attachment` encoded per **RFC 6266**
  (`filename*=UTF-8''<pct-encoded>` + ASCII fallback), CR/LF + control chars stripped from the name (Arabic
  names are the norm); `X-Content-Type-Options: nosniff`; never serve uploaded content inline (no stored XSS).
- **Uploads:** streamed to a temp file on the **same filesystem** as storage (never `.toBuffer()` — memory
  bomb); `@fastify/multipart` `limits.fileSize=100MB` aborts mid-stream; quota **reserve-then-commit**
  (reserve `min(Content-Length,100MB)` against `used_bytes` in a short txn; on completion verify actual
  bytes vs quota, then atomic rename+commit real size, or unlink + release). nginx `proxy_request_buffering off`.
- **Headers:** Helmet CSP (self only, no `unsafe-inline` for scripts, `frame-ancestors 'none'`); HSTS via
  nginx; `Referrer-Policy: no-referrer` on `/s/<token>`.
- **Timestamps:** epoch-ms integers compared numerically; user-entered Damascus datetimes converted to UTC
  at the API boundary via a fixed `Asia/Damascus` zone; "now" is one canonical source.

---

## 9. Lifecycle, access gate & scheduler

**Access gate (evaluated at REQUEST time — not by the scheduler flag):** a share is publicly live iff
`is_active=1 AND (expires_at IS NULL OR expires_at>now) AND node exists AND node.trashed_at IS NULL AND
(node.auto_delete_at IS NULL OR auto_delete_at>now)`. So an expired/auto-deleted item stops serving
immediately even before the next tick; re-toggling `is_active` with a past `expires_at` still 410s.

**Scheduler (node-cron, 60s) — cleanup/UX only:**
- **Reentrancy lock:** a module-level run-lock skips a tick if the prior run is still in flight.
- `dueTrash(now)`: nodes with `auto_delete_at≤now` and not yet trashed → stamp subtree trashed, 410 their
  shares, set `purge_after = now + 7d`. Bounded batch per tick (`LIMIT`).
- `duePurge(now)`: nodes with `purge_after≤now` → permanent delete. **DB delete committed in a txn first**
  (collect `storage_path`s), **blob unlink AFTER commit** in small batches yielding to the loop (idempotent:
  missing file = success). Large subtrees deferred across ticks.
- `orphanGC()`: periodically unlink blob files with no node row, and flag file nodes whose blob is missing.
- Pure functions (`dueTrash`/`duePurge`/`orphanGC` selection) are unit-tested with an injected clock; heavy
  deletes never block the event loop unbounded.

---

## 10. Deployment

- **Path:** `/var/www/projects/mirsal/` (git; `data/` ignored). **Branch strategy:** feature branch
  `feat/mvp-build` → merge to `main` only when tests green.
- **Build (memory-safe on this box):** build the SPA + image using the **host's Node 20.20.2** (or off-box)
  and `docker load`; if building in-Docker, cap it (`--memory=1g --memory-swap=2g`,
  `NODE_OPTIONS=--max-old-space-size=768`) and run at low load. **Build-time budget is separate from the
  ~250 MB runtime budget.** Multi-stage: builder stage on **`node:20-slim`** installs `better-sqlite3`
  (pinned version) using the linux-x64 glibc prebuilt binary; runtime stage on the **identical base**;
  `node_modules` copied across identical bases (no toolchain in the runtime layer). If a compile is ever
  forced, add `python3 + build-essential` to the builder stage only.
- **Container user:** pinned UID; `data/{db,storage,backups}` pre-created on the host with **matching
  ownership** (documented install step) so SQLite can open the DB and uploads can write.
- **Compose:** one service `mirsal`, `restart: unless-stopped`, publishes `127.0.0.1:8084`, bind-mounts
  `./data`, **log rotation** `json-file max-size=10m max-file=3`. Env: `SESSION_SECRET`, `CSRF_SECRET`,
  `PUBLIC_BASE_URL`, `TZ=Asia/Damascus`.
- **nginx vhost `mirsal`** → `proxy_pass http://127.0.0.1:8084`; reuse
  `/etc/letsencrypt/live/project4.system.mow.gov.sy/`; `client_max_body_size 120M`; upload location
  `proxy_request_buffering off` + long `client_body_timeout`; `X-Forwarded-Proto https` + `-For`/`-Host`;
  single 80+443 block, **no http→https redirect**. Deploy enables **only** the `mirsal` vhost; confirm no
  other enabled vhost matches project4 (`nginx -T | grep project4`); park stale `odk-central`/`jasim-bot`.
- **First-boot seed (idempotent):** creates one **admin** with a random password + `must_change_password=1`.
  The credential is written to a **root-only `0600` file outside the image** (and printed once) — **not**
  left in the rotating container log. Skips if any admin exists.
- **Disconnect resilience:** build + `compose up` + migrate + seed run **detached** (`systemd-run --scope`
  / `nohup` / `tmux`) with output tee'd to a file; migrations + seed are idempotent/re-runnable.
- **Backups:** `.backup` via **better-sqlite3 backup API inside the container** (host has no `sqlite3` CLI)
  with WAL + busy_timeout; snapshot **storage first, then DB** (restore tolerates extra blobs); ship the DB
  dump **off-box via rclone to B2** (like ODK/Freepik) + keep 1–2 local copies; retention bounded by total
  size; skip gzip on already-compressed blobs; **restore-test step** in the runbook.

---

## 11. Testing strategy ("keep testing until launch")

- **Unit (injected clock/fakes):** `dueTrash`/`duePurge`/`orphanGC` selection; token gen + constant-time
  compare; quota reserve/commit math; canonical subtree resolver; RFC-6266 filename encoding; argon2 verify;
  Damascus→UTC conversion (whole-second vs ms; DST-style boundary).
- **Integration (better-sqlite3 temp file, FKs ON):**
  - auth: login/logout/logout-all/me/password; bad creds; inactive-at-login blocked; **session revoked
    mid-flight** (deactivate/reset while a session is live → next request 401); login rate-limit/lockout.
  - **cross-user isolation:** A cannot read/patch/delete/download B's nodes/shares (403/404); admin has no
    content endpoint.
  - nodes: folder CRUD; **duplicate root names rejected**; upload; rename/move; **move into self/descendant
    → 409**; **trash + re-create + re-trash same name all succeed**; restore-collision auto-suffix; recursive
    permanent delete → **zero orphan rows/blobs**; quota reject; trashed bytes still counted.
  - shares: create → public meta → download; folder-share **subtree confinement** (sibling id/`..`/moved-out
    → 403); password gate (pre-unlock leaks nothing; wrong→lockout; right→unlock); toggle-off → 410-stopped;
    **expired-not-yet-swept → 410-expired**; re-toggle with past expiry → 410; revoke → 404; ZIP streams subtree.
  - scheduler: reentrancy (two overlapping runs over same due set → exactly one deletion); due auto-delete
    trashes subtree + 410s shares + sets purge_after; due purge removes blobs+rows; **crash-after-commit →
    GC reclaims orphan**.
  - last-admin guard: demote/deactivate/delete last admin → 409; self-deactivate → 409.
- **E2E smoke (curl vs running container):** login → change password → create folder → upload → share →
  `/s/<token>` meta → public download → ZIP → stop sharing → 410 → set past expiry variant.
- **Local chain check:** `curl --resolve project4.system.mow.gov.sy:443:127.0.0.1
  https://project4.system.mow.gov.sy/` returns the app AND share links come back `https://` (proxy-proto).
- **Manual UI pass:** admin creates a user; that user uploads/organizes/shares; recipient (AR + EN toggle)
  downloads; RTL + dark + mobile + reduced-motion + focus-visible + Arabic-filename download spot-checks.

**Launch gate:** no "launched" claim until unit + integration + E2E green and the local chain returns the app.

---

## 12. Risks & mitigations
- **Memory pressure (box already swapping):** single lean container; SQLite not Postgres; **build off the
  runtime path** (host/off-box, capped); streamed uploads/downloads; argon2 concurrency semaphore. Monitor RSS.
- **No at-rest encryption v1:** acceptable for stated use; documented v2 option. Share passwords + HTTPS
  cover in-transit + link secrecy.
- **Large recursive deletes:** batched across ticks, blob unlink post-commit off the hot path.
- **Public route:** project4 proven for ODK; re-verify local chain; if blocked, ask IT to confirm project4
  route (networking memory).

---

## 13. What the user provides / decisions to confirm
1. **Review this spec** (or edit).
2. **Brand name** — default **Mirsal / مِرسال**.
3. Confirm the three defaults in §1: (a) admin cannot read user file contents; (b) auto-delete routes
   through Trash with a 7-day grace (recoverable) vs instant hard purge; (c) optional per-user quotas.
4. Nothing else unblocks launch — project4 cert + route are ready; agent verifies the local chain and flags
   if IT must re-confirm the public route.

At launch the agent hands over: admin URL + generated admin credential (from the root-only file), a short
runbook, and the backup/restore recipe.
```
