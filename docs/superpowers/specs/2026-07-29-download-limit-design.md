# Design Spec — Download Limit (Burn-After-Download) for File Shares

- **Date:** 2026-07-29
- **Status:** Approved for planning (revised after a 4-lens expert review — see §17)
- **Scope:** Mirsal (`/var/www/projects/mirsal`), feature branch `feat/download-limit`
- **Author:** Claude (VPS), with user

## 1. Goal

Let a share's creator cap how many times a **single file** can be downloaded (default **1**). When the cap is reached, the creator's chosen terminal action fires: **stop the link** or **delete the file** (default). This delivers a "burn-after-download" workflow matching the project's data-minimization intent (files are transient — shared, received, then gone), and composes with the existing lifecycle controls (share expiry, start/stop, password, and the file's auto-delete date).

## 2. Locked decisions

1. **Terminal action:** creator chooses per file — `stop` (link dies, file stays) or `delete` (file removed). **Default = `delete`.**
2. **Scope (v1):** single-**file** shares only. Folder shares are unchanged and get no cap.
3. **Delete depth:** on `delete`, the file goes to **Trash immediately** (link dies at once), **auto-purged after 24 hours** (recoverable until then), reusing the existing scheduler.
4. **Bot protection (review):** a counted/destructive download fires **only on an explicit human action**. The counted download is a **`POST`**; a passive `GET` (link-preview unfurlers, URL/AV scanners, browser prefetch) can neither trigger the burn nor bypass the cap.
5. **Recipient display (review):** a **static** label ("one-time download" / "up to N downloads"), never a live decrementing counter — so it can't act as a delivery-confirmation oracle.

## 3. Background — the existing model (verified in code)

- **`shares`** — one share per node. Columns: `token`, `password_hash`, `is_active`, `expires_at`, `allow_download`, `revoked_at`. Liveness decided at request time by `isShareLive` (stopped / expired / gone). PATCH goes through `setShareState` (`shares/shares.ts`), a bare owner-scoped `UPDATE shares` with **no join to `nodes`**. Status is derived by `ownerStatus` from `is_active`/`expires_at` only.
- **`nodes`** — files/folders. `auto_delete_at` (existing scheduled deletion), `trashed_at`, `original_parent_id`, `purge_after` (absolute epoch-ms hard-purge deadline).
- **Download endpoints** (`server/src/routes/public.ts`): `GET /download` (one file), `GET /zip` (folder). Unauthenticated, rate-limited per-IP and per-token, `logShareAccess` on each. **Anti-oracle stance:** unknown token and resolver rejection are constant-shape; `delete` collapses to an ambiguous `404 gone`. The `/zip` handler shows the correct concurrency-slot pattern: `count++; slotSet.add(req); reply.raw.once('close', release)` wired **before** `logShareAccess`, with `onResponse` as defence-in-depth; `releaseZipSlot` is idempotent via a `WeakSet`.
- **Scheduler** (`server/src/scheduler/runner.ts`): every 60s, `duePurge` selects any node with `purge_after <= now` and `permanentDelete`s it (row + blob unlink + orphan sweep). `trashNode` sets `purge_after = NULL` and **throws** on an already-trashed/foreign node (`trash.ts:44`). The auto-trash path `trashAndStampPurge` trashes **then** stamps `purge_after`. **`restoreNode` clears `purge_after`** (`trash.ts:151`) — a restored file is never surprise-purged. ✅
- **Migration** (`server/src/db/migrate.ts`): single-shot — applies `schema.sql` when `schema_version < SCHEMA_VERSION (=1)`, else no-op. `schema.sql` is all `CREATE TABLE IF NOT EXISTS` (won't add columns). **Live DB verified at `schema_version = 1`, original 10 `shares` columns, 0 shares** → the v2 upgrade runs against an empty table (zero data-loss risk). `connection.ts` sets `foreign_keys=ON`, WAL, `busy_timeout=5000`.
- **i18n** (`web/src/i18n`): `fallbackLng: 'ar'`; the authenticated app is **Arabic-only** (`share.*` lives in `ar.json` only); **only the public share page is bilingual** (`public.*` in both `ar.json` and `en.json`).

## 4. Data model

Three additive columns on `shares`, **appended after `revoked_at`** (ALTER always appends; fresh and upgraded DBs must match column order):

| Column | Type | Meaning |
|--------|------|---------|
| `download_limit` | `INTEGER` nullable, `CHECK(download_limit IS NULL OR download_limit >= 1)` | `NULL` = unlimited (unchanged). `≥1` = capped. Default when enabled = `1`. |
| `download_count` | `INTEGER NOT NULL DEFAULT 0` | Downloads that have **completed** against the current budget. |
| `on_exhaust` | `TEXT NOT NULL DEFAULT 'delete' CHECK(on_exhaust IN ('stop','delete'))` | Terminal action; only meaningful when a limit is set. |

Every existing share keeps `download_limit = NULL` → behaviorally unchanged (all enforcement gates on `download_limit IS NOT NULL`). The DB `CHECK` is defence-in-depth behind Zod validation.

## 5. Migration system upgrade

`migrate.ts` becomes an **incremental versioned runner** with **robust fresh-detection** (do not equate "no version row" with "empty DB"):

- `LATEST_VERSION = 2`. Ordered steps list, each `{ version, up(db) }`.
- v2 step (one `db.exec`, inside a transaction):
  ```sql
  ALTER TABLE shares ADD COLUMN download_limit INTEGER
    CHECK(download_limit IS NULL OR download_limit >= 1);
  ALTER TABLE shares ADD COLUMN download_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE shares ADD COLUMN on_exhaust TEXT NOT NULL DEFAULT 'delete'
    CHECK(on_exhaust IN ('stop','delete'));
  ```
- `migrate(db)`:
  1. Ensure `schema_version` table.
  2. `current = MAX(version) ?? 0`.
  3. **Truly fresh** (no core tables — probe `SELECT 1 FROM sqlite_master WHERE type='table' AND name='shares'`): apply full `schema.sql` (already includes the columns) and record `version = LATEST_VERSION`. Whole thing in one transaction.
  4. **Tables exist but `current < LATEST`** (includes the "tables present, no version row" restored-dump case → treat as `current = 1`): run each step with `current < step.version <= LATEST_VERSION`, **each in its own transaction**, recording its version row.
  5. `current >= LATEST_VERSION`: no-op.
- Verified against SQLite 3.53.0: the `ALTER … ADD COLUMN … NOT NULL DEFAULT … CHECK(…)` statements are legal, run as one `exec`, and stamp existing rows with defaults; `RETURNING` (used in §6) is supported.
- **Convergence guarantee + test:** a fresh DB and a `v1`-then-migrated DB must produce **identical `PRAGMA table_info(shares)`**. §15 adds a test asserting this.

## 6. Backend enforcement — the counted download

**Bot protection (decision 4):** the counted download is **`POST /api/public/:token/download`**. The recipient page triggers it as a form/`fetch` POST so the browser downloads natively (streamed, no in-memory buffering). For a **limited** share, `GET /download` returns **`405`** (non-counting, non-delivering) — so neither a passive prefetch/scanner GET nor a raw-link GET can trigger the burn *or* bypass the cap. **Unlimited** shares keep `GET /download` exactly as today. `/zip` is untouched (folders are out of scope).

The counter separates two things:
- **`download_count` (DB, durable)** — **completed** downloads. Incremented only on completion, guarded so it can never exceed the limit.
- **in-flight reservations (in-memory `Map<shareId, number>`, per process)** — currently-streaming downloads; bounds concurrency; ephemeral (empty each boot, so a crash can never strand one).

**Single-process assumption:** Mirsal is one Node process in one container, so the in-memory map is authoritative. Multi-process would need a shared store — out of scope (§14).

**Request flow (`POST /download`, limited file share):**
1. Existing gates: `loadLiveShare` → `requireUnlocked` → `allow_download` → resolve node → must be a file with `storage_path`.
2. **Open the blob** (`waitForOpen`). `ENOENT` → `404`, nothing reserved.
3. **Reserve** (synchronous block — atomic under Node's single thread, **no `await` between read and write**): read `download_count`; `inflight = map.get(shareId) ?? 0`; if `download_count + inflight >= download_limit` → **destroy the opened `ReadStream`** and respond `410 gone` (same shape as other rejections — no "live-but-reserved" oracle); else `map.set(shareId, inflight + 1)`.
4. **Immediately** (before anything fallible) wire the release: `reply.raw.once('close', handler)` **and** an `onResponse` hook as defence-in-depth (idempotent via a per-request `WeakSet`, exactly like `releaseZipSlot`). Only after this: set headers, `logShareAccess`, `reply.send(stream)`. *(Ordering is load-bearing: reserving before wiring the release — or letting `logShareAccess` throw in between — would strand a reservation and permanently `410`-brick the share.)*
5. **The close handler** — wrapped **entirely in `try/catch`** (a throw in a raw `'close'` listener is an uncaught exception that kills the single process), and run as **one synchronous, `await`-free block**:
   - **Release** the reservation on *both* outcomes (decrement, clamp at 0, delete the key at 0).
   - Branch on `reply.raw.writableFinished`:
     - **completed** (`true`): `UPDATE shares SET download_count = download_count + 1 WHERE id=@id AND download_limit IS NOT NULL AND download_count < download_limit RETURNING download_count, download_limit`. If a row changed and `download_count === download_limit`, run the terminal action (§7).
     - **aborted** (`false`): nothing else — `download_count` untouched, so the link stays live and the recipient can retry.

**Why this is race-free and safe:**
- `download_count` counts only real deliveries → the terminal fires exactly when the limit-th download *completes*, never prematurely because a concurrent download aborted.
- The completion `UPDATE`'s `download_count < download_limit` guard is a hard backstop (SQLite serializes writers, re-evaluates the `WHERE`): total counted completions can never exceed the limit even under a post-boot burst or the multi-process edge — only raw in-flight bytes are unbounded there (§14).
- Firing the terminal action mid-stream (of a *different*, already-gated download) is safe: `delete` only trashes the row + stamps a 24h `purge_after` (blob not unlinked for 24h; an open fd keeps streaming); `stop` only flips `is_active`.
- The terminal action is **idempotent** and must tolerate an already-trashed/foreign node (§7) — an owner manually trashing the file mid-download must not crash the process.
- **Accepted trade-off:** the reservation map is per-process, reset on restart; a restart *during* concurrent in-flight downloads of the same limited file could deliver already-streaming bytes the post-restart counter no longer bounds. Negligible for a single-process, low-traffic, typically-limit-1 workload; the durable guard still caps *counted* completions.

## 7. Terminal actions

A dedicated, unit-testable, **idempotent** helper (`server/src/shares/exhaustion.ts`), all writes in **one transaction**:

- **`stop`:** `UPDATE shares SET is_active = 0 WHERE id = @id`. Link → `410`. File untouched, reversible.
- **`delete`:** mirror `trashAndStampPurge` — **if the node is still live**: `trashNode(db, share.owner_id, fileNodeId, now)` **then** `UPDATE nodes SET purge_after = @deadline` with `@deadline = now + EXHAUST_PURGE_GRACE_MS` (`24h`, a named constant distinct from the 7-day `GRACE_MS`). `trashNode` **throws on an already-trashed/foreign node**, so the helper first checks liveness (or catches and treats it as a no-op) — never lets that throw escape.
- **Audit** (§11) is written **inside the same transaction** as the terminal write.
- **"Exactly once"** holds within a single budget; re-enabling a limit after a prior exhaustion starts a new budget (which can exhaust again) — the idempotent already-trashed handling makes a repeat `delete` a safe no-op.

## 8. API changes

- **`POST /api/public/:token/download`** — the new counted download (§6). Keep `GET` for unlimited shares; `GET` on a limited share → `405`.
- **`PATCH /api/shares/:id`** — accept optional `download_limit` (`integer ≥ 1` or `null`) and `on_exhaust` (`'stop' | 'delete'`). Required edits (the current validator would otherwise reject a limit-only PATCH):
  - Extend `patchShareSchema` (Zod object) **and** its `.refine()` "at least one field" predicate to include the two new fields.
  - Extend the handler's field-forwarding and `setShareState`.
  - **Folder-share rejection:** before `setShareState`, load the share owner-scoped and `SELECT kind FROM nodes WHERE id = share.node_id`; **`404`** for a missing/foreign share (preserve the no-oracle behavior), **`400`** only for a genuine folder share owned by the caller.
  - **Reset rule (resolves the §8/§13 contradiction):** setting `download_limit` to a non-null value resets `download_count` to `0` in **one atomic `UPDATE`** (`SET download_limit=@lim, download_count=0`), never split across the `await hashPassword` path. Clearing sets `download_limit = NULL`. **There is no retroactive burn via "lowering" the limit** — to end a live share now, use Stop or Revoke.
- **`GET /api/shares`** (owner list) — `ShareDto` gains `download_limit`, `download_count`, `on_exhaust`, and the derived **status must reflect exhaustion** (see §9). When `download_limit IS NULL`, the DTO reports `download_count` as `0`/ignored.
- **`GET /api/public/:token`** (recipient meta) — for a valid, unlocked **file** share with a limit, include the **static** `download_limit` (config, unchanging → not an oracle). **Do NOT expose `download_count` or a remaining count.** Drives the static label (§10).

## 9. Creator UI — `ShareModal`

New `DownloadLimitSection` (mirrors `PasswordSection`/`ExpirySection`), rendered **only when `node.kind === 'file'`**:

- State line: **"Unlimited"** or **"X of N downloads used"** (best-effort; refreshes on the owner's own mutations).
- Number input (`min 1`), default `1`, with **Apply** / **Clear** (clear = unlimited). All buttons `disabled={patch.isPending}`.
- Terminal-action choice (segmented control): **"When used up: [Delete file] · [Stop link]"**, default **Delete** — **shown only when a limit is set**. Inline warning when **Delete** is selected: *"The file moves to Trash after the last download (recoverable for 24h)."*
- Wired through `usePatchShare({ id, downloadLimit, onExhaust })`.
- **Owner status honesty:** after a `delete` burn, `is_active` stays `1` but the file is gone, so `ownerStatus`/`toShareDto` must derive an **`exhausted`/`burned`** state (from `download_count >= download_limit`, or node-trashed) so `StatusChip` never shows "active" for a dead link.

**Boundary wiring (must all be edited — TypeScript won't compile otherwise, and a missed camel↔snake map makes Apply a silent no-op):**
- `server/src/shares/shares.ts`: `Share` interface + `toShareDto` (+ exhausted-status derivation).
- `web/.../share/types.ts`: `ShareDto` mirror (+ 3 fields + status).
- `web/.../share/api.ts`: `PatchShareVars` + `patchShare()` body mapping **camelCase→snake_case** (`downloadLimit`→`download_limit`, `onExhaust`→`on_exhaust`), matching the existing `isActive`→`is_active` convention.
- `web/.../public/api.ts`: `PublicMeta` + `download_limit` (snake_case).
- `web/test/share.test.tsx`: update the `mkShare` fixture for the new required `ShareDto` fields.

## 10. Recipient UI — public file page

- **Static label** (decision 5), from `meta.download_limit`: `=== 1` → **"one-time download"**; `> 1` → **"up to N downloads"**; `null` → nothing. Use `{{count}}` interpolation; accept the Arabic number-agreement compromise consciously.
- **Download button issues the `POST`** (form submit / streamed fetch) so the browser downloads natively and passive GETs can't trigger the burn.
- After exhaustion → the existing gone screen (`410`/`404`), unchanged.
- **i18n:** recipient keys are `public.*` → **both `ar.json` and `en.json`** (the page is bilingual; missing `en` keys would fall back to Arabic — a visible bug). Creator keys are `share.*` → **`ar.json` only** (the app is Arabic-only).

## 11. Audit logging

Write to `audit_log` **inside the terminal-action transaction**, `actorId = null` (a system action; detail carries attribution):
- `action = 'share_download_limit_deleted'`, target = token, detail = `{ owner_id, node_id, limit }`.
- `action = 'share_download_limit_stopped'`, target = token, detail = `{ owner_id, limit }`.

**Known limitation:** `audit_log` is readable only via the admin route (`requireAdmin`) — there is **no owner-facing audit view** today, so an owner cannot directly see "why my file vanished" (they'd notice it in Trash). An owner notification/activity surface is **out of scope for v1** (§14); this section is admin/IR visibility only.

## 12. Validation & security

- `download_limit`: Zod integer `[1, 1_000_000]` or `null`; plus the DB `CHECK ≥ 1` (defence-in-depth — a `0` would `410` every download and never fire the terminal).
- `on_exhaust`: enum `'stop' | 'delete'` (Zod + DB `CHECK`).
- **File-shares-only** enforced server-side via the node-kind lookup on PATCH (§8) — never rely on the UI hiding the control.
- **Bot/prefetch safety:** counted download is `POST`-only (§6); a limited share's `GET /download` is `405` (non-counting, non-delivering) — passive GETs neither burn nor bypass. Cross-site auto-POST is not a new risk (knowing the token already implies the ability to download; password shares' unlock cookie is `SameSite=Lax`, so a cross-site POST can't carry it).
- **No new oracle:** terminal states stay ambiguous (`delete` → `404 gone`; `stop` → `410 stopped`, identical to a manual stop); the reservation reject reuses the standard rejection shape; the recipient sees only the **static** limit, never a live remaining count.
- Reservation/completion/terminal are single-writer-atomic; `busy_timeout=5000` means contention blocks (a rare ≤5s stall inside the close handler) rather than throwing — the `try/catch` covers a throw either way.
- `delete` uses `trashNode` (ownership-checked) and is idempotent.

## 13. Edge cases

- **Concurrent downloads:** bounded by the reserve guard; completion guard caps counted completions at the limit.
- **Mid-stream abort:** reservation released; `download_count` untouched; link live; recipient can retry.
- **Missing blob (ENOENT):** `404`, no reservation consumed (reserve after open).
- **Owner manually trashes the file mid-download:** completion's terminal `delete` finds it already trashed → idempotent no-op, no crash (§7).
- **Changing the limit:** setting a value resets `download_count = 0` (fresh budget, one atomic UPDATE); clearing → unlimited. **No retroactive burn** — use Stop/Revoke to end a live share now.
- **Restore within 24h** of a burn-delete: `restoreNode` clears `purge_after` → file survives; `download_count` is at the limit so downloads stay blocked until the owner raises/clears the limit.
- **Password + limit:** unlock never counts; only a completed `POST /download` counts; a burn-deleted password share collapses to `404 gone` *before* the unlock check → no pre-auth oracle.
- **`Range`/206:** the route streams the whole file (no range support); a partial that aborts is an abort (released reservation). §15 asserts a `Range` request still yields the full body and only a full delivery counts.

## 14. Non-goals (v1)

Folder-share limits · `/zip` counting · per-recipient limits · `Range`/resumable partial-download counting · multi-process deployment of the reservation map · an **owner-facing** notification/audit view of auto-actions.

## 15. Testing strategy

**Server (`server/test`):**
- Migration: existing v1 DB gains the 3 columns; fresh DB has them; **convergence** (fresh vs upgraded `PRAGMA table_info(shares)` identical); idempotent re-run; `schema_version` records v2; the "tables present, no version row" case runs the ALTERs (not the fresh path).
- Concurrency bound & abort tests use the **real-listen socket harness** (like the existing `/zip` abort test — `light-my-request`/`inject` can't park a stream mid-flight or produce `writableFinished === false`): two concurrent `POST /download` on `limit=1` → one `200`, one `410`, final `download_count = 1`; abort mid-stream → `download_count` unchanged, link live, a subsequent download succeeds.
- **Crash-safety:** owner trashes the file while a limited download streams → completion's terminal `delete` is a no-op, process does not crash.
- Terminal `delete`: last completing download → node trashed + `purge_after ≈ now+24h` + audit row (same txn); a scheduler tick past the deadline purges it (row + blob).
- Terminal `stop`: → `is_active = 0` + audit; link `410`.
- Bot protection: `GET /download` on a limited share → `405`; `POST` counts.
- `Range` request → full 200 body; only full delivery increments the count.
- PATCH: limit-only body accepted (refine extended); folder share → `400`, missing/foreign → `404`; `0`/negative rejected (Zod + DB CHECK); setting a limit resets `download_count`; clearing → NULL.
- Public meta exposes static `download_limit`, never a remaining count.

**Web (`web/test`):**
- `DownloadLimitSection` renders only for file shares; Apply/Clear; terminal toggle + Delete warning shown only when limited; disabled states.
- Owner `StatusChip` shows an exhausted/burned state (not "active") after a `delete` burn.
- `PublicFile` shows the static label ("one-time download" / "up to N"); download uses `POST`.
- `mkShare` fixture updated; `ShareModal` integration.

## 16. Rollout

- Additive, backward-compatible. Deploy = rebuild the container image; `migrate()` runs at boot and applies the v2 `ALTER` to the live DB (empty `shares` table → trivial). Existing shares stay unlimited (`download_limit = NULL`). Code rollback onto the v2 schema is safe (old code's `createShare` is column-explicit; old code sees `MAX(version)=2 ≥ 1` → no-op).
- **Take a manual DB snapshot before the first deploy** (`deploy/backup-mirsal.sh`).
- Build on `feat/download-limit`, TDD, merge to `main` only when green (phase-pause / commit-often workflow).

## 17. Review addendum — expert-panel findings addressed (2026-07-29)

A 4-lens review (concurrency, security, data/migration, integration), each grounded in the code, produced these changes:

1. **Passive-GET burn (security, major):** counted download is now `POST`-only; limited `GET` → `405` (§2.4, §6, §8, §12).
2. **Close-handler crash + reservation leak (concurrency/security, blocker/major):** release wired before `logShareAccess`, whole close handler in `try/catch` as one synchronous block, idempotent already-trashed-tolerant terminal action (§6, §7).
3. **§8/§13 reset contradiction (correctness/migration, major):** one rule — setting a limit resets the count (atomic); no retroactive burn (§8, §13).
4. **PATCH rejects limit-only body (integration, blocker):** extend `patchShareSchema` + `.refine()` + forwarding + `setShareState` (§8).
5. **Folder-share rejection needs node-kind lookup (integration, major):** load share + `SELECT kind FROM nodes`; 404 missing/foreign, 400 folder (§8, §12).
6. **i18n placement wrong (integration, major):** creator `share.*` → `ar.json` only; recipient `public.*` → both (§10).
7. **Owner status lies after burn (integration, major):** derive an exhausted/burned status in `toShareDto`/`ownerStatus` (§8, §9).
8. **Boundary wiring unspecified (integration, major):** enumerated `Share`/`ShareDto`/`api.ts` camel↔snake/`PublicMeta`/`mkShare` edits (§9).
9. **Migration fresh-detection hazard (migration, major):** detect fresh by probing `sqlite_master`, not by a missing version row; transaction-wrapped; convergence test (§5, §15).
10. **Delivery-confirmation oracle (security, minor):** expose only the static `download_limit`; reservation reject reuses the standard shape (§8, §10, §12).
11. **Audit is admin-only / actor+atomicity (security, minor):** `actorId=null` system, same-txn write, limitation documented (§11).
12. **Concurrency tests can't use `inject` (integration, minor):** use the real-listen harness (§15).
13. **Nits:** DB `CHECK(download_limit>=1)`; append columns at end of `schema.sql`; PATCH reset as one atomic UPDATE; `Range`→full-body test; disabled/hidden UI states; Arabic number agreement (folded across §4, §8, §9, §12, §15).
