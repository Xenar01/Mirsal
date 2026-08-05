# Mirsal MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build & launch Mirsal — an Arabic-first, full-RTL secure file-sharing platform (admin creates users; per-user Drive-like dashboard; share files/folders with independent auto-delete and auto-unshare) on `project4.system.mow.gov.sy`.

**Architecture:** One lean Docker container. Fastify (TypeScript) serves a REST API + the built React SPA. Data in SQLite (better-sqlite3, WAL, FKs ON); file blobs on a bind-mounted disk. Opaque server-side sessions (real revocation). A 60-second reentrant node-cron scheduler does cleanup only; the public access gate is evaluated at request time. Host nginx reverse-proxies `127.0.0.1:8084`, reuses the project4 Let's Encrypt cert, sets `X-Forwarded-Proto https`, no http→https redirect.

**Tech Stack:** Node 20 · TypeScript · Fastify 4 (`@fastify/cookie`, `/multipart`, `/static`, `/rate-limit`, `/helmet`) · better-sqlite3 · argon2 · zod · archiver · pino · Vitest (unit+integration via `app.inject`) · React 18 · Vite · Tailwind CSS v4 · react-router-dom · TanStack Query · i18next · self-hosted Reem Kufi / IBM Plex Sans Arabic / IBM Plex Mono.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-25-mirsal-design.md` — every task inherits it. Brand: **Mirsal / مِرسال**.
- **Node:** pin `20` (match host `20.20.2`); pin `better-sqlite3` exact version; rely on its linux-x64 glibc prebuilt (no compile in the runtime layer).
- **Max file size:** 100 MB (104857600 bytes) enforced app-side; nginx `client_max_body_size 120M`.
- **Timestamps:** epoch-millis INTEGER everywhere; compare numerically; convert user Damascus datetimes → UTC at the API boundary; one canonical `now()`.
- **RTL:** root `dir="rtl"`; CSS logical properties only (no physical left/right in layout); wrap every Latin/mono run in `<bdi dir="ltr">`. Numerals: Western 0–9; Plex Mono carries ASCII only.
- **Contrast contract (§4.1):** primary CTA = brass fill + `--brass-ink` label (never white-on-brass); brass never a text/icon foreground on light; seal has `--brass-ring`. `--teal #0E5A63`, `--emerald #24694B`, `--clay #A13D28`.
- **Security:** opaque sessions validated every request (check `is_active`); argon2id with a concurrency semaphore; login + `/unlock` rate-limited (per-IP and per-token/user); downloads `Content-Disposition` per RFC 6266 with CR/LF stripped + `nosniff`, never inline; canonical subtree resolver is the only public addressing; CSP self-only, no `unsafe-inline` scripts; `Referrer-Policy: no-referrer` on `/s/*`.
- **DB rules:** `PRAGMA foreign_keys=ON; journal_mode=WAL; busy_timeout=5000` on every connection. Partial unique index `ux_live_name`. Delete order: shares → child nodes depth-first → parent → blobs (after commit) → dirs.
- **Git:** work on `feat/mvp-build`; **commit after every step**; merge to `main` only when the suite is green.
- **Deploy:** memory-safe build off the runtime path; detached/disconnect-resilient; idempotent migrations + first-boot admin seed (credential to a root-only `0600` file, not the log); enable only the `mirsal` vhost.

---

## File Structure

```
/var/www/projects/mirsal/
├─ package.json                      # root: scripts orchestrate server + web
├─ tsconfig.base.json
├─ .env.example                      # SESSION_SECRET, CSRF_SECRET, PUBLIC_BASE_URL, TZ, ARGON_* , DB_PATH, STORAGE_DIR
├─ server/
│  ├─ package.json  tsconfig.json  vitest.config.ts
│  ├─ src/
│  │  ├─ config.ts                   # env parsing (zod), constants (MAX_FILE, GRACE_MS=7d)
│  │  ├─ clock.ts                    # now(): number; injectable Clock for tests
│  │  ├─ db/
│  │  │  ├─ connection.ts            # openDb(path): Database (sets PRAGMAs)
│  │  │  ├─ migrate.ts               # idempotent schema migrations (version table)
│  │  │  └─ schema.sql               # canonical DDL (mirrors spec §6)
│  │  ├─ util/
│  │  │  ├─ ids.ts                   # randomToken(bytes): url-safe
│  │  │  ├─ contentDisposition.ts    # rfc6266(name): string
│  │  │  ├─ time.ts                  # damascusToUtcMs(localIso): number
│  │  │  └─ semaphore.ts             # concurrency limiter for argon2
│  │  ├─ auth/
│  │  │  ├─ passwords.ts             # hash/verify (argon2id + semaphore)
│  │  │  ├─ sessions.ts              # create/validate/revoke sessions
│  │  │  ├─ csrf.ts                  # issue/verify HMAC session-bound token
│  │  │  └─ guards.ts                # requireAuth / requireAdmin (Fastify preHandler)
│  │  ├─ storage/
│  │  │  ├─ blobs.ts                 # writeStream→temp→commit path, read, unlink
│  │  │  └─ quota.ts                 # reserve/commit/release against users.used_bytes
│  │  ├─ nodes/
│  │  │  ├─ tree.ts                  # create/list/rename/move(+cycle guard)/rollups
│  │  │  ├─ trash.ts                 # trash subtree / restore / permanent delete
│  │  │  └─ collisions.ts            # 409 vs auto-suffix policy
│  │  ├─ shares/
│  │  │  ├─ shares.ts                # create/toggle/expire/revoke
│  │  │  ├─ resolver.ts              # canonical subtree resolver (public)
│  │  │  └─ gate.ts                  # isShareLive(share,node,now) request-time gate
│  │  ├─ scheduler/
│  │  │  ├─ selectors.ts             # dueTrash/duePurge/orphan selection (pure)
│  │  │  └─ runner.ts                # reentrant 60s loop, batched, blob-unlink-after-commit
│  │  ├─ routes/
│  │  │  ├─ auth.ts admin.ts nodes.ts shares.ts public.ts health.ts
│  │  ├─ audit.ts                    # audit(actor,action,target,detail)
│  │  ├─ app.ts                      # buildApp(deps): Fastify (helmet, cookie, multipart, static, routes)
│  │  ├─ seed.ts                     # ensureAdmin(): idempotent first-boot admin
│  │  └─ index.ts                    # bootstrap: migrate → seed → start scheduler → listen
│  └─ test/                          # vitest: unit + integration (fresh temp DB per file)
├─ web/
│  ├─ package.json  vite.config.ts  tailwind.config / index.css (tokens)
│  ├─ index.html                     # <html dir="rtl" lang="ar">
│  ├─ public/fonts/                  # self-hosted woff2
│  └─ src/
│     ├─ main.tsx  app/router.tsx
│     ├─ styles/tokens.css           # §4.1 tokens (light+dark), focus ring
│     ├─ i18n/{ar.json,en.json,index.ts}
│     ├─ lib/api.ts                  # fetch wrapper (CSRF header, credentials)
│     ├─ components/                 # Seal, StatusChip, Icon set, FileRow, Toolbar, Drawer, Modal…
│     ├─ features/dashboard/         # DriveView, UploadDrop, ShareModal, AutoDeleteMenu, TrashView
│     ├─ features/admin/             # UsersTable, CreateUserModal, AuditLog, SharesTable
│     └─ features/public/            # SealedDispatch (file), PublicFolder, PasswordGate
├─ Dockerfile                        # multi-stage (builder = node:20-slim, runtime = identical base)
├─ docker-compose.yml                # 127.0.0.1:8084, unless-stopped, log rotation, bind ./data
├─ deploy/
│  ├─ nginx-mirsal.conf              # vhost template
│  ├─ backup-mirsal.sh               # in-container .backup + rclone to B2
│  └─ install.md                     # pinned-UID data dirs, enable-only-mirsal vhost
└─ data/ (gitignored)               # db/ storage/ backups/
```

---

## Phase A — Scaffold & tooling

### Task A1: Repo scaffold, tsconfig, vitest, first green test

**Files:** Create `package.json`, `tsconfig.base.json`, `server/package.json`, `server/tsconfig.json`, `server/vitest.config.ts`, `server/src/clock.ts`, `server/test/clock.test.ts`.
**Interfaces — Produces:** `clock.ts`: `export type Clock = () => number; export const systemClock: Clock = () => Date.now();`

- [ ] **Step 1:** Write `server/test/clock.test.ts`: `import {systemClock} from '../src/clock'; test('clock returns ms number', ()=>{ const t=systemClock(); expect(typeof t).toBe('number'); expect(t).toBeGreaterThan(1_700_000_000_000); });`
- [ ] **Step 2:** Add deps in `server/package.json` (`fastify better-sqlite3 argon2 zod archiver pino @fastify/cookie @fastify/multipart @fastify/static @fastify/rate-limit @fastify/helmet`; dev: `typescript tsx vitest @types/node @types/better-sqlite3`), pin versions; `npm install` (run detached, tee log).
- [ ] **Step 3:** Write `clock.ts` as above.
- [ ] **Step 4:** Run `npx vitest run test/clock.test.ts` → PASS.
- [ ] **Step 5:** `git add -A && git commit -m "chore: scaffold server workspace + clock"`.

---

## Phase B — Database layer

### Task B1: Connection + PRAGMAs

**Files:** Create `server/src/db/connection.ts`, `server/test/db/connection.test.ts`.
**Produces:** `openDb(path: string): Database.Database` — opens better-sqlite3 and runs `PRAGMA foreign_keys=ON; journal_mode=WAL; busy_timeout=5000`.

- [ ] **Step 1 (test):** open an in-file temp DB; assert `db.pragma('foreign_keys',{simple:true})===1` and `journal_mode` is `wal`.
- [ ] **Step 2:** Run → FAIL (module missing).
- [ ] **Step 3:** Implement `openDb`.
- [ ] **Step 4:** Run → PASS. **Step 5:** Commit.

### Task B2: Schema + idempotent migrations

**Files:** Create `server/src/db/schema.sql` (verbatim DDL from spec §6: users, sessions, nodes + `ux_live_name` partial index + indexes, shares, audit_log, share_access_log), `server/src/db/migrate.ts`, `server/test/db/migrate.test.ts`.
**Produces:** `migrate(db): void` — creates a `schema_version` table, applies `schema.sql` once, is safe to call repeatedly.

- [ ] **Step 1 (test):** `migrate(db)` twice on the same DB → no throw; `sqlite_master` contains `users`,`nodes`,`shares`,`sessions`,`ux_live_name`; inserting two `nodes` with same `(parent_id,name)` both live → **throws UNIQUE**; same name with one `trashed_at` set → **OK**; two nodes with `parent_id IS NULL` same name → OK (index is partial).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit.

### Task B3: Config + injectable now

**Files:** Create `server/src/config.ts` (zod-parsed env: `DB_PATH, STORAGE_DIR, SESSION_SECRET, CSRF_SECRET, PUBLIC_BASE_URL, ARGON_MEMORY_KIB, ARGON_TIME, ARGON_PARALLELISM, ARGON_MAX_CONCURRENCY`; constants `MAX_FILE_BYTES=104857600`, `GRACE_MS=604800000`), `.env.example`, test.

- [ ] Test: parsing a complete env object yields typed config; a missing required var throws a clear error. TDD 5 steps, commit.

---

## Phase C — Auth

### Task C1: Password hashing with concurrency cap

**Files:** Create `server/src/util/semaphore.ts`, `server/src/auth/passwords.ts`, tests.
**Produces:** `Semaphore(max)` with `run<T>(fn):Promise<T>`; `hashPassword(pw):Promise<string>`, `verifyPassword(hash,pw):Promise<boolean>` (argon2id, params from config, all calls funneled through a module-level semaphore of size `ARGON_MAX_CONCURRENCY`).

- [ ] **Step 1 (test):** `verifyPassword(await hashPassword('x'),'x')===true`; wrong pw `false`; **semaphore:** launch 10 concurrent `hashPassword` with a semaphore(2) and assert peak concurrency never exceeded 2 (instrument a counter).
- [ ] Steps 2–5: fail → implement → pass → commit.

### Task C2: Sessions (create/validate/revoke) — real revocation

**Files:** Create `server/src/util/ids.ts`, `server/src/auth/sessions.ts`, tests.
**Produces:**

```
randomToken(bytes=32): string                 // url-safe base64
createSession(db, userId, now, ttlMs): {token, id}   // stores sha256(token) in sessions
validateSession(db, token, now): {userId, role, mustChangePassword} | null
                                              // null if missing/expired/revoked OR user inactive; slides last_used_at/expires_at
revokeSession(db, token): void
revokeAllForUser(db, userId): void
```

- [ ] **Step 1 (tests):** valid token → resolves user; **deactivate user (`is_active=0`) then validate → null**; `revokeSession` → null next; `revokeAllForUser` → null; expired (now>expires_at) → null. (Seed a user row directly.)
- [ ] Steps 2–5.

### Task C3: CSRF (HMAC, session-bound) + guards

**Files:** Create `server/src/auth/csrf.ts`, `server/src/auth/guards.ts`, tests.
**Produces:** `issueCsrf(sessionToken):string`, `verifyCsrf(sessionToken, csrf):boolean` (HMAC with `CSRF_SECRET`). Guards are Fastify preHandlers: `requireAuth` (reads session cookie via `validateSession`, sets `req.user`, enforces CSRF header on non-GET), `requireAdmin` (requireAuth + role==='admin').

- [ ] Tests: `verifyCsrf` accepts a token it issued for the same session, rejects one for a different session; forged token rejected. (Guard wiring is covered by integration tests in Phase J.) TDD, commit.

---

## Phase D — Storage & quota

### Task D1: Blob storage (streamed, temp→rename)

**Files:** Create `server/src/storage/blobs.ts`, tests.
**Produces:**

```
blobPathFor(ownerId, nodeId): string          // <STORAGE_DIR>/<ownerId>/<nodeId>
writeStreamToTemp(ownerId, stream, limitBytes): Promise<{tempPath, bytes}>  // aborts >limit
commitTemp(tempPath, ownerId, nodeId): string // rename into final path (same fs), returns relative storage_path
readBlob(storagePath): ReadStream
deleteBlob(storagePath): void                 // idempotent (missing = ok)
```

- [ ] Tests: write a 10-byte stream → temp has 10 bytes; a stream exceeding `limitBytes` → rejects and temp is cleaned; `commitTemp` moves file and path resolves under STORAGE_DIR (no traversal); `deleteBlob` on a missing file does not throw. TDD, commit.

### Task D2: Quota reserve/commit

**Files:** Create `server/src/storage/quota.ts`, tests.
**Produces:** `reserve(db,userId,bytes,now): boolean` (atomically bumps `used_bytes` iff `quota_bytes IS NULL OR used_bytes+bytes<=quota_bytes`), `commitActual(db,userId,reserved,actual)`, `release(db,userId,reserved)`, `subtract(db,userId,bytes)`.

- [ ] Tests: reserve within quota → true + counter rises; reserve over quota → false + counter unchanged; NULL quota → always true; commitActual adjusts delta; release restores. TDD, commit.

---

## Phase E — Nodes (tree)

### Task E1: Roots + create + list

**Files:** Create `server/src/nodes/tree.ts`, tests.
**Produces:**

```
ensureUserRoots(db,userId,now): {rootId, trashId}   // create synthetic 'root'+'trash' if absent (idempotent)
createFolder(db,ownerId,parentId,name,now): node
listChildren(db,ownerId,parentId): node[]           // trashed_at IS NULL only
rollupSize(db,nodeId): number                        // recursive sum of descendant file bytes (CTE)
```

- [ ] Tests: `ensureUserRoots` twice → same ids; create folder under root; list shows it; duplicate live name → throws (mapped later); rollup sums nested files. TDD, commit.

### Task E2: Rename & move with cycle guard

**Files:** Modify `server/src/nodes/tree.ts`; add `server/src/nodes/collisions.ts`; tests.
**Produces:** `isAncestor(db,maybeAncestorId,nodeId):boolean` (walk up via recursive CTE); `moveNode(db,ownerId,nodeId,newParentId,now)` throws `CycleError` if `nodeId===newParentId` or `isAncestor(nodeId,newParentId)`, throws `CollisionError` on live-name clash; `renameNode(...)` same collision check. `collisions.ts`: `mapDbError(e): {http:number,code:string}` (SQLite UNIQUE → 409 `name_conflict`) and `nextSuffixedName(db,parentId,base)`.

- [ ] **Step 1 (tests):** move folder into itself → `CycleError`; into its own child → `CycleError`; into a sibling → OK; move onto an occupied name → `CollisionError`; `nextSuffixedName` returns `x (1)` then `x (2)`.
- [ ] Steps 2–5.

### Task E3: Trash subtree / restore / permanent delete

**Files:** Create `server/src/nodes/trash.ts`, tests.
**Produces:**

```
trashNode(db,ownerId,nodeId,now)         // stamp subtree trashed_at, capture original_parent_id on the top node, 410 its shares (is_active kept but gate excludes trashed), set purge_after=NULL (manual)
restoreNode(db,ownerId,nodeId,now)       // clear trashed_at on subtree; on live-name collision auto-suffix top node
permanentDelete(db,ownerId,nodeId): {freedBytes, storagePaths[]}  // txn deletes rows (shares→children→node); returns blob paths to unlink AFTER commit; decrement used_bytes
```

- [ ] Tests: trash a folder → whole subtree `trashed_at` set, name freed (can re-create same name live), re-trash same name OK; restore → reappears; restore into occupied name → auto-suffixed; permanentDelete returns all descendant storage paths and zero rows remain (FK cascade verified); used_bytes decremented. TDD, commit.

---

## Phase F — Shares

### Task F1: Create / toggle / expire / revoke

**Files:** Create `server/src/shares/shares.ts`, tests.
**Produces:** `createShare(db,ownerId,nodeId,{password?,expiresAt?},now):share`; `setShareState(db,ownerId,shareId,{isActive?,password?|null,expiresAt?|null})`; `revokeShare(db,ownerId,shareId)`; `ownerStatus(share,now): 'active'|'stopped'|'expired'`.

- [ ] Tests: create → token length ≥ 43 chars, is_active=1; setState toggles; password set hashes (verify), clear nulls it; ownerStatus: is_active=0→stopped, expires_at<now→expired, else active; revoke removes row. TDD, commit.

### Task F2: Canonical subtree resolver + request-time gate

**Files:** Create `server/src/shares/resolver.ts`, `server/src/shares/gate.ts`, tests.
**Produces:**

```
isShareLive(db, share, now): {live:boolean, reason:'ok'|'stopped'|'expired'|'gone'}
   // is_active AND (expires_at null|>now) AND node exists AND not trashed AND (auto_delete_at null|>now)
resolveInSubtree(db, share, requestedNodeId): node
   // walk parent_id up from requestedNodeId; require share.node_id as ancestor AND same owner AND not trashed; else throw ForbiddenError
listPublic(db, share, folderId): node[]   // uses resolveInSubtree; trashed excluded
```

- [ ] **Step 1 (tests):** file share of node X: `resolveInSubtree(X)` OK; a sibling id outside subtree → `ForbiddenError`; folder share of F: descendant OK, node moved out of F afterward → Forbidden, `../`/absolute nonsense id → Forbidden; `isShareLive`: active→ok, is_active=0→stopped, past expiry→expired, node trashed→gone, past auto_delete→gone.
- [ ] Steps 2–5.

---

## Phase G — Scheduler

### Task G1: Pure selectors

**Files:** Create `server/src/scheduler/selectors.ts`, tests.
**Produces:** `dueTrash(db,now,limit): node[]` (auto_delete_at≤now AND trashed_at IS NULL); `duePurge(db,now,limit): node[]` (purge_after≤now); `orphanBlobs(db, storageDir): string[]` (blob files with no node row).

- [ ] Tests with seeded rows + fixed `now`: only due items selected, respects limit; purge selects only past `purge_after`. TDD, commit.

### Task G2: Reentrant runner (batched, unlink-after-commit)

**Files:** Create `server/src/scheduler/runner.ts`, tests.
**Produces:** `runTick(db, now): {trashed, purged}` — for each `dueTrash`: `trashNode`+set `purge_after=now+GRACE_MS`; for each `duePurge`: `permanentDelete` then unlink returned blobs (post-commit); a module-level `running` lock; `startScheduler(db, clock, intervalMs=60000)` / `stopScheduler()`.

- [ ] **Step 1 (tests):** seed a node with `auto_delete_at=now-1` → `runTick` trashes it and sets `purge_after`; seed one with `purge_after=now-1` → `runTick` deletes rows AND removes the blob file; **reentrancy:** call `runTick` twice "simultaneously" over the same due set (invoke the internal locked wrapper) → exactly one deletion, no error; **crash-after-commit sim:** delete rows but leave a blob, then `orphanBlobs`+GC removes it.
- [ ] Steps 2–5.

---

## Phase H — HTTP routes (integration-tested via `app.inject`)

### Task H1: App bootstrap + health + static + security headers

**Files:** Create `server/src/app.ts` (`buildApp(deps)`: registers helmet with CSP self-only + no unsafe-inline scripts + `frame-ancestors none`, `@fastify/cookie`, `@fastify/multipart` `{limits:{fileSize:MAX_FILE_BYTES}}`, `@fastify/static` serving `web/dist`, `trustProxy:true`, route plugins), `server/src/routes/health.ts`, `server/src/audit.ts`, tests.

- [ ] Tests: `app.inject GET /api/health` → 200 `{ok:true}`; response carries `x-content-type-options: nosniff` and a CSP header; unknown `/api/x` → 404. TDD, commit.

### Task H2: Auth routes + login rate-limit

**Files:** Create `server/src/routes/auth.ts`, tests.
Routes: `POST /api/auth/login` (zod body; `@fastify/rate-limit` keyed by `username+ip`, lockout after N; audit failures; sets session cookie httpOnly+Secure+SameSite=Lax + CSRF cookie), `logout`, `logout-all`, `GET /me`, `POST /password`.

- [ ] **Tests (inject):** login with seeded admin → 200 + `set-cookie`; bad password → 401; inactive user → 401; `/me` with cookie → user; `/me` without → 401; **rate limit:** N+1 rapid bad logins → 429; **mid-flight revocation:** login → deactivate the user via DB → next authed request → 401; change password keeps the current session but `revokeAllForUser` others. TDD, commit.

### Task H3: Nodes routes (list/folder/upload/rename/move/trash/restore/delete/auto-delete/download)

**Files:** Create `server/src/routes/nodes.ts`, tests.
Key points: upload streams via multipart → `reserve`→`writeStreamToTemp`→create node→`commitTemp`→`commitActual`; download sets `Content-Disposition` via `rfc6266` + `nosniff`, streams `readBlob`; all handlers `requireAuth` + owner-scope; `mapDbError` → 409 on collisions; auto-delete rejects a past timestamp.

- [ ] **Tests (inject):** create folder; upload a small file (multipart) → node appears + used_bytes rises; **cross-user isolation:** user B `GET /api/nodes/:idOfA` → 404, download A's node → 404, patch/delete → 404; move into descendant → 409 cycle; duplicate upload name → auto-suffixed 200; trash→list excludes→restore; permanent delete → blob gone; download of an Arabic-named file → `content-disposition` has `filename*=UTF-8''` and no raw CR/LF; auto-delete with past date → 400. TDD, commit.

### Task H4: Shares routes + public routes

**Files:** Create `server/src/routes/shares.ts`, `server/src/routes/public.ts`, tests.
Public: `GET /api/public/:token` → gate; if password and no unlock cookie → 401 `{needsPassword:true}` and **no** metadata; `POST /unlock` (rate-limited per-ip AND per-token global; argon2 via semaphore) → scoped short-lived cookie; `GET /list`,`/download`,`/zip` via `resolveInSubtree`; all `/s|/api/public` responses set `Referrer-Policy: no-referrer`; `share_access_log` on download.

- [ ] **Tests (inject):** create file share → public meta → download bytes match; folder share → list subtree, download a descendant, **sibling/out-of-subtree id → 403**, moved-out node → 403; password share: pre-unlock reveals no name/size; wrong pw → 401 then lockout 429; right pw → cookie → download; stop sharing → 410 stopped; set `expires_at` in the past → 410 expired even before a tick; revoke → 404; zip streams a subtree. TDD, commit.

### Task H5: Admin routes + last-admin guard + metadata-only browse

**Files:** Create `server/src/routes/admin.ts`, tests.
Routes per spec §7; `PATCH/DELETE` enforce **last-admin guard** (≥1 active admin; no self-deactivate/delete) → 409; deactivate/reset → `revokeAllForUser`; `GET /users/:id/nodes` returns **metadata only** (no storage_path, no download route exists for admin); every admin action audited.

- [ ] **Tests (inject):** admin creates user (must_change_password=1) → that user can login + is forced to change; admin lists users/usage; deactivate last admin → 409; admin self-delete → 409; admin `GET /users/:id/nodes` returns names/sizes but there is **no** admin content/download endpoint; audit rows written. TDD, commit.

### Task H6: Seed + index bootstrap

**Files:** Create `server/src/seed.ts` (`ensureAdmin`: if no admin, create `admin` with a random password, `must_change_password=1`, write credential to `${DB_DIR}/../admin-credential.txt` mode 0600, log only "admin seeded"), `server/src/index.ts` (migrate → ensureUserRoots for admin → ensureAdmin → startScheduler → listen 127.0.0.1:8084), test for `ensureAdmin` idempotency.

- [ ] Tests: `ensureAdmin` on empty DB creates one admin + writes 0600 file; second call is a no-op (no second admin, file not overwritten). TDD, commit.

---

## Phase I — Frontend foundation

### Task I1: Vite + Tailwind + tokens + fonts + RTL shell

**Files:** Create `web/` scaffold, `web/index.html` (`<html dir="rtl" lang="ar">`), `web/src/styles/tokens.css` (all §4.1 tokens light+dark via `prefers-color-scheme` + `:root[data-theme]`, `--focus` ring), Tailwind config mapping tokens, self-hosted `@font-face` for the three families, `web/src/main.tsx`, a smoke component.

- [ ] **Steps:** scaffold; add fonts; `npm run build` (detached) produces `web/dist`; a Vitest/RTL render test asserts the root has `dir="rtl"` and a token CSS var resolves. Commit. (Aesthetics per frontend-design skill during component tasks.)

### Task I2: i18n (ar/en) + api client + auth context + router

**Files:** Create `web/src/i18n/*`, `web/src/lib/api.ts` (fetch with `credentials:'include'`, injects CSRF header from cookie, throws typed errors), `web/src/app/router.tsx` (routes: `/login`, `/` dashboard, `/admin`, `/trash`, `/shared`, `/s/:token`), `web/src/features/auth/*` (login page + guard + force-password-change).

- [ ] Tests: api client attaches CSRF header on POST; login form validates; unauthorized redirect to `/login`. Commit.

---

## Phase J — Frontend features (frontend-design skill governs visuals; build to the §4 identity)

> For each of J1–J4: brainstorm the component's visual per the frontend-design plan (Ink & Brass, dispatch register, brass seal), build, self-critique against the contrast contract + RTL + reduced-motion, commit. Include component render tests where logic exists (status derivation, disabled states).

### Task J1: Design-system primitives

**Files:** `web/src/components/` — `Seal` (badge 18px + dispatch 72px, `--brass-ring`, Kufic م monogram, stamp motion + reduced-motion fallback), `StatusChip` (active/stopped/expired/shared — color **+ label + icon**, never color-only), `Icon` set (dossier folder, seal-send, stamp, hourglass, calendar-stamp), `Button` (primary = brass fill + ink label), `Modal`, `Drawer` (inline-end), `Toast`.

- [ ] Render tests: StatusChip shows the right label+icon per status; Button primary uses brass-ink; Seal respects reduced-motion (no animation attr when `matchMedia` reduced). Commit.

### Task J2: Dashboard (Drive-like "dispatch register")

**Files:** `web/src/features/dashboard/` — `DriveView` (nav rail inline-start, breadcrumb, register-style list: mono size/date columns via `<bdi>`, stamp/status column), `UploadDrop` (drag-drop + picker, ≤100MB client check + progress), folder create/rename/move, `TrashView`, storage meter (used/quota + trash size).

- [ ] Wire to API via TanStack Query; render test: >100MB file shows the authored error; list renders Arabic names RTL with mono sizes LTR-isolated. Commit.

### Task J3: Share + auto-delete controls

**Files:** `ShareModal` (create/copy link, active toggle, optional password, expiry picker → Damascus→UTC, status chip, revoke), `AutoDeleteMenu` (set/clear future date, warning copy).

- [ ] Render tests: expiry picker rejects past datetime; owner status chip matches state; auto-delete warns before enabling. Commit.

### Task J4: Admin panel

**Files:** `UsersTable` (usage bars), `CreateUserModal` (generated password reveal-once), `SharesTable` (force-revoke), `AuditLog`. Last-admin actions disabled with a tooltip.

- [ ] Render tests: create-user validates; deactivate-last-admin control disabled. Commit.

### Task J5: Public sealed-dispatch page (bilingual)

**Files:** `web/src/features/public/` — `SealedDispatch` (file: 72px seal, "وصلك ملف عبر مِرسال / A file was sent to you via Mirsal", **Download primary**, "valid until" stamp if expiry), `PublicFolder` (read-only browse + per-file + Download-all-ZIP), `PasswordGate` (attempts-remaining), AR/EN toggle that flips `dir` to LTR for EN; distinct 404 / 410-stopped / 410-expired screens with authored copy.

- [ ] Render tests: EN toggle sets `dir=ltr`; 410-stopped vs 410-expired show different copy; Download is the visually primary action. Commit.

---

## Phase K — Package, deploy, launch

### Task K1: Dockerfile + compose

**Files:** Create `Dockerfile` (builder `node:20-slim`: install server prod deps incl. better-sqlite3 prebuilt + build web with `--max-old-space-size=768`; runtime identical base, `USER` pinned uid, copy `server` build + `web/dist`, expose 8084), `docker-compose.yml` (`127.0.0.1:8084:8084`, `restart:unless-stopped`, `logging json-file max-size=10m max-file=3`, bind `./data`, env from `.env`), `.dockerignore`.

- [ ] Build **on host node** or `docker build --memory=1g --memory-swap=2g` (detached, tee log); `docker compose up -d`; `curl 127.0.0.1:8084/api/health` → 200. Commit.

### Task K2: nginx vhost + cert + local chain

**Files:** Create `deploy/nginx-mirsal.conf` (server_name project4; 80+443 single block; reuse project4 cert; `client_max_body_size 120M`; `location /api/nodes/upload { proxy_request_buffering off; client_body_timeout 300s; }`; set `X-Forwarded-Proto https`,`-For`,`-Host`; **no** redirect), `deploy/install.md`.

- [ ] Symlink into sites-enabled (only mirsal for project4; `nginx -T | grep project4` shows no dup); `nginx -t` (run; do not disable other vhosts' certs); `systemctl reload nginx`; `curl --resolve project4.system.mow.gov.sy:443:127.0.0.1 https://…/api/health` → 200 and any returned URL is `https://`. Commit.

### Task K3: Backups + runbook + launch verification

**Files:** Create `deploy/backup-mirsal.sh` (docker exec → better-sqlite3 `.backup` to a dump; snapshot storage first then DB; `rclone` dump → B2 `b2backup:…/mirsal/`; keep 1–2 local; restore-test note), `docs/RUNBOOK.md`, add a cron line (02:40).

- [ ] Run the E2E smoke script (`deploy/smoke.sh`: login→change pw→folder→upload→share→public download→zip→stop→410) against the live container; run one backup + a restore into a scratch DB; **launch gate**: unit+integration+E2E green + local chain 200. Commit; merge `feat/mvp-build` → `main`.

---

## Self-Review (spec coverage)

- Admin creates users, quotas, usage, audit, force-revoke → H5, J4. **Admin metadata-only** → H5 (no content endpoint).
- Drive dashboard: folders/files/upload/download/rename/move/trash → E1–E3, H3, J2.
- Share file OR folder; start/stop; password; expiry; ZIP → F1–F2, H4, J3, J5.
- Auto-delete DATE (→trash+7d grace) vs manual delete → E3, G1–G2, H3.
- Scheduled auto-STOP-sharing + request-time gate → F2, G1–G2, H4.
- Sessions revocable → C2, H2. Public folder IDOR closed → F2, H4. Tree bugs (root/trash/cycle/cascade/orphan) → B2, E2, E3, G2. WCAG brass + RTL logical + bidi → Global Constraints, I1, J1. Streamed upload + quota → D1–D2, H3. RFC-6266 → H3. Rate-limit login + unlock → H2, H4. Memory-safe build + off-box backup + disconnect-resilient + vhost hygiene → K1–K3.

All spec sections map to a task. No placeholders remain; interface names are consistent across tasks (`validateSession`, `resolveInSubtree`, `isShareLive`, `permanentDelete`, `reserve/commitActual`, `mapDbError`).

```

```
