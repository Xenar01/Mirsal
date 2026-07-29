# Design Spec — Download Limit (Burn-After-Download) for File Shares

- **Date:** 2026-07-29
- **Status:** Approved for planning
- **Scope:** Mirsal (`/var/www/projects/mirsal`), feature branch `feat/download-limit`
- **Author:** Claude (VPS), with user

## 1. Goal

Let a share's creator cap how many times a **single file** can be downloaded (default **1**). When the cap is reached, the creator's chosen terminal action fires: either **stop the link** or **delete the file** (default). This delivers a "burn-after-download" workflow that matches the project's data-minimization intent (files are transient — shared, received, then gone), and composes with the existing lifecycle controls (share expiry, start/stop, password, and the file's auto-delete date).

## 2. Locked decisions (from brainstorming)

1. **Terminal action:** creator chooses per file — `stop` (link dies, file stays) or `delete` (file removed). **Default = `delete`.**
2. **Scope (v1):** single-**file** shares only. Folder shares are unchanged and get no cap yet.
3. **Delete depth:** on `delete`, the file goes to **Trash immediately** (link dies at once) and is **auto-purged after 24 hours** (recoverable until then), reusing the existing scheduler.

## 3. Background — the existing model (verified in code)

- **`shares`** — one share per node (the UI enforces one share per file/folder). Columns today: `token`, `password_hash`, `is_active`, `expires_at`, `allow_download`, `revoked_at`. Liveness is decided at request time by `isShareLive` (stopped / expired / gone).
- **`nodes`** — files/folders. `auto_delete_at` (the existing "scheduled deletion"), `trashed_at`, `original_parent_id`, `purge_after` (absolute epoch-ms hard-purge deadline).
- **Download endpoints** (`server/src/routes/public.ts`): `GET /api/public/:token/download` (one file) and `GET /api/public/:token/zip` (folder → zip). Both are unauthenticated, rate-limited per-IP and per-token, and call `logShareAccess`.
- **Scheduler** (`server/src/scheduler/runner.ts`): every 60s, `duePurge` selects any node with `purge_after <= now` and `permanentDelete`s it (row + blob unlink + orphan sweep). `trashNode` sets `purge_after = NULL`; the auto-trash path (`trashAndStampPurge`) trashes **then** stamps `purge_after`. **`restoreNode` explicitly clears `purge_after`** (trash.ts) — so a restored burn-file is never surprise-purged. ✅
- **Migration** (`server/src/db/migrate.ts`): **single-shot** — applies `schema.sql` once when `schema_version < SCHEMA_VERSION (=1)`, then never again. `schema.sql` is all `CREATE TABLE IF NOT EXISTS`, which does **not** add columns to an existing table. This must be upgraded (see §5).

## 4. Data model

Three additive columns on `shares`:

| Column | Type | Meaning |
|--------|------|---------|
| `download_limit` | `INTEGER` (nullable) | `NULL` = unlimited (unchanged behavior). `≥1` = capped. Default when the owner turns it on = `1`. |
| `download_count` | `INTEGER NOT NULL DEFAULT 0` | Completed downloads counted against the current limit. |
| `on_exhaust` | `TEXT NOT NULL DEFAULT 'delete' CHECK(on_exhaust IN ('stop','delete'))` | Terminal action; only meaningful when a limit is set. |

Canonical `schema.sql` gains these columns (fresh DBs get them directly). Existing DBs get them via the v2 migration (§5). Every existing share keeps `download_limit = NULL` → no behavior change.

## 5. Migration system upgrade (the gap)

`migrate.ts` becomes an **incremental versioned runner**:

- `LATEST_VERSION = 2`.
- An ordered list of steps: `[{ version: 2, up(db) { db.exec("ALTER TABLE shares ADD COLUMN download_limit INTEGER; ALTER TABLE shares ADD COLUMN download_count INTEGER NOT NULL DEFAULT 0; ALTER TABLE shares ADD COLUMN on_exhaust TEXT NOT NULL DEFAULT 'delete' CHECK(on_exhaust IN ('stop','delete'));") } }]`.
- `migrate(db)`:
  1. Ensure `schema_version` table.
  2. `current = MAX(version) ?? 0`.
  3. If `current === 0` (fresh DB): apply full `schema.sql` (already includes the new columns) and record `version = LATEST_VERSION`.
  4. Else: for each step with `current < step.version <= LATEST_VERSION`, run `step.up(db)` and insert its version row — **each step in its own transaction**.
  5. If `current >= LATEST_VERSION`: no-op.
- SQLite supports `ADD COLUMN` with `NOT NULL DEFAULT <constant>` and column `CHECK` — fresh and upgraded DBs end structurally identical.
- Idempotent and repeatable; safe to call on every boot.

## 6. Backend enforcement — `/api/public/:token/download`

Applies **only** when `share.download_limit !== null` (guaranteed a file share — §12). Unlimited shares and `/zip` are untouched.

The counter separates two things, which is what makes the terminal action fire at the right moment:
- **`download_count` (DB, durable)** — downloads that have **completed**. Incremented *only* on a completed delivery, guarded so it can never exceed the limit.
- **in-flight reservations (in-memory `Map<shareId, number>`, per process)** — downloads currently streaming. This bounds concurrency; it is ephemeral (starts empty each boot, so a crash can never strand a reservation).

**Single-process assumption:** Mirsal runs as one Node process in one container, so the in-memory map is authoritative for in-flight state. A multi-process deployment would need a shared store or sticky routing — out of scope for v1, noted as a constraint (§14).

**Request flow:**
1. Existing gates: `loadLiveShare` → `requireUnlocked` → `allow_download` → resolve node → must be a file with `storage_path`.
2. **Open the blob** (`waitForOpen`). `ENOENT` → `404`, nothing reserved.
3. **Reserve** (only if a limit is set) — one synchronous block, atomic by virtue of Node's single thread (no `await` between read and write):
   - read `download_count` for the share; `inflight = map.get(shareId) ?? 0`;
   - if `download_count + inflight >= download_limit` → close the stream, respond `410 gone`;
   - else `map.set(shareId, inflight + 1)`.
4. Set headers, `logShareAccess`, pipe the stream.
5. Wire `reply.raw.once('close', …)` (Fastify `onResponse` does **not** fire on a mid-stream abort — learned in `/zip`), guarded to run **at most once** per request:
   - **Release the reservation** on *both* outcomes: decrement the map entry (clamped at 0; delete the key at 0 to bound memory).
   - Then branch on `reply.raw.writableFinished`:
     - **completed** (`true`): `UPDATE shares SET download_count = download_count + 1 WHERE id=@id AND download_limit IS NOT NULL AND download_count < download_limit RETURNING download_count, download_limit`. If a row changed and `download_count === download_limit`, fire the terminal action (§7).
     - **aborted** (`false`): nothing else — `download_count` is untouched, so the link stays live and the recipient can retry (the freed reservation lets them).

**Why this shape:**
- `download_count` counts **only real deliveries**, so the terminal action fires exactly when the limit-th download *completes* — never prematurely because a concurrent download aborted (the bug the reserve-then-refund model had).
- The completion `UPDATE`'s `download_count < download_limit` guard is a hard backstop: even if in-flight bounding were ever imperfect (e.g. a burst right after boot), total *counted* completions can never exceed the limit, and the terminal fires exactly once.
- Firing the terminal action while another gated download is still streaming is safe: `delete` only trashes the row + sets a 24h `purge_after` (blob not unlinked for 24h; an open fd keeps streaming), and `stop` only flips `is_active` (already-gated streams finish).
- **Accepted trade-off:** the reservation map is per-process and reset on restart. In the rare event of a restart *during* several concurrent in-flight downloads of the same limited file, a download already streaming can deliver bytes the post-restart counter no longer bounds. The durable `download_count` guard still caps *counted* completions at the limit; only raw bytes already in flight are unaffected. Negligible for a single-process, low-traffic, typically limit-1 workload.

## 7. Terminal actions

A dedicated, unit-testable helper (`server/src/shares/exhaustion.ts`):

- **`stop`:** `UPDATE shares SET is_active = 0 WHERE id = @id`. Link → `410`. File untouched, reversible.
- **`delete`:** one transaction mirroring `trashAndStampPurge` (runner.ts): `trashNode(db, share.owner_id, fileNodeId, now)` **then** `UPDATE nodes SET purge_after = @deadline WHERE id = @fileNodeId`, where `@deadline = now + EXHAUST_PURGE_GRACE_MS (24h)`. The node is trashed (link reads gone), recoverable for 24h, then the existing scheduler purges it. `trashNode` sets `purge_after = NULL`, so the stamp must come **after** it, inside the same transaction.
- Both write an **audit row** (§11). Both are idempotent (trashing an already-trashed node is caught; stopping an already-stopped share is a no-op).

`EXHAUST_PURGE_GRACE_MS = 24 * 60 * 60 * 1000` (a named constant, distinct from the 7-day `GRACE_MS`).

## 8. API changes

- **`PATCH /api/shares/:id`** — accept optional `download_limit` (`integer ≥ 1`, or `null` to clear) and `on_exhaust` (`'stop' | 'delete'`). Zod-validated. **Setting `download_limit` resets `download_count` to 0** (a fresh budget). Clearing sets `download_limit = NULL` (count becomes irrelevant). Reject `download_limit` on a **folder** share with `400` (§12).
- **`GET /api/shares`** (owner list) — `ShareDto` gains `download_limit`, `download_count`, `on_exhaust`.
- **`GET /api/public/:token`** (recipient meta) — for a valid, unlocked **file** share with a limit, include `downloads_remaining = download_limit - download_count` (else `null`). Drives the recipient line (§10). Peeking meta never counts as a download.

## 9. Creator UI — `ShareModal`

New `DownloadLimitSection` (mirrors `PasswordSection` / `ExpirySection`), rendered **only when `node.kind === 'file'`**, placed alongside the others:

- State line: **"Unlimited"** or **"X of N downloads used"**.
- Number input (`min 1`), default `1`, with **Apply** / **Clear** (clear = unlimited).
- Terminal-action choice (segmented control / radio): **"When used up: [Delete file] · [Stop link]"**, default **Delete**.
- Inline warning shown when **Delete** is selected: *"The file moves to Trash after the last download (recoverable for 24h)."*
- Wired through `usePatchShare({ id, downloadLimit, onExhaust })`.
- New i18n keys in `ar.json` + `en.json`.

## 10. Recipient UI — public file page

In `PublicFile.tsx`, when `meta.downloads_remaining != null`, show a subtle line:
- `downloads_remaining === 1` → **"one-time download"**.
- otherwise → **"N downloads remaining"**.

After exhaustion the recipient gets the existing gone screen (`410`/`404`), unchanged. New i18n keys.

**Note (copy):** for `limit > 1` shared to several people, "N remaining" is per-*share* shared state — one recipient's download lowers what the others see. Wording will avoid implying a per-person allowance.

## 11. Audit logging

Write to `audit_log` when a limit auto-acts, so an owner can see *why* a file vanished:
- `action = 'share_download_limit_deleted'`, target = token, detail = `{ node_id, limit }`.
- `action = 'share_download_limit_stopped'`, target = token, detail = `{ limit }`.

## 12. Validation & security

- `download_limit`: integer in `[1, 1_000_000]` or `null`; reject `0`, negatives, non-integers.
- `on_exhaust`: enum `'stop' | 'delete'`.
- **Server-enforced "file shares only":** `PATCH` rejects `download_limit` on a folder share; enforcement (`/download`) only counts when `download_limit !== null` (which, given the PATCH rule, only ever holds for file shares). Do **not** rely on the UI hiding the control.
- **Inert when `allow_download = false`:** downloads are already `403` before the reservation runs, so the counter never advances.
- Reservation/refund/terminal are all single-writer-atomic (better-sqlite3 / SQLite) — no over-limit under concurrency.
- `delete` uses `trashNode`, which checks ownership.

## 13. Edge cases

- **Concurrent downloads:** bounded by the atomic guard (§6).
- **Mid-stream abort:** the reservation is released; `download_count` is untouched, so the file is not deleted, the link stays live, and the recipient can retry.
- **Missing blob (ENOENT):** `404`, no reservation consumed (reserve after open).
- **Lowering the limit below the count** via PATCH: never deletes retroactively — deletion only ever results from a real completing download. Further downloads are simply blocked by the `count < limit` guard.
- **Restore within 24h** of a burn-delete: `restoreNode` clears `purge_after` (verified) → file survives. The share's `is_active` was not changed by `delete`, but `download_count` is at the limit, so downloads stay blocked (`410`) until the owner raises/clears the limit.
- **Setting/changing the limit resets `download_count = 0`** (fresh budget). Clearing → unlimited.
- **Password + limit:** unlock never counts; only a completed `/download` counts.

## 14. Non-goals (v1)

Folder-share limits · `/zip` counting · per-recipient limits · special handling of HTTP `Range`/resumable partial downloads (the endpoint streams the whole file; a partial that aborts is treated as an abort → released reservation) · multi-process deployment of the counter (the in-flight reservation map is per-process; v1 assumes one process).

## 15. Testing strategy

**Server (`server/test`):**
- Migration: existing v1 DB gains the 3 columns; fresh DB has them; idempotent re-run; `schema_version` records v2.
- Concurrency bound: two concurrent `/download` on `limit=1` → exactly one `200`, one `410`; after the winner completes, `download_count = 1`.
- Abort releases the reservation: aborted mid-stream → `download_count` unchanged, file not trashed, link live, and a subsequent download succeeds.
- Terminal `delete`: last completing download → node trashed + `purge_after ≈ now + 24h` + audit row; a scheduler tick past the deadline purges it (row + blob).
- Terminal `stop`: → `is_active = 0` + audit row; link `410`.
- PATCH validation: limit on a folder share rejected; `0`/negative rejected; `on_exhaust` enum enforced; setting a limit resets `download_count`.
- Public meta exposes `downloads_remaining` correctly; `null` when unlimited.

**Web (`web/test`):**
- `DownloadLimitSection` renders only for file shares; apply/clear; terminal toggle + the Delete warning.
- `PublicFile` shows the remaining line (and "one-time download" at 1).
- `ShareModal` integration (section appears with the others).

## 16. Rollout

- Additive, backward-compatible. Deploy = rebuild the container image; `migrate()` runs at startup and applies the v2 `ALTER` to the live DB. Existing shares stay unlimited (`download_limit = NULL`).
- **Take a manual DB snapshot before the first deploy** (`deploy/backup-mirsal.sh` — DB-only VACUUM INTO) as a rollback point, since this is the first live schema change since launch.
- Follow the phase-pause / commit-often workflow: build on `feat/download-limit`, TDD, merge to `main` only when green.
