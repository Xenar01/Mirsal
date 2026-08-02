# Design Spec — Collections (طلب تجميع): distribute one file, collect many responses

- **Date:** 2026-08-02
- **Status:** Awaiting user review of this spec (design approved in brainstorming)
- **Scope:** Mirsal (`/var/www/projects/mirsal`), feature branch `feat/collections`
- **Author:** Claude (VPS), with user

## 1. Goal

Today Mirsal is **one-way**: a share-link recipient can only *download*. A user asked for the reverse — **send one file out to a known set of people and collect a filled-in response back from each of them**. The concrete case: an owner runs data collection across **~30 departments**; every department receives the **same template file**, fills it, and uploads its response; the owner watches all responses arrive in one place, attributed by department, and can see who has **not** responded yet.

This introduces a new first-class feature, **Collections (طلب تجميع)** — a "file request / intake" flow that is the inbound mirror of the existing outbound Share. It is Mirsal's **first inbound-write capability** (§9 covers the security consequences).

## 2. Locked decisions (from brainstorming with the user)

1. **One shared link**, not per-recipient links. The owner distributes a single `/c/<token>` URL to all departments. *(Rationale: per-department links mean sending 30 links and risking sending the wrong one to the wrong person.)*
2. **Uploader self-identifies from a predefined list.** The owner enters the department names once at creation; each uploader **picks their department from a dropdown**. This yields clean attribution (no typos/dupes) and enables the **responded / still-missing roster** — the payoff of collecting from a *known* set.
3. **A response is a set of 1..N files** (not a single file). Departments sometimes send 2–3 documents together; the uploader can select up to a capped number (`COLLECTION_MAX_FILES_PER_RESPONSE`, default **10**) and upload them in one submission, plus an optional note.
4. **Latest replaces.** If a department submits again, the **new set of files replaces its previous set entirely** (previous files removed, quota reclaimed). Each department has exactly one current response slot; corrections are a re-submit.
5. **Template attached, freely re-downloadable.** The collection carries an optional template file; recipients can download it any number of times (not burn-after-download).
6. **Optional short note** per response.
7. **Lifecycle:** owner can **open/close** the collection at will, and optionally set a **deadline** after which the link auto-closes. Liveness is computed at request time (like share `expires_at`), so **no scheduler change is needed**.
8. **Optional password** on the collection link (same mechanism as shares).
9. **Privacy (non-negotiable):** an uploader only ever sees the title, the template to download, the department picker, and *their own* upload form + confirmation. They can **never** see other departments' responses or who has/hasn't responded.
10. **No email/SMS notifications in v1** (Mirsal has no mail infrastructure). The owner sees the live "X / N" count on the dashboard.
11. **Responses live in the owner's Drive and count against the owner's quota.** A large collection needs sufficient quota assigned to the owner.

## 3. Background — the existing model this reuses (verified in code)

- **`nodes`** (`schema.sql`) — tree of `kind IN ('root','trash','folder','file')`; files carry `storage_path` (`ownerId/nodeId`) and `size_bytes`; folders roll up size on read. Live-namespace uniqueness via `ux_live_name(parent_id, name) WHERE trashed_at IS NULL AND parent_id IS NOT NULL`. **Collection responses are stored as ordinary file nodes** under owner-owned folders → reuses upload, download (`/api/nodes/:id/download`), folder ZIP (`/api/nodes/:id/zip`), trash, and rollup unchanged.
- **Blobs** (`storage/blobs.ts`) — `writeStreamToTemp(ownerId, stream, limitBytes) → {tempPath, bytes}` (streamed, aborts past `limitBytes`, cleans up), then `commitTemp(tempPath, ownerId, nodeId) → "ownerId/nodeId"`. `deleteBlob`, `readBlob` are traversal-safe. A **single shared `BlobStore` instance** is wired in `app.ts` (Phase-2 change) — collection routes use that same instance.
- **Quota** (`storage/quota.ts`) — `reserve(db, ownerId, bytes, now)` (atomic, `WHERE quota_bytes IS NULL OR used+bytes<=quota`), `commitActual`, `release`, `subtract`. Keyed on the **owner** — the collection owner is the quota target even though the uploader is anonymous.
- **Shares public routes** (`routes/public.ts`) — the reference for **unauthenticated, token-addressed, per-IP + per-token rate-limited** endpoints with an **anti-oracle** stance (unknown token and rejection are constant-shape; a `no-store` Cache-Control header on all public responses). The `/download` form POST also taught the **`application/x-www-form-urlencoded` parser** lesson (415 bug) — the submit endpoint here is `multipart/form-data`, handled by the already-registered `@fastify/multipart`.
- **Share password/unlock** (`shares/gate.ts`) — HMAC unlock cookie, `SameSite=Lax`, per-IP + per-token limited `/unlock`. The collection password gate mirrors this.
- **SPA delivery** (`app.ts`) — the built SPA is served at `/s/*` with `Referrer-Policy: no-referrer`. The public collect page adds the same shell at `/c/*`.
- **Migration** (`db/migrate.ts`) — incremental versioned runner, `LATEST_VERSION = 3`, ordered `STEPS`, fresh-detection by probing `sqlite_master` for `shares`. Adding tables is a new `{version:4, up}` step (§5).
- **i18n** (`web/src/i18n`) — the authenticated app is **Arabic-only** (creator/owner keys in `ar.json` only); **only public pages are bilingual** (keys in both `ar.json` and `en.json`).
- **Audit** (`audit_log`) — `actor_id` nullable (survives user deletion / system actions), `action`, `target`, `detail` (JSON string).

## 4. User-facing behavior

### 4.1 Owner — create a collection
Fields: **title**, optional **template file** (pick an existing file from the owner's Drive, or upload one), the **department list** (paste/enter names; deduped; order preserved), optional **password**, optional **deadline**. On save, Mirsal:
- creates a folder `طلب تجميع: <title>` in the owner's Drive (`collections.folder_node_id`),
- generates a 32-byte URL-safe **token**, and
- returns the shareable link `PUBLIC_BASE_URL + /c/<token>`.

### 4.2 Owner — collection dashboard (the roster)
A collection detail view shows:
- **X / N responded** headline.
- **Responded** list: each department with its **file count**, submitted time, and note; actions = download a single file, **download that department's set as a ZIP** (reuses folder `/zip`), or **download the whole collection as one ZIP**.
- **Missing** list: departments with no response yet — the chase list.
- Controls: **edit the department list** (add always; **remove only a department with no response yet** — never orphan stored files), **close / reopen**, edit deadline/password, **delete the collection** (removes the collection, its departments, response rows, and the Drive folder + blobs).

### 4.3 Uploader — public page `/c/<token>`
Neutral, bilingual page: collection **title**, a **Download template** button (if a template is attached), a **department dropdown** (required), a **file picker accepting 1..N files** (client hint: up to the cap; each ≤ 100 MB), an **optional note**, and **Upload response**. On success → a simple "received, thank you" confirmation; re-visiting and re-uploading replaces the department's set (decision 4). If the collection is password-protected, a password gate precedes the form (mirrors the share unlock). A **closed/expired** link shows a neutral "this collection is closed" page. The uploader **never** sees other responses or the roster.

## 5. Data model

Three new tables (all `CREATE TABLE IF NOT EXISTS`, added to `schema.sql` for fresh DBs **and** created by the v4 migration step for existing DBs). No changes to existing tables.

**`collections`**
| Column | Type | Meaning |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY` | |
| `owner_id` | `INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE` | creator/owner (quota + audit subject) |
| `token` | `TEXT UNIQUE NOT NULL` | 32-byte CSPRNG, URL-safe (same generator as `shares.token`) |
| `title` | `TEXT NOT NULL` | shown to owner + uploaders |
| `template_node_id` | `INTEGER REFERENCES nodes(id) ON DELETE SET NULL` | NULL = no template |
| `folder_node_id` | `INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE` | the collection's response folder in the owner's tree |
| `password_hash` | `TEXT` | NULL = no password (argon2id, same service as shares) |
| `is_active` | `INTEGER NOT NULL DEFAULT 1` | owner open/close toggle |
| `deadline_at` | `INTEGER` | NULL = no deadline; `deadline_at <= now` ⇒ closed (request-time) |
| `created_at` | `INTEGER NOT NULL` | epoch-ms |
| `updated_at` | `INTEGER NOT NULL` | epoch-ms |

**`collection_departments`**
| Column | Type | Meaning |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY` | |
| `collection_id` | `INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE` | |
| `name` | `TEXT NOT NULL` | department label (Arabic or English) |
| `position` | `INTEGER NOT NULL DEFAULT 0` | display order |
| `created_at` | `INTEGER NOT NULL` | |

`UNIQUE(collection_id, name)` — the roster is a set of distinct names.

**`collection_responses`**
| Column | Type | Meaning |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY` | |
| `collection_id` | `INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE` | |
| `department_id` | `INTEGER NOT NULL REFERENCES collection_departments(id) ON DELETE CASCADE` | which department |
| `folder_node_id` | `INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE` | the department's response subfolder (holds its 1..N file nodes) |
| `note` | `TEXT` | optional uploader note |
| `submitted_at` | `INTEGER NOT NULL` | epoch-ms of the latest (current) submission |
| `submitted_ip` | `TEXT` | best-effort client IP for audit |

`UNIQUE(collection_id, department_id)` — **one current response per department** (latest-replaces updates this row and swaps its folder's contents). Indexes: `ix_collections_owner(owner_id)`, `ix_collection_responses_collection(collection_id)`.

**Drive tree layout for a collection:**
```
<owner root>
  └── طلب تجميع: <title>            (collections.folder_node_id, kind=folder)
        ├── <Department A>          (collection_responses.folder_node_id, kind=folder)
        │     ├── report.xlsx       (kind=file)
        │     └── annex.pdf
        └── <Department B>
              └── form.docx
```
Per-department subfolders avoid cross-department filename collisions and make "download this department's set" a plain folder ZIP. Within one submission, duplicate filenames are de-duplicated with the existing `nodes/collisions.ts` helper.

## 6. Migration (v3 → v4)

- Bump `LATEST_VERSION = 4`. Add one ordered step `{ version: 4, up(db) }` that runs the three `CREATE TABLE IF NOT EXISTS` statements + indexes (one `db.exec`, inside the step's transaction).
- Add the identical DDL to `schema.sql` so a **fresh** DB gets the tables and records `version = 4`.
- Fresh-detection is unchanged (probe `sqlite_master` for `shares`).
- **Zero data-loss risk:** the step only *creates new tables* — it never alters or drops anything. The live production DB is at `schema_version = 3`; on deploy it runs exactly the v4 create step.
- **Convergence test** (§11): a fresh DB and a `v3`-then-migrated DB produce identical `sqlite_master` for the three new tables; idempotent re-run; `schema_version` records 4.
- **Pre-deploy DB snapshot required** (it is a migration) via `deploy/backup-mirsal.sh`.

## 7. API surface

### 7.1 Owner routes (authenticated: `requireAuth` + CSRF, owner-scoped)
- `POST /api/collections` — create `{ title, templateNodeId?, departments: string[], password?, deadlineAt? }` → `{ id, token, url }`. Validates: title non-empty; ≥1 department; departments deduped/trimmed/length-capped; template (if given) is an owner-owned live **file** node; `deadlineAt` (if given) is in the future.
- `GET /api/collections` — list the owner's collections with summary counts (`departmentCount`, `respondedCount`, `is_active`, `deadline_at`).
- `GET /api/collections/:id` — detail: collection fields + department roster, each annotated with `responded` (bool), file count, `submitted_at`, `note`, and the `folder_node_id` (so the UI can wire downloads via the existing node routes).
- `PATCH /api/collections/:id` — update `{ title?, password?, deadlineAt?, isActive? }` (owner-scoped; `404` for missing/foreign — no oracle). Clearing password/deadline via explicit `null`.
- `POST /api/collections/:id/departments` — add `{ name }` (dedup 409).
- `DELETE /api/collections/:id/departments/:deptId` — remove; **409 if that department already has a response** (never orphan files).
- `DELETE /api/collections/:id` — delete collection (cascade rows + remove the Drive folder, blobs, quota reclaimed).
- **Downloads reuse existing node routes** (`/api/nodes/:id/download`, `/api/nodes/:id/zip`) against the response folder ids — no new download code.

### 7.2 Public routes (unauthenticated, token-addressed, rate-limited, `Cache-Control: no-store`)
- `GET /api/collect/:token` — **meta**: `{ title, hasTemplate, templateName?, departments: [{id, name}], needsPassword, isOpen }`. **Reveals department names** (needed for the dropdown) but **never** which have responded, nor owner identity/quota. A closed/expired/unknown collection returns a neutral closed/`404` shape.
- `POST /api/collect/:token/unlock` — password unlock (only when `needsPassword`); mirrors share `/unlock` (per-IP + per-token limit, HMAC `SameSite=Lax` cookie).
- `GET /api/collect/:token/template` — stream the template file (uncounted, unlimited); `404` if none/closed.
- `POST /api/collect/:token/submit` — **the inbound write** (`multipart/form-data`): fields `departmentId`, optional `note`, and 1..N file parts. Enforces §8. Returns a neutral success; errors are constant-shape (§9).

## 8. Submit flow (`POST /api/collect/:token/submit`)

1. **Gate:** load collection by token → must be **open** (`is_active = 1` AND (`deadline_at IS NULL` OR `deadline_at > now`)); if password-protected, require a valid unlock cookie (else `401 {needsPassword}`); unknown/closed → neutral reject. All rejects share a constant shape (no existence oracle).
2. **Validate `departmentId`** belongs to this collection (else constant-shape reject).
3. **Count guard:** reject if the multipart carries `0` files or `> COLLECTION_MAX_FILES_PER_RESPONSE`.
4. **Per-file streaming, into the owner's quota** — for each file part, in order:
   - `writeStreamToTemp(ownerId, part, MAX_FILE_BYTES)` (aborts past 100 MB → reject + cleanup).
   - `reserve(db, ownerId, bytes, now)` — **quota exceeded ⇒ reject the whole submission**, release everything already reserved, unlink temps (no partial response stored).
   - create the file node (row-first) under the department's response subfolder, `commitTemp`, `commitActual`.
5. **Latest-replaces swap (transactional):** ensure the department's response subfolder exists (create under `collections.folder_node_id` on first submission). If a prior response exists, **permanently delete its previous file set** (blob unlink + `subtract` quota) as part of committing the new set, then `INSERT OR REPLACE` the `collection_responses` row (`folder_node_id`, `note`, `submitted_at`, `submitted_ip`). *(Immediate hard-delete of the superseded set — not Trash — keeps quota honest and matches Mirsal's transient-files ethos.)*
6. **Audit:** `collection_response_submitted`, `actor_id = NULL`, detail `{ collection_id, department_id, department_name, file_count }`, plus the IP.
7. **Response:** neutral success. Concurrency on the same department is serialized by SQLite's writer lock + the `UNIQUE(collection_id, department_id)` constraint; a rare loser retries.

## 9. Security — the new inbound-write surface (stated plainly)

This is the **first time Mirsal lets an outsider *write***; every existing public route is read-only. Consequences and mitigations (all reuse existing tools):

- **Storage/DoS ceiling:** an attacker holding the link could fill the owner's quota. Bounds: each file ≤ **100 MB** (`MAX_FILE_BYTES`, streamed-abort), ≤ **10 files/response** (`COLLECTION_MAX_FILES_PER_RESPONSE`), one slot per department with **latest-replaces**, and hard-stopped by the **owner's quota** (`reserve` rejects). So the maximum resident bytes for a collection is bounded by `departments × 10 × 100 MB` **and** by the owner's quota — whichever is smaller. Recommend owners set a realistic quota.
- **Per-IP rate-limiting** on `/collect/:token/*` (reuse `@fastify/rate-limit`), tighter on `submit` than on reads, keyed on the real client IP (nginx `real_ip` is already enabled on the project4 vhost → `req.ip` is the true client, not the gateway).
- **Impersonation — the accepted trade-off (decision 1/2):** with one shared link + self-identification, anyone with the link can pick *any* department (or submit garbage as "Finance"). Per-department links would prevent this but were rejected (link-management burden). The **optional password** is the primary lever to limit who can reach the form; the roster shows exactly what was submitted, and the owner controls link distribution.
- **No CSRF token on the public submit** (the uploader has no account/session) — same stance as public download: protection is the unguessable token + rate-limit + optional password. The unlock cookie is `SameSite=Lax`, so a cross-site auto-POST can't carry it for password-protected collections.
- **Content-type:** submit requires `multipart/form-data` (via `@fastify/multipart`); other media types are rejected before the handler (the 415-lesson analog).
- **Anti-oracle:** unknown/closed/foreign token, wrong department, and rejections are **constant-shape**; meta never leaks response status or owner identity; all public responses carry `Cache-Control: no-store`.
- **Malware (accepted limitation):** uploaded files are stored as-is and never scanned (as with any file store). The owner downloads at their discretion. Out of scope to scan in v1; noted for the owner's awareness.
- **Traversal safety:** filenames from the uploader are sanitized (CR/LF/control-strip + length cap, as elsewhere) before becoming node names; blob paths are `ownerId/nodeId` (server-generated) — the uploader never influences a storage path.

## 10. Frontend

**Owner (Arabic-only, keys `collections.*` in `ar.json` only):** a new `web/src/features/collections/` area — a **Collections** nav entry, a **list** view, a **create** modal (title, template picker/upload, department entry, password, deadline), and a **detail/roster** view (responded/missing split, file counts, per-department + whole-collection ZIP download reusing node routes). New status/labels reuse the design system (Ink & Brass / Cairo); no new palette.

**Uploader (bilingual, keys `collect.*` in both `ar.json` and `en.json`):** a new `web/src/features/collect/` public page mounted at `/c/:token` — password gate → title, template download, **department `<select>`**, multi-file `<input type="file" multiple>`, optional note, **Upload** (multipart POST), confirmation; closed/expired state. Missing `en` keys would fall back to Arabic (a visible bug) → both locales required.

**Wiring:** `app.ts` serves the SPA at `/c/*` with `Referrer-Policy: no-referrer` and registers the new owner + public route plugins against the shared `blobStore`. Router adds `/c/:token` (public) and the owner collections routes under the authenticated app.

## 11. Testing strategy

**Server (`server/test`):**
- Migration: v3 DB gains the three tables; fresh DB has them; convergence (fresh vs upgraded `sqlite_master` identical); idempotent re-run; `schema_version` records 4.
- Collections model: create (dedup/trim/validate departments; template must be an owner file); list/detail counts; PATCH owner-scoped (`404` foreign, no oracle); department add (409 dup) / remove (409 if responded); delete cascades rows + folder + blobs + quota.
- Public meta: reveals department names + `needsPassword`/`isOpen`, **never** response status or owner; closed/expired/unknown → neutral.
- Submit happy paths: 1 file; 3 files; with note. Guards: 0 files rejected; >10 rejected; >100 MB streamed-abort; **over-quota rejects the whole submission with nothing stored** (temps unlinked, quota released). Latest-replaces: re-submit removes the prior set, reclaims quota, keeps one slot; `UNIQUE(collection_id, department_id)` holds. Password gate: submit without unlock → `401`; with unlock → OK. Audit row written with `actor_id = NULL`. Constant-shape rejects. Multipart content-type required.
- Rate-limit: submit is per-IP limited.

**Web (`web/test`):**
- Create modal (title/departments/template/password/deadline; validation). Roster (X/N, responded vs missing, file counts, download wiring). Public page (department dropdown from meta, template download, multi-file input, submit issues a multipart POST, confirmation, closed + password states, **both** ar/en labels present).

## 12. Rollout

- **Additive & backward-compatible:** three new tables, new routes, new UI; **no existing feature is modified** (Share/download/download-limit paths untouched → no regression risk).
- **Suggested build phasing** (each its own branch-phase, TDD, commit per step, **stop after each for user review + conversation clear** per the phase-pause workflow; merge to `main` only when green **and** the user confirms):
  1. **Data + owner API:** migration v4, `collections`/`departments`/`responses` models, owner CRUD routes, department management. (server-only)
  2. **Public intake:** `/c/*` SPA shell, public meta/unlock/template routes, the **submit** flow (§8) with all guards, audit, rate-limit.
  3. **Frontend:** owner Collections list + create modal + roster; public uploader page (bilingual); nav wiring.
  4. **Finish:** whole-collection ZIP polish, empty/closed states, E2E sweep (owner create → 30-name roster → uploader submit 1 & 3 files → latest-replaces → download-all-ZIP → close/deadline/password), RUNBOOK "Collections" note.
- **Deploy:** pre-deploy DB snapshot (migration), `docker compose build && up -d`, verify live `schema_version = 4` + the three tables, HTTPS chain 200 via `curl --resolve project4.system.mow.gov.sy:443:127.0.0.1`, headless-render the public `/c/<token>` page and the owner roster.

## 13. Non-goals (v1)

Per-department individual links · email/SMS notifications or any owner activity feed · response version history (replace-only; no keeping of superseded sets) · malware/AV scanning · per-collection storage cap beyond the owner's quota · automatic deletion of collected responses (owner manages the Drive folder) · CSV/export of the roster · in-browser preview of responses · multi-process deployment concerns.

## 14. Open copy (finalized during build, non-blocking)

Exact Arabic wording for the feature name and page labels (working: feature "التجميع", a collection "طلب تجميع", uploader page heading + "ارفع ردّك"). These are copy strings placed per §10's locale rules; the user can adjust wording at review or during the build without affecting the design.
