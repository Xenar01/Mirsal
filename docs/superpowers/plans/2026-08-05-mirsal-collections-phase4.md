# Mirsal Collections — Phase 4 (ZIP export · upload progress · E2E · RUNBOOK) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the Collections (طلب تجميع) feature — let owners download a department's response set or the whole collection as one ZIP, show an upload-progress bar on the uploader's submit, verify the full flow end-to-end, and document Collections in the RUNBOOK.

**Architecture:** The only ZIP code today lives in the public share route (`server/src/routes/public.ts`): the `archiver` stream, a bounded subtree walk (`collectSubtreeFiles`), a server-wide concurrency bound, and a `<name>.zip` filename sanitizer. Phase 4 **extracts that machinery into a shared, tested module** (`server/src/util/zip.ts`) and adds an **authenticated, owner-scoped `GET /api/nodes/:id/zip`** that reuses it. Collections then get both ZIPs for free by pointing that route at (a) a department's response folder node and (b) the collection's own root folder node — no collection-specific server code. Frontend wires two ZIP links plus an XHR-based upload-progress bar (mirroring the existing `/api/nodes/upload` XHR client). **No DB migration** — schema stays v4.

**Tech Stack:** Fastify 5 · better-sqlite3 · `archiver` (already a dependency) · Vitest (server) · React 19 + Vitest/Testing-Library (web) · i18next.

## Global Constraints

- **No schema change.** Live DB is at `schema_version = 4`; Phase 4 adds no migration. `LATEST_VERSION` stays `4`.
- **Owner-scoping is mandatory + oracle-free.** Any node lookup on an authenticated route goes through `getOwnedNode(db, uid, id)`; a node the caller does not own returns **404** (never 403 — no existence oracle), exactly like the existing `/api/nodes/:id/download`.
- **Reuse, don't re-invent.** ZIP bounds/filename/walk come from the shared module extracted in Task 1. Upload progress reuses the XHR shape already in `web/src/features/dashboard/api.ts` (`uploadFile`, line ~90–110).
- **Ink & Brass / Cairo only.** No new palette, fonts, or components — reuse `Button`, `DownloadArrow`/`DownloadGlyph`, `PrimaryLink`, existing Tailwind tokens (`text-teal`, `text-ink-2`, `border-line`, …).
- **Owner UI strings are Arabic-only** (`collections.*` in `web/src/i18n/ar.json` only). **Uploader strings are bilingual** (`collect.*` in both `ar.json` and `en.json`, kept at key parity — there is a parity test).
- **Gates per workspace:** `cd server && npm test && npm run typecheck`; `cd web && npm test && npm run typecheck && npm run build`. There is **no eslint/lint script** — do not invent one.
- **Commit after every green step** (feedback: save-often); Phase 4 lands on branch **`feat/collections-phase4`** off `main` (`b2246bf`). **Do not merge or deploy** — stop at the finish checkpoint for the user's go (feedback: phase-pause).

---

## File Structure

**Server**
- Create `server/src/util/zip.ts` — shared ZIP helpers: `MAX_ZIP_ENTRIES`, `MAX_ZIP_WALK_NODES`, `ZIP_COMPRESSION_LEVEL`, `collectSubtreeFiles(db, ownerId, root)`, `zipFileName(rawName)`, `appendFilesToArchive(archive, files, blobStore)`.
- Create `server/test/util/zip.test.ts` — unit tests for the walk bounds + filename sanitizer.
- Modify `server/src/routes/public.ts` — delete the inlined copies of the above; import them from `util/zip.ts`. Behaviour unchanged; existing public-zip tests must stay green.
- Modify `server/src/routes/nodes.ts` — add authenticated `GET /api/nodes/:id/zip` (folder-only, owner-scoped, concurrency-bounded, audited).
- Modify `server/test/routes/nodes.test.ts` (or the file that holds node-route tests) — tests for the new route.
- Modify `server/src/routes/collections.ts` — add `folder_node_id` to `CollectionDetailDto` + `buildDetailDto`.
- Modify `server/test/routes/collections.test.ts` — assert the detail DTO carries `folder_node_id`.

**Web**
- Modify `web/src/features/dashboard/api.ts` — add `zipUrl(id)`.
- Modify `web/src/features/collections/types.ts` — add `folder_node_id: number | null` to the collection-detail type.
- Modify `web/src/features/collections/CollectionDetail.tsx` — whole-collection ZIP button (header) + per-department ZIP link (responded roster row).
- Modify `web/src/features/collect/api.ts` — `submitResponse` gains an optional `onProgress(fraction)` and switches from `fetch` to XHR.
- Modify `web/src/features/collect/CollectForm.tsx` — progress state + bar; route `closed`/`locked` submit results to the proper screen (carry #5).
- Modify `web/src/features/collections/CollectionsView.tsx` + `CollectionDetail.tsx` — not-found screen for a non-integer `/collections/:id` (carry #4).
- Modify `web/src/i18n/ar.json` — add `collections.detail.downloadDeptZip`, `collections.detail.downloadAllZip`; delete dead keys (carry #2). Modify `web/src/i18n/en.json` + `ar.json` — add `collect.uploading`.
- Add/modify component tests alongside each changed component.

**Docs**
- Modify `docs/RUNBOOK.md` — a "Collections (طلب تجميع)" section.

---

### Task 1: Extract shared ZIP module (refactor, behaviour-preserving)

**Files:**
- Create: `server/src/util/zip.ts`
- Create: `server/test/util/zip.test.ts`
- Modify: `server/src/routes/public.ts` (remove inlined `collectSubtreeFiles`, `zipFileName`, `MAX_ZIP_ENTRIES`, `MAX_ZIP_WALK_NODES`, `ZIP_COMPRESSION_LEVEL`; import from `util/zip.ts`)

**Interfaces:**
- Produces:
  - `const MAX_ZIP_ENTRIES = 10_000`
  - `const MAX_ZIP_WALK_NODES = 20_000`
  - `const ZIP_COMPRESSION_LEVEL = 6`
  - `function collectSubtreeFiles(db: Database.Database, ownerId: number, root: Node): Array<{ storagePath: string; name: string }>` — iterative, bounded on both `MAX_ZIP_ENTRIES` and `MAX_ZIP_WALK_NODES`; uses `listChildren` (excludes trashed); a `file` root returns a single `{storagePath, name}`.
  - `function zipFileName(rawName: string): string` — sanitizes to `<base>.zip` (CR/LF + path separators stripped; empty → `download.zip`).
  - `function appendFilesToArchive(archive: ZipArchive, files: Array<{ storagePath: string; name: string }>, blobStore: BlobStore): void` — `for (const f of files) archive.append(blobStore.readBlob(f.storagePath), { name: f.name })`.
- Consumes: `listChildren` from `../nodes/tree.js`, `Node` type, `ZipArchive` from `archiver`, `BlobStore` from `../storage/blobs.js`.

- [ ] **Step 1: Write the failing unit test** — `server/test/util/zip.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { collectSubtreeFiles, zipFileName, MAX_ZIP_ENTRIES } from './zip.js';
import { runMigrations } from '../db/migrate.js';        // match the project's migration entrypoint
import { createFolder } from '../nodes/tree.js';         // match actual helper names/signatures

function seedOwner(db: Database.Database): number {
  db.prepare(`INSERT INTO users(email, password_hash, role, quota_bytes, created_at)
              VALUES ('o@x','h','user', 1000000000, 0)`).run();
  return Number(db.prepare('SELECT id FROM users WHERE email = ?').get('o@x') as any['id'] ?? 1);
}

describe('zipFileName', () => {
  it('sanitizes name, strips separators/CRLF, appends .zip', () => {
    expect(zipFileName('طلب تجميع: تقرير')).toMatch(/\.zip$/);
    expect(zipFileName('a/b\\c\r\nd')).not.toMatch(/[/\\\r\n]/);
    expect(zipFileName('')).toBe('download.zip');
  });
});

describe('collectSubtreeFiles', () => {
  it('walks a folder subtree and prefixes nested paths, excluding the root folder name', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const ownerId = seedOwner(db);
    // Build: root/ (folder) -> a.txt, sub/ -> b.txt   (use the real node-insert helpers)
    // ... insert file nodes with storage_path = `${ownerId}/<id>` and a folder ...
    // const files = collectSubtreeFiles(db, ownerId, rootFolderNode);
    // expect(files.map(f => f.name).sort()).toEqual(['a.txt', 'sub/b.txt']);
    expect(MAX_ZIP_ENTRIES).toBe(10_000); // guards the constant survived the move
  });
});
```

> The implementer fills the seed helpers using the repo's actual node-insert utilities (see `nodes/tree.ts` / test fixtures already used by `public.ts` zip tests). The point of this task is the **move**, verified primarily by the existing public-zip tests staying green.

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd server && npx vitest run test/util/zip.test.ts`
Expected: FAIL — `Cannot find module './zip.js'`.

- [ ] **Step 3: Create `server/src/util/zip.ts`** — cut the five symbols verbatim out of `public.ts` (lines ~99–111 constants, ~123–127 `zipFileName`, ~729–771 `collectSubtreeFiles`) into the new module and add `appendFilesToArchive`. Preserve the doc-comments (they explain the DoS bounds).

```ts
import type Database from 'better-sqlite3';
import { ZipArchive } from 'archiver';
import type { Node } from '../nodes/types.js';       // match actual Node import path
import { listChildren } from '../nodes/tree.js';
import type { BlobStore } from '../storage/blobs.js';

export const MAX_ZIP_ENTRIES = 10_000;
export const MAX_ZIP_WALK_NODES = 20_000;
export const ZIP_COMPRESSION_LEVEL = 6;

export function zipFileName(rawName: string): string { /* moved verbatim */ }

export function collectSubtreeFiles(
  db: Database.Database, ownerId: number, root: Node
): Array<{ storagePath: string; name: string }> { /* moved verbatim */ }

export function appendFilesToArchive(
  archive: ZipArchive, files: Array<{ storagePath: string; name: string }>, blobStore: BlobStore
): void {
  for (const f of files) archive.append(blobStore.readBlob(f.storagePath), { name: f.name });
}
```

- [ ] **Step 4: Rewire `public.ts`** — delete the moved copies; add `import { MAX_ZIP_ENTRIES, MAX_ZIP_WALK_NODES, ZIP_COMPRESSION_LEVEL, collectSubtreeFiles, zipFileName, appendFilesToArchive } from '../util/zip.js';` and replace the inline `for (const f of files) archive.append(...)` loop with `appendFilesToArchive(archive, files, blobStore)`.

- [ ] **Step 5: Run the whole server suite** (regression is the real gate)

Run: `cd server && npm test && npm run typecheck`
Expected: PASS — including every existing `public.ts` zip test, unchanged.

- [ ] **Step 6: Commit**

```bash
git add server/src/util/zip.ts server/test/util/zip.test.ts server/src/routes/public.ts
git commit -m "refactor(zip): extract shared ZIP helpers from public route into util/zip"
```

---

### Task 2: Authenticated `GET /api/nodes/:id/zip` (owner-scoped, folder-only, concurrency-bounded)

**Files:**
- Modify: `server/src/routes/nodes.ts` (add the route near the existing `/api/nodes/:id/download`, line ~674)
- Modify: `server/test/routes/nodes.test.ts` (the suite covering node routes — match the repo's actual test file)

**Interfaces:**
- Consumes: `getOwnedNode(db, uid, id)`, `parseIdParam(req)`, `buildContentDisposition`, and from `util/zip.ts`: `collectSubtreeFiles`, `zipFileName`, `appendFilesToArchive`, `ZIP_COMPRESSION_LEVEL`.
- Produces: route `GET /api/nodes/:id/zip` → `200 application/zip` (folder subtree, streamed) · `404 {error:'not_found'}` (bad id / not owned / missing) · `400 {error:'not_a_folder'}` (id is a file/root/trash) · `429 {error:'too_many_requests'}` (concurrency cap).

- [ ] **Step 1: Write the failing tests** — in the node-routes test file

```ts
it('zips an owned folder subtree (authenticated)', async () => {
  const { app, agent, ownerId } = await bootAuthedApp();          // reuse existing test bootstrap
  const folderId = await makeFolderWithFiles(app, ownerId, ['a.txt', 'b.txt']);
  const res = await agent.get(`/api/nodes/${folderId}/zip`);
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('application/zip');
  expect(res.headers['content-disposition']).toMatch(/\.zip/);
});

it('returns 404 for a folder owned by someone else (no oracle)', async () => {
  const { app, otherAgent, foreignFolderId } = await bootTwoUsers();
  const res = await otherAgent.get(`/api/nodes/${foreignFolderId}/zip`);
  expect(res.statusCode).toBe(404);
});

it('returns 400 when the node is a file, not a folder', async () => {
  const { app, agent, fileId } = await bootWithOneFile();
  const res = await agent.get(`/api/nodes/${fileId}/zip`);
  expect(res.statusCode).toBe(400);
  expect(res.json()).toEqual({ error: 'not_a_folder' });
});

it('returns 404 for a non-integer id', async () => {
  const { agent } = await bootAuthedApp();
  expect((await agent.get('/api/nodes/abc/zip')).statusCode).toBe(404);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd server && npx vitest run test/routes/nodes.test.ts -t zip`
Expected: FAIL — 404 (route not registered) on the happy path.

- [ ] **Step 3: Implement the route** in `nodes.ts` (add imports from `util/zip.js` + `ZipArchive` from `archiver`). Mirror the download route's guard shape and the public-zip concurrency-slot discipline (release on raw `'close'`, idempotent via a `WeakSet`).

```ts
// module scope in nodes.ts route factory:
const MAX_CONCURRENT_NODE_ZIPS = 4;
let activeNodeZipCount = 0;
const nodeZipSlots = new WeakSet<FastifyRequest>();
function releaseNodeZipSlot(req: FastifyRequest) {
  if (nodeZipSlots.delete(req)) activeNodeZipCount--;
}

app.get('/api/nodes/:id/zip', { preHandler: guards.requireAuth }, async (req, reply) => {
  const id = parseIdParam(req);
  if (id === null) { reply.code(404).send({ error: 'not_found' }); return; }

  const uid = req.user!.id;
  const node = getOwnedNode(db, uid, id);
  if (!node) { reply.code(404).send({ error: 'not_found' }); return; }
  if (node.kind !== 'folder') { reply.code(400).send({ error: 'not_a_folder' }); return; }

  if (activeNodeZipCount >= MAX_CONCURRENT_NODE_ZIPS) {
    reply.code(429).send({ error: 'too_many_requests' }); return;
  }
  const files = collectSubtreeFiles(db, uid, node);

  activeNodeZipCount++;
  nodeZipSlots.add(req);
  reply.raw.once('close', () => releaseNodeZipSlot(req));   // fires on finish AND mid-stream abort

  const archive = new ZipArchive({ zlib: { level: ZIP_COMPRESSION_LEVEL } });
  archive.on('error', (err) => { req.log.error({ err }, 'node zip stream failed'); reply.raw.destroy(err); });
  appendFilesToArchive(archive, files, blobStore);

  reply.header('Content-Type', 'application/zip');
  reply.header('Content-Disposition', buildContentDisposition(zipFileName(node.name)));
  reply.header('X-Content-Type-Options', 'nosniff');
  writeAudit(db, { actorId: uid, action: 'zip', target: String(id) }, now);

  const sent = reply.send(archive);
  void archive.finalize();
  return sent;
});
```

- [ ] **Step 4: Run tests to green**

Run: `cd server && npx vitest run test/routes/nodes.test.ts -t zip`
Expected: PASS (all four).

- [ ] **Step 5: Full suite + typecheck**

Run: `cd server && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/nodes.ts server/test/routes/nodes.test.ts
git commit -m "feat(nodes): authenticated owner-scoped GET /api/nodes/:id/zip (folder subtree)"
```

---

### Task 3: Expose collection root `folder_node_id` in the detail DTO

**Files:**
- Modify: `server/src/routes/collections.ts` (`CollectionDetailDto` + `buildDetailDto`, lines ~38–47, ~73+)
- Modify: `server/test/routes/collections.test.ts`

**Interfaces:**
- Produces: `CollectionDetailDto.folder_node_id: number` (the collection's own root folder node — the whole-collection ZIP target). `Collection.folder_node_id` already exists (`collections/collections.ts:18`), so this is a passthrough.

- [ ] **Step 1: Failing test** — in `collections.test.ts`, extend the existing "GET /api/collections/:id returns detail" test:

```ts
expect(typeof body.folder_node_id).toBe('number');
expect(body.folder_node_id).toBe(created.folder_node_id); // matches the folder created at create-time
```

- [ ] **Step 2: Run — confirm fail**

Run: `cd server && npx vitest run test/routes/collections.test.ts -t detail`
Expected: FAIL — `folder_node_id` undefined on the DTO.

- [ ] **Step 3: Add the field** — in `collections.ts`:
  - Add `folder_node_id: number;` to `interface CollectionDetailDto`.
  - In `buildDetailDto`, add `folder_node_id: c.folder_node_id,` to the returned object.

- [ ] **Step 4: Run to green + suite**

Run: `cd server && npx vitest run test/routes/collections.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/collections.ts server/test/routes/collections.test.ts
git commit -m "feat(collections): expose collection root folder_node_id in detail DTO"
```

---

### Task 4: Owner ZIP buttons — per-department + whole-collection

**Files:**
- Modify: `web/src/features/dashboard/api.ts` (add `zipUrl`)
- Modify: `web/src/features/collections/types.ts` (add `folder_node_id`)
- Modify: `web/src/features/collections/CollectionDetail.tsx` (whole-collection button + per-dept link)
- Modify: `web/src/i18n/ar.json` (`collections.detail.downloadDeptZip`, `collections.detail.downloadAllZip`)
- Modify/Add: `web/test/collections-detail.test.tsx`

**Interfaces:**
- Consumes: `zipUrl(id: number): string` → `/api/nodes/${id}/zip`; `detail.folder_node_id` (Task 3); `dept.folder_node_id` (already present on responded rows).
- Produces: two anchor links (`<a href={zipUrl(...)}>`), no new API calls (ZIP is a plain authenticated GET the browser follows).

- [ ] **Step 1: Failing test** — `CollectionDetail.test.tsx`

```tsx
it('renders a whole-collection ZIP link pointing at the collection folder node', () => {
  renderDetail({ folder_node_id: 42, departments: [] });
  const all = screen.getByRole('link', { name: /تنزيل الكل/ });   // collections.detail.downloadAllZip
  expect(all).toHaveAttribute('href', '/api/nodes/42/zip');
});

it('renders a per-department ZIP link for a responded department', () => {
  renderDetail({ folder_node_id: 42, departments: [
    { id: 1, name: 'المالية', responded: true, file_count: 2, submitted_at: 1, note: null, folder_node_id: 77 },
  ]});
  const dept = screen.getByRole('link', { name: /تنزيل كملف مضغوط/ }); // collections.detail.downloadDeptZip
  expect(dept).toHaveAttribute('href', '/api/nodes/77/zip');
});
```

- [ ] **Step 2: Run — confirm fail**

Run: `cd web && npx vitest run test/collections-detail.test.tsx`
Expected: FAIL — links not found.

- [ ] **Step 3: Implement**
  - `dashboard/api.ts`: `export function zipUrl(id: number): string { return \`/api/nodes/${id}/zip\`; }`
  - `types.ts`: add `folder_node_id: number | null;` to the collection-detail type (mirror the server DTO; may be a plain `number` — match Task 3).
  - `ar.json` under `collections.detail`: `"downloadAllZip": "تنزيل الكل كملف مضغوط"`, `"downloadDeptZip": "تنزيل كملف مضغوط"`.
  - `CollectionDetail.tsx`:
    - In the detail header (near title/roster count), when `detail.folder_node_id != null` and `responded_count > 0`, render `<a href={zipUrl(detail.folder_node_id)} className="inline-flex items-center gap-1 text-teal">…{t('collections.detail.downloadAllZip')}</a>` with a `<DownloadArrow size={16} />`.
    - In the responded roster row (the `RespondedRow`, near the `showFiles` toggle around line 241–251), add `{dept.folder_node_id != null && <a href={zipUrl(dept.folder_node_id)} className="inline-flex items-center gap-1 text-teal"><DownloadArrow size={16} />{t('collections.detail.downloadDeptZip')}</a>}`.

- [ ] **Step 4: Run to green**

Run: `cd web && npx vitest run test/collections-detail.test.tsx`
Expected: PASS.

- [ ] **Step 5: Web gates**

Run: `cd web && npm test && npm run typecheck && npm run build`
Expected: PASS (build regenerates the PWA SW cleanly).

- [ ] **Step 6: Commit**

```bash
git add web/src/features/dashboard/api.ts web/src/features/collections/types.ts \
        web/src/features/collections/CollectionDetail.tsx web/src/i18n/ar.json \
        web/test/collections-detail.test.tsx
git commit -m "feat(collections): per-department + whole-collection ZIP download links"
```

---

### Task 5: Upload-progress bar on the uploader submit

**Files:**
- Modify: `web/src/features/collect/api.ts` (`submitResponse` → XHR + `onProgress`)
- Modify: `web/src/features/collect/CollectForm.tsx` (progress state + bar; route `closed`/`locked` to proper screen — carry #5)
- Modify: `web/src/i18n/ar.json` + `web/src/i18n/en.json` (`collect.uploading`)
- Modify/Add: `web/test/collect.test.tsx`, `web/test/collect-api.test.ts`

**Interfaces:**
- Consumes: existing multipart contract — field name `files`, `departmentId`, optional `note` — unchanged on the wire.
- Produces: `submitResponse(token, body, opts?: { onProgress?: (fraction: number) => void }): Promise<SubmitResult>` where `fraction ∈ [0,1]`. Mirror the XHR shape in `dashboard/api.ts` (`xhr.upload.onprogress` → `e.loaded / e.total`).

- [ ] **Step 1: Failing test** — `api.test.ts` (mock `XMLHttpRequest`) asserts `onProgress` is invoked with a fraction, and the result mapping is preserved for a 200/413/401/404.

```ts
it('reports upload progress and resolves ok on 200', async () => {
  const xhr = installMockXHR();                    // helper mocking upload.onprogress + load
  const seen: number[] = [];
  const p = submitResponse('tok', { departmentId: 1, files: [new File(['x'],'a.txt')] },
                            { onProgress: (f) => seen.push(f) });
  xhr.emitProgress(50, 100);
  xhr.emitLoad(200, JSON.stringify({ ok: true }));
  await expect(p).resolves.toMatchObject({ kind: 'ok' });
  expect(seen).toContain(0.5);
});
```

Also a `CollectForm.test.tsx` case: while submitting, a progress bar (`role="progressbar"`) is shown and `aria-valuenow` tracks progress.

- [ ] **Step 2: Run — confirm fail**

Run: `cd web && npx vitest run test/collect-api.test.ts test/collect.test.tsx`
Expected: FAIL — `onProgress` not supported / no progressbar.

- [ ] **Step 3: Implement**
  - `collect/api.ts`: rewrite `submitResponse` body to build the same `FormData` and send it via `XMLHttpRequest` (mirror `dashboard/api.ts` `uploadFile`): `xhr.open('POST', \`/api/collect/${token}/submit\`)`, `xhr.upload.onprogress = (e) => { if (e.lengthComputable) opts?.onProgress?.(e.loaded / e.total); }`, map `xhr.status` → the existing `SubmitResult` kinds (200→ok, 413→quota/tooLarge per body, 401→locked, 404→closed, 400→tooManyFiles, else error). Keep the **no-CSRF, no-credentials-cookie-for-meta** posture the file documents; submit still posts to the unlock-cookie-scoped path.
  - `CollectForm.tsx`: add `const [progress, setProgress] = useState(0)`; pass `{ onProgress: setProgress }` to `submitResponse`; while `submitting`, render a bar:
    ```tsx
    {submitting && (
      <div className="w-full max-w-sm" role="progressbar" aria-valuemin={0} aria-valuemax={100}
           aria-valuenow={Math.round(progress * 100)}>
        <div className="h-2 rounded bg-line">
          <div className="h-2 rounded bg-teal transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        <p className="mt-1 font-body text-xs text-ink-2">{t('collect.uploading', { pct: Math.round(progress * 100) })}</p>
      </div>
    )}
    ```
  - Carry #5: in the `switch (result.kind)`, replace the `case 'closed'` / `case 'locked'` fall-through into `submitError` with re-routing — surface a distinct localized message (`collect.closedNow` / re-trigger the meta refetch so the page moves to its closed/gate screen). Minimum: show `t('collect.closedNow')` for `closed` and `t('collect.lockedNow')` for `locked` instead of the generic error, and reset `submitting`.
  - i18n: `collect.uploading` = `"جارٍ الرفع… {{pct}}%"` (ar) / `"Uploading… {{pct}}%"` (en); add `collect.closedNow` / `collect.lockedNow` in both.

- [ ] **Step 4: Run to green**

Run: `cd web && npx vitest run test/collect.test.tsx test/collect-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Web gates**

Run: `cd web && npm test && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/features/collect/api.ts web/src/features/collect/CollectForm.tsx \
        web/src/i18n/ar.json web/src/i18n/en.json \
        web/test/collect-api.test.ts web/test/collect.test.tsx
git commit -m "feat(collect): upload-progress bar + route closed/locked submit to proper screen"
```

---

### Task 6: RUNBOOK "Collections" section + dead-i18n cleanup

**Files:**
- Modify: `docs/RUNBOOK.md`
- Modify: `web/src/i18n/ar.json` (+ `en.json` if any dead `collect.*` keys) — remove carry #2 dead keys: `collections.status.{open,closed,expired}`, `collections.open`, `collect.{filesPick,toEnglish,toArabic}` (verify each is truly unreferenced with `grep -rn "key" web/src` before deleting).

- [ ] **Step 1: Verify each dead key is unreferenced**

Run (per key): `cd web && grep -rn "collections.status.open\|collect.filesPick\|collect.toEnglish\|collect.toArabic\|collections.open\|collections.status.closed\|collections.status.expired" src`
Expected: only the definitions in `ar.json`/`en.json`, no `t('…')` call sites. (If any IS referenced, leave it.)

- [ ] **Step 2: Delete the confirmed-dead keys; run the i18n parity test**

Run: `cd web && npx vitest run -t i18n` (or the collect parity test) `&& npm run typecheck && npm run build`
Expected: PASS — parity holds (dead keys removed from both locales where applicable).

- [ ] **Step 3: Write the RUNBOOK section** — add under the appropriate heading in `docs/RUNBOOK.md`:

```markdown
## Collections (طلب تجميع)

Distribute one file and collect a response set back from each of ~N departments via a
single public link `/c/<token>`.

- **Owner UI:** Collections nav → create (title, optional template, department list, optional
  password, optional deadline) → detail/roster (responded X/N; per-department files;
  **download a department's set as ZIP** or **the whole collection as ZIP**; open/close;
  add/remove department; edit title/password/deadline).
- **Storage:** responses land in the owner's Drive under a "طلب تجميع: <title>" folder with a
  per-department subfolder; they count against the owner's quota. **Latest-replaces** —
  a re-submit permanently deletes the department's previous set (not Trash).
- **ZIP downloads** reuse the authenticated `GET /api/nodes/:id/zip` (folder subtree,
  owner-scoped, concurrency-bounded); per-department = the department's response folder,
  whole-collection = the collection's root folder.
- **Bounds:** ≤100 MB/file, ≤10 files/response, one slot/department, owner-quota hard stop.
  Public routes are rate-limited (nginx `real_ip` gives the true client IP).
- **Deadline** closes the form at request-time (no scheduler). Owner open/close is manual.
- **Schema:** tables `collections`, `collection_departments`, `collection_responses`
  (migration v3→v4; live DB at v4). No Phase-4 schema change.
```

- [ ] **Step 4: Commit**

```bash
git add docs/RUNBOOK.md web/src/i18n/ar.json web/src/i18n/en.json
git commit -m "docs(collections): RUNBOOK section + remove dead i18n keys"
```

---

## Finish: full-flow E2E sweep + phase checkpoint (NOT a commit of test code)

Per repo practice, E2E is a **throwaway** boot on `:8099` (create `server/e2e-boot.ts`, run, then delete it — it is not committed).

- [ ] **Step 1: Server + web gates on the branch tip**

Run: `cd server && npm test && npm run typecheck` then `cd web && npm test && npm run typecheck && npm run build`
Expected: all green.

- [ ] **Step 2: Throwaway E2E sweep** (scratch DB, scratch data root, port 8099):
  1. Boot; create an admin/owner; create a collection with a template + a 3-name department list + a password + a deadline.
  2. Hit `/api/collect/<token>` meta (locked → unlock with password), download the template.
  3. Submit **1 file** for dept A; submit **3 files** for dept B; **re-submit** dept B (latest-replaces → old set gone, quota reclaimed).
  4. Owner detail: roster shows **2/3**; per-department ZIP for dept B returns `200 application/zip` with the **replacement** files only; whole-collection ZIP returns `200` containing A + B subfolders.
  5. Owner-scope negative: a *second* owner requesting `/api/nodes/<foreign folder>/zip` → **404**.
  6. Close the collection (or trip the deadline) → submit now blocked; meta shows closed.
  7. Delete `server/e2e-boot.ts` and the scratch DB/data root.

- [ ] **Step 3: Update the SDD ledger / memory** with the branch tip, test counts, and the E2E result. **STOP — do not merge, do not deploy.** Report to the user for the phase-pause gate. On their "go": `superpowers:finishing-a-development-branch` → **pre-deploy DB snapshot** (`VACUUM INTO` → gz, even though there's no migration) → merge `--no-ff` → `docker compose build && up -d` → live-verify HTTPS chain (`/api/nodes/<id>/zip` behind auth returns 401 unauth; collections detail carries `folder_node_id`; served bundle carries the ZIP/progress strings).

---

## Self-Review

**1. Spec coverage (§ lines 51, 132, 168, 193):**
- "download that department's set as a ZIP" → Task 2 (route) + Task 4 (per-dept link). ✅
- "download the whole collection as one ZIP" → Task 2 + Task 3 (root folder_node_id) + Task 4 (all link). ✅
- "reuses folder `/zip`" → Task 1 extraction + Task 2 authenticated route (the route the spec names did **not** previously exist; Phase 4 creates it). ✅ (flagged correction)
- §193 finish: "whole-collection ZIP polish, empty/closed states, E2E sweep (create → 30-name roster → submit 1 & 3 → latest-replaces → download-all-ZIP → close/deadline/password), RUNBOOK note" → Finish section + Task 6. ✅
- Upload-progress bar (memory carry, not spec) → Task 5. ✅

**2. Placeholder scan:** Server task test code is representative but references real helpers; the `zip.test.ts` seed helpers are explicitly delegated to the repo's existing node-insert fixtures (the same ones `public.ts` zip tests already use) — the implementer wires them, and the **regression gate** (existing public-zip tests green after the move) is the real proof of Task 1. No `TODO`/`add error handling`/`similar to` placeholders. ✅

**3. Type consistency:** `zipUrl(id)`, `collectSubtreeFiles`, `zipFileName`, `appendFilesToArchive`, `folder_node_id` used identically across tasks. Route contract (`404`/`400 not_a_folder`/`429`) consistent between Task 2 impl and its tests. ✅

## Deferred (non-blocking carries NOT in Phase 4 scope)

Carries #1 (untested edit-settings console), #3 (`mapStatus`/copy-link dedupe → `useCopyLink()`), #6 (CreateCollectionModal template-orphan rollback) are left for a later polish pass — they don't gate the four Phase-4 deliverables. Carry #4 (non-integer `/collections/:id` → not-found) is folded into Task 4/5 UI touch **only if cheap**; otherwise it also defers. (Carry #2 dead-i18n and #5 closed/locked routing ARE done — Tasks 6 and 5.)
