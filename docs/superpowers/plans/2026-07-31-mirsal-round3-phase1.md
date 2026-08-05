# Mirsal Round 3 — Phase 1 (Bug Fixes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four live-facing Mirsal bugs from the round-3 batch: (#3) a user's assigned quota is invisible on their own dashboard, (#9) a deactivated login looks like a wrong password, (#10) a shared folder leaks its contents on the recipient page, and (#11) a password link never re-prompts.

**Architecture:** Server = Fastify 5 + better-sqlite3 (routes in `server/src/routes/*`); web = React 19 + Vite + TanStack Query + react-i18next (features in `web/src/features/*`). No schema change in Phase 1. Each fix is one or two TDD tasks (server test via `built.inject`, web test via Testing Library + a `fetch` stub).

**Tech Stack:** TypeScript (strict, ESM/NodeNext), vitest, better-sqlite3, Fastify, React, TanStack Query, i18next, Tailwind.

## Global Constraints

- Branch: `feat/round3-phase1-bugfixes` (already created off `main`). Commit after every task; the post-commit hook auto-pushes to the private origin.
- Quality gates per workspace: `npm test` (vitest) + `npm run typecheck` (tsc). **No eslint/lint script exists — do not run one.**
- App UI strings are **Arabic-only** (`web/src/i18n/ar.json`); only the public recipient page is bilingual (`ar.json` + `en.json`) — any new recipient-facing string goes in BOTH.
- Anti-enumeration login stays constant-work: exactly ONE argon2 verify per attempt. The dummy hash is used only when there is no such user.
- Public failures stay constant-shape (`{ error: 'forbidden' }` / `{ error: 'not_found' }`) — no existence oracle.
- Single-file test run (server): `cd server && npx vitest run <path>`. Web: `cd web && npx vitest run <path>`. Full green before merge: `npm test` + `npm run typecheck` in BOTH `server/` and `web/`.
- Reference spec: `docs/superpowers/specs/2026-07-31-mirsal-round3-design.md` (§Phase 1).

---

## File Structure

- `server/src/routes/auth.ts` — Task 1 (expose quota on `/me`+`/login`), Task 3 (deactivated login).
- `server/test/routes/auth.test.ts` — Tasks 1 & 3 tests (extend; Task 3 rewrites one existing test).
- `web/src/features/auth/auth-context.tsx` — Task 2 (`PublicUser` gains quota fields).
- `web/src/features/dashboard/StorageMeter.tsx` — Task 2 (quota bar).
- `web/test/storage-meter.test.tsx` — Task 2 (new).
- `web/src/features/auth/LoginPage.tsx` + `web/src/i18n/ar.json` — Task 4 (deactivated message).
- `web/test/login.test.tsx` — Task 4 test.
- `server/src/routes/public.ts` — Task 5 (folder share blocks list/per-file download), Task 7 (unlock cookie → session, 600s).
- `server/test/routes/public.test.ts` — Task 5 (rewrite the folder test), Task 7 (update lifetime test + add session-cookie test).
- `web/src/features/public/PublicFolder.tsx` — Task 6 (name + ZIP only).
- `web/src/features/public/api.ts` + `web/src/features/public/queries.ts` + `web/src/features/public/SealedDispatch.tsx` — Task 8 (meta omits cookie until unlocked).
- `web/test/public.test.tsx` — Tasks 6 & 8 (new tests).

---

## Task 1: (#3 server) `/me` and `/login` expose `quotaBytes` + `usedBytes`

**Files:**

- Modify: `server/src/routes/auth.ts`
- Test: `server/test/routes/auth.test.ts`

**Interfaces:**

- Produces: `PublicUser` now includes `quotaBytes: number | null` and `usedBytes: number` in the JSON returned by `POST /api/auth/login` (`{ user }`) and `GET /api/auth/me`. Task 2 (web) consumes these.

- [ ] **Step 1: Write the failing tests** — append to `server/test/routes/auth.test.ts`:

```ts
test('login + /me expose quotaBytes and usedBytes (a set quota is visible to the user)', async () => {
  const built = await makeApp();
  const uid = await seedUser('quotaed', 'pw', { role: 'user' });
  db!.prepare('UPDATE users SET quota_bytes = 1000, used_bytes = 250 WHERE id = ?').run(uid);

  const res = await login(built, 'quotaed', 'pw');
  expect(res.statusCode).toBe(200);
  const user = (res.body as { user: { quotaBytes: number | null; usedBytes: number } }).user;
  expect(user.quotaBytes).toBe(1000);
  expect(user.usedBytes).toBe(250);

  const me = await built.inject({
    method: 'GET',
    url: '/api/auth/me',
    cookies: { mirsal_session: res.session! },
  });
  expect(me.json()).toMatchObject({ quotaBytes: 1000, usedBytes: 250 });
});

test('login: a user with no quota reports quotaBytes null', async () => {
  const built = await makeApp();
  await seedUser('nolimit', 'pw', { role: 'user' });
  const res = await login(built, 'nolimit', 'pw');
  expect((res.body as { user: { quotaBytes: number | null } }).user.quotaBytes).toBeNull();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx vitest run test/routes/auth.test.ts`
Expected: FAIL — `quotaBytes`/`usedBytes` are `undefined` on the returned user.

- [ ] **Step 3: Implement** in `server/src/routes/auth.ts`:

(a) Extend the `UserRow` interface (currently id/username/password_hash/role/is_active/must_change_password) with:

```ts
quota_bytes: number | null;
used_bytes: number;
```

(b) Extend `PublicUser` with:

```ts
quotaBytes: number | null;
usedBytes: number;
```

(c) Update `toPublicUser` — widen the `Pick` and return the two fields:

```ts
function toPublicUser(
  row: Pick<UserRow, 'id' | 'username' | 'role' | 'must_change_password' | 'quota_bytes' | 'used_bytes'>,
  rootNodeId: number,
): PublicUser {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    mustChangePassword: !!row.must_change_password,
    rootNodeId,
    quotaBytes: row.quota_bytes,
    usedBytes: row.used_bytes,
  };
}
```

(d) Add the two columns to the login SELECT:

```ts
`SELECT id, username, password_hash, role, is_active, must_change_password, quota_bytes, used_bytes
 FROM users WHERE username = ?`;
```

(e) Add them to the `/me` SELECT and widen its type annotation:

```ts
const row = db
  .prepare(`SELECT id, username, role, must_change_password, quota_bytes, used_bytes FROM users WHERE id = ?`)
  .get(req.user!.id) as
  Pick<UserRow, 'id' | 'username' | 'role' | 'must_change_password' | 'quota_bytes' | 'used_bytes'> | undefined;
```

- [ ] **Step 4: Run to verify pass**

Run: `cd server && npx vitest run test/routes/auth.test.ts`
Expected: PASS (all auth tests, including the two new ones).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/auth.ts server/test/routes/auth.test.ts
git commit -m "fix(server): expose quotaBytes+usedBytes on /me and /login (#3)"
```

---

## Task 2: (#3 web) StorageMeter shows the quota bar

**Files:**

- Modify: `web/src/features/auth/auth-context.tsx`, `web/src/features/dashboard/StorageMeter.tsx`
- Test: `web/test/storage-meter.test.tsx` (create)

**Interfaces:**

- Consumes: `useAuth().user.quotaBytes` (number|null) and `.usedBytes` (number) from Task 1.

- [ ] **Step 1: Write the failing test** — create `web/test/storage-meter.test.tsx`:

```tsx
import { describe, test, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../src/i18n';

// StorageMeter still shows a Trash sub-line derived from the trash listing.
vi.mock('../src/features/dashboard/queries', () => ({
  useTrash: () => ({ data: [] }),
  sumSizes: () => 0,
}));

let mockUser: unknown = null;
vi.mock('../src/features/auth/auth-context', () => ({
  useAuth: () => ({ user: mockUser }),
}));

import StorageMeter from '../src/features/dashboard/StorageMeter';

function renderMeter() {
  return render(
    <I18nextProvider i18n={i18n}>
      <StorageMeter />
    </I18nextProvider>,
  );
}

afterEach(() => {
  mockUser = null;
});

describe('StorageMeter', () => {
  test('a user WITH a quota shows a progress bar (25%) and NOT the no-quota note', () => {
    mockUser = {
      id: 1,
      username: 'u',
      role: 'user',
      mustChangePassword: false,
      rootNodeId: 2,
      quotaBytes: 1000,
      usedBytes: 250,
    };
    renderMeter();
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '25');
    expect(screen.queryByText(i18n.t('storage.noQuota'))).not.toBeInTheDocument();
  });

  test('a user with NO quota shows the no-quota note and no progress bar', () => {
    mockUser = {
      id: 1,
      username: 'u',
      role: 'user',
      mustChangePassword: false,
      rootNodeId: 2,
      quotaBytes: null,
      usedBytes: 250,
    };
    renderMeter();
    expect(screen.getByText(i18n.t('storage.noQuota'))).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx vitest run test/storage-meter.test.tsx`
Expected: FAIL — current StorageMeter renders no `progressbar` and reads no `useAuth`.

- [ ] **Step 3: Implement**

(a) `web/src/features/auth/auth-context.tsx` — add to `PublicUser`:

```ts
quotaBytes: number | null;
usedBytes: number;
```

(b) Replace `web/src/features/dashboard/StorageMeter.tsx` entirely with:

```tsx
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/auth-context';
import { useTrash, sumSizes } from './queries';
import { formatBytes } from './format';

/*
 * Storage meter (§3.2). "Used" + the quota bar come from the authoritative,
 * server-maintained figures on the session user (`GET /api/auth/me` now returns
 * quotaBytes/usedBytes). used_bytes already includes trashed-but-not-purged
 * bytes; the Trash sub-line is an informational breakdown from the trash
 * listing. When quotaBytes is null the user has no quota and the bar is omitted.
 */
export default function StorageMeter() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const trashQuery = useTrash();
  const trashBytes = sumSizes(trashQuery.data);

  const usedBytes = user?.usedBytes ?? 0;
  const quotaBytes = user?.quotaBytes ?? null;
  const hasQuota = quotaBytes !== null;
  const fraction = hasQuota ? (quotaBytes > 0 ? Math.min(1, usedBytes / quotaBytes) : 1) : 0;
  const over = hasQuota && usedBytes > quotaBytes;

  return (
    <section aria-label={t('storage.title')} className="rounded-[10px] border border-line bg-surface p-3">
      <h2 className="font-display text-sm text-ink">{t('storage.title')}</h2>
      <dl className="mt-2 flex flex-col gap-1 font-body text-sm">
        <div className="flex items-center justify-between gap-3">
          <dt className="text-ink-2">{t('storage.used')}</dt>
          <dd className="text-ink">
            <bdi dir="ltr" className="font-mono">
              {formatBytes(usedBytes)}
            </bdi>
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-ink-2">{t('storage.trash')}</dt>
          <dd className="text-ink-2">
            <bdi dir="ltr" className="font-mono">
              {formatBytes(trashBytes)}
            </bdi>
          </dd>
        </div>
      </dl>
      {hasQuota ? (
        <div className="mt-2">
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(fraction * 100)}
            className="h-1.5 w-full overflow-hidden rounded-full border border-line bg-paper"
          >
            <div className={`h-full ${over ? 'bg-clay' : 'bg-brass'}`} style={{ width: `${fraction * 100}%` }} />
          </div>
          <p className="mt-1 font-body text-xs text-ink-2">
            <bdi dir="ltr" className="font-mono">
              {formatBytes(usedBytes)} / {formatBytes(quotaBytes)}
            </bdi>
          </p>
        </div>
      ) : (
        <p className="mt-2 font-body text-xs text-ink-2">{t('storage.noQuota')}</p>
      )}
    </section>
  );
}
```

Note: `bg-clay`/`bg-brass`/`bg-paper`/`border-line` are existing theme tokens (see `web/src/features/admin/UsersTable.tsx` `UsageCell` ~lines 141-157 for the same bar recipe). If any token is missing at build time, mirror `UsageCell`'s exact classes.

- [ ] **Step 4: Run to verify pass**

Run: `cd web && npx vitest run test/storage-meter.test.tsx`
Expected: PASS.

- [ ] **Step 5: Full web suite (StorageMeter no longer calls `useNodes`)**

Run: `cd web && npm test && npm run typecheck`
Expected: PASS (confirms no other component/test depended on StorageMeter's old queries).

- [ ] **Step 6: Commit**

```bash
git add web/src/features/auth/auth-context.tsx web/src/features/dashboard/StorageMeter.tsx web/test/storage-meter.test.tsx
git commit -m "fix(web): show real quota bar on the user dashboard (#3)"
```

---

## Task 3: (#9 server) Deactivated login → 403 `account_deactivated` (correct password only)

**Files:**

- Modify: `server/src/routes/auth.ts` (login handler)
- Test: `server/test/routes/auth.test.ts` (rewrite one existing test + add one)

**Interfaces:**

- Produces: `POST /api/auth/login` returns `403 { error: 'account_deactivated' }` when username+password are BOTH correct and the account is inactive; every other failure stays `401 { error: 'invalid_credentials' }`. Task 4 (web) consumes the 403.

- [ ] **Step 1: Update the existing inactive test + add the wrong-password case** in `server/test/routes/auth.test.ts`.

Replace the existing test titled `login: inactive user -> 401 invalid_credentials (generic, not a distinct reason)` with:

```ts
test('login: inactive user with the CORRECT password -> 403 account_deactivated', async () => {
  const built = await makeApp();
  await seedUser('deactivated', 'pw', { isActive: 0 });

  const res = await built.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'deactivated', password: 'pw' },
  });

  expect(res.statusCode).toBe(403);
  expect(res.json()).toEqual({ error: 'account_deactivated' });
  expect(findCookie(res.cookies, 'mirsal_session')).toBeUndefined();
});

test('login: inactive user with a WRONG password -> 401 generic (no deactivation oracle)', async () => {
  const built = await makeApp();
  await seedUser('deactivated', 'pw', { isActive: 0 });

  const res = await built.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'deactivated', password: 'wrong' },
  });

  expect(res.statusCode).toBe(401);
  expect(res.json()).toEqual({ error: 'invalid_credentials' });
});
```

(Leave the `unknown username -> 401` and `wrong password -> 401` tests as-is — they must stay 401.)

- [ ] **Step 2: Run to verify the updated test fails**

Run: `cd server && npx vitest run test/routes/auth.test.ts`
Expected: FAIL — the correct-password inactive case currently returns 401, not 403.

- [ ] **Step 3: Implement** — replace the verify+branch block in the `/api/auth/login` handler (currently the `isUsable` / `verified` / `if (!isUsable || !verified)` section) with:

```ts
const hasUser = !!row;
// Constant-work anti-enumeration: exactly one real argon2 verify per attempt.
// Use the REAL hash whenever the row exists (active OR inactive) so a correct
// password on an inactive account is detectable; the dummy hash only when
// there is no such user.
const verified = await passwordService.verifyPassword(hasUser ? row!.password_hash : dummyHash, password);

// Disclose "deactivated" ONLY to a fully-correct username+password — a wrong
// password on an inactive account still gets the generic 401, so no one can
// probe which usernames exist.
if (hasUser && verified && row!.is_active !== 1) {
  writeAudit(db, { actorId: row!.id, action: 'login_denied_inactive', target: username }, now);
  reply.code(403).send({ error: 'account_deactivated' });
  return;
}

if (!hasUser || !verified || row!.is_active !== 1) {
  writeAudit(db, { actorId: row?.id ?? null, action: 'login_failure', target: username }, now);
  reply.code(401).send({ error: 'invalid_credentials' });
  return;
}
```

The success path below is unchanged (it already uses `row!` and `toPublicUser`).

- [ ] **Step 4: Run to verify pass**

Run: `cd server && npx vitest run test/routes/auth.test.ts`
Expected: PASS (all auth tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/auth.ts server/test/routes/auth.test.ts
git commit -m "fix(server): deactivated login returns account_deactivated on correct password (#9)"
```

---

## Task 4: (#9 web) LoginPage shows the deactivated message

**Files:**

- Modify: `web/src/features/auth/LoginPage.tsx`, `web/src/i18n/ar.json`
- Test: `web/test/login.test.tsx`

**Interfaces:**

- Consumes: `403 { error: 'account_deactivated' }` from Task 3 (`apiPost` throws `ApiError` with `.status === 403`).

- [ ] **Step 1: Write the failing test** — append to `web/test/login.test.tsx`:

```tsx
test('a 403 account_deactivated response shows the deactivated message', async () => {
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).endsWith('/auth/login')) {
      return jsonResponse(403, { error: 'account_deactivated' });
    }
    return jsonResponse(401);
  });
  vi.stubGlobal('fetch', fetchMock);
  await renderLogin(fetchMock);

  fireEvent.change(screen.getByLabelText(i18n.t('login.username')), { target: { value: 'x' } });
  fireEvent.change(screen.getByLabelText(i18n.t('login.password')), { target: { value: 'y' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('login.submit') }));
  });

  expect(screen.getByRole('alert')).toHaveTextContent(i18n.t('login.error.deactivated'));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx vitest run test/login.test.tsx`
Expected: FAIL — no `login.error.deactivated` key / a 403 falls through to the generic message.

- [ ] **Step 3: Implement**

(a) `web/src/i18n/ar.json` — add to the `login.error` object:

```json
"deactivated": "هذا الحساب معطَّل. تواصل مع المسؤول."
```

(Add a comma after the preceding `"generic"` line so the JSON stays valid.)

(b) `web/src/features/auth/LoginPage.tsx` — in the `catch`, add a 403 branch before the generic `else`:

```tsx
} else if (err instanceof ApiError && err.status === 403) {
  setError(t('login.error.deactivated'));
} else {
  setError(t('login.error.generic'));
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd web && npx vitest run test/login.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/features/auth/LoginPage.tsx web/src/i18n/ar.json web/test/login.test.tsx
git commit -m "fix(web): show a distinct 'account deactivated' login message (#9)"
```

---

## Task 5: (#10 server) Folder shares block `/list` and per-file `/download`

**Files:**

- Modify: `server/src/routes/public.ts`
- Test: `server/test/routes/public.test.ts` (rewrite the folder-share test)

**Interfaces:**

- Produces: for a share whose node `kind === 'folder'`, `GET /api/public/:token/list` and BOTH `GET`/`POST /api/public/:token/download` (with or without `?node=`) return `403 { error: 'forbidden' }`. `GET /api/public/:token/zip` and `GET /api/public/:token` (meta) are unchanged. File shares are unaffected.

- [ ] **Step 1: Rewrite the folder-share test** — in `server/test/routes/public.test.ts`, replace the whole test titled `folder share: list children, download a descendant; sibling-outside + moved-out -> 403 forbidden` with:

```ts
test('folder share hides contents: /list and per-file /download are 403; only /zip + meta work (#10)', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);

  const folder = await makeFolder(built, session, csrf, rootId, 'Album');
  const inside = await uploadFile(built, session, csrf, {
    parentId: folder.id,
    filename: 'inside.txt',
    data: Buffer.from('IN'),
  });
  const share = await createShare(built, session, csrf, { node_id: folder.id });

  // meta still works — the recipient sees the folder name + isFolder.
  const metaRes = await built.inject({ method: 'GET', url: `/api/public/${share.token}` });
  expect(metaRes.statusCode).toBe(200);
  expect(metaRes.json()).toMatchObject({ isFolder: true, name: 'Album' });

  // Listing is blocked — contents are never enumerable.
  const listRes = await built.inject({ method: 'GET', url: `/api/public/${share.token}/list` });
  expect(listRes.statusCode).toBe(403);
  expect(listRes.json()).toEqual({ error: 'forbidden' });

  // Per-file download is blocked even for a real in-subtree file id.
  const dlRes = await built.inject({ method: 'GET', url: `/api/public/${share.token}/download?node=${inside.id}` });
  expect(dlRes.statusCode).toBe(403);
  expect(dlRes.json()).toEqual({ error: 'forbidden' });

  // Default (no node) download is blocked too (the shared node is a folder).
  const dlDefault = await built.inject({ method: 'GET', url: `/api/public/${share.token}/download` });
  expect(dlDefault.statusCode).toBe(403);

  // The ZIP (download-all) remains the ONLY content path.
  const zipRes = await built.inject({ method: 'GET', url: `/api/public/${share.token}/zip` });
  expect(zipRes.statusCode).toBe(200);
});
```

(Leave the `folder share: /zip streams a zip...` test and all file-share tests unchanged.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run test/routes/public.test.ts`
Expected: FAIL — `/list` currently 200 and per-file `/download` currently 200.

- [ ] **Step 3: Implement** in `server/src/routes/public.ts`.

(a) In the `GET /api/public/:token/list` handler, after `if (!requireUnlocked(req, reply, share)) return;` and before the `listPublic` call, add:

```ts
// #10: a folder share exposes ONLY the ZIP — its contents are never listed.
const listNode = db.prepare('SELECT kind FROM nodes WHERE id = @id').get({ id: share.node_id }) as
  { kind: string } | undefined;
if (listNode?.kind === 'folder') {
  reply.code(403).send({ error: 'forbidden' });
  return;
}
```

(b) In `resolveDownloadableFile`, right after the `if (!share.allow_download) { ... }` block (before the `resolveInSubtree` call), add:

```ts
// #10: a folder share allows no per-file download (with or without ?node=) —
// only the ZIP. Constant-shape 403, identical to an out-of-subtree rejection.
const shareNode = db.prepare('SELECT kind FROM nodes WHERE id = @id').get({ id: share.node_id }) as
  { kind: string } | undefined;
if (shareNode?.kind === 'folder') {
  reply.code(403).send({ error: 'forbidden' });
  return null;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd server && npx vitest run test/routes/public.test.ts`
Expected: PASS (folder test now green; file-share + zip tests still green).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/public.ts server/test/routes/public.test.ts
git commit -m "fix(server): folder shares expose ZIP only — block /list and per-file /download (#10)"
```

---

## Task 6: (#10 web) PublicFolder shows name + ZIP only

**Files:**

- Modify: `web/src/features/public/PublicFolder.tsx`
- Test: `web/test/public.test.tsx` (add a folder test)

**Interfaces:**

- Consumes: `PublicMeta` (`name`, `isFolder`, `allow_download`) + `zipUrl(token)`. No longer calls `usePublicList`.

- [ ] **Step 1: Write the failing test** — append inside the `describe('SealedDispatch — public share page', ...)` block in `web/test/public.test.tsx`:

```tsx
test('a folder share shows the name + Download-all-as-ZIP and NO file listing (#10)', async () => {
  setNavigatorLanguage('en-US');
  const liveFolder = {
    token: TOKEN,
    kind: 'folder' as const,
    name: 'Reports',
    size_bytes: 4096,
    isFolder: true,
    allow_download: true,
    download_limit: null as number | null,
    download_count: 0,
  };
  const fetchMock = vi.fn(async () => jsonResponse(200, liveFolder));
  vi.stubGlobal('fetch', fetchMock);

  const { container } = renderPage();
  await screen.findByText('A folder was sent to you via Mirsal');

  // The folder name is shown and ZIP is the only content action.
  expect(screen.getByText('Reports')).toBeInTheDocument();
  expect(container.querySelector(`a[href="/api/public/${TOKEN}/zip"]`)).not.toBeNull();

  // No /list request is ever made — contents stay hidden.
  const listCalled = fetchMock.mock.calls.some((c) => String(c[0]).includes('/list'));
  expect(listCalled).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx vitest run test/public.test.tsx`
Expected: FAIL — current PublicFolder calls `/list` and renders a listing table.

- [ ] **Step 3: Implement** — replace `web/src/features/public/PublicFolder.tsx` entirely with:

```tsx
import { useTranslation } from 'react-i18next';
import { SealHeader } from './DispatchFrame';
import { PrimaryLink, DownloadGlyph } from './controls';
import { zipUrl, type PublicMeta } from './api';

/*
 * PublicFolder — the live folder dispatch (§3.5). Per the round-3 decision the
 * recipient sees ONLY the folder name + "Download all as ZIP"; the contents are
 * never listed (the server also blocks /list and per-file /download for a folder
 * share). When download is forbidden, only the framing line is shown.
 */
export default function PublicFolder({ token, meta }: { token: string; meta: PublicMeta }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <SealHeader stamp />
      <p className="font-body text-base text-ink-2">{t('public.framingFolder')}</p>
      <p className="font-display text-lg text-ink">
        <bdi>{meta.name}</bdi>
      </p>
      {meta.allow_download && (
        <PrimaryLink href={zipUrl(token)}>
          <DownloadGlyph />
          {t('public.downloadAll')}
        </PrimaryLink>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd web && npx vitest run test/public.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/features/public/PublicFolder.tsx web/test/public.test.tsx
git commit -m "fix(web): folder recipient page shows name + ZIP only, no listing (#10)"
```

---

## Task 7: (#11 server) Unlock cookie → session cookie, 600s server lifetime

**Files:**

- Modify: `server/src/routes/public.ts`
- Test: `server/test/routes/public.test.ts` (update the lifetime test + add a session-cookie test)

**Interfaces:**

- Produces: the `mirsal_unlock` cookie is a session cookie (no `Max-Age`/`Expires`) with a server-enforced 600s lifetime.

- [ ] **Step 1: Update the lifetime test + add a session-cookie test** in `server/test/routes/public.test.ts`.

In the test `unlock cookie lifetime is enforced server-side, not only via the Max-Age attribute`, change the clock-advance line and its comment from 1800 to 600:

```ts
// Advance the server's own clock past the 600s lifetime and confirm the SAME
// cookie is now rejected (expiry enforced by the route, not the client Max-Age).
mockNow = NOW + 600 * 1000 + 1;
```

Add a new test (next to it):

```ts
test('unlock cookie is a session cookie (no Max-Age / Expires) so it dies with the browser session (#11)', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);
  const file = await uploadFile(built, session, csrf, { parentId: rootId, filename: 's.txt', data: Buffer.from('S') });
  const share = await createShare(built, session, csrf, { node_id: file.id, password: 'pw2' });

  const unlockRes = await built.inject({
    method: 'POST',
    url: `/api/public/${share.token}/unlock`,
    payload: { password: 'pw2' },
  });
  expect(unlockRes.statusCode).toBe(200);

  const setCookie = unlockRes.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie.join('\n') : String(setCookie);
  const line = raw.split('\n').find((l) => l.startsWith('mirsal_unlock='));
  expect(line).toBeDefined();
  expect(line!.toLowerCase()).not.toContain('max-age');
  expect(line!.toLowerCase()).not.toContain('expires');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run test/routes/public.test.ts`
Expected: FAIL — the cookie currently carries `Max-Age=1800`; the lifetime test still expects the old boundary too.

- [ ] **Step 3: Implement** in `server/src/routes/public.ts`:

(a) Change the constant + its comment:

```ts
/** Unlock cookie server-side lifetime (10 min). A short bridge only — the client re-prompts on every fresh open (#11); this bounds the transport window. */
const UNLOCK_COOKIE_MAX_AGE_S = 600;
```

(b) In the `/unlock` handler's `reply.setCookie(UNLOCK_COOKIE, ...)` call, REMOVE the `maxAge: UNLOCK_COOKIE_MAX_AGE_S,` line so the cookie becomes a session cookie. The options object keeps `httpOnly: true, secure: true, sameSite: 'lax', path: \`/api/public/${token}\``.

- [ ] **Step 4: Run to verify pass**

Run: `cd server && npx vitest run test/routes/public.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/public.ts server/test/routes/public.test.ts
git commit -m "fix(server): unlock cookie is a session cookie w/ 600s lifetime (#11)"
```

---

## Task 8: (#11 web) Meta omits the unlock cookie until unlocked in-session

**Files:**

- Modify: `web/src/features/public/api.ts`, `web/src/features/public/queries.ts`, `web/src/features/public/SealedDispatch.tsx`
- Test: `web/test/public.test.tsx` (add a re-prompt test)

**Interfaces:**

- Produces: `fetchPublicMeta(token, opts?: { reveal?: boolean })` — `credentials: 'omit'` unless `reveal`. `usePublicMeta(token, reveal: boolean)`. SealedDispatch passes `revealed` (in-memory, false on every fresh mount) so a password share always shows the gate on open, then flips `revealed` true on unlock.

- [ ] **Step 1: Write the failing test** — append inside the `describe('SealedDispatch — public share page', ...)` block in `web/test/public.test.tsx`:

```tsx
test('a password share re-prompts on every fresh open even if the unlock cookie is still valid (#11)', async () => {
  setNavigatorLanguage('en-US');
  // Simulate a STILL-VALID unlock cookie: the server would return live meta IF
  // the cookie were sent. The client omits it until the user unlocks in-session,
  // so the first meta (credentials:'omit') is 401 needsPassword -> gate shows.
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/unlock')) return jsonResponse(200, { ok: true });
    if (init?.credentials === 'include') return jsonResponse(200, { ...liveFile, name: 'secret.txt' });
    return jsonResponse(401, { needsPassword: true });
  });
  vi.stubGlobal('fetch', fetchMock);

  renderPage();

  // Fresh open: gate shown despite a "valid cookie"; no metadata leaks.
  expect(await screen.findByText('This file is password-protected.')).toBeInTheDocument();
  expect(screen.queryByText('secret.txt')).not.toBeInTheDocument();

  // Enter the password -> unlock -> reveal -> content.
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'right' } });
  fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
  expect(await screen.findByText('A file was sent to you via Mirsal')).toBeInTheDocument();
  expect(screen.getByText('secret.txt')).toBeInTheDocument();

  // The FIRST meta fetch omitted credentials — the mechanism that forces the re-prompt.
  const firstMeta = fetchMock.mock.calls.find((c) => !String(c[0]).includes('/unlock'))!;
  expect((firstMeta[1] as RequestInit).credentials).toBe('omit');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx vitest run test/public.test.tsx`
Expected: FAIL — current meta fetch uses `credentials:'include'`, so the "valid cookie" reveals content and the gate never shows.

- [ ] **Step 3: Implement**

(a) `web/src/features/public/api.ts` — change `fetchPublicMeta`'s signature + the fetch `credentials`:

```ts
export async function fetchPublicMeta(
  token: string,
  opts?: { reveal?: boolean }
): Promise<PublicMetaResult> {
  const res = await fetch(tokenPath(token), {
    // Until the recipient unlocks IN THIS page-load, omit the unlock cookie so a
    // still-valid cookie can't silently reveal a password share — the gate must
    // re-appear on every fresh open (#11). After unlock we pass reveal:true to
    // send the cookie and receive the live metadata.
    credentials: opts?.reveal ? 'include' : 'omit',
    headers: { accept: 'application/json' },
  });
  // ...the rest of the function body is unchanged (the 200/401/410/404 branches).
```

(b) `web/src/features/public/queries.ts` — thread `reveal` into the key + query fn:

```ts
export const publicMetaKey = (token: string, reveal: boolean) =>
  ['public', token, 'meta', reveal ? 'reveal' : 'gate'] as const;

export function usePublicMeta(token: string, reveal: boolean) {
  return useQuery({
    queryKey: publicMetaKey(token, reveal),
    queryFn: () => fetchPublicMeta(token, { reveal }),
    enabled: token.length > 0,
  });
}
```

(c) `web/src/features/public/SealedDispatch.tsx`:

- Import `useState` is already imported. Add the reveal state and pass it:

```tsx
const [revealed, setRevealed] = useState(false);
const meta = usePublicMeta(token, revealed);
```

- Change the `'password'` case so unlocking flips `revealed` (and refetches the current query as a fallback for a re-unlock while already revealed):

```tsx
      case 'password':
        return (
          <PasswordGate
            token={token}
            onUnlocked={() => {
              setRevealed(true);
              void meta.refetch();
            }}
          />
        );
```

- [ ] **Step 4: Run to verify pass**

Run: `cd web && npx vitest run test/public.test.tsx`
Expected: PASS (the new #11 test AND the existing `password gate: pre-unlock reveals no name/size...` test — its mock keys on an `unlocked` flag, not credentials, so it stays green).

- [ ] **Step 5: Commit**

```bash
git add web/src/features/public/api.ts web/src/features/public/queries.ts web/src/features/public/SealedDispatch.tsx web/test/public.test.tsx
git commit -m "fix(web): password link re-prompts on every fresh open (#11)"
```

---

## Final: full green + phase checkpoint

- [ ] **Step 1: Full server suite**

Run: `cd server && npm test && npm run typecheck`
Expected: all green, tsc exit 0.

- [ ] **Step 2: Full web suite**

Run: `cd web && npm test && npm run typecheck`
Expected: all green, tsc exit 0.

- [ ] **Step 3: STOP — phase checkpoint.** Do NOT merge or deploy yet. Report to the user: the four bug fixes are implemented, tested, and committed on `feat/round3-phase1-bugfixes`. Per `feedback_phase_pause`, wait for the user to review before merge + deploy (and before starting Phase 2). Deployment (rebuild + `docker compose up -d` + live HTTPS-chain verify + headless render of the changed public/login/dashboard pages) happens only on the user's go — Phase 1 has no schema migration, so no DB snapshot is required for it.

---

## Self-Review (against the spec §Phase 1)

- **#3 quota** → Tasks 1 (server `/me`+`/login`) + 2 (web StorageMeter bar). ✓
- **#9 deactivated** → Tasks 3 (server 403) + 4 (web message). Constant-work verify preserved; wrong-password-on-inactive stays generic 401. ✓
- **#10 folder contents** → Tasks 5 (server blocks `/list` + per-file `/download`, keeps `/zip`+meta) + 6 (web name + ZIP only). Existing folder test rewritten. ✓
- **#11 password re-prompt** → Tasks 7 (server session cookie + 600s) + 8 (web meta omits cookie until in-session unlock). Existing server meta-with-cookie tests untouched (server meta logic unchanged); existing web password test stays green (keys on an `unlocked` flag, not credentials). ✓
- **Placeholders:** none — every step has concrete code and exact run/verify commands.
- **Type consistency:** `quotaBytes`/`usedBytes` names match across server `PublicUser` (Task 1), web `PublicUser` (Task 2), and StorageMeter (Task 2). `fetchPublicMeta(token, {reveal})` / `usePublicMeta(token, reveal)` names match across Task 8's three files.
