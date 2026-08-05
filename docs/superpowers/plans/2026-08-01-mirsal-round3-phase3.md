# Mirsal Round-3 Phase 3 — Dashboard UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the three Phase-3 dashboard-UX requests — (#6) empty-the-whole-Trash, (#7) sort files/folders, (#8) multi-select rows → bulk move to Trash.

**Architecture:** One new server route reuses the existing per-subtree `permanentDelete` over each top-level trashed node; the other two items are web-only and reuse the existing TanStack Query mutations (`useTrashNode`) and the `Register`/`NodeRow` two-layout (desktop table + mobile cards) pattern. No schema change, no migration, no DB snapshot.

**Tech Stack:** Server — Fastify 5 + better-sqlite3 + Zod, TDD via vitest (`server/test/**`). Web — React 19 + TanStack Query + react-i18next + Tailwind, TDD via vitest + Testing Library (`web/test/dashboard.test.tsx`).

## Global Constraints

- **No schema change / no migration.** Phase 3 leaves `schema_version` at its current value (3). No `deploy/backup-mirsal.sh` pre-deploy snapshot is required for the migration reason (unlike Phase 2).
- **Owner-scoped, `requireAuth`.** Every new server handler is behind `guards.requireAuth` and only ever touches `req.user!.id`'s own nodes; never confirm existence of another user's node.
- **`blobStore` is the injected instance.** Use `deps.blobStore` inside `nodesRoutes` — never the bare `storage/blobs.js` exports (they bind to a `process.env`-keyed default store). Same rule the file already documents.
- **better-sqlite3 transactions do not nest.** `permanentDelete` opens its own `db.transaction`. Do **not** wrap a loop of `permanentDelete` calls in another `db.transaction` — better-sqlite3 throws "cannot start a transaction within a transaction". Per-node transactions are per the spec ("applied to each top-level trashed node").
- **Arabic-only i18n.** Add new UI strings to `web/src/i18n/ar.json` only (the app is `ar`-first; Phase 1/2 added `ar`-only keys — match that). Do not touch `en.json`.
- **Test gates (both workspaces must stay green at every commit):**
  - Server: `cd server && npx vitest run` + `npm run typecheck`
  - Web: `cd web && npx vitest run` + `npm run typecheck`
  - There is **no eslint / `lint` script** in this repo — the gates are `vitest` + `typecheck` only.
- **Branch:** `feat/round3-phase3-dashboard`, off `main` (`62fb5ab`). Commit per task ([[feedback_save_often]]). STOP after the phase for user review before merge/deploy ([[feedback_phase_pause]]).
- **RTL/ledger conventions** (existing): size/date are `<bdi dir="ltr" className="font-mono">`; `text-start`/`ps-*`/`pe-*` (never `text-left`/`pl-*`); action chips use the existing `ROW_ACTION` / `ROW_ACTION_DANGER` class constants.

---

## Preflight (once, before Task 1)

- [ ] **Create the branch off main.**

```bash
cd /var/www/projects/mirsal
git checkout main && git pull --ff-only
git checkout -b feat/round3-phase3-dashboard
```

- [ ] **Confirm both suites are green before touching anything** (baseline):

```bash
cd /var/www/projects/mirsal/server && npx vitest run && npm run typecheck
cd /var/www/projects/mirsal/web && npx vitest run && npm run typecheck
```

Expected: all green (server 350/350, web 157/157 as of `62fb5ab`; counts may differ — the point is zero failures).

---

## Task 1: Server — `POST /api/nodes/trash/empty` (empty the whole Trash)

**Files:**

- Modify: `server/src/routes/nodes.ts` (add one route inside `nodesRoutes`, after the existing `DELETE /api/nodes/:id` handler ~line 590)
- Test: `server/test/routes/nodes.test.ts` (append tests at end of file)

**Interfaces:**

- Consumes: `permanentDelete(db, ownerId, nodeId): { freedBytes: number; storagePaths: string[] }` from `../nodes/trash.js` (already imported at line 22); `blobStore.deleteBlob(path)`; `writeAudit(db, { actorId, action, target }, now)`.
- Produces: `POST /api/nodes/trash/empty` → `200 { freedBytes: number }`. Permanently deletes every **top-level** trashed node the caller owns (each such node's subtree cascades via `permanentDelete`). Idempotent: empty trash → `200 { freedBytes: 0 }`.

**Why top-level only:** the same reason `GET /api/nodes/trash` lists only top-level trashed items — a node nested inside a trashed folder is stamped trashed in the same op, but its bytes already roll up into the ancestor. Iterating `permanentDelete` over the _top-level_ trashed nodes deletes every trashed subtree exactly once (each top-level trashed node is an independent subtree, since its parent is not trashed).

- [ ] **Step 1: Write the failing tests**

Append to `server/test/routes/nodes.test.ts`:

```ts
test('POST /api/nodes/trash/empty permanently deletes all trashed nodes, frees quota, and unlinks blobs; leaves live nodes untouched', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const rootId = rootIdFor(uid);

  // A live file that must survive.
  const liveUp = await uploadFile(built, session, csrf, {
    parentId: rootId,
    filename: 'keep.txt',
    data: Buffer.from('keepme'),
  }); // 6 bytes
  const liveId = liveUp.body.id as number;

  // A folder with a nested file, plus a loose file — both trashed.
  const folderRes = await built.inject({
    method: 'POST',
    url: '/api/nodes/folder',
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { parent_id: rootId, name: 'Box' },
  });
  const folder = folderRes.json();
  await uploadFile(built, session, csrf, { parentId: folder.id, filename: 'inside.txt', data: Buffer.from('hello') }); // 5
  const looseUp = await uploadFile(built, session, csrf, {
    parentId: rootId,
    filename: 'loose.txt',
    data: Buffer.from('worldwide'),
  }); // 9

  await built.inject({
    method: 'POST',
    url: `/api/nodes/${folder.id}/trash`,
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
  });
  await built.inject({
    method: 'POST',
    url: `/api/nodes/${looseUp.body.id}/trash`,
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
  });

  const usedBefore = (db!.prepare('SELECT used_bytes FROM users WHERE id = ?').get(uid) as { used_bytes: number })
    .used_bytes;
  expect(usedBefore).toBe(6 + 5 + 9);

  const res = await built.inject({
    method: 'POST',
    url: '/api/nodes/trash/empty',
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().freedBytes).toBe(5 + 9); // the two trashed subtrees, not the live file

  // Trash now empty; live file still listed.
  const trashList = (
    await built.inject({ method: 'GET', url: '/api/nodes/trash', cookies: { mirsal_session: session } })
  ).json();
  expect(trashList).toEqual([]);
  const rootList = (
    await built.inject({ method: 'GET', url: '/api/nodes', cookies: { mirsal_session: session } })
  ).json() as Array<{ id: number }>;
  expect(rootList.some((n) => n.id === liveId)).toBe(true);

  // Quota dropped by exactly the trashed bytes; live file's blob still on disk.
  const usedAfter = (db!.prepare('SELECT used_bytes FROM users WHERE id = ?').get(uid) as { used_bytes: number })
    .used_bytes;
  expect(usedAfter).toBe(6);
  expect(fs.existsSync(path.join(storageDir!, String(uid), String(liveId)))).toBe(true);
});

test('POST /api/nodes/trash/empty is a no-op 200 on an already-empty trash', async () => {
  const built = await makeApp();
  await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');

  const res = await built.inject({
    method: 'POST',
    url: '/api/nodes/trash/empty',
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().freedBytes).toBe(0);
});

test("POST /api/nodes/trash/empty is owner-scoped — never touches another user's trash", async () => {
  const built = await makeApp();
  const aliceId = await seedUser('alice', 'pw');
  const bobId = await seedUser('bob', 'pw');
  const alice = await login(built, 'alice', 'pw');
  const bob = await login(built, 'bob', 'pw');

  // Bob trashes a file.
  const bobUp = await uploadFile(built, bob.session, bob.csrf, {
    parentId: rootIdFor(bobId),
    filename: 'b.txt',
    data: Buffer.from('bob'),
  });
  await built.inject({
    method: 'POST',
    url: `/api/nodes/${bobUp.body.id}/trash`,
    cookies: { mirsal_session: bob.session },
    headers: { 'x-csrf-token': bob.csrf },
  });

  // Alice empties HER trash (empty) — Bob's trashed file must remain.
  await built.inject({
    method: 'POST',
    url: '/api/nodes/trash/empty',
    cookies: { mirsal_session: alice.session },
    headers: { 'x-csrf-token': alice.csrf },
  });

  const bobTrash = (
    await built.inject({ method: 'GET', url: '/api/nodes/trash', cookies: { mirsal_session: bob.session } })
  ).json() as Array<{ id: number }>;
  expect(bobTrash.some((n) => n.id === bobUp.body.id)).toBe(true);
  expect(aliceId).not.toBe(bobId);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run test/routes/nodes.test.ts -t "trash/empty"`
Expected: FAIL — the route does not exist (404 → assertions fail).

- [ ] **Step 3: Implement the route**

In `server/src/routes/nodes.ts`, add immediately **after** the `app.delete('/api/nodes/:id', …)` handler (ends ~line 590), still inside `nodesRoutes`:

```ts
app.post('/api/nodes/trash/empty', { preHandler: guards.requireAuth }, async (req, reply) => {
  const uid = req.user!.id;

  // Top-level trashed nodes only — the same shape GET /api/nodes/trash uses.
  // Each is an independent subtree (its parent is not trashed), so
  // permanentDelete over each deletes every trashed subtree exactly once;
  // a file nested inside a trashed folder is removed by its ancestor's cascade.
  const topLevel = db
    .prepare(
      `SELECT n.id FROM nodes n
         WHERE n.owner_id = @uid AND n.trashed_at IS NOT NULL
           AND (n.parent_id IS NULL OR NOT EXISTS (
             SELECT 1 FROM nodes p WHERE p.id = n.parent_id AND p.trashed_at IS NOT NULL
           ))`,
    )
    .all({ uid }) as { id: number }[];

  // Per-node transactions (permanentDelete opens its own) — never wrap in one
  // outer transaction (better-sqlite3 forbids nesting).
  let freedBytes = 0;
  const storagePaths: string[] = [];
  for (const { id } of topLevel) {
    const result = permanentDelete(db, uid, id);
    freedBytes += result.freedBytes;
    storagePaths.push(...result.storagePaths);
  }

  // Unlink blobs AFTER every commit (mirrors DELETE /api/nodes/:id): the rows
  // and used_bytes are already gone, so a disk error here must not be mapped
  // to a 404. Idempotent no-op when the trash was empty.
  for (const p of storagePaths) {
    blobStore.deleteBlob(p);
  }

  if (topLevel.length > 0) {
    writeAudit(db, { actorId: uid, action: 'empty_trash', target: String(topLevel.length) }, now);
  }

  reply.code(200).send({ freedBytes });
});
```

Note: `empty_trash` is deliberately **not** in the admin audit view's `AUDIT_TARGET_IS_ID` allowlist, so its `target` (a count) is displayed verbatim and never mis-resolved to a username — no admin-side change is needed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run test/routes/nodes.test.ts -t "trash/empty"`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full server suite + typecheck**

Run: `cd server && npx vitest run && npm run typecheck`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
cd /var/www/projects/mirsal
git add server/src/routes/nodes.ts server/test/routes/nodes.test.ts
git commit -m "feat(server): POST /api/nodes/trash/empty — empty the whole Trash (#6)"
```

---

## Task 2: Web — empty-Trash button + `useEmptyTrash`

**Files:**

- Modify: `web/src/features/dashboard/api.ts` (add `emptyTrash`)
- Modify: `web/src/features/dashboard/queries.ts` (add `useEmptyTrash`)
- Modify: `web/src/features/dashboard/TrashView.tsx` (top-of-view button + confirm modal)
- Modify: `web/src/i18n/ar.json` (keys under `trash`)
- Test: `web/test/dashboard.test.tsx` (append tests in the existing `TrashView` describe area)

**Interfaces:**

- Consumes: `apiPost` from `../../lib/api`; `useMutation`/`useQueryClient` + the existing `invalidateNodes(client)` (already invalidates `['nodes']` + `trashKey` + `meKey`); the existing `Modal` + `Button` (`variant="danger"`) components; `useToast`.
- Produces: `emptyTrash(): Promise<{ freedBytes: number }>` (api); `useEmptyTrash()` mutation (queries); an "إفراغ سلة المهملات" button in `TrashView` shown only when `items.length > 0`.

- [ ] **Step 1: Write the failing test**

Append inside `web/test/dashboard.test.tsx` (near the existing `describe('TrashView …')`):

```tsx
describe('TrashView — empty whole trash (#6)', () => {
  test('shows an empty-trash button only when the trash is non-empty, and calls the endpoint on confirm', async () => {
    const trashed: NodeDto[] = [
      {
        id: 10,
        parent_id: 2,
        kind: 'file',
        name: 'old.txt',
        size_bytes: 5,
        mime_type: 'text/plain',
        auto_delete_at: null,
        created_at: NOW,
        updated_at: NOW,
      },
    ];
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url).split('?')[0];
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push(`${method} ${path}`);
      if (path === '/api/nodes/trash' && method === 'GET') return jsonResponse(200, trashed);
      if (path === '/api/nodes/trash/empty' && method === 'POST') return jsonResponse(200, { freedBytes: 5 });
      return jsonResponse(200, {});
    });
    vi.stubGlobal('fetch', fetchMock);

    renderTrash(['/trash']);
    const emptyBtn = await screen.findByRole('button', { name: 'إفراغ سلة المهملات' });

    fireEvent.click(emptyBtn);
    // Destructive confirm modal → the confirm button carries the "إفراغ" label.
    const confirm = await screen.findByRole('button', { name: 'إفراغ' });
    await act(async () => {
      fireEvent.click(confirm);
    });

    expect(calls).toContain('POST /api/nodes/trash/empty');
  });

  test('hides the empty-trash button when the trash is empty', async () => {
    stubFetch({ '/api/nodes/trash': [] });
    renderTrash(['/trash']);
    // The empty-state copy renders…
    await screen.findByText('المهملات فارغة.');
    // …and no empty-trash button is present.
    expect(screen.queryByRole('button', { name: 'إفراغ سلة المهملات' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx vitest run test/dashboard.test.tsx -t "empty whole trash"`
Expected: FAIL — no such button.

- [ ] **Step 3a: Add the api wrapper**

In `web/src/features/dashboard/api.ts`, after `deleteNode` (~line 50):

```ts
/** Permanently empties the caller's whole Trash (server cascades each subtree). */
export function emptyTrash(): Promise<{ freedBytes: number }> {
  return apiPost<{ freedBytes: number }>('/nodes/trash/empty');
}
```

- [ ] **Step 3b: Add the mutation**

In `web/src/features/dashboard/queries.ts`, after `useDeleteNode` (~line 86):

```ts
export function useEmptyTrash() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => nodesApi.emptyTrash(),
    onSuccess: () => invalidateNodes(client),
  });
}
```

- [ ] **Step 3c: Add the i18n keys**

In `web/src/i18n/ar.json`, extend the `"trash"` object (currently ends ~line 352). Add `emptyAll` + a `confirmEmpty` block, and two `toast` keys:

```jsonc
  "trash": {
    "title": "المهملات",
    "loading": "جارٍ التحميل…",
    "error": "تعذّر تحميل المهملات. حاول مجددًا.",
    "empty": "المهملات فارغة.",
    "emptyAll": "إفراغ سلة المهملات",
    "restore": "استعادة",
    "deletePermanent": "حذف نهائي",
    "confirm": {
      "title": "حذف نهائي",
      "body": "سيُحذف «{{name}}» نهائيًا بلا رجعة. متابعة؟",
      "cancel": "إلغاء",
      "confirm": "حذف نهائي"
    },
    "confirmEmpty": {
      "title": "إفراغ سلة المهملات",
      "body": "سيُحذف كل ما في سلة المهملات نهائيًا بلا رجعة. متابعة؟",
      "cancel": "إلغاء",
      "confirm": "إفراغ"
    },
    "toast": {
      "restored": "تمت الاستعادة.",
      "restoreFailed": "تعذّرت الاستعادة. حاول مجددًا.",
      "deleted": "حُذف نهائيًا.",
      "deleteFailed": "تعذّر الحذف. حاول مجددًا.",
      "emptied": "أُفرغت سلة المهملات.",
      "emptyFailed": "تعذّر إفراغ السلة. حاول مجددًا."
    }
  },
```

(Only `emptyAll`, the `confirmEmpty` block, and `toast.emptied`/`toast.emptyFailed` are new — the rest is unchanged, shown for placement.)

- [ ] **Step 3d: Wire the button + confirm modal into TrashView**

In `web/src/features/dashboard/TrashView.tsx`:

1. Extend the imports at line 9 to include the new mutation:

```ts
import { useTrash, useRestoreNode, useDeleteNode, useEmptyTrash } from './queries';
```

2. In the `TrashView` component, add empty-trash confirm state next to `deleteTarget` (~line 28):

```ts
const [emptyOpen, setEmptyOpen] = useState(false);
```

3. Replace the header `<h1>` block (~lines 40) so the button sits beside the title, shown only when there are items:

```tsx
<div className="flex flex-wrap items-center justify-between gap-3">
  <h1 className="font-display text-lg text-ink">{t('trash.title')}</h1>
  {!isPending && !isError && items.length > 0 && (
    <Button variant="danger" onClick={() => setEmptyOpen(true)}>
      {t('trash.emptyAll')}
    </Button>
  )}
</div>
```

4. Render the confirm modal next to the existing `ConfirmDeleteModal` (~line 58):

```tsx
{
  emptyOpen && <ConfirmEmptyModal onClose={() => setEmptyOpen(false)} />;
}
```

5. Add the `ConfirmEmptyModal` component at the end of the file (mirrors `ConfirmDeleteModal`):

```tsx
function ConfirmEmptyModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const empty = useEmptyTrash();

  function confirm() {
    empty.mutate(undefined, {
      onSuccess: () => {
        toast({ kind: 'success', message: t('trash.toast.emptied') });
        onClose();
      },
      onError: () => {
        toast({ kind: 'error', message: t('trash.toast.emptyFailed') });
        onClose();
      },
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('trash.confirmEmpty.title')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('trash.confirmEmpty.cancel')}
          </Button>
          <Button variant="danger" onClick={confirm} disabled={empty.isPending}>
            {t('trash.confirmEmpty.confirm')}
          </Button>
        </>
      }
    >
      <p className="font-body text-sm text-ink">{t('trash.confirmEmpty.body')}</p>
    </Modal>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run test/dashboard.test.tsx -t "empty whole trash"`
Expected: PASS (2 tests).

- [ ] **Step 5: Full web suite + typecheck**

Run: `cd web && npx vitest run && npm run typecheck`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
cd /var/www/projects/mirsal
git add web/src/features/dashboard/api.ts web/src/features/dashboard/queries.ts web/src/features/dashboard/TrashView.tsx web/src/i18n/ar.json web/test/dashboard.test.tsx
git commit -m "feat(web): empty-whole-Trash button + useEmptyTrash (#6)"
```

---

## Task 3: Web — sorting for files and folders

**Files:**

- Create: `web/src/features/dashboard/sort.ts` (pure sort helper)
- Modify: `web/src/features/dashboard/DriveView.tsx` (sort state + sortable headers + mobile sort control in `Register`)
- Modify: `web/src/i18n/ar.json` (keys under `dashboard.sort`)
- Test: `web/test/dashboard.test.tsx` (a pure-helper `describe` + a render assertion)

**Interfaces:**

- Produces:
  - `type SortKey = 'name' | 'size' | 'date'`; `type SortDir = 'asc' | 'desc'`; `interface SortState { key: SortKey; dir: SortDir }`.
  - `sortNodes(nodes: NodeDto[], sort: SortState): NodeDto[]` — pure, returns a NEW array; **folders always before files**, then within each group by the chosen key/dir. Name via `Intl.Collator('ar', { numeric: true, sensitivity: 'base' })`; size via `size_bytes`; date via `updated_at`; ties break by name.
- Consumes: `useMemo`, `useState` (React); the collator lives in `sort.ts`.

- [ ] **Step 1: Write the failing test (pure helper)**

At the top of `web/test/dashboard.test.tsx` add the import:

```ts
import { sortNodes, type SortState } from '../src/features/dashboard/sort';
```

Then append a describe block:

```ts
describe('sortNodes — folders first, then by key/direction (#7)', () => {
  const mk = (id: number, kind: 'folder' | 'file', name: string, size: number, updated: number): NodeDto => ({
    id,
    parent_id: 1,
    kind,
    name,
    size_bytes: size,
    mime_type: null,
    auto_delete_at: null,
    created_at: 0,
    updated_at: updated,
  });
  const nodes: NodeDto[] = [
    mk(1, 'file', 'banana', 30, 100),
    mk(2, 'folder', 'Zebra', 0, 300),
    mk(3, 'file', 'apple', 10, 200),
    mk(4, 'folder', 'alpha', 0, 50),
  ];

  const names = (s: SortState) => sortNodes(nodes, s).map((n) => n.name);

  test('name asc: folders (by name) before files (by name)', () => {
    expect(names({ key: 'name', dir: 'asc' })).toEqual(['alpha', 'Zebra', 'apple', 'banana']);
  });
  test('name desc reverses within each group but keeps folders first', () => {
    expect(names({ key: 'name', dir: 'desc' })).toEqual(['Zebra', 'alpha', 'banana', 'apple']);
  });
  test('size asc sorts files by size_bytes (folders still first)', () => {
    expect(names({ key: 'size', dir: 'asc' }).slice(2)).toEqual(['apple', 'banana']); // 10 < 30
  });
  test('date desc sorts by updated_at newest-first within group', () => {
    expect(names({ key: 'date', dir: 'desc' }).slice(2)).toEqual(['apple', 'banana']); // 200 > 100
  });
  test('returns a new array (does not mutate input order)', () => {
    const before = nodes.map((n) => n.id);
    sortNodes(nodes, { key: 'size', dir: 'desc' });
    expect(nodes.map((n) => n.id)).toEqual(before);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx vitest run test/dashboard.test.tsx -t "sortNodes"`
Expected: FAIL — module `sort.ts` does not exist.

- [ ] **Step 3a: Create the pure helper**

`web/src/features/dashboard/sort.ts`:

```ts
import type { NodeDto } from './types';

export type SortKey = 'name' | 'size' | 'date';
export type SortDir = 'asc' | 'desc';
export interface SortState {
  key: SortKey;
  dir: SortDir;
}

// Arabic, numeric-aware, case/diacritic-insensitive collation for names.
const collator = new Intl.Collator('ar', { numeric: true, sensitivity: 'base' });

/**
 * Sorts a node listing for display (§3.2 / spec §Phase 3.2). Folders always
 * come before files; within each group, rows are ordered by the chosen key
 * and direction, with a stable name tiebreak. Pure — returns a NEW array and
 * never mutates its input.
 */
export function sortNodes(nodes: NodeDto[], sort: SortState): NodeDto[] {
  const dir = sort.dir === 'asc' ? 1 : -1;
  const within = (a: NodeDto, b: NodeDto): number => {
    let base: number;
    if (sort.key === 'size') base = a.size_bytes - b.size_bytes;
    else if (sort.key === 'date') base = a.updated_at - b.updated_at;
    else base = collator.compare(a.name, b.name);
    if (base === 0) base = collator.compare(a.name, b.name); // stable tiebreak
    return base * dir;
  };
  const folders = nodes.filter((n) => n.kind === 'folder').sort(within);
  const files = nodes.filter((n) => n.kind !== 'folder').sort(within);
  return [...folders, ...files];
}
```

- [ ] **Step 3b: Run the helper test to green**

Run: `cd web && npx vitest run test/dashboard.test.tsx -t "sortNodes"`
Expected: PASS.

- [ ] **Step 3c: Add the i18n keys**

In `web/src/i18n/ar.json`, inside the `"dashboard"` object, add a `"sort"` block (e.g. after the `"action"` block ~line 87):

```jsonc
    "sort": {
      "label": "ترتيب حسب",
      "byName": "الاسم",
      "bySize": "الحجم",
      "byDate": "التاريخ",
      "toggleDir": "عكس اتجاه الترتيب"
    },
```

- [ ] **Step 3d: Wire sorting into `Register`**

In `web/src/features/dashboard/DriveView.tsx`:

1. Add imports (line 1 area + after the `./format` import ~line 21):

```ts
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
```

```ts
import { sortNodes, type SortKey, type SortState } from './sort';
```

2. Inside `Register` (after the `useTranslation()` line ~243, before the `isPending` guard), add sort state + the sorted list:

```ts
const [sort, setSort] = useState<SortState>({ key: 'name', dir: 'asc' });
const sorted = useMemo(() => sortNodes(nodes, sort), [nodes, sort]);

function onSortKey(key: SortKey) {
  setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
}
const ariaSort = (key: SortKey): 'ascending' | 'descending' | 'none' =>
  sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
```

3. Render `sorted` instead of `nodes` in BOTH the desktop `<tbody>` map (~278) and the mobile card map (~299): change `{nodes.map((node) => (` → `{sorted.map((node) => (`.

4. Make the Name/Size/Date `<th>` cells sortable buttons with an affordance + `aria-sort`. Replace the three `<th>` for name/size/date (~268–270) with:

```tsx
              <th aria-sort={ariaSort('name')} className="ps-3 pe-3 py-2 text-start font-medium">
                <button type="button" onClick={() => onSortKey('name')} className="inline-flex items-center gap-1 hover:text-ink">
                  {t('dashboard.col.name')}
                  {sort.key === 'name' && <span aria-hidden="true">{sort.dir === 'asc' ? '↑' : '↓'}</span>}
                </button>
              </th>
              <th aria-sort={ariaSort('size')} className="ps-3 pe-3 py-2 text-start font-medium">
                <button type="button" onClick={() => onSortKey('size')} className="inline-flex items-center gap-1 hover:text-ink">
                  {t('dashboard.col.size')}
                  {sort.key === 'size' && <span aria-hidden="true">{sort.dir === 'asc' ? '↑' : '↓'}</span>}
                </button>
              </th>
              <th aria-sort={ariaSort('date')} className="ps-3 pe-3 py-2 text-start font-medium">
                <button type="button" onClick={() => onSortKey('date')} className="inline-flex items-center gap-1 hover:text-ink">
                  {t('dashboard.col.date')}
                  {sort.key === 'date' && <span aria-hidden="true">{sort.dir === 'asc' ? '↑' : '↓'}</span>}
                </button>
              </th>
```

5. Add a compact mobile sort control (the mobile card list has no table header). Immediately **before** the mobile `<div className="flex flex-col gap-3 md:hidden">` block (~298), add:

```tsx
<div className="flex items-center gap-2 md:hidden">
  <label htmlFor="mobile-sort-key" className="font-body text-xs text-ink-2">
    {t('dashboard.sort.label')}
  </label>
  <select
    id="mobile-sort-key"
    value={sort.key}
    onChange={(e) => setSort((s) => ({ key: e.target.value as SortKey, dir: s.dir }))}
    className="rounded-md border border-line bg-surface ps-2 pe-2 py-1 font-body text-xs text-ink"
  >
    <option value="name">{t('dashboard.sort.byName')}</option>
    <option value="size">{t('dashboard.sort.bySize')}</option>
    <option value="date">{t('dashboard.sort.byDate')}</option>
  </select>
  <button
    type="button"
    aria-label={t('dashboard.sort.toggleDir')}
    onClick={() => setSort((s) => ({ key: s.key, dir: s.dir === 'asc' ? 'desc' : 'asc' }))}
    className="inline-flex min-h-10 items-center rounded-md border border-line px-2 py-1 font-body text-xs text-ink"
  >
    {sort.dir === 'asc' ? '↑' : '↓'}
  </button>
</div>
```

- [ ] **Step 4: Write + run a render assertion for header-click sorting**

Append inside the existing `describe('DriveView …')` in `web/test/dashboard.test.tsx`:

```tsx
test('clicking the Size column header reorders the rows (folders stay first) (#7)', async () => {
  const listing: NodeDto[] = [
    {
      id: 1,
      parent_id: 9,
      kind: 'file',
      name: 'big.bin',
      size_bytes: 900,
      mime_type: null,
      auto_delete_at: null,
      created_at: 0,
      updated_at: 100,
    },
    {
      id: 2,
      parent_id: 9,
      kind: 'file',
      name: 'small.txt',
      size_bytes: 10,
      mime_type: null,
      auto_delete_at: null,
      created_at: 0,
      updated_at: 200,
    },
    {
      id: 3,
      parent_id: 9,
      kind: 'folder',
      name: 'Docs',
      size_bytes: 0,
      mime_type: null,
      auto_delete_at: null,
      created_at: 0,
      updated_at: 300,
    },
  ];
  stubFetch({ '/api/nodes': listing, '/api/shares': [] });
  renderDrive(['/']);

  await screen.findByText('big.bin');
  const table = document.querySelector('table')!;
  const sizeHeaderBtn = within(table).getByRole('button', { name: /الحجم/ });
  await act(async () => {
    fireEvent.click(sizeHeaderBtn); // size asc
  });

  const nameCells = within(table)
    .getAllByText(/big\.bin|small\.txt|Docs/)
    .map((el) => el.textContent);
  // Folder first, then files ascending by size: Docs, small.txt, big.bin
  expect(nameCells).toEqual(['Docs', 'small.txt', 'big.bin']);
});
```

Run: `cd web && npx vitest run test/dashboard.test.tsx -t "Size column header"`
Expected: PASS. (If the `getAllByText` ordering assertion proves brittle against the existing markup, assert row order via `within(table).getAllByRole('row')` and their name cell text instead — same intent.)

- [ ] **Step 5: Full web suite + typecheck**

Run: `cd web && npx vitest run && npm run typecheck`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
cd /var/www/projects/mirsal
git add web/src/features/dashboard/sort.ts web/src/features/dashboard/DriveView.tsx web/src/i18n/ar.json web/test/dashboard.test.tsx
git commit -m "feat(web): sort files/folders by name/size/date, folders-first (#7)"
```

---

## Task 4: Web — multi-select rows → bulk move to Trash

**Files:**

- Modify: `web/src/features/dashboard/DriveView.tsx` (selection state in `DriveView`, cleared on folder nav; checkbox column + select-all + bulk action bar in `Register`/`NodeRow`)
- Modify: `web/src/i18n/ar.json` (keys under `dashboard.select` + two `toast` keys)
- Test: `web/test/dashboard.test.tsx` (append tests in the `DriveView` describe)

**Interfaces:**

- Consumes: the existing `useTrashNode()` mutation (already created in `DriveView` as `trashMutation`) — bulk delete loops `trashMutation.mutateAsync(id)` over the selected ids (spec: "reusing the existing single-row trash mutation (`Promise.all` over the ids)"). No new server route (the optional `POST /api/nodes/trash-bulk` is explicitly out of scope for v1).
- Produces: a `Set<number>` selection owned by `DriveView`, cleared whenever `parentId` changes; a bulk action bar shown when `selected.size > 0`.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('DriveView …')` in `web/test/dashboard.test.tsx`:

```tsx
test('selecting rows shows a bulk bar; confirming bulk-trashes each selected id (#8)', async () => {
  const listing: NodeDto[] = [
    {
      id: 1,
      parent_id: 9,
      kind: 'file',
      name: 'a.txt',
      size_bytes: 5,
      mime_type: null,
      auto_delete_at: null,
      created_at: 0,
      updated_at: 100,
    },
    {
      id: 2,
      parent_id: 9,
      kind: 'file',
      name: 'b.txt',
      size_bytes: 6,
      mime_type: null,
      auto_delete_at: null,
      created_at: 0,
      updated_at: 200,
    },
  ];
  const trashed: number[] = [];
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url).split('?')[0];
    const method = (init?.method ?? 'GET').toUpperCase();
    if (path === '/api/nodes' && method === 'GET') return jsonResponse(200, listing);
    if (path === '/api/shares') return jsonResponse(200, []);
    const m = path.match(/^\/api\/nodes\/(\d+)\/trash$/);
    if (m && method === 'POST') {
      trashed.push(Number(m[1]));
      return jsonResponse(200, {});
    }
    return jsonResponse(200, {});
  });
  vi.stubGlobal('fetch', fetchMock);

  renderDrive(['/']);
  await screen.findByText('a.txt');

  // Select both rows via their per-row checkboxes.
  const cbs = screen.getAllByRole('checkbox', { name: 'تحديد الصف' });
  await act(async () => {
    fireEvent.click(cbs[0]);
    fireEvent.click(cbs[1]);
  });

  // Bulk bar appears with the count; confirm.
  const bulkBtn = await screen.findByRole('button', { name: /نقل إلى المهملات \(2\)/ });
  await act(async () => {
    fireEvent.click(bulkBtn);
  });
  const confirm = await screen.findByRole('button', { name: 'نقل' });
  await act(async () => {
    fireEvent.click(confirm);
  });

  expect(trashed.sort()).toEqual([1, 2]);
});

test('the select-all checkbox toggles every row in the current folder (#8)', async () => {
  const listing: NodeDto[] = [
    {
      id: 1,
      parent_id: 9,
      kind: 'file',
      name: 'a.txt',
      size_bytes: 5,
      mime_type: null,
      auto_delete_at: null,
      created_at: 0,
      updated_at: 100,
    },
    {
      id: 2,
      parent_id: 9,
      kind: 'folder',
      name: 'Docs',
      size_bytes: 0,
      mime_type: null,
      auto_delete_at: null,
      created_at: 0,
      updated_at: 200,
    },
  ];
  stubFetch({ '/api/nodes': listing, '/api/shares': [] });
  renderDrive(['/']);
  await screen.findByText('a.txt');

  const selectAll = screen.getByRole('checkbox', { name: 'تحديد الكل' });
  await act(async () => {
    fireEvent.click(selectAll);
  });
  // Bulk bar reflects both rows selected.
  await screen.findByRole('button', { name: /نقل إلى المهملات \(2\)/ });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx vitest run test/dashboard.test.tsx -t "bulk"`
Expected: FAIL — no checkboxes / bulk bar.

- [ ] **Step 3a: Add the i18n keys**

In `web/src/i18n/ar.json`, add a `"select"` block under `"dashboard"` (after the `"sort"` block from Task 3) and two `toast` keys:

```jsonc
    "select": {
      "row": "تحديد الصف",
      "all": "تحديد الكل",
      "bulkTrash": "نقل إلى المهملات ({{n}})",
      "cancel": "إلغاء التحديد",
      "confirmTitle": "نقل إلى المهملات",
      "confirmBody": "سيُنقل {{n}} عنصرًا إلى المهملات. متابعة؟",
      "confirmSubmit": "نقل"
    },
```

And add to the existing `"dashboard.toast"` block (~line 113):

```jsonc
      "bulkTrashed": "نُقلت العناصر إلى المهملات.",
      "bulkTrashFailed": "تعذّر نقل بعض العناصر. حاول مجددًا."
```

- [ ] **Step 3b: Add selection state in `DriveView`, cleared on folder navigation**

In `DriveView` (after the modal-target `useState`s ~line 94):

```ts
const [selected, setSelected] = useState<Set<number>>(() => new Set());
const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);

// Selection is per-folder — clear it whenever the listing's parent changes
// (drill in / breadcrumb / back button all change parentId).
useEffect(() => {
  setSelected(new Set());
}, [parentId]);

function toggleSelect(id: number) {
  setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
}
function toggleSelectAll(ids: number[]) {
  setSelected((prev) => (prev.size === ids.length ? new Set() : new Set(ids)));
}

async function runBulkTrash() {
  const ids = [...selected];
  try {
    await Promise.all(ids.map((id) => trashMutation.mutateAsync(id)));
    toast({ kind: 'success', message: t('dashboard.toast.bulkTrashed') });
  } catch {
    toast({ kind: 'error', message: t('dashboard.toast.bulkTrashFailed') });
  } finally {
    setSelected(new Set());
    setBulkConfirmOpen(false);
  }
}
```

- [ ] **Step 3c: Pass selection props to `Register`**

Extend the `<Register … />` usage (~126) with:

```tsx
<Register
  isPending={isPending}
  isError={isError}
  nodes={children}
  shareByNode={shareByNode}
  selected={selected}
  onToggleSelect={toggleSelect}
  onToggleSelectAll={toggleSelectAll}
  onBulkTrash={() => setBulkConfirmOpen(true)}
  onClearSelection={() => setSelected(new Set())}
  onOpen={openFolder}
  onRename={setRenameTarget}
  onMove={setMoveTarget}
  onShare={setShareTarget}
  onAutoDelete={setAutoDeleteTarget}
  onTrash={onTrash}
/>
```

And render a bulk confirm modal near the other modals (~140):

```tsx
{
  bulkConfirmOpen && (
    <Modal
      open
      onClose={() => setBulkConfirmOpen(false)}
      title={t('dashboard.select.confirmTitle')}
      footer={
        <>
          <Button variant="secondary" onClick={() => setBulkConfirmOpen(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" onClick={runBulkTrash} disabled={trashMutation.isPending}>
            {t('dashboard.select.confirmSubmit')}
          </Button>
        </>
      }
    >
      <p className="font-body text-sm text-ink">{t('dashboard.select.confirmBody', { n: selected.size })}</p>
    </Modal>
  );
}
```

- [ ] **Step 3d: Add the checkbox column + select-all + bulk bar to `Register`**

Extend `Register`'s prop type and body:

1. Add to the `Register({ … })` destructure + its type (~220–242):

```ts
  selected,
  onToggleSelect,
  onToggleSelectAll,
  onBulkTrash,
  onClearSelection,
```

```ts
  selected: Set<number>;
  onToggleSelect: (id: number) => void;
  onToggleSelectAll: (ids: number[]) => void;
  onBulkTrash: () => void;
  onClearSelection: () => void;
```

2. Inside `Register`, after `sorted` is computed (Task 3), derive the id list + all-selected flag:

```ts
const allIds = sorted.map((n) => n.id);
const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));
```

3. Render a bulk action bar above the table/cards (inside the returned fragment, right after `return (` `<>`):

```tsx
{
  selected.size > 0 && (
    <div className="flex flex-wrap items-center gap-2 rounded-[10px] border border-line bg-paper px-3 py-2">
      <Button variant="danger" onClick={onBulkTrash}>
        {t('dashboard.select.bulkTrash', { n: selected.size })}
      </Button>
      <button type="button" onClick={onClearSelection} className="font-body text-sm text-teal">
        {t('dashboard.select.cancel')}
      </button>
    </div>
  );
}
```

4. Add a leading select-all `<th>` in the desktop header row (before the Name `<th>`):

```tsx
<th className="ps-3 pe-1 py-2 text-start font-medium">
  <input
    type="checkbox"
    aria-label={t('dashboard.select.all')}
    checked={allSelected}
    onChange={() => onToggleSelectAll(allIds)}
  />
</th>
```

5. Pass `selected`/`onToggleSelect` into each `NodeRow` (both desktop and mobile maps):

```tsx
                selected={selected.has(node.id)}
                onToggleSelect={onToggleSelect}
```

6. In `NodeRow`, add the two props (type + destructure), then render a per-row checkbox. Desktop: a leading `<td>` before the name cell; mobile card: a checkbox at the top-left of the card header.

Desktop leading `<td>` (before the name `<td>` ~557):

```tsx
<td className="ps-3 pe-1 py-2 align-top">
  <input
    type="checkbox"
    aria-label={t('dashboard.select.row')}
    checked={selected}
    onChange={() => onToggleSelect(node.id)}
  />
</td>
```

Mobile card — wrap the existing header row so the checkbox sits beside the icon/name (inside the `variant === 'card'` block, as the first child of the card `<div>`):

```tsx
<div className="mb-2 flex items-center gap-2">
  <input
    type="checkbox"
    aria-label={t('dashboard.select.row')}
    checked={selected}
    onChange={() => onToggleSelect(node.id)}
  />
  <span className="font-body text-xs text-ink-2">{t('dashboard.select.row')}</span>
</div>
```

`NodeRow` prop additions:

```ts
  selected: boolean;
  onToggleSelect: (id: number) => void;
```

Note: the desktop table gains one leading column, so the empty/loading/error states (which render a `<p>` not a table) are unaffected; only the `<thead>`/`<tbody>` need the extra cell. Keep the select-all `<th>` and each row's leading `<td>` in sync (both present) so the column count matches.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && npx vitest run test/dashboard.test.tsx -t "bulk"` then `-t "select-all"`
Expected: PASS.

- [ ] **Step 5: Full web suite + typecheck**

Run: `cd web && npx vitest run && npm run typecheck`
Expected: all green. (If any pre-existing `DriveView` row-count/query assertions break because of the new leading column, update them to account for the checkbox cell — do not weaken unrelated assertions.)

- [ ] **Step 6: Commit**

```bash
cd /var/www/projects/mirsal
git add web/src/features/dashboard/DriveView.tsx web/src/i18n/ar.json web/test/dashboard.test.tsx
git commit -m "feat(web): multi-select rows → bulk move to Trash (#8)"
```

---

## Final: whole-branch verification (before requesting review)

- [ ] **Both suites fully green + typecheck clean:**

```bash
cd /var/www/projects/mirsal/server && npx vitest run && npm run typecheck
cd /var/www/projects/mirsal/web && npx vitest run && npm run typecheck
```

- [ ] **Adversarial self-review of the diff** (`git diff main...HEAD`): confirm — empty-trash is owner-scoped + idempotent + unlinks blobs after commit; no nested transaction; sorting is pure + folders-first + doesn't mutate; selection clears on folder nav; new i18n keys resolve (no raw `dashboard.select.…` leaking into the DOM); the desktop table column count is consistent (select-all `<th>` ↔ per-row `<td>`).

- [ ] **STOP for user review.** Do NOT merge or deploy without an explicit go ([[feedback_phase_pause]]). On go, the rollout is (no migration → no DB snapshot needed):

```bash
git checkout main && git merge --no-ff feat/round3-phase3-dashboard
git push origin main
cd /var/www/projects/mirsal && docker compose build && docker compose up -d
```

Then live-verify the nginx→container HTTPS chain (box can't reach its own public IP):

```bash
curl -sk --resolve project4.system.mow.gov.sy:443:127.0.0.1 https://project4.system.mow.gov.sy/api/health
curl -sk --resolve project4.system.mow.gov.sy:443:127.0.0.1 https://project4.system.mow.gov.sy/login -o /dev/null -w '%{http_code}\n'
```

and **headless-render** the Trash view (empty-trash button) + Drive view (sortable headers, checkboxes/bulk bar) with the `/root/.agent-browser` chrome against `127.0.0.1:8084` before calling it verified (unit-green ≠ visually verified — the standing lesson from the auth-pages placeholder). Confirm `schema_version` is unchanged (still 3) and users/shares are intact.

---

## Self-Review (plan vs spec §Phase 3)

- **§3.1 (#6) empty whole Trash** → Task 1 (server route reusing `permanentDelete` over top-level trashed nodes, idempotent, quota subtract, blob unlink, owner-scoped) + Task 2 (button shown only when non-empty, destructive confirm, `useEmptyTrash` invalidates nodes+trash+meter). ✅
- **§3.2 (#7) sorting** → Task 3 (`sortNodes` pure helper: folders-first, name via `Intl.Collator('ar',{numeric,sensitivity:'base'})`, size via `size_bytes`, date via `updated_at`; sortable `<th>` with `aria-sort` + asc/desc affordance; mobile sort control; no server change). ✅
- **§3.3 (#8) multi-select → bulk trash** → Task 4 (`Set<number>` selection in `DriveView` cleared on folder nav; per-row + select-all checkboxes; bulk bar with count + cancel; single confirm; `Promise.all` over the existing `useTrashNode` mutation = move to Trash, not permanent delete; accessible labels). ✅
- **Out of scope respected:** no `POST /api/nodes/trash-bulk` (v1 loops the existing endpoint); bulk = move to Trash, not permanent delete; no schema/migration. ✅
- **Type consistency:** `sortNodes`/`SortState`/`SortKey` names match across Task 3 def and DriveView use; `emptyTrash`/`useEmptyTrash` match across api/queries/TrashView; selection prop names (`selected`,`onToggleSelect`,`onToggleSelectAll`,`onBulkTrash`,`onClearSelection`) match across `DriveView`→`Register`→`NodeRow`. ✅
