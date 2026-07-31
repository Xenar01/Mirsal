# Mirsal "Round 3" — Admin & UX improvements + bug fixes

- **Date:** 2026-07-31
- **App:** Mirsal (مِرسال), LIVE on project4. `main == live == de8a723`.
- **Scope:** 11 user-requested items (4 bugs + 7 features) after live use.
- **Delivery:** three phases, one feature branch each, TDD, merge-when-green, **stop for user review between phases**.

This spec is the durable design record for all three phases. Each phase gets its own
implementation plan (via `writing-plans`) and its own branch. Only **Phase 2** carries a
schema migration.

---

## Global constraints (unchanged from the app)

- Server: Fastify 5 + better-sqlite3, ESM/NodeNext, TS strict, vitest. Web: React 19 + Vite +
  TanStack Query + react-i18next + Tailwind (logical-property RTL).
- Quality gates per workspace: `npm test` (vitest) + `npm run typecheck` (tsc). **No eslint/lint
  script exists** — do not invent one.
- Arabic-first: app UI strings are Arabic-only (`ar.json`); only the public recipient page is
  bilingual (`ar.json` + `en.json`). Any new recipient-facing string goes in **both**.
- Admin surface is **metadata-only** — it never gains a content/download path, and never receives
  a live share token. Audit `target` redaction (`share_unlock_failure`) must be preserved.
- Anti-enumeration login is constant-work (one real argon2 verify per attempt). Preserve that
  property except where a decision below deliberately relaxes it.
- Commit after every step; feature branch; merge to main only when the full suite is green
  (`feedback_save_often`). Stop after each phase (`feedback_phase_pause`).

---

# Phase 1 — Bug fixes (no schema change)

Branch: `feat/round3-phase1-bugfixes`.

## 1.1 — (#3) User's own dashboard shows "unlimited" even when a quota is set

**Problem.** `GET /api/auth/me` (and the `/login` response) project only
`{id, username, role, mustChangePassword, rootNodeId}` — `quota_bytes`/`used_bytes` are never
sent to a non-admin. `web/src/features/dashboard/StorageMeter.tsx` therefore has no quota to show
and always renders the fixed note `storage.noQuota` ("بلا حصة محددة"). So an admin-assigned quota
is invisible to the user.

**Server change.**
- `server/src/routes/auth.ts`: extend `PublicUser` + `toPublicUser` to include
  `quotaBytes: number | null` and `usedBytes: number`. Read those two columns in the `/login`
  SELECT and the `/me` SELECT (both currently omit them). `used_bytes` is the authoritative,
  transactionally-maintained figure (includes trashed-but-not-purged bytes) — use it directly, do
  not recompute.

**Web change.**
- `web/src/features/auth/auth-context.tsx`: add `quotaBytes: number | null` + `usedBytes: number`
  to the `PublicUser` type.
- `web/src/features/dashboard/StorageMeter.tsx`: when `user.quotaBytes !== null`, render a labelled
  used/quota bar (fraction = `min(1, usedBytes/quotaBytes)`, over-quota styling when
  `usedBytes > quotaBytes`), reusing the visual pattern already in the admin `UsageCell`. When
  `quotaBytes === null`, keep the existing "no quota set" note. Use the server `usedBytes` as the
  "used" number (the current client-side `sumSizes(rootQuery)+sumSizes(trashQuery)` derivation is
  replaced; the trash breakdown line may remain if desired).

**Tests.** Server: `/me` and `/login` responses include `quotaBytes`/`usedBytes` (both a set-quota
user and a null-quota user). Web: `StorageMeter` renders a bar with the right fraction for a
quota'd user and the "no quota" note for a null-quota user.

## 1.2 — (#9) Deactivated account should say so (decision: only after correct password)

**Problem.** Login treats an inactive account exactly like a wrong password (`isUsable = row &&
is_active===1`; when not usable it verifies the dummy hash → generic `invalid_credentials`). A
deactivated user cannot tell why they're locked out.

**Decision.** Reveal "account deactivated" **only** when the submitted username + password are both
correct and the account is inactive. Wrong password on an inactive account, or an unknown username,
still returns the generic error — so no username-existence oracle is created (an attacker must
already know the correct password).

**Server change (`server/src/routes/auth.ts`).** Restructure the verify branch so the real
password hash is used whenever `row` exists (active **or** inactive), and the dummy hash only when
there is no row — preserving constant work (exactly one argon2 verify per attempt):
```
const hasUser = !!row;
const verified = await verifyPassword(hasUser ? row.password_hash : dummyHash, password);
if (hasUser && verified && row.is_active !== 1) {
  writeAudit(..., 'login_denied_inactive', target: username);
  return reply.code(403).send({ error: 'account_deactivated' });
}
if (!hasUser || !verified || row.is_active !== 1) {  // wrong pw / unknown / (inactive w/ wrong pw)
  writeAudit(..., 'login_failure', ...);
  return reply.code(401).send({ error: 'invalid_credentials' });
}
// active + verified → success (unchanged)
```
Note the ordering guarantees an inactive account with a **wrong** password falls through to the
generic 401, not the 403.

**Web change.** `LoginPage` maps a `403 account_deactivated` to a distinct Arabic message
(`login.deactivated` — e.g. "هذا الحساب معطَّل. راجع المسؤول."); everything else keeps the generic
`login.error`.

**Tests.** Server: (a) active+correct → 200; (b) inactive+correct → 403 `account_deactivated`;
(c) inactive+wrong → 401 generic; (d) unknown user → 401 generic; (e) timing/verify still runs once
per attempt (assert a verify call on every branch). Web: the 403 renders the deactivated message.

## 1.3 — (#10) Folder share must not reveal its contents

**Problem.** For a folder share the recipient page lists every child (`GET /api/public/:token/list`
→ `PublicFolder` renders the listing + breadcrumb + per-file download links). Decision: recipient
sees **only** the folder name + "Download all as ZIP"; contents are hidden — enforced server-side,
not just in the UI.

**Server change (`server/src/routes/public.ts`).** When the share's node is a folder:
- `GET /api/public/:token/list` → constant-shape `403 {error:'forbidden'}` (never enumerate).
- `GET`/`POST /api/public/:token/download` (single-file) → `403 {error:'forbidden'}` regardless of
  any `?node=` param (so a recipient can't fetch individual children by guessing ids).
- `GET /api/public/:token/zip` → **unchanged** (download-all remains the only content path).
- `GET /api/public/:token` (meta) → unchanged (returns name/size/isFolder/allow_download).

Keep every rejection byte-identical to the existing constant-shape 403 (no existence oracle).
File shares are unaffected (their node kind is `file`).

**Web change.** `web/src/features/public/PublicFolder.tsx`: remove the listing table, breadcrumb,
in-subtree navigation, and `usePublicList` call. Render the folder name (from meta) + the existing
"Download all as ZIP" `PrimaryLink` (shown when `meta.allow_download`). `usePublicList`/`fetchPublicList`
in the public api/queries become unused for folder shares — leave the endpoint client wrapper but
stop calling it (or delete if nothing references it).

**Tests.** Server: for a folder share, `/list` → 403, `/download` (with and without `?node=`) → 403,
`/zip` → 200 stream, meta → 200. For a file share, `/download` still 200 (regression guard). Web:
`PublicFolder` renders name + ZIP button and **no** file-name listing.

## 1.4 — (#11) Password-protected link must re-prompt on every open

**Problem.** The unlock cookie (`mirsal_unlock`) lasts 30 min (server-enforced), so revisiting the
link in the same browser skips the password. Decision: re-prompt on **every fresh open/reload**; a
download within the same open page still works after entering the password once.

**Client change (authoritative for the UX).**
`web/src/features/public/SealedDispatch.tsx`: track an in-memory `unlocked` boolean (React state,
per mount). For a password share, always render `PasswordGate` until `unlocked` is true in **this**
mount — a reload resets the state → the gate shows again. On successful unlock, set `unlocked=true`
and reveal the file/folder view (refetch meta as today). The client no longer treats a
still-valid cookie as "already unlocked" for the purpose of showing content on load.

**Server change (`server/src/routes/public.ts`).** Make the unlock cookie a **session cookie** with
a short lifetime so it only bridges the current page's requests (meta refetch + download form POST)
and cannot silently authorize a later visit:
- Drop the persistent `maxAge` on `reply.setCookie(UNLOCK_COOKIE, …)` so the browser treats it as a
  session cookie (cleared when the browser session ends).
- Reduce `UNLOCK_COOKIE_MAX_AGE_S` (server-side lifetime enforced in `isUnlocked`) from 1800 to a
  short bridge window (e.g. **600s / 10 min**) — long enough for a slow download, short enough that
  it isn't a lingering skip. (The client gate is what enforces "every open"; this is defense in
  depth on the transport.)
- Cookie stays httpOnly + Secure + SameSite=Lax + path-scoped + hash-bound (unchanged).

**Tests.** Server: unlock sets a session cookie (no `Max-Age`/`Expires` far in the future) and the
server-side lifetime uses the shortened window (a cookie older than the window fails `isUnlocked`).
Web: a password share renders `PasswordGate` on mount even when a prior unlock happened in a
previous mount (fresh state ⇒ gate), and reveals content after unlock in the current mount.

---

# Phase 2 — Admin features (ONE schema migration: `users.display_name`, v2→v3)

Branch: `feat/round3-phase2-admin` (off main after Phase 1 merges). **Pre-deploy DB snapshot
required** (migration). Take it before `docker compose up -d`, as with the download-limit deploy.

## 2.0 — Migration (shared prerequisite for 2.1)

- `server/src/db/migrate.ts`: `LATEST_VERSION = 3`; add
  `{ version: 3, up(db){ db.exec("ALTER TABLE users ADD COLUMN display_name TEXT;") } }` to `STEPS`.
- `server/src/db/schema.sql`: add `display_name TEXT,` to the `users` table (fresh-DB path).
- **Test:** migrate.test — a v2 DB migrates to v3 with the `display_name` column present and
  idempotent across two boots; a fresh DB starts at v3 with the column.

## 2.1 — (#4) Per-user display name (Arabic or English)

**Server (`server/src/routes/admin.ts`).**
- `AdminUserDto` + `USER_DTO_COLUMNS`: add `display_name: string | null`.
- `createUserSchema`: add `display_name: z.string().trim().max(120).nullable().optional()`
  (a free-text label — trusted display string, never a path segment; length-bounded, no control
  chars via `.trim()` + a simple guard). Persist it in the INSERT (`NULL` when absent).
- `patchUserSchema`: add the same optional field; when present (including explicit `null` to clear),
  add `display_name = @displayName` to the UPDATE set. Keep the "at least one field" refine.

**Web (`web/src/features/admin/`).**
- `types.ts` `AdminUserDto`: add `display_name: string | null`.
- `api.ts`/`queries.ts`: thread `display_name` through `createUser` and `patchUser` var types.
- `UsersTable.tsx`: add a "الاسم" column (thead + `UserRow` cell) showing `display_name` beside the
  mono username; add a display-name text input to the create form and the edit path (a small
  "rename label" affordance or fold into an existing edit modal). Empty → dim placeholder.

**Tests.** Server: create with `display_name` persists + returns it; patch updates it; patch `null`
clears it. Web: the column renders the name (and a placeholder when null); create/edit sends it.

## 2.2 — (#1) Audit log shows usernames, not IDs

**Problem.** `GET /api/admin/audit` returns raw `actor_id`; `AuditLog.tsx` prints the integer.
Targets for user-management actions are raw user ids too.

**Server (`server/src/routes/admin.ts`, audit handler).** After fetching the page of rows:
- Collect the distinct ids needed: every non-null `actor_id`, plus every `target` that is a numeric
  user id for a **user-target action** (`user_create`, `user_update`, `user_delete`,
  `user_password_reset`, `user_nodes_view`, and the new `user_clear_space`). One
  `SELECT id, username, display_name FROM users WHERE id IN (…)` → map.
- Add to each DTO: `actor_username` (username, or `null` if actor is null/deleted) and
  `actor_display_name`. For user-target actions add `target_username`/`target_display_name`
  (null if that user was since deleted). Non-user targets (share ids, usernames already stored as
  the target for `login_*`) pass through unchanged.
- **Preserve** `redactAuditTarget` for `share_unlock_failure` — resolution must run only for the
  known user-target action set, never on a secret target.

**Web (`web/src/features/admin/AuditLog.tsx` + `types.ts`).** Render `actor_display_name ||
actor_username || '#'+actor_id` (and "النظام" when actor is null). For user-target actions, show the
resolved target name with the id as a fallback (`name` or `#id`, and a "(محذوف)"/deleted hint when
the id no longer resolves).

**Tests.** Server: audit DTO carries `actor_username` for a real actor and `null` for a system row;
a `user_create` row resolves `target_username`; a `share_unlock_failure` row's target stays
redacted (never resolved). Web: the actor column shows the username/display-name, not the id.

## 2.3 — (#2) Admin: total space used by all users

**Server.** No new endpoint — `GET /api/admin/users` already returns `used_bytes` (and
`quota_bytes`) per user.

**Web (`web/src/features/admin/UsersTable.tsx`).** Add a summary strip above the table:
`Σ used_bytes` across all users (formatted), and the user count. Optionally show total allocated
quota (`Σ quota_bytes`, treating null as "∞"). Client-side reduce over the already-loaded list.

**Tests.** Web: the summary shows the correct total for a fixture set of users.

## 2.4 — (#5) Admin: clear a user's space (wipe their whole drive)

**Decision.** Permanently delete ALL of the user's files + folders (live and trashed), unlink their
blobs, reset `used_bytes = 0`, re-create empty root/trash. Account, login, role, quota preserved.
Their shares cascade-delete with the nodes (expected — the shared files are gone).

**Server (`server/src/routes/admin.ts`).** New audited route
`POST /api/admin/users/:id/clear` behind `requireAdmin`:
1. 404 if the target user doesn't exist.
2. Collect the user's file blob `storage_path`s (`SELECT storage_path FROM nodes WHERE owner_id=? AND
   kind='file' AND storage_path IS NOT NULL`) for post-txn unlink.
3. In one `db.transaction`: `DELETE FROM nodes WHERE owner_id=? AND kind IN ('folder','file')`
   (FK `ON DELETE CASCADE` covers subtrees + the `shares` rows on those nodes); set
   `used_bytes=0, updated_at=now` on the user; `writeAudit('user_clear_space', target: id,
   detail: '<n> files, <bytes> freed')`.
4. After commit: best-effort unlink the collected blob paths via `blobStore` (non-fatal; any
   stragglers are reaped by the existing orphan sweep, same as the user-delete path). Then
   `ensureUserRoots` to guarantee an empty root/trash exists.
5. Return the refreshed `AdminUserDto` (used_bytes now 0).

`adminRoutes` deps must gain `blobStore` (currently not injected there — thread it from `buildApp`,
same instance the public/nodes routes use).

**Web (`web/src/features/admin/UsersTable.tsx` + api/queries).** A "تفريغ المساحة" (clear space)
chip in the `UserRow` actions cell → destructive `ConfirmModal` (variant danger, mirrors
`DeleteUserModal`) → `clearUserSpace(id)` mutation → invalidate `['admin','users']`. Copy must be
explicit that it permanently deletes everything the user uploaded.

**Tests.** Server: after clear, the user's file/folder nodes are gone, `used_bytes===0`, root+trash
remain, their shares are gone, blobs unlinked; a non-existent user → 404; audited. Web: the confirm
gates the call; success refreshes the row to 0.

---

# Phase 3 — Dashboard UX (no schema change)

Branch: `feat/round3-phase3-dashboard` (off main after Phase 2 merges).

## 3.1 — (#6) Empty the whole Trash

**Server (`server/src/routes/nodes.ts` + reuse `nodes/trash.ts`).** New route
`POST /api/nodes/trash/empty` behind `requireAuth`: permanently delete every node in the caller's
Trash (all of the caller's nodes with `trashed_at IS NOT NULL`), reusing the existing
permanent-delete subtree logic (cascade + quota subtract + blob unlink) that the single-item
`DELETE /api/nodes/:id` already uses — applied to each top-level trashed node. Idempotent on an
already-empty trash (200, nothing to do).

**Web (`web/src/features/dashboard/TrashView.tsx`).** An "إفراغ سلة المهملات" (empty trash) button
at the top of the view → destructive `ConfirmDeleteModal` → `useEmptyTrash()` mutation → invalidate
nodes + trash + meter. Disabled/hidden when the trash is empty.

**Tests.** Server: empty-trash permanently removes all trashed nodes for the caller, subtracts
their bytes from `used_bytes`, unlinks blobs, leaves live nodes untouched, and is a no-op on an
empty trash. Web: the button confirms then calls the mutation; hidden when empty.

## 3.2 — (#7) Sorting for files and folders

**Web only (`web/src/features/dashboard/DriveView.tsx`, `Register`).** Client-side sort of the
current listing:
- Sort state `{ key: 'name'|'size'|'date', dir: 'asc'|'desc' }` (component state; default
  `name/asc`). Clicking a sortable column header (Name/Size/Date) toggles direction / switches key.
- **Folders first**, then files; within each group sort by the chosen key. Name uses
  `Intl.Collator('ar', { numeric: true, sensitivity: 'base' })`; size uses `size_bytes`; date uses
  `updated_at`.
- Header cells show an asc/desc affordance and `aria-sort`. No server change.

**Tests.** Web: rows reorder by name/size/date and by direction; folders stay grouped before files.

## 3.3 — (#8) Multi-select rows → bulk delete (to Trash)

**Web (`web/src/features/dashboard/DriveView.tsx`).**
- A checkbox column in `Register` + a header "select all (current folder)" checkbox. Selection is a
  `Set<number>` of node ids in component state, cleared on folder navigation.
- When ≥1 selected, show a bulk action bar: "نقل إلى المهملات (N)" + "إلغاء". Confirm once, then
  move each selected node to Trash by reusing the existing single-row trash mutation
  (`Promise.all` over the ids), then invalidate + clear selection. (Matches the single-row action,
  which trashes rather than permanently deletes.)
- Accessible: checkboxes have labels; the bulk bar is keyboard reachable.

**Optional server nicety (not required for v1):** a `POST /api/nodes/trash-bulk` that trashes an
array of ids in one transaction (atomicity + fewer round-trips). v1 loops the existing endpoint;
add the bulk endpoint only if the loop proves janky.

**Tests.** Web: selecting rows enables the bar; select-all toggles all; bulk delete calls trash for
each selected id and clears the selection; navigating folders clears selection.

---

## Cross-cutting: testing & rollout

- Every server change is TDD (failing test → impl → green); every web change likewise via the
  existing vitest + Testing Library setup. Full suite must stay green (`npm test` + `npm run
  typecheck`, both workspaces) at each commit.
- Per-phase: adversarial review of the diff before merge; merge `--no-ff` to main; rebuild +
  `docker compose up -d`; live-verify the nginx→container HTTPS chain via
  `curl --resolve project4.system.mow.gov.sy:443:127.0.0.1 …` (box can't hit its own public IP);
  headless-render the changed UI before calling it verified (lesson from the auth-pages placeholder).
- **Phase 2 only:** pre-deploy DB snapshot via `deploy/backup-mirsal.sh` + a rotation-safe copy,
  because it migrates the live DB (v2→v3). Migration is additive (`ADD COLUMN … NULL`) → zero data
  loss; verify `schema_version=3` + column present on the live DB post-deploy.
- **Stop after each phase** for the user to review and clear the conversation before the next.

## Out of scope / explicitly deferred
- No off-box backups (files remain transient, per the standing decision).
- Download limits stay single-file only (folder shares are uncounted/unlimited).
- Bulk delete is "move to Trash", not permanent delete (permanent stays a deliberate per-item or
  empty-trash action).
- Display name is admin-facing (admin list + audit labels); optionally greeting the user by it in
  their own header is a nice-to-have, not built here.
