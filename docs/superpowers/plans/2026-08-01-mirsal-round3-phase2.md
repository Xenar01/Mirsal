# Mirsal Round 3 — Phase 2 (Admin Features) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the admin panel four capabilities requested after live use — a per-user display name, audit-log rows that show usernames (not raw ids), a total-space summary across all users, and a "clear a user's whole drive" action — carried by one additive schema migration (`users.display_name`, v2→v3).

**Architecture:** Server is Fastify 5 + better-sqlite3 (ESM/NodeNext, TS strict); the admin surface stays **metadata-only** (no content/download path, no share tokens). One additive migration adds a nullable `users.display_name`. All other work threads that column through the existing admin DTO/route/web layers, resolves audit ids to usernames server-side, and adds one new audited route (`POST /api/admin/users/:id/clear`). Web is React 19 + Vite + TanStack Query + react-i18next + Tailwind (logical-property RTL); app UI strings are Arabic-only (`ar.json`).

**Tech Stack:** Fastify 5, better-sqlite3, zod, argon2, vitest (server); React 19, TanStack Query, react-i18next, Testing Library, vitest (web).

## Global Constraints

- **Branch:** `feat/round3-phase2-admin`, cut from `main` at `db82eff`. Merge to main only when the full suite is green.
- **Quality gates per workspace:** `npm test` (vitest) + `npm run typecheck` (tsc). **No eslint/lint script exists — do not invent one.**
- **Commit after every step** (disconnect-resilience); one commit per completed step/task.
- **Arabic-only app UI:** every new admin-facing string goes in `web/src/i18n/ar.json` only (the admin panel is never bilingual; only the public recipient page is, and Phase 2 touches nothing public).
- **Metadata-only admin invariant:** the admin surface never gains a content/download path and never receives a live share token. `redactAuditTarget` for `share_unlock_failure` MUST be preserved and MUST NOT be run through the new user-id resolution.
- **Constant-work login is untouched** in Phase 2 (no auth changes here).
- **One migration only:** `users.display_name`, additive (`ADD COLUMN … TEXT` nullable) → zero data loss. `LATEST_VERSION` goes 2 → 3. A **pre-deploy DB snapshot** is required before deploying this phase (handled at rollout, not in these tasks).
- **Column order:** `ALTER TABLE ADD COLUMN` appends at the end, so `schema.sql` must also add `display_name` as the **last** column of `users` — otherwise the fresh-vs-upgraded `PRAGMA table_info(users)` convergence test fails.
- **Test commands:** single-file server run `cd server && npx vitest run test/<path>`; single-file web run `cd web && npx vitest run test/<path>`. Full gate: `cd server && npm test && npm run typecheck` then `cd web && npm test && npm run typecheck`.

---

## File Structure

**Server (create none — all modifications):**

- `server/src/db/migrate.ts` — bump `LATEST_VERSION` to 3, add the v3 step.
- `server/src/db/schema.sql` — add `display_name TEXT` as the last `users` column.
- `server/src/routes/admin.ts` — display_name in DTO/columns/schemas/INSERT/PATCH; audit id→username resolution; new `POST /users/:id/clear` route; `blobStore` added to deps.
- `server/src/app.ts` — thread the existing `blobStore` instance into `adminRoutes`.
- `server/test/db/migrate.test.ts` — v3 migration tests.
- `server/test/routes/admin.test.ts` — display_name, audit resolution, and clear-space tests.

**Web (create one modal, rest modifications):**

- `web/src/features/admin/types.ts` — add `display_name` to `AdminUserDto`; add resolved-name fields to `AuditRowDto`.
- `web/src/features/admin/api.ts` — thread `display_name` through create/patch vars; add `clearUserSpace`; add a `USER_TARGET_ACTIONS` constant.
- `web/src/features/admin/queries.ts` — add `useClearUserSpace`.
- `web/src/features/admin/CreateUserModal.tsx` — display-name input.
- `web/src/features/admin/UsersTable.tsx` — "الاسم" column, total-space summary strip, label-edit + clear-space row actions and their modals.
- `web/src/features/admin/AuditLog.tsx` — render resolved actor/target names.
- `web/src/i18n/ar.json` — all new admin strings.
- `web/test/admin.test.tsx` — column, summary, label-edit, clear-space, and audit-name assertions.

---

## Task 1: Migration v2→v3 — `users.display_name`

**Files:**

- Modify: `server/src/db/migrate.ts:4` (`LATEST_VERSION`) and `:10-23` (`STEPS`)
- Modify: `server/src/db/schema.sql:5-19` (users table — append column)
- Test: `server/test/db/migrate.test.ts`

**Interfaces:**

- Consumes: existing `migrate(db)`, `STEPS`, `LATEST_VERSION` from `migrate.ts`.
- Produces: after `migrate(db)`, the `users` table has a `display_name TEXT` (nullable) column and `MAX(version)` in `schema_version` is `3`. Fresh and v2-upgraded `users` `PRAGMA table_info` converge.

- [ ] **Step 1: Write the failing migration tests**

Append to `server/test/db/migrate.test.ts` (after the existing `describe('migrate v2 download-limit columns', …)` block):

```ts
/** The exact pre-v3 `users` DDL (v2 baseline), used to simulate an old DB for the display_name migration. */
const V2_USERS = `CREATE TABLE users(
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','user')),
  quota_bytes INTEGER,
  used_bytes INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  root_node_id INTEGER,
  trash_node_id INTEGER,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL)`;

function userCols(db: Database.Database): string[] {
  return (db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[]).map((r) => r.name);
}

describe('migrate v3 users.display_name column', () => {
  it('a fresh DB has display_name and lands at version 3', () => {
    const db = new Database(':memory:');
    migrate(db);
    expect(userCols(db)).toContain('display_name');
    expect((db.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }).v).toBe(3);
  });

  it('adds display_name to a v2 DB and records version 3', () => {
    const db = new Database(':memory:');
    db.exec(V2_USERS);
    db.exec('CREATE TABLE schema_version(version INTEGER NOT NULL, applied_at INTEGER NOT NULL)');
    db.prepare('INSERT INTO schema_version(version, applied_at) VALUES (2, 0)').run();
    migrate(db);
    expect(userCols(db)).toContain('display_name');
    expect((db.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }).v).toBe(3);
  });

  it('fresh and upgraded users schemas converge (identical table_info)', () => {
    const fresh = new Database(':memory:');
    migrate(fresh);
    const upgraded = new Database(':memory:');
    upgraded.exec(V2_USERS);
    upgraded.exec('CREATE TABLE schema_version(version INTEGER NOT NULL, applied_at INTEGER NOT NULL)');
    upgraded.prepare('INSERT INTO schema_version(version, applied_at) VALUES (2, 0)').run();
    migrate(upgraded);
    expect(fresh.prepare('PRAGMA table_info(users)').all()).toEqual(upgraded.prepare('PRAGMA table_info(users)').all());
  });

  it('is idempotent across repeated boots at v3', () => {
    const db = new Database(':memory:');
    migrate(db);
    expect(() => {
      migrate(db);
      migrate(db);
    }).not.toThrow();
    expect((db.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }).v).toBe(3);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /var/www/projects/mirsal/server && npx vitest run test/db/migrate.test.ts`
Expected: FAIL — the new `describe('migrate v3 …')` cases fail (`display_name` absent, `MAX(version)` is `2`). The pre-existing v2 case that asserts `MAX(version) === 2` will now be discussed in Step 5.

- [ ] **Step 3: Bump `LATEST_VERSION` and add the v3 step**

In `server/src/db/migrate.ts`, change line 4:

```ts
export const LATEST_VERSION = 3;
```

Add a step to the `STEPS` array (after the existing `version: 2` object, keeping ascending order):

```ts
  {
    version: 3,
    up(db) {
      db.exec(`ALTER TABLE users ADD COLUMN display_name TEXT;`);
    },
  },
```

- [ ] **Step 4: Add `display_name` as the last `users` column in `schema.sql`**

In `server/src/db/schema.sql`, change the end of the `users` table (line 18) so `display_name` is appended after `updated_at` (matching the `ALTER … ADD COLUMN` append position):

```sql
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  display_name TEXT                              -- NULL = no label; free-text admin-facing name (v3)
);
```

- [ ] **Step 5: Fix the pre-existing v2 assertions that hard-coded version 2**

The existing `describe('migrate v2 download-limit columns', …)` block asserts `MAX(version)` is `2` in three cases and, in "a fresh DB … lands at version 2", now a fresh DB lands at `3`. Update those three `.toBe(2)` assertions inside that block to `.toBe(3)` (a fresh or fully-upgraded DB now reaches the latest version, `3`; the `shares` columns from v2 are still present). Leave the `shares`-column existence assertions unchanged. Do **not** change the `is idempotent` count assertion — it still expects exactly the migrations that ran, but that block's fresh DB now records versions {3} on the fresh path (a single `schema_version` row inserted with `LATEST_VERSION`), so its `COUNT(*) === 1` still holds. Verify by reading the file after editing.

- [ ] **Step 6: Run the migration tests to verify they pass**

Run: `cd /var/www/projects/mirsal/server && npx vitest run test/db/migrate.test.ts`
Expected: PASS (all v2 and v3 cases green).

- [ ] **Step 7: Commit**

```bash
cd /var/www/projects/mirsal
git add server/src/db/migrate.ts server/src/db/schema.sql server/test/db/migrate.test.ts
git commit -m "feat(server): migrate v2→v3 adding users.display_name column"
```

---

## Task 2: Display name — server (DTO, schemas, INSERT, PATCH)

**Files:**

- Modify: `server/src/routes/admin.ts` — `AdminUserDto` (`:27-36`), `USER_DTO_COLUMNS` (`:50-51`), `createUserSchema` (`:97-103`), create INSERT (`:210-216`), `patchUserSchema` (`:105-113`), PATCH set-builder (`:270-284`)
- Test: `server/test/routes/admin.test.ts`

**Interfaces:**

- Consumes: the v3 `users.display_name` column from Task 1.
- Produces: `AdminUserDto` now includes `display_name: string | null`. `POST /api/admin/users` accepts an optional `display_name` (free text, trimmed, ≤120 chars, no control chars; empty/whitespace → `null`). `PATCH /api/admin/users/:id` accepts the same optional field (explicit `null` clears it) and still requires ≥1 field. Both echo the stored `display_name` in the returned DTO.

- [ ] **Step 1: Write the failing server tests**

Add these tests to `server/test/routes/admin.test.ts` (they reuse the file's existing `makeApp`, `seedUser`, `login`, `adminReq` helpers). Place near the other user-create/patch tests:

```ts
test('POST /users persists and returns display_name (trimmed)', async () => {
  const built = await makeApp();
  await seedUser('admin', 'admin-pass-123', { role: 'admin' });
  const auth = await login(built, 'admin', 'admin-pass-123');
  const res = await adminReq(built, 'POST', '/api/admin/users', auth as { session: string; csrf: string }, {
    username: 'labeled',
    password: 'user-pass-123',
    role: 'user',
    display_name: '  أحمد الموظف  ',
  });
  expect(res.statusCode).toBe(201);
  expect(JSON.parse(res.body).display_name).toBe('أحمد الموظف');
});

test('POST /users without display_name stores null', async () => {
  const built = await makeApp();
  await seedUser('admin', 'admin-pass-123', { role: 'admin' });
  const auth = await login(built, 'admin', 'admin-pass-123');
  const res = await adminReq(built, 'POST', '/api/admin/users', auth as { session: string; csrf: string }, {
    username: 'nolabel',
    password: 'user-pass-123',
    role: 'user',
  });
  expect(res.statusCode).toBe(201);
  expect(JSON.parse(res.body).display_name).toBeNull();
});

test('PATCH /users/:id sets and then clears display_name', async () => {
  const built = await makeApp();
  await seedUser('admin', 'admin-pass-123', { role: 'admin' });
  const uid = await seedUser('target', 'x', { role: 'user' });
  const auth = (await login(built, 'admin', 'admin-pass-123')) as { session: string; csrf: string };

  const setRes = await adminReq(built, 'PATCH', `/api/admin/users/${uid}`, auth, { display_name: 'سارة' });
  expect(setRes.statusCode).toBe(200);
  expect(JSON.parse(setRes.body).display_name).toBe('سارة');

  const clearRes = await adminReq(built, 'PATCH', `/api/admin/users/${uid}`, auth, { display_name: null });
  expect(clearRes.statusCode).toBe(200);
  expect(JSON.parse(clearRes.body).display_name).toBeNull();
});

test('PATCH /users/:id with only display_name is accepted (refine allows it)', async () => {
  const built = await makeApp();
  await seedUser('admin', 'admin-pass-123', { role: 'admin' });
  const uid = await seedUser('target2', 'x', { role: 'user' });
  const auth = (await login(built, 'admin', 'admin-pass-123')) as { session: string; csrf: string };
  const res = await adminReq(built, 'PATCH', `/api/admin/users/${uid}`, auth, { display_name: 'علي' });
  expect(res.statusCode).toBe(200);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /var/www/projects/mirsal/server && npx vitest run test/routes/admin.test.ts -t "display_name"`
Expected: FAIL — `display_name` is `undefined`/not returned (column not projected, schema strips the unknown field).

- [ ] **Step 3: Add the display-name schema helper and thread it into the DTO/columns/schemas**

In `server/src/routes/admin.ts`:

Add near the other schema constants (after `USERNAME_RE`, before `createUserSchema`):

```ts
/** Max length of a display name (a trusted admin-facing label, never a path segment). */
const DISPLAY_NAME_MAX = 120;

// A free-text display label (Arabic or English). Trusted display string only —
// never used as a path segment. Trimmed; empty-after-trim collapses to null;
// bounded length; control chars rejected (defense-in-depth on a display value).
const displayNameSchema = z
  .string()
  .transform((s) => s.trim())
  .refine((s) => s.length <= DISPLAY_NAME_MAX, { message: 'display_name too long' })
  .refine(
    (s) =>
      ![...s].some((c) => {
        const n = c.charCodeAt(0);
        return n < 0x20 || n === 0x7f;
      }),
    { message: 'display_name has control chars' },
  )
  .transform((s) => (s.length === 0 ? null : s))
  .nullable()
  .optional();
```

Extend `AdminUserDto` (add the field, keeping the others):

```ts
interface AdminUserDto {
  id: number;
  username: string;
  role: string;
  is_active: number;
  quota_bytes: number | null;
  used_bytes: number;
  must_change_password: number;
  created_at: number;
  display_name: string | null;
}
```

Extend `USER_DTO_COLUMNS`:

```ts
const USER_DTO_COLUMNS =
  'id, username, role, is_active, quota_bytes, used_bytes, must_change_password, created_at, display_name';
```

Add the field to `createUserSchema`:

```ts
const createUserSchema = z.object({
  username: z.string().trim().regex(USERNAME_RE),
  password: z.string().min(1),
  role: z.enum(['admin', 'user']),
  quota_bytes: z.number().int().nonnegative().nullable().optional(),
  display_name: displayNameSchema,
});
```

Add the field to `patchUserSchema` and widen the refine:

```ts
const patchUserSchema = z
  .object({
    is_active: z.boolean().optional(),
    role: z.enum(['admin', 'user']).optional(),
    quota_bytes: z.number().int().nonnegative().nullable().optional(),
    display_name: displayNameSchema,
  })
  .refine(
    (v) =>
      v.is_active !== undefined || v.role !== undefined || v.quota_bytes !== undefined || v.display_name !== undefined,
    { message: 'at least one field is required' },
  );
```

- [ ] **Step 4: Persist display_name on create**

In the `POST /api/admin/users` handler, after `const quotaBytes = parsed.data.quota_bytes ?? null;` add:

```ts
const displayName = parsed.data.display_name ?? null;
```

Change the INSERT to include the column (both the column list and the `@displayName` param):

```ts
const info = db
  .prepare(
    `INSERT INTO users(username, password_hash, role, quota_bytes, used_bytes, is_active, must_change_password, display_name, created_by, created_at, updated_at)
           VALUES (@username, @hash, @role, @quotaBytes, 0, 1, 1, @displayName, @actor, @now, @now)`,
  )
  .run({ username, hash, role, quotaBytes, displayName, actor: req.user!.id, now: nowMs });
```

- [ ] **Step 5: Persist display_name on patch**

In the `PATCH /api/admin/users/:id` set-builder (after the `quota_bytes` block, before `sets.push('updated_at = @now')`) add:

```ts
if (parsed.data.display_name !== undefined) {
  sets.push('display_name = @displayName');
  params.displayName = parsed.data.display_name; // string | null (null clears)
}
```

- [ ] **Step 6: Run the server tests to verify they pass**

Run: `cd /var/www/projects/mirsal/server && npx vitest run test/routes/admin.test.ts`
Expected: PASS (new display_name tests green; existing admin tests still green).

- [ ] **Step 7: Typecheck + commit**

```bash
cd /var/www/projects/mirsal/server && npm run typecheck
cd /var/www/projects/mirsal
git add server/src/routes/admin.ts server/test/routes/admin.test.ts
git commit -m "feat(server): admin create/patch accept & return users.display_name"
```

---

## Task 3: Display name — web (type, api/queries, create form, table column, label-edit modal)

**Files:**

- Modify: `web/src/features/admin/types.ts:13-22` (`AdminUserDto`)
- Modify: `web/src/features/admin/api.ts:30-64` (`CreateUserVars`/`createUser`, `PatchUserVars`/`patchUser`)
- Modify: `web/src/features/admin/CreateUserModal.tsx` (add input + state)
- Modify: `web/src/features/admin/UsersTable.tsx` (column header + cell, label action + `LabelModal`)
- Modify: `web/src/i18n/ar.json` (new keys)
- Test: `web/test/admin.test.tsx`

**Interfaces:**

- Consumes: server `display_name` from Task 2.
- Produces: `AdminUserDto.display_name: string | null` (client mirror). `CreateUserVars.displayName?: string | null` and `PatchUserVars.displayName?: string | null` thread through to the request body as `display_name`. `UsersTable` renders a "الاسم" column and a "تسمية" row action opening `LabelModal`.

- [ ] **Step 1: Write the failing web tests**

Add to `web/test/admin.test.tsx`. First extend the local `AdminUser` interface and `mkUser` factory to carry `display_name` (add `display_name: string | null;` to the interface and `display_name: null,` to the `mkUser` defaults). Then add:

```ts
test('users table shows the display name column value and a placeholder when null', async () => {
  await renderAdmin({
    users: [
      mkUser({ id: 2, username: 'ahmed', display_name: 'أحمد الموظف' }),
      mkUser({ id: 3, username: 'noname', display_name: null }),
    ],
  });
  expect(screen.getByText('أحمد الموظف')).toBeInTheDocument();
  // the name column header is present
  expect(screen.getByText(t('admin.users.col.name'))).toBeInTheDocument();
});

test('create-user modal sends display_name in the POST body', async () => {
  const { calls } = stubFetch({ users: [] });
  await renderAdmin({}); // renderAdmin ignores calls; use the stub above
  // open create modal
  fireEvent.click(screen.getByText(t('admin.users.create')));
  const nameInput = screen.getByLabelText(t('admin.create.nameLabel'));
  fireEvent.change(nameInput, { target: { value: 'سارة' } });
  const userInput = screen.getByLabelText(t('admin.create.usernameLabel'));
  fireEvent.change(userInput, { target: { value: 'sara' } });
  await act(async () => {
    fireEvent.click(screen.getByText(t('admin.create.submit')));
  });
  const post = calls.find((c) => c.method === 'POST' && c.path === '/api/admin/users');
  expect(post?.body).toMatchObject({ username: 'sara', display_name: 'سارة' });
});
```

> Note on the create test: `renderAdmin` in this file builds its own stub via `stubFetch` internally in some helpers; if the existing `renderAdmin(cfg)` already installs the fetch stub and returns nothing, refactor this test to capture calls the way the sibling create tests do (look at `createPosts(calls)` / how other create tests obtain `calls`). Mirror the existing create-flow test's setup exactly rather than the sketch above — the assertion (`display_name` present in the POST body) is the contract.

- [ ] **Step 2: Run the web tests to verify they fail**

Run: `cd /var/www/projects/mirsal/web && npx vitest run test/admin.test.tsx -t "display name"` and `-t "display_name in the POST"`
Expected: FAIL — no name column, no name input, `display_name` absent from the body.

- [ ] **Step 3: Add `display_name` to the client type**

In `web/src/features/admin/types.ts`, extend `AdminUserDto`:

```ts
export interface AdminUserDto {
  id: number;
  username: string;
  role: 'admin' | 'user';
  is_active: 0 | 1;
  quota_bytes: number | null;
  used_bytes: number;
  must_change_password: 0 | 1;
  created_at: number;
  display_name: string | null;
}
```

- [ ] **Step 4: Thread `displayName` through the api vars**

In `web/src/features/admin/api.ts`:

Extend `CreateUserVars` and `createUser`:

```ts
export interface CreateUserVars {
  username: string;
  password: string;
  role: 'admin' | 'user';
  quotaBytes?: number | null;
  /** Free-text label; omit for none. */
  displayName?: string | null;
}

export function createUser(vars: CreateUserVars): Promise<AdminUserDto> {
  const body: Record<string, unknown> = {
    username: vars.username,
    password: vars.password,
    role: vars.role,
  };
  if (vars.quotaBytes !== undefined && vars.quotaBytes !== null) {
    body.quota_bytes = vars.quotaBytes;
  }
  if (vars.displayName !== undefined) {
    body.display_name = vars.displayName;
  }
  return apiPost<AdminUserDto>('/admin/users', body);
}
```

Extend `PatchUserVars` and `patchUser`:

```ts
export interface PatchUserVars {
  id: number;
  isActive?: boolean;
  role?: 'admin' | 'user';
  quotaBytes?: number | null;
  /** string sets a label; null clears it; omit = unchanged. */
  displayName?: string | null;
}

export function patchUser(vars: PatchUserVars): Promise<AdminUserDto> {
  const body: Record<string, unknown> = {};
  if (vars.isActive !== undefined) body.is_active = vars.isActive;
  if (vars.role !== undefined) body.role = vars.role;
  if (vars.quotaBytes !== undefined) body.quota_bytes = vars.quotaBytes;
  if (vars.displayName !== undefined) body.display_name = vars.displayName;
  return apiPatch<AdminUserDto>(`/admin/users/${vars.id}`, body);
}
```

- [ ] **Step 5: Add the display-name input to `CreateUserModal`**

In `web/src/features/admin/CreateUserModal.tsx`:

Add a `nameId` alongside the other `useId()` calls and a `displayName` state:

```ts
const nameId = useId();
```

```ts
const [displayName, setDisplayName] = useState('');
```

Reset it on open (inside the `useEffect(open)` block): add `setDisplayName('');`.

In `submit`, pass it to the mutation (send `null` when blank so the server stores null):

```ts
    const trimmedName = displayName.trim();
    create.mutate(
      { username: trimmedUser, password, role, quotaBytes, displayName: trimmedName === '' ? null : trimmedName },
```

Add the input to the form, immediately after the username `<div>` block (before the role block):

```tsx
<div>
  <label htmlFor={nameId} className="block font-body text-sm text-ink-2">
    {t('admin.create.nameLabel')}
  </label>
  <input
    id={nameId}
    type="text"
    value={displayName}
    onChange={(e) => setDisplayName(e.target.value)}
    className="mt-1 w-full rounded-lg border border-line bg-surface ps-3 pe-3 py-2 font-body text-sm text-ink"
  />
  <p className="mt-1 font-body text-xs text-ink-2">{t('admin.create.nameHint')}</p>
</div>
```

- [ ] **Step 6: Add the "الاسم" column and the label-edit action to `UsersTable`**

In `web/src/features/admin/UsersTable.tsx`:

Add a `labelTarget` state alongside the others in `UsersTable`:

```ts
const [labelTarget, setLabelTarget] = useState<AdminUserDto | null>(null);
```

Add the column header after the `username` `<th>` (before `role`):

```tsx
<th className="ps-3 pe-3 py-2 text-start font-medium">{t('admin.users.col.name')}</th>
```

Pass an `onLabel` prop to `UserRow` (in the `.map`) and render the label modal near the others:

```tsx
                  onLabel={() => setLabelTarget(row)}
```

```tsx
{
  labelTarget && <LabelModal user={labelTarget} onClose={() => setLabelTarget(null)} />;
}
```

In `UserRow`'s prop list add `onLabel: () => void;` and destructure it. Add the name **cell** right after the username `<td>` (before the role `<td>`):

```tsx
<td className="ps-3 pe-3 py-2">
  {row.display_name ? (
    <span className="font-body text-ink">{row.display_name}</span>
  ) : (
    <span className="font-body text-ink-2">{t('admin.users.noName')}</span>
  )}
</td>
```

Add a "تسمية" chip to the row actions (a plain, non-guarded action — placed next to the quota chip):

```tsx
<button type="button" onClick={onLabel} className={ADMIN_ACTION}>
  {t('admin.users.action.label')}
</button>
```

Add the `LabelModal` component (after `QuotaModal`, mirroring its shape):

```tsx
/* ── Edit display name ────────────────────────────────────────────────── */

function LabelModal({ user, onClose }: { user: AdminUserDto; onClose: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const patch = usePatchUser();
  const inputId = useId();
  const [value, setValue] = useState(user.display_name ?? '');

  function submit() {
    const trimmed = value.trim();
    patch.mutate(
      { id: user.id, displayName: trimmed === '' ? null : trimmed },
      {
        onSuccess: () => {
          toast({ kind: 'success', message: t('admin.users.toast.nameUpdated') });
          onClose();
        },
        onError: () => toast({ kind: 'error', message: t('admin.label.error') }),
      },
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('admin.label.title')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={submit} disabled={patch.isPending}>
            {t('admin.label.submit')}
          </Button>
        </>
      }
    >
      <label htmlFor={inputId} className="block font-body text-sm text-ink-2">
        {t('admin.label.label')}
      </label>
      <input
        id={inputId}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="mt-1 w-full rounded-lg border border-line bg-surface ps-3 pe-3 py-2 font-body text-sm text-ink"
      />
      <p className="mt-1 font-body text-xs text-ink-2">{t('admin.label.hint')}</p>
    </Modal>
  );
}
```

- [ ] **Step 7: Add the new i18n keys**

In `web/src/i18n/ar.json`, under `admin.users.col` add `"name": "الاسم"`; under `admin.users` add `"noName": "—"`; under `admin.users.action` add `"label": "تسمية"`; under `admin.users.toast` add `"nameUpdated": "حُدِّث الاسم."`. Under `admin.create` add:

```json
      "nameLabel": "الاسم المعروض (اختياري)",
      "nameHint": "اسم بالعربية أو الإنجليزية لتمييز المستخدم.",
```

Add a new `admin.label` block (e.g. after the `admin.quota` block):

```json
    "label": {
      "title": "تعديل الاسم المعروض",
      "label": "الاسم المعروض",
      "hint": "اتركه فارغًا لإزالة الاسم.",
      "submit": "حفظ",
      "error": "تعذّر تحديث الاسم. حاول مجددًا."
    },
```

(Watch trailing commas — validate the JSON parses; `npm test` will fail to import if it doesn't.)

- [ ] **Step 8: Run the web tests to verify they pass**

Run: `cd /var/www/projects/mirsal/web && npx vitest run test/admin.test.tsx`
Expected: PASS (new column/create tests green; existing admin tests still green).

- [ ] **Step 9: Typecheck + commit**

```bash
cd /var/www/projects/mirsal/web && npm run typecheck
cd /var/www/projects/mirsal
git add web/src/features/admin/types.ts web/src/features/admin/api.ts web/src/features/admin/CreateUserModal.tsx web/src/features/admin/UsersTable.tsx web/src/i18n/ar.json web/test/admin.test.tsx
git commit -m "feat(web): admin display-name column, create field, and label-edit modal"
```

---

## Task 4: Audit log shows usernames — server (id→username resolution)

**Files:**

- Modify: `server/src/routes/admin.ts` — audit handler (`:493-518`); add a `USER_TARGET_ACTIONS` constant near `AUDIT_TARGET_IS_SECRET` (`:154`)
- Test: `server/test/routes/admin.test.ts`

**Interfaces:**

- Consumes: `users.display_name` (Task 1/2), the existing `redactAuditTarget`.
- Produces: each `GET /api/admin/audit` row DTO gains `actor_username: string | null`, `actor_display_name: string | null`, `target_username: string | null`, `target_display_name: string | null`. Target names are resolved **only** for the user-target action set; `share_unlock_failure` targets stay redacted and are never resolved. The `target` field itself is unchanged (still `redactAuditTarget(action, target)`).

- [ ] **Step 1: Write the failing server tests**

Add to `server/test/routes/admin.test.ts`:

```ts
test('audit DTO resolves actor and user-target usernames, redacts secret targets', async () => {
  const built = await makeApp();
  const adminId = await seedUser('admin', 'admin-pass-123', { role: 'admin' });
  const auth = (await login(built, 'admin', 'admin-pass-123')) as { session: string; csrf: string };

  // A real user-management action → writes a user_create audit row with the new user's id as target.
  const createRes = await adminReq(built, 'POST', '/api/admin/users', auth, {
    username: 'newbie',
    password: 'user-pass-123',
    role: 'user',
    display_name: 'المستخدم الجديد',
  });
  const newId = JSON.parse(createRes.body).id as number;

  // A secret-target row (simulate a failed share unlock) inserted directly.
  db!
    .prepare('INSERT INTO audit_log(actor_id, action, target, detail, created_at) VALUES (NULL, ?, ?, NULL, ?)')
    .run('share_unlock_failure', 'super-secret-token-value', NOW);

  const res = await adminReq(built, 'GET', '/api/admin/audit', auth);
  expect(res.statusCode).toBe(200);
  const rows = JSON.parse(res.body) as Array<Record<string, unknown>>;

  const createRow = rows.find((r) => r.action === 'user_create' && Number(r.target) === newId)!;
  expect(createRow.actor_username).toBe('admin');
  expect(createRow.actor_id).toBe(adminId);
  expect(createRow.target_username).toBe('newbie');
  expect(createRow.target_display_name).toBe('المستخدم الجديد');

  const secretRow = rows.find((r) => r.action === 'share_unlock_failure')!;
  expect(secretRow.actor_username).toBeNull();
  expect(String(secretRow.target)).toMatch(/^redacted:/); // still redacted
  expect(secretRow.target_username).toBeNull(); // never resolved
});

test('audit DTO leaves target_username null for a deleted user target', async () => {
  const built = await makeApp();
  await seedUser('admin', 'admin-pass-123', { role: 'admin' });
  const auth = (await login(built, 'admin', 'admin-pass-123')) as { session: string; csrf: string };
  // Audit row referencing a user id that does not exist.
  db!
    .prepare('INSERT INTO audit_log(actor_id, action, target, detail, created_at) VALUES (NULL, ?, ?, NULL, ?)')
    .run('user_delete', '99999', NOW);
  const res = await adminReq(built, 'GET', '/api/admin/audit', auth);
  const rows = JSON.parse(res.body) as Array<Record<string, unknown>>;
  const row = rows.find((r) => r.action === 'user_delete' && r.target === '99999')!;
  expect(row.target_username).toBeNull();
  expect(row.target_display_name).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /var/www/projects/mirsal/server && npx vitest run test/routes/admin.test.ts -t "audit DTO"`
Expected: FAIL — the DTO has no `actor_username`/`target_username` fields.

- [ ] **Step 3: Add the user-target action set**

In `server/src/routes/admin.ts`, near `AUDIT_TARGET_IS_SECRET`, add:

```ts
/**
 * `audit_log.action` values whose `target` holds a **numeric user id** — the
 * only rows whose target should be resolved to a username/display-name for the
 * admin view. Deliberately excludes `login_*` (target is a plain username
 * string, not an id) and every share/secret action (see AUDIT_TARGET_IS_SECRET).
 * Adding an action here must guarantee its target is a users.id.
 */
const USER_TARGET_ACTIONS = new Set([
  'user_create',
  'user_update',
  'user_delete',
  'user_password_reset',
  'user_nodes_view',
  'user_clear_space',
]);
```

- [ ] **Step 4: Resolve ids to names in the audit handler**

Replace the DTO-mapping tail of the `GET /api/admin/audit` handler (the part after the `rows` SELECT, i.e. the `const dtos = rows.map(...)` line) with:

```ts
// Collect the distinct user ids we can resolve: every non-null actor, plus
// every numeric target of a user-target action (never a secret/username
// target). One lookup, then attach names to each DTO.
const ids = new Set<number>();
for (const r of rows) {
  if (r.actor_id !== null) ids.add(r.actor_id);
  if (USER_TARGET_ACTIONS.has(r.action) && r.target !== null && /^\d+$/.test(r.target)) {
    ids.add(Number(r.target));
  }
}

const nameById = new Map<number, { username: string; display_name: string | null }>();
if (ids.size > 0) {
  const idList = [...ids];
  const placeholders = idList.map(() => '?').join(',');
  const nameRows = db
    .prepare(`SELECT id, username, display_name FROM users WHERE id IN (${placeholders})`)
    .all(...idList) as { id: number; username: string; display_name: string | null }[];
  for (const nr of nameRows) nameById.set(nr.id, { username: nr.username, display_name: nr.display_name });
}

const dtos = rows.map((r) => {
  const actor = r.actor_id !== null ? nameById.get(r.actor_id) : undefined;
  const isUserTarget = USER_TARGET_ACTIONS.has(r.action) && r.target !== null && /^\d+$/.test(r.target);
  const targetUser = isUserTarget ? nameById.get(Number(r.target)) : undefined;
  return {
    ...r,
    target: redactAuditTarget(r.action, r.target),
    actor_username: actor?.username ?? null,
    actor_display_name: actor?.display_name ?? null,
    target_username: targetUser?.username ?? null,
    target_display_name: targetUser?.display_name ?? null,
  };
});
reply.code(200).send(dtos);
```

(The `redactAuditTarget` call is preserved verbatim; `USER_TARGET_ACTIONS` excludes `share_unlock_failure`, so a secret target is never used as a lookup id.)

- [ ] **Step 5: Run to verify pass**

Run: `cd /var/www/projects/mirsal/server && npx vitest run test/routes/admin.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
cd /var/www/projects/mirsal/server && npm run typecheck
cd /var/www/projects/mirsal
git add server/src/routes/admin.ts server/test/routes/admin.test.ts
git commit -m "feat(server): resolve audit actor/target ids to usernames (secrets stay redacted)"
```

---

## Task 5: Audit log shows usernames — web (render resolved names)

**Files:**

- Modify: `web/src/features/admin/types.ts:44-52` (`AuditRowDto`)
- Modify: `web/src/features/admin/api.ts` (add `USER_TARGET_ACTIONS` client mirror)
- Modify: `web/src/features/admin/AuditLog.tsx` (actor + target cells)
- Modify: `web/src/i18n/ar.json` (`admin.audit.deleted`, `admin.audit.action.user_clear_space`)
- Test: `web/test/admin.test.tsx`

**Interfaces:**

- Consumes: the resolved-name fields from Task 4.
- Produces: `AuditRowDto` gains `actor_username`, `actor_display_name`, `target_username`, `target_display_name` (all `string | null`). The actor cell renders `display_name || username || '#'+id` (or "النظام" for a null actor); the target cell renders the resolved name for user-target actions (with a "(محذوف)" hint when unresolved) and the raw redacted/plain target otherwise.

- [ ] **Step 1: Write the failing web test**

Add to `web/test/admin.test.tsx` (build the audit fixture inline in the test):

```ts
test('audit log renders actor and target usernames, not ids', async () => {
  await renderAdmin({
    audit: [
      {
        id: 1,
        actor_id: 1,
        action: 'user_create',
        target: '2',
        detail: null,
        created_at: NOW,
        actor_username: 'admin',
        actor_display_name: null,
        target_username: 'newbie',
        target_display_name: 'المستخدم الجديد',
      },
    ],
  });
  // switch to the audit tab
  fireEvent.click(screen.getByText(t('admin.tabs.audit')));
  await act(async () => {});
  expect(screen.getByText('admin')).toBeInTheDocument();
  expect(screen.getByText('المستخدم الجديد')).toBeInTheDocument();
});
```

> If the existing audit tests already navigate to the audit tab via a helper, reuse that helper. The contract asserted: the actor username ("admin") and the resolved target display-name render.

- [ ] **Step 2: Run to verify failure**

Run: `cd /var/www/projects/mirsal/web && npx vitest run test/admin.test.tsx -t "actor and target usernames"`
Expected: FAIL — the cell still prints the numeric id.

- [ ] **Step 3: Extend `AuditRowDto`**

In `web/src/features/admin/types.ts`:

```ts
export interface AuditRowDto {
  id: number;
  actor_id: number | null;
  action: string;
  target: string | null;
  detail: string | null;
  created_at: number;
  actor_username: string | null;
  actor_display_name: string | null;
  target_username: string | null;
  target_display_name: string | null;
}
```

- [ ] **Step 4: Add the client `USER_TARGET_ACTIONS` mirror**

In `web/src/features/admin/api.ts`, add (near the other exported constants):

```ts
/**
 * Client mirror of the server's user-target audit actions (admin.ts). Used only
 * to decide whether an *unresolved* target id should show a "(deleted user)"
 * hint vs. be rendered as a plain value. Server remains the source of truth.
 */
export const USER_TARGET_ACTIONS = new Set([
  'user_create',
  'user_update',
  'user_delete',
  'user_password_reset',
  'user_nodes_view',
  'user_clear_space',
]);
```

- [ ] **Step 5: Render resolved names in `AuditLog`**

In `web/src/features/admin/AuditLog.tsx`, import the set:

```ts
import { AUDIT_PAGE_SIZE, USER_TARGET_ACTIONS } from './api';
```

Replace the **actor** `<td>` body with:

```tsx
<td className="ps-3 pe-3 py-2">
  {entry.actor_id === null ? (
    <span className="text-ink-2">{t('admin.audit.system')}</span>
  ) : entry.actor_display_name || entry.actor_username ? (
    <span className="font-body text-ink">{entry.actor_display_name || entry.actor_username}</span>
  ) : (
    <bdi dir="ltr" className="font-mono text-ink">
      {`#${entry.actor_id}`}
    </bdi>
  )}
</td>
```

Replace the **target** `<td>` body with:

```tsx
<td className="ps-3 pe-3 py-2">
  {entry.target === null ? (
    <span className="text-ink-2">—</span>
  ) : entry.target_display_name || entry.target_username ? (
    <span className="font-body text-ink-2">{entry.target_display_name || entry.target_username}</span>
  ) : USER_TARGET_ACTIONS.has(entry.action) ? (
    <bdi dir="ltr" className="font-mono text-ink-2 break-all">
      {`#${entry.target} ${t('admin.audit.deleted')}`}
    </bdi>
  ) : (
    <bdi dir="ltr" className="font-mono text-ink-2 break-all">
      {entry.target}
    </bdi>
  )}
</td>
```

- [ ] **Step 6: Add i18n keys**

In `web/src/i18n/ar.json`, under `admin.audit` add `"deleted": "(محذوف)"`; under `admin.audit.action` add `"user_clear_space": "تفريغ مساحة مستخدم"`.

- [ ] **Step 7: Run to verify pass**

Run: `cd /var/www/projects/mirsal/web && npx vitest run test/admin.test.tsx`
Expected: PASS.

- [ ] **Step 8: Typecheck + commit**

```bash
cd /var/www/projects/mirsal/web && npm run typecheck
cd /var/www/projects/mirsal
git add web/src/features/admin/types.ts web/src/features/admin/api.ts web/src/features/admin/AuditLog.tsx web/src/i18n/ar.json web/test/admin.test.tsx
git commit -m "feat(web): audit log renders resolved usernames/display-names, not ids"
```

---

## Task 6: Total space used by all users — web (summary strip)

**Files:**

- Modify: `web/src/features/admin/UsersTable.tsx` (summary strip above the table)
- Modify: `web/src/i18n/ar.json` (`admin.users.summary.*`)
- Test: `web/test/admin.test.tsx`

**Interfaces:**

- Consumes: `AdminUserDto.used_bytes` / `quota_bytes` (already returned by `GET /api/admin/users`; no server change).
- Produces: a summary strip in `UsersTable` showing the user count, `Σ used_bytes` (formatted via `formatBytes`), and total allocated quota (`Σ quota_bytes`, with any null quota making the total read "غير محدودة").

- [ ] **Step 1: Write the failing web test**

Add to `web/test/admin.test.tsx`:

```ts
test('users table shows a total-space summary across all users', async () => {
  await renderAdmin({
    users: [
      mkUser({ id: 2, username: 'a', used_bytes: 1024 * 1024, quota_bytes: 10 * 1024 * 1024 }),
      mkUser({ id: 3, username: 'b', used_bytes: 3 * 1024 * 1024, quota_bytes: 20 * 1024 * 1024 }),
    ],
  });
  // Σ used = 4 MB → formatBytes renders "4" and the MB unit somewhere in the strip.
  expect(screen.getByTestId('admin-users-summary')).toHaveTextContent('4');
  // user count = 2
  expect(screen.getByTestId('admin-users-summary')).toHaveTextContent('2');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /var/www/projects/mirsal/web && npx vitest run test/admin.test.tsx -t "total-space summary"`
Expected: FAIL — no `admin-users-summary` element.

- [ ] **Step 3: Render the summary strip**

In `web/src/features/admin/UsersTable.tsx`, compute totals inside `UsersTable` (after `const users = …`):

```ts
const totalUsed = users.reduce((sum, u) => sum + u.used_bytes, 0);
const anyUnlimited = users.some((u) => u.quota_bytes === null);
const totalQuota = users.reduce((sum, u) => sum + (u.quota_bytes ?? 0), 0);
```

Render a strip immediately above the table block (inside the `!isPending && !isError && users.length > 0` region, before the `<div className="overflow-x-auto …">`):

```tsx
<div
  data-testid="admin-users-summary"
  className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-[10px] border border-line bg-surface ps-3 pe-3 py-2 font-body text-sm text-ink-2"
>
  <span>{t('admin.users.summary.count', { count: users.length })}</span>
  <span>
    {t('admin.users.summary.used')}{' '}
    <bdi dir="ltr" className="font-mono text-ink">
      {formatBytes(totalUsed)}
    </bdi>
  </span>
  <span>
    {t('admin.users.summary.allocated')}{' '}
    {anyUnlimited ? (
      <span className="text-ink">{t('admin.users.unlimited')}</span>
    ) : (
      <bdi dir="ltr" className="font-mono text-ink">
        {formatBytes(totalQuota)}
      </bdi>
    )}
  </span>
</div>
```

(`formatBytes` is already imported at the top of the file.)

- [ ] **Step 4: Add i18n keys**

In `web/src/i18n/ar.json`, add under `admin.users` a `summary` block:

```json
      "summary": {
        "count": "المستخدمون: {{count}}",
        "used": "إجمالي المستخدَم:",
        "allocated": "إجمالي المخصَّص:"
      },
```

- [ ] **Step 5: Run to verify pass**

Run: `cd /var/www/projects/mirsal/web && npx vitest run test/admin.test.tsx`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
cd /var/www/projects/mirsal/web && npm run typecheck
cd /var/www/projects/mirsal
git add web/src/features/admin/UsersTable.tsx web/src/i18n/ar.json web/test/admin.test.tsx
git commit -m "feat(web): admin users total-space summary strip"
```

---

## Task 7: Clear a user's space — server (`POST /api/admin/users/:id/clear`)

**Files:**

- Modify: `server/src/routes/admin.ts` — imports, `AdminRouteDeps`, new route
- Modify: `server/src/app.ts:106-114` — thread `blobStore` into `adminRoutes`
- Test: `server/test/routes/admin.test.ts`

**Interfaces:**

- Consumes: `blobStore.deleteBlob(storagePath)` (from `server/src/storage/blobs.ts`), `ensureUserRoots(db, userId, now)` (from `server/src/nodes/tree.js`), `writeAudit`.
- Produces: `POST /api/admin/users/:id/clear` (requireAdmin, CSRF, audited). Permanently deletes every `folder`/`file` node the user owns (cascading their shares), unlinks the file blobs, resets `used_bytes = 0`, guarantees an empty root/trash, and returns the refreshed `AdminUserDto`. 404 for an unknown user. Writes a `user_clear_space` audit row (target = user id).

- [ ] **Step 1: Write the failing server tests**

Add to `server/test/routes/admin.test.ts`. This test seeds a user, gives them a live file node + a real blob on disk, then clears:

```ts
test('POST /users/:id/clear wipes the user drive, frees quota, keeps roots, unlinks blobs', async () => {
  const built = await makeApp();
  await seedUser('admin', 'admin-pass-123', { role: 'admin' });
  const uid = await seedUser('victim', 'x', { role: 'user', quotaBytes: 100 * 1024 * 1024 });
  const auth = (await login(built, 'admin', 'admin-pass-123')) as { session: string; csrf: string };

  const roots = ensureUserRoots(db!, uid, NOW);
  // A real blob on disk under STORAGE_DIR/<uid>/<name>.
  const storageDir = path.join(dir!, 'storage');
  const ownerDir = path.join(storageDir, String(uid));
  fs.mkdirSync(ownerDir, { recursive: true });
  const blobRel = `${uid}/blob1`;
  fs.writeFileSync(path.join(storageDir, blobRel), 'hello');

  // A folder + a file inside it, and used_bytes set to the file size.
  const folderId = Number(
    db!
      .prepare(`INSERT INTO nodes(owner_id, parent_id, kind, name, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
      .run(uid, roots.rootId, 'folder', 'Docs', NOW, NOW).lastInsertRowid,
  );
  db!
    .prepare(
      `INSERT INTO nodes(owner_id, parent_id, kind, name, size_bytes, storage_path, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(uid, folderId, 'file', 'a.txt', 5, blobRel, NOW, NOW);
  db!.prepare('UPDATE users SET used_bytes = 5 WHERE id = ?').run(uid);

  const res = await adminReq(built, 'POST', `/api/admin/users/${uid}/clear`, auth);
  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body).used_bytes).toBe(0);

  // No folder/file nodes remain for this user; root+trash remain.
  const remaining = db!
    .prepare(`SELECT COUNT(*) c FROM nodes WHERE owner_id = ? AND kind IN ('folder','file')`)
    .get(uid) as { c: number };
  expect(remaining.c).toBe(0);
  const roleCounts = db!
    .prepare(`SELECT COUNT(*) c FROM nodes WHERE owner_id = ? AND kind IN ('root','trash')`)
    .get(uid) as { c: number };
  expect(roleCounts.c).toBe(2);
  // Blob unlinked.
  expect(fs.existsSync(path.join(storageDir, blobRel))).toBe(false);
  // Audited.
  const audit = db!
    .prepare(`SELECT COUNT(*) c FROM audit_log WHERE action = 'user_clear_space' AND target = ?`)
    .get(String(uid)) as { c: number };
  expect(audit.c).toBe(1);
});

test('POST /users/:id/clear cascades the user shares', async () => {
  const built = await makeApp();
  await seedUser('admin', 'admin-pass-123', { role: 'admin' });
  const uid = await seedUser('victim2', 'x', { role: 'user' });
  const auth = (await login(built, 'admin', 'admin-pass-123')) as { session: string; csrf: string };
  const roots = ensureUserRoots(db!, uid, NOW);
  const fileId = Number(
    db!
      .prepare(
        `INSERT INTO nodes(owner_id, parent_id, kind, name, size_bytes, storage_path, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(uid, roots.rootId, 'file', 'b.txt', 0, `${uid}/b`, NOW, NOW).lastInsertRowid,
  );
  db!
    .prepare(`INSERT INTO shares(node_id, owner_id, token, is_active, allow_download, created_at) VALUES (?,?,?,?,?,?)`)
    .run(fileId, uid, 'tok-clear-test', 1, 1, NOW);

  await adminReq(built, 'POST', `/api/admin/users/${uid}/clear`, auth);
  const shares = db!.prepare(`SELECT COUNT(*) c FROM shares WHERE owner_id = ?`).get(uid) as { c: number };
  expect(shares.c).toBe(0);
});

test('POST /users/:id/clear on an unknown user → 404', async () => {
  const built = await makeApp();
  await seedUser('admin', 'admin-pass-123', { role: 'admin' });
  const auth = (await login(built, 'admin', 'admin-pass-123')) as { session: string; csrf: string };
  const res = await adminReq(built, 'POST', '/api/admin/users/99999/clear', auth);
  expect(res.statusCode).toBe(404);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /var/www/projects/mirsal/server && npx vitest run test/routes/admin.test.ts -t "clear"`
Expected: FAIL — route returns 404 for all (unregistered → not-found handler).

- [ ] **Step 3: Thread `blobStore` into `adminRoutes` deps + imports**

In `server/src/routes/admin.ts`, add imports:

```ts
import type { BlobStore } from '../storage/blobs.js';
import { ensureUserRoots } from '../nodes/tree.js';
```

Extend `AdminRouteDeps`:

```ts
export interface AdminRouteDeps {
  db: Database.Database;
  now: Clock;
  guards: Guards;
  passwordService: PasswordService;
  blobStore: BlobStore;
}
```

Destructure it in the plugin body (`const { db, now, guards, passwordService } = deps;` → add `blobStore`):

```ts
const { db, now, guards, passwordService, blobStore } = deps;
```

- [ ] **Step 4: Wire the existing `blobStore` instance in `app.ts`**

In `server/src/app.ts`, move the `blobStore` creation **above** the `adminRoutes` registration and pass it in. Change the block at lines ~104-114 so it reads:

```ts
const blobStore = createBlobStore({ storageDir: deps.config.STORAGE_DIR });

// H5: admin control panel — every route `guards.requireAdmin` + CSRF
// (inherited) + audited. Same single `passwordService`/`guards`/`blobStore`.
await app.register(adminRoutes, {
  db: deps.db,
  now: deps.now,
  guards,
  passwordService,
  blobStore,
});

await app.register(nodesRoutes, { db: deps.db, now: deps.now, guards, blobStore });
```

(There is now a single `createBlobStore` call shared by admin, nodes, and public — remove the second `const blobStore = createBlobStore(...)` that previously sat between admin and nodes so it is not declared twice.)

- [ ] **Step 5: Add the clear-space route**

In `server/src/routes/admin.ts`, add this handler in the `// --- Users ---` section (e.g. after the `DELETE /api/admin/users/:id` handler, before `GET /users/:id/nodes`):

```ts
// Permanently wipe a user's whole drive (live + trashed): delete every
// folder/file they own (FK cascade removes subtrees + their shares), unlink
// the file blobs, reset used_bytes to 0, and guarantee an empty root/trash.
// The account/login/role/quota are preserved. Audited (metadata-only — no
// content is ever read).
app.post('/api/admin/users/:id/clear', { preHandler: guards.requireAdmin }, async (req, reply) => {
  const id = parseIdParam(req);
  if (id === null) {
    reply.code(404).send({ error: 'not_found' });
    return;
  }
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(id) as { id: number } | undefined;
  if (!target) {
    reply.code(404).send({ error: 'not_found' });
    return;
  }

  // Collect blob paths BEFORE deletion (unlink is post-commit — a rollback
  // must never orphan a still-referenced blob).
  const blobRows = db
    .prepare(`SELECT storage_path FROM nodes WHERE owner_id = ? AND kind = 'file' AND storage_path IS NOT NULL`)
    .all(id) as { storage_path: string }[];
  const storagePaths = blobRows.map((r) => r.storage_path);

  const nowMs = now();
  const run = db.transaction(() => {
    db.prepare(`DELETE FROM nodes WHERE owner_id = @id AND kind IN ('folder','file')`).run({ id });
    db.prepare('UPDATE users SET used_bytes = 0, updated_at = @now WHERE id = @id').run({ id, now: nowMs });
    writeAudit(
      db,
      { actorId: req.user!.id, action: 'user_clear_space', target: String(id), detail: `${storagePaths.length} files` },
      now,
    );
  });
  run();

  // Best-effort blob unlink (non-fatal; the scheduler's orphan sweep reaps
  // any straggler, same as the user-delete path).
  for (const p of storagePaths) {
    try {
      blobStore.deleteBlob(p);
    } catch {
      // ignore — orphan sweep handles it
    }
  }
  // Root/trash are kind 'root'/'trash' (never deleted above), so this is
  // idempotent; call it to guarantee the pair exists.
  ensureUserRoots(db, id, nowMs);

  const dto = db.prepare(`SELECT ${USER_DTO_COLUMNS} FROM users WHERE id = ?`).get(id) as AdminUserDto;
  reply.code(200).send(dto);
});
```

- [ ] **Step 6: Run the server suite to verify pass**

Run: `cd /var/www/projects/mirsal/server && npx vitest run test/routes/admin.test.ts test/app.test.ts`
Expected: PASS (clear tests green; `app.test.ts` still green after the blobStore rewiring).

- [ ] **Step 7: Typecheck + commit**

```bash
cd /var/www/projects/mirsal/server && npm run typecheck
cd /var/www/projects/mirsal
git add server/src/routes/admin.ts server/src/app.ts server/test/routes/admin.test.ts
git commit -m "feat(server): POST /admin/users/:id/clear wipes a user drive (audited)"
```

---

## Task 8: Clear a user's space — web (chip + confirm modal + mutation)

**Files:**

- Modify: `web/src/features/admin/api.ts` (add `clearUserSpace`)
- Modify: `web/src/features/admin/queries.ts` (add `useClearUserSpace`)
- Modify: `web/src/features/admin/UsersTable.tsx` (clear-space chip + `ClearSpaceModal`)
- Modify: `web/src/i18n/ar.json` (`admin.users.action.clearSpace`, `admin.clearSpace.*`, `admin.users.toast.cleared`)
- Test: `web/test/admin.test.tsx`

**Interfaces:**

- Consumes: `POST /api/admin/users/:id/clear` (Task 7).
- Produces: `clearUserSpace(id): Promise<AdminUserDto>` and `useClearUserSpace()` (invalidates `['admin','users']`). A "تفريغ المساحة" danger chip in each user row opens a danger `ConfirmModal` that calls the mutation.

- [ ] **Step 1: Write the failing web test**

Add to `web/test/admin.test.tsx`:

```ts
test('clear-space confirm calls POST /clear and refreshes the row', async () => {
  const { calls } = stubFetch({
    users: [mkUser({ id: 2, username: 'victim', used_bytes: 5 * 1024 * 1024, quota_bytes: 10 * 1024 * 1024 })],
    overrides: { 'POST /api/admin/users/2/clear': [200, mkUser({ id: 2, username: 'victim', used_bytes: 0 })] },
  });
  await renderAdmin({}); // reuse the stub installed above (mirror sibling tests' pattern)

  fireEvent.click(within(screen.getByTestId('user-row-2')).getByText(t('admin.users.action.clearSpace')));
  await act(async () => {
    fireEvent.click(screen.getByText(t('admin.clearSpace.confirm')));
  });
  const call = calls.find((c) => c.method === 'POST' && c.path === '/api/admin/users/2/clear');
  expect(call).toBeTruthy();
});
```

> As in Task 3, mirror the exact stub-capture pattern the sibling delete/reset tests use (how they obtain `calls` and render). The contract: clicking the chip then confirming issues `POST /api/admin/users/2/clear`.

- [ ] **Step 2: Run to verify failure**

Run: `cd /var/www/projects/mirsal/web && npx vitest run test/admin.test.tsx -t "clear-space confirm"`
Expected: FAIL — no clear-space chip.

- [ ] **Step 3: Add the api wrapper**

In `web/src/features/admin/api.ts` (in the `// --- Users ---` section):

```ts
export function clearUserSpace(id: number): Promise<AdminUserDto> {
  return apiPost<AdminUserDto>(`/admin/users/${id}/clear`, {});
}
```

- [ ] **Step 4: Add the mutation hook**

In `web/src/features/admin/queries.ts`:

```ts
export function useClearUserSpace() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => adminApi.clearUserSpace(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: usersKey });
    },
  });
}
```

- [ ] **Step 5: Add the chip + `ClearSpaceModal`**

In `web/src/features/admin/UsersTable.tsx`:

Import the hook (extend the existing `./queries` import):

```ts
import { useAdminUsers, usePatchUser, useResetPassword, useDeleteUser, useClearUserSpace } from './queries';
```

Add a `clearTarget` state in `UsersTable`:

```ts
const [clearTarget, setClearTarget] = useState<AdminUserDto | null>(null);
```

Pass `onClearSpace` into `UserRow` in the `.map`:

```tsx
                  onClearSpace={() => setClearTarget(row)}
```

Render the modal near the others:

```tsx
{
  clearTarget && <ClearSpaceModal user={clearTarget} onClose={() => setClearTarget(null)} />;
}
```

In `UserRow`'s props add `onClearSpace: () => void;`, destructure it, and add a danger chip next to the delete action:

```tsx
<button type="button" onClick={onClearSpace} className={ADMIN_ACTION_DANGER}>
  {t('admin.users.action.clearSpace')}
</button>
```

Add the modal (mirroring `DeleteUserModal`, danger variant):

```tsx
/* ── Clear user space (destructive confirm) ───────────────────────────── */

function ClearSpaceModal({ user, onClose }: { user: AdminUserDto; onClose: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const clear = useClearUserSpace();

  function confirm() {
    clear.mutate(user.id, {
      onSuccess: () => {
        toast({ kind: 'success', message: t('admin.users.toast.cleared') });
        onClose();
      },
      onError: () => {
        toast({ kind: 'error', message: t('admin.clearSpace.error') });
        onClose();
      },
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('admin.clearSpace.title')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" onClick={confirm} disabled={clear.isPending}>
            {t('admin.clearSpace.confirm')}
          </Button>
        </>
      }
    >
      <p className="font-body text-sm text-ink">{t('admin.clearSpace.body', { username: user.username })}</p>
    </Modal>
  );
}
```

- [ ] **Step 6: Add i18n keys**

In `web/src/i18n/ar.json`: under `admin.users.action` add `"clearSpace": "تفريغ المساحة"`; under `admin.users.toast` add `"cleared": "أُفرغت مساحة المستخدم."`; add a new `admin.clearSpace` block:

```json
    "clearSpace": {
      "title": "تفريغ مساحة المستخدم",
      "body": "سيُحذف نهائيًا كل ما رفعه «{{username}}» من ملفات ومجلدات (بما في ذلك المهملات) وتُلغى روابط مشاركته، وتُصفَّر مساحته المستخدَمة. يبقى الحساب. لا يمكن التراجع. متابعة؟",
      "confirm": "تفريغ نهائي",
      "error": "تعذّر تفريغ المساحة. حاول مجددًا."
    },
```

- [ ] **Step 7: Run to verify pass**

Run: `cd /var/www/projects/mirsal/web && npx vitest run test/admin.test.tsx`
Expected: PASS.

- [ ] **Step 8: Typecheck + commit**

```bash
cd /var/www/projects/mirsal/web && npm run typecheck
cd /var/www/projects/mirsal
git add web/src/features/admin/api.ts web/src/features/admin/queries.ts web/src/features/admin/UsersTable.tsx web/src/i18n/ar.json web/test/admin.test.tsx
git commit -m "feat(web): admin clear-user-space action with danger confirm"
```

---

## Final verification (before declaring Phase 2 done)

- [ ] **Full server gate:** `cd /var/www/projects/mirsal/server && npm test && npm run typecheck` — all green.
- [ ] **Full web gate:** `cd /var/www/projects/mirsal/web && npm test && npm run typecheck` — all green.
- [ ] **Confirm the branch is `feat/round3-phase2-admin`, tree clean, one commit per task.**
- [ ] **STOP.** Do not merge or deploy. Report the green suite counts + the migration/DB-snapshot reminder to the user and wait for explicit review + "go" (`feedback_phase_pause`). Rollout (merge `--no-ff`, **pre-deploy DB snapshot** via `deploy/backup-mirsal.sh`, `docker compose build && up -d`, live HTTPS-chain verify via `curl --resolve project4.system.mow.gov.sy:443:127.0.0.1`, headless-render the admin panel, and confirm live `schema_version=3` + `display_name` present) happens only after approval.

---

## Self-review notes (author checklist — verified while writing)

- **Spec coverage:** 2.0 → Task 1; 2.1 → Tasks 2 (server) + 3 (web); 2.2 → Tasks 4 (server) + 5 (web); 2.3 → Task 6; 2.4 → Tasks 7 (server) + 8 (web). All Phase-2 spec sections mapped.
- **Type consistency:** `display_name: string | null` is identical in the server DTO (Task 2), client `AdminUserDto` (Task 3), and every SELECT (`USER_DTO_COLUMNS`). `USER_TARGET_ACTIONS` is defined once server-side (Task 4) and mirrored once client-side (Task 5) with the same six actions including `user_clear_space` (added in Task 7's route). `clearUserSpace`/`useClearUserSpace` names match across Tasks 7-8. `blobStore` is the single shared instance (Task 7 Step 4).
- **Migration convergence:** `schema.sql` appends `display_name` last (Task 1 Step 4) so fresh and ALTER-upgraded `users` `table_info` converge (Task 1 Step 1's third case).
- **Security invariants preserved:** `redactAuditTarget` is untouched and `USER_TARGET_ACTIONS` excludes `share_unlock_failure`, so a secret target is never resolved (Task 4). The admin surface gains no content path — clear-space reads only `storage_path` strings for unlink, never file contents (Task 7).
