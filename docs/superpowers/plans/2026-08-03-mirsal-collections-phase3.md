# Mirsal Collections — Phase 3 (Frontend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or superpowers:subagent-driven-development) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Collections UI — the owner's Arabic-only list/create/roster views and the bilingual public uploader page at `/c/:token` — on top of the already-shipped Phase-1 (owner API) and Phase-2 (public intake) server routes. **Frontend-only: no server or schema change.**

**Architecture:** Two new feature areas mirroring existing conventions. `web/src/features/collections/` (owner, Arabic-only, keys `collections.*`) reuses the share-feature pattern: a typed `api.ts` over `lib/api`, TanStack-Query `queries.ts`, a `DashboardShell`-framed list view, a create `Modal`, and a roster/detail view. `web/src/features/collect/` (public, bilingual, keys `collect.*`) mirrors the `features/public/` sealed-dispatch page: a direct-fetch `api.ts` returning a discriminated meta result, a bilingual `DispatchFrame`-style page with an AR/EN language toggle, a password gate, and the multipart upload form (the inbound write). Router gains `/collections` (auth) and `/c/:token` (public); `AppNav` gains a Collections pill.

**Tech Stack:** React 19 + Vite, react-router-dom `<Routes>`, TanStack Query v5, react-i18next, Tailwind (Ink & Brass tokens), Vitest + @testing-library/react. Same toolchain as the rest of `web/`.

## Global Constraints

- **Frontend-only.** No file under `server/` changes. All server endpoints already exist (Phase 1 owner routes `/api/collections*`, Phase 2 public routes `/api/collect/:token/*`). Verify against `server/src/routes/collections.ts` and `server/src/routes/collect.ts` — never guess a shape.
- **Owner UI is Arabic-only** — every owner string is a `collections.*` key added to `web/src/i18n/ar.json` **only** (mirrors `share.*`/`shared.*`, which have no `en` entries; `fallbackLng: 'ar'`).
- **Public uploader UI is bilingual** — every `collect.*` key MUST exist in **both** `web/src/i18n/ar.json` and `web/src/i18n/en.json`. A key present in `ar` but missing from `en` is a visible bug (falls back to Arabic in the EN view). A parity test enforces this.
- **Design system:** Ink & Brass tokens only (`bg-paper`/`bg-surface`/`text-ink`/`text-ink-2`/`border-line`/`text-clay`/`text-emerald`/`text-teal`/`bg-brass`/`text-brass-ink`). No raw hex. Reuse `Modal`, `Button`, `StatusChip`, `useToast`, `Seal`, icons from `components/`, and `DispatchFrame`/`SealHeader` chrome pattern for the public page. Cairo/`font-display`/`font-body`/`font-mono` as elsewhere.
- **RTL correctness:** logical properties only (`ps-*`/`pe-*`/`ms-*`/`me-*`/`text-start`/`border-e`), never `left`/`right`. Mono/LTR ledger data (tokens, dates, sizes, the public URL) wrapped in `<bdi dir="ltr">`. Tap targets ≥ 40px (`min-h-10`/`min-h-11`).
- **CSRF/credentials:** owner calls ride the shared `lib/api` client (auto CSRF + `credentials:'include'`). Public calls are the ONE unauthenticated surface — raw `fetch`/`XMLHttpRequest`, `credentials:'include'` (for the path-scoped unlock cookie), **no** CSRF header.
- **File caps (client-side pre-check, mirrors `UploadDrop`):** each file ≤ `MAX_FILE_BYTES` (100 MB, `104_857_600`, from `dashboard/format.ts`); ≤ 10 files per response (`COLLECTION_MAX_FILES_PER_RESPONSE`); note ≤ 2000 chars.
- **Numerals:** Western 0–9 for all ledger data via the existing `formatBytes`/`formatDate` (Asia/Damascus) helpers in `dashboard/format.ts`; deadline picker uses `damascusInputToUtcMs`/`utcMsToDamascusInput` from `dashboard/share/datetime.ts`.
- **Commit after every task** (feedback_save_often) on branch `feat/collections`. **STOP after Phase 3** (feedback_phase_pause) — do not start Phase 4.
- **Gates:** `npm test` + `npm run typecheck` in `web/` (there is NO eslint/lint script). Both MUST be green before each commit.

## Scope decisions (locked from spec + code reality — flag to user)

1. **Template = inline upload to the owner's Drive.** The server create route accepts only an existing owner-owned `template_node_id`; there is no inline-template-upload endpoint. So the create modal's optional template is a file `<input>`: on submit, if a file is chosen, it is uploaded to the owner's Drive **root** via the existing `uploadFile` (`/api/nodes/upload`), and the returned `node.id` is passed as `template_node_id`. ("Pick an existing Drive file via a folder-browser" is heavier and deferred — inline upload covers the natural need. The template file lives in the owner's root as an ordinary node.)
2. **Roster downloads = per-file only in Phase 3.** There is **no owner-side folder-ZIP route** (`/api/nodes/:id/zip` does not exist; ZIP lives only on the public share route). A responded department's files are retrieved by lazily listing its response subfolder (`listNodes(folder_node_id)` → `/api/nodes?parent=<id>`) and downloading each file via the existing `/api/nodes/:id/download` (`downloadUrl`). **Per-department ZIP and whole-collection ZIP are deferred to Phase 4** ("whole-collection ZIP polish" per spec §12) because both require a new owner ZIP server route — out of scope for a frontend-only phase.
3. **No upload-progress bar on the public submit (v1).** The submit is a single multipart request of up to 10 files; a "sending…" busy state is shown. (An XHR overall-progress bar is a Phase-4 polish; using plain `fetch` keeps the inbound-write path minimal.)

## File Structure

**Owner feature — `web/src/features/collections/` (all new):**
- `types.ts` — client mirrors of the server DTOs (`CollectionSummaryDto`, `CollectionDetailDto`, `RosterDeptDto`). Single source of truth for owner shapes.
- `api.ts` — typed wrappers over `/api/collections*` via `lib/api` (list/get/create/patch/delete/add-dept/remove-dept) + the `CreateCollectionVars`/`PatchCollectionVars` input types.
- `queries.ts` — TanStack-Query hooks + query keys (`collectionsKey`, `collectionKey(id)`); mutations invalidate the list and the affected detail.
- `CollectionsView.tsx` — the list register (DashboardShell-framed): summary rows (title, X/N, StatusChip, copy-link) + "new collection" button opening the create modal + empty state.
- `CreateCollectionModal.tsx` — the create form (title, departments textarea, optional template file, optional password, optional deadline) → POST create → reveal the copyable `/c/<token>` link.
- `CollectionDetail.tsx` — the roster + lifecycle console for one collection: X/N headline, responded/missing split, per-department file count + note + submitted time + lazy per-file download, and controls (open/close, edit title/password/deadline, add/remove department, delete collection).

**Public feature — `web/src/features/collect/` (all new):**
- `api.ts` — direct-fetch client for `/api/collect/:token/*`: `fetchCollectMeta` (returns a discriminated `CollectMetaResult`), `unlockCollection`, `submitResponse` (multipart), `templateUrl`.
- `queries.ts` — `useCollectMeta(token, reveal)` (never throws for an expected state, mirrors `usePublicMeta`).
- `CollectPage.tsx` — the `/c/:token` page: bilingual (AR default + EN toggle flips `dir`), branches loading/closed/notFound/password/open-form/confirmation. Mirrors `SealedDispatch` + `DispatchFrame`.
- `CollectPasswordGate.tsx` — the pre-unlock password screen (mirrors `PasswordGate` but calls `unlockCollection`).
- `CollectForm.tsx` — the open uploader form: title, template download, department `<select>`, multi-file `<input>`, note, submit, client-side guards, per-error copy, success confirmation.

**Wiring / shared (modify):**
- `web/src/app/router.tsx` — add `<Route path="/collections">` (RequireAuth → CollectionsView), `<Route path="/collections/:id">` (RequireAuth → CollectionDetail), and `<Route path="/c/:token">` (public → CollectPage).
- `web/src/features/dashboard/AppNav.tsx` — add `{ to: '/collections', key: 'dashboard.nav.collections' }` to `NAV_ITEMS`.
- `web/src/i18n/ar.json` — add `dashboard.nav.collections`, the `collections.*` block (owner), and the `collect.*` block (public AR).
- `web/src/i18n/en.json` — add the `collect.*` block (public EN, parity with ar).

**Tests (new):**
- `web/test/collections-api.test.ts` — owner api layer (method/path/body per call).
- `web/test/collections-i18n.test.ts` — `collect.*` ar/en key parity + presence of core owner keys.
- `web/test/collections-view.test.tsx` — list render, empty state, opens create modal, nav pill.
- `web/test/collections-create.test.tsx` — create validation, POST body, template-upload flow, link reveal.
- `web/test/collections-detail.test.tsx` — roster X/N, responded/missing, per-file expand+download, open/close, add/remove dept, delete.
- `web/test/collect.test.tsx` — public page: closed/notFound/password/open states, AR+EN copy, submit multipart POST, guards, confirmation.

---

## Task 1: Owner data layer (types + api + queries)

**Files:**
- Create: `web/src/features/collections/types.ts`
- Create: `web/src/features/collections/api.ts`
- Create: `web/src/features/collections/queries.ts`
- Test: `web/test/collections-api.test.ts`

**Interfaces:**
- Consumes: `apiGet`/`apiPost`/`apiPatch`/`apiDelete` from `../../lib/api`; the shared TanStack Query client (provided by `App`/tests).
- Produces (later tasks rely on these EXACT names/shapes):
  - Types: `CollectionSummaryDto`, `CollectionDetailDto`, `RosterDeptDto`.
  - api fns: `listCollections(): Promise<CollectionSummaryDto[]>`, `getCollection(id): Promise<CollectionDetailDto>`, `createCollection(vars: CreateCollectionVars): Promise<CollectionDetailDto>`, `patchCollection(vars: PatchCollectionVars): Promise<CollectionDetailDto>`, `deleteCollection(id): Promise<{ ok: true }>`, `addDepartment(id, name): Promise<{ id; name; position }>`, `removeDepartment(id, deptId): Promise<{ ok: true }>`.
  - Input types: `CreateCollectionVars { title; departments: string[]; templateNodeId?: number | null; password?: string | null; deadlineAt?: number | null }`, `PatchCollectionVars { id; title?; password?: string | null; deadlineAt?: number | null; isActive?: boolean }`.
  - hooks: `useCollections()`, `useCollection(id)`, `useCreateCollection()`, `usePatchCollection()`, `useDeleteCollection()`, `useAddDepartment()`, `useRemoveDepartment()`; keys `collectionsKey`, `collectionKey(id)`.

**Server shapes to mirror (from `server/src/routes/collections.ts`):** `CollectionSummaryDto`, `CollectionDetailDto`, `RosterDeptDto` — copy field-for-field. Note the tri-state PATCH body uses snake_case server keys (`title`, `password`, `deadline_at`, `is_active`) and create uses `title`, `departments`, `template_node_id`, `password`, `deadline_at`.

- [ ] **Step 1: Write `types.ts`** (mirror server exactly):

```ts
/**
 * Client-side mirrors of the server's Collections DTOs (see
 * server/src/routes/collections.ts). status is derived server-side vs the
 * clock; url is the full public /c/<token> link. has_password/has_template are
 * booleans (the server never sends the hash or the template's blob).
 */
export interface CollectionSummaryDto {
  id: number;
  token: string;
  title: string;
  is_active: boolean;
  has_password: boolean;
  has_template: boolean;
  deadline_at: number | null;
  created_at: number;
  status: 'open' | 'closed' | 'expired';
  department_count: number;
  responded_count: number;
  url: string;
}

export interface RosterDeptDto {
  id: number;
  name: string;
  responded: boolean;
  file_count: number;
  submitted_at: number | null;
  note: string | null;
  /** The department's response subfolder in the owner's Drive; null until it responds. */
  folder_node_id: number | null;
}

export interface CollectionDetailDto {
  id: number;
  token: string;
  title: string;
  is_active: boolean;
  has_password: boolean;
  has_template: boolean;
  deadline_at: number | null;
  created_at: number;
  status: 'open' | 'closed' | 'expired';
  department_count: number;
  responded_count: number;
  departments: RosterDeptDto[];
  template: { node_id: number; name: string } | null;
  url: string;
}
```

- [ ] **Step 2: Write the failing api test** (`web/test/collections-api.test.ts`) — copy the `stubFetch` helper pattern from `test/share.test.tsx` (records `"<METHOD> <path>"`, 404s unmapped):

```ts
import { describe, test, expect, vi, afterEach } from 'vitest';
import * as api from '../src/features/collections/api';

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
}
function stubFetch(map: Record<string, unknown>) {
  const mock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url).split('?')[0];
    const method = (init?.method ?? 'GET').toUpperCase();
    const keyed = `${method} ${path}`;
    const record = { path, method, body: init?.body };
    calls.push(record);
    if (keyed in map) return jsonResponse(method === 'POST' ? 201 : 200, map[keyed]);
    if (path in map) return jsonResponse(200, map[path]);
    return jsonResponse(404, { error: 'not_found' });
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}
const calls: Array<{ path: string; method: string; body: BodyInit | null | undefined }> = [];
afterEach(() => { vi.unstubAllGlobals(); calls.length = 0; });

describe('collections api', () => {
  test('createCollection POSTs /api/collections with the mapped snake_case body', async () => {
    stubFetch({ 'POST /api/collections': { id: 5, token: 'tok', title: 't', departments: [], url: 'u' } });
    await api.createCollection({ title: 'مسح', departments: ['المالية', 'الموارد'], deadlineAt: 123, password: 'pw' });
    const call = calls.find((c) => c.method === 'POST');
    expect(call?.path).toBe('/api/collections');
    expect(JSON.parse(String(call?.body))).toEqual({
      title: 'مسح', departments: ['المالية', 'الموارد'], deadline_at: 123, password: 'pw',
    });
  });

  test('patchCollection sends ONLY the provided keys (tri-state), snake_cased', async () => {
    stubFetch({ 'PATCH /api/collections/9': { id: 9 } });
    await api.patchCollection({ id: 9, isActive: false, password: null });
    const call = calls.find((c) => c.method === 'PATCH');
    expect(call?.path).toBe('/api/collections/9');
    expect(JSON.parse(String(call?.body))).toEqual({ is_active: false, password: null });
  });

  test('addDepartment / removeDepartment hit the department subroutes', async () => {
    stubFetch({ 'POST /api/collections/9/departments': { id: 2, name: 'x', position: 1 } });
    await api.addDepartment(9, 'الشؤون');
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: '/api/collections/9/departments' });
    stubFetch({ 'DELETE /api/collections/9/departments/2': { ok: true } });
    await api.removeDepartment(9, 2);
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/api/collections/9/departments/2' });
  });
});
```

- [ ] **Step 3: Run the test, verify it fails** — `cd web && npx vitest run test/collections-api.test.ts` → FAIL (module `../src/features/collections/api` not found).

- [ ] **Step 4: Write `api.ts`**:

```ts
/**
 * Typed wrappers over the owner Collections endpoints (spec §7.1). Every call
 * rides the shared lib/api client (same-origin /api, credentials:'include',
 * CSRF header on mutating verbs, typed ApiError). Bodies use the server's
 * snake_case keys; PATCH is tri-state — send ONLY the keys the caller changes
 * (null = clear, omit = unchanged), never password:'' (the server rejects it).
 */
import { apiGet, apiPost, apiPatch, apiDelete } from '../../lib/api';
import type { CollectionSummaryDto, CollectionDetailDto } from './types';

export function listCollections(): Promise<CollectionSummaryDto[]> {
  return apiGet<CollectionSummaryDto[]>('/collections');
}
export function getCollection(id: number): Promise<CollectionDetailDto> {
  return apiGet<CollectionDetailDto>(`/collections/${id}`);
}

export interface CreateCollectionVars {
  title: string;
  departments: string[];
  templateNodeId?: number | null;
  password?: string | null;
  deadlineAt?: number | null;
}
export function createCollection(vars: CreateCollectionVars): Promise<CollectionDetailDto> {
  const body: Record<string, unknown> = { title: vars.title, departments: vars.departments };
  if (vars.templateNodeId != null) body.template_node_id = vars.templateNodeId;
  if (vars.password) body.password = vars.password;
  if (vars.deadlineAt != null) body.deadline_at = vars.deadlineAt;
  return apiPost<CollectionDetailDto>('/collections', body);
}

export interface PatchCollectionVars {
  id: number;
  title?: string;
  password?: string | null;
  deadlineAt?: number | null;
  isActive?: boolean;
}
export function patchCollection(vars: PatchCollectionVars): Promise<CollectionDetailDto> {
  const body: Record<string, unknown> = {};
  if (vars.title !== undefined) body.title = vars.title;
  if (vars.password !== undefined) body.password = vars.password;
  if (vars.deadlineAt !== undefined) body.deadline_at = vars.deadlineAt;
  if (vars.isActive !== undefined) body.is_active = vars.isActive;
  return apiPatch<CollectionDetailDto>(`/collections/${vars.id}`, body);
}

export function deleteCollection(id: number): Promise<{ ok: true }> {
  return apiDelete<{ ok: true }>(`/collections/${id}`);
}
export function addDepartment(id: number, name: string): Promise<{ id: number; name: string; position: number }> {
  return apiPost(`/collections/${id}/departments`, { name });
}
export function removeDepartment(id: number, deptId: number): Promise<{ ok: true }> {
  return apiDelete<{ ok: true }>(`/collections/${id}/departments/${deptId}`);
}
```

- [ ] **Step 5: Write `queries.ts`**:

```ts
/**
 * TanStack Query layer for owner Collections. The list is cached under
 * ['collections']; each detail under ['collections', id]. Every mutation
 * invalidates the list and (where relevant) the affected detail so the list
 * counts and the roster refresh together. A 401 bubbles to the auth layer.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from './api';
import type { CreateCollectionVars, PatchCollectionVars } from './api';

export const collectionsKey = ['collections'] as const;
export const collectionKey = (id: number) => ['collections', id] as const;

export function useCollections() {
  return useQuery({ queryKey: collectionsKey, queryFn: api.listCollections });
}
export function useCollection(id: number) {
  return useQuery({ queryKey: collectionKey(id), queryFn: () => api.getCollection(id), enabled: Number.isInteger(id) });
}

function useInvalidate() {
  const client = useQueryClient();
  return (id?: number) => {
    void client.invalidateQueries({ queryKey: collectionsKey });
    if (id !== undefined) void client.invalidateQueries({ queryKey: collectionKey(id) });
  };
}

export function useCreateCollection() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (v: CreateCollectionVars) => api.createCollection(v), onSuccess: () => invalidate() });
}
export function usePatchCollection() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (v: PatchCollectionVars) => api.patchCollection(v), onSuccess: (d) => invalidate(d.id) });
}
export function useDeleteCollection() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (id: number) => api.deleteCollection(id), onSuccess: () => invalidate() });
}
export function useAddDepartment() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { id: number; name: string }) => api.addDepartment(v.id, v.name),
    onSuccess: (_r, v) => invalidate(v.id),
  });
}
export function useRemoveDepartment() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { id: number; deptId: number }) => api.removeDepartment(v.id, v.deptId),
    onSuccess: (_r, v) => invalidate(v.id),
  });
}
```

- [ ] **Step 6: Run the test + typecheck, verify green** — `cd web && npx vitest run test/collections-api.test.ts && npm run typecheck` → PASS.

- [ ] **Step 7: Commit**

```bash
cd /var/www/projects/mirsal
git add web/src/features/collections/types.ts web/src/features/collections/api.ts web/src/features/collections/queries.ts web/test/collections-api.test.ts
git commit -m "feat(collections): owner data layer (types + api + queries)"
```

---

## Task 2: i18n keys (owner AR + public AR/EN)

**Files:**
- Modify: `web/src/i18n/ar.json` (add `dashboard.nav.collections`, `collections.*`, `collect.*`)
- Modify: `web/src/i18n/en.json` (add `collect.*`)
- Test: `web/test/collections-i18n.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the translation keys every later task's `t('collections.*')` / `t('collect.*')` calls resolve against.

**Rationale for doing i18n now:** later component tasks assert on the authored Arabic/English strings; the keys must exist first.

- [ ] **Step 1: Write the failing parity test** (`web/test/collections-i18n.test.ts`):

```ts
import { describe, test, expect } from 'vitest';
import ar from '../src/i18n/ar.json';
import en from '../src/i18n/en.json';

function flatten(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' ? flatten(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`]
  );
}

describe('collections i18n', () => {
  test('every collect.* key exists in BOTH ar and en (public page is bilingual)', () => {
    const arCollect = flatten(ar).filter((k) => k.startsWith('collect.'));
    const enCollect = flatten(en).filter((k) => k.startsWith('collect.'));
    expect(arCollect.length).toBeGreaterThan(0);
    expect(new Set(enCollect)).toEqual(new Set(arCollect));
  });

  test('owner collections.* keys are present (Arabic-only)', () => {
    const keys = flatten(ar);
    for (const k of [
      'dashboard.nav.collections',
      'collections.title', 'collections.new', 'collections.empty',
      'collections.create.title', 'collections.create.departmentsLabel', 'collections.create.submit',
      'collections.detail.responded', 'collections.detail.missing', 'collections.detail.delete',
    ]) {
      expect(keys, `missing ${k}`).toContain(k);
    }
  });
});
```

- [ ] **Step 2: Run it, verify it fails** — `cd web && npx vitest run test/collections-i18n.test.ts` → FAIL (keys absent).

- [ ] **Step 3: Add `dashboard.nav.collections` to `ar.json`** — inside the existing `dashboard.nav` object, after `"admin"`:

```json
      "admin": "لوحة الإدارة",
      "collections": "التجميع"
```

- [ ] **Step 4: Add the `collections.*` owner block to `ar.json`** (top-level, e.g. after the `share` block). Authored MSA copy:

```json
  "collections": {
    "title": "التجميع",
    "subtitle": "أنشئ طلب تجميع: وزّع ملفًا واحدًا واجمع ردود الأقسام في مكان واحد.",
    "new": "طلب تجميع جديد",
    "loading": "جارٍ التحميل…",
    "error": "تعذّر تحميل الطلبات. حاول مجددًا.",
    "empty": "لا طلبات تجميع بعد. أنشئ أول طلب.",
    "col": {
      "title": "العنوان",
      "responses": "الردود",
      "status": "الحالة",
      "actions": "إجراءات"
    },
    "status": {
      "open": "مفتوح",
      "closed": "مغلق",
      "expired": "منتهٍ"
    },
    "count": "{{responded}}/{{total}} قسمًا",
    "copyLink": "نسخ الرابط",
    "open": "فتح",
    "create": {
      "title": "طلب تجميع جديد",
      "titleLabel": "عنوان الطلب",
      "titleRequired": "أدخل عنوانًا للطلب.",
      "departmentsLabel": "الأقسام (سطر لكل قسم)",
      "departmentsHint": "الصق أسماء الأقسام، اسمًا في كل سطر. تُحذف التكرارات والفراغات.",
      "departmentsRequired": "أدخل اسم قسم واحد على الأقل.",
      "departmentsCount": "{{count}} قسمًا",
      "templateLabel": "ملف نموذج (اختياري)",
      "templateHint": "يُرفع إلى ملفاتك ويصبح متاحًا للتحميل لكل قسم.",
      "templatePick": "اختيار ملف النموذج",
      "templateClear": "إزالة الملف",
      "passwordLabel": "كلمة مرور (اختياري)",
      "deadlineLabel": "موعد الإغلاق (بتوقيت دمشق، اختياري)",
      "deadlinePast": "اختر وقتًا في المستقبل.",
      "deadlineInvalid": "أدخل تاريخًا ووقتًا صحيحين.",
      "submit": "إنشاء الطلب",
      "creating": "جارٍ الإنشاء…",
      "error": "تعذّر إنشاء الطلب. حاول مجددًا.",
      "linkLabel": "رابط الطلب",
      "linkIntro": "شارك هذا الرابط مع الأقسام لجمع ردودها.",
      "done": "تم"
    },
    "detail": {
      "back": "رجوع إلى الطلبات",
      "loading": "جارٍ التحميل…",
      "error": "تعذّر تحميل الطلب. حاول مجددًا.",
      "responded": "الأقسام التي ردّت",
      "missing": "الأقسام المتبقية",
      "noneResponded": "لم يردّ أي قسم بعد.",
      "noneMissing": "ردّت جميع الأقسام.",
      "files": "{{count}} ملفًا",
      "submittedAt": "أُرسل في",
      "note": "ملاحظة",
      "showFiles": "عرض الملفات",
      "hideFiles": "إخفاء الملفات",
      "download": "تنزيل",
      "filesLoading": "جارٍ التحميل…",
      "filesError": "تعذّر تحميل الملفات.",
      "link": "رابط الطلب",
      "copyLink": "نسخ الرابط",
      "close": "إغلاق الطلب",
      "reopen": "إعادة الفتح",
      "addDepartment": "إضافة قسم",
      "addDepartmentLabel": "اسم القسم",
      "addDepartmentSubmit": "إضافة",
      "removeDepartment": "إزالة",
      "removeBlocked": "لا يمكن إزالة قسم قد ردّ.",
      "duplicateDepartment": "هذا القسم موجود بالفعل.",
      "delete": "حذف الطلب",
      "deleteTitle": "حذف طلب التجميع",
      "deleteBody": "سيُحذف الطلب وكل ردوده وملفاته نهائيًا. لا يمكن التراجع. متابعة؟",
      "deleteConfirm": "حذف نهائي",
      "cancel": "إلغاء"
    },
    "toast": {
      "created": "أُنشئ الطلب.",
      "copied": "نُسخ الرابط.",
      "copyFailed": "تعذّر النسخ. انسخه يدويًا.",
      "closed": "أُغلق الطلب.",
      "reopened": "أُعيد فتح الطلب.",
      "departmentAdded": "أُضيف القسم.",
      "departmentRemoved": "أُزيل القسم.",
      "deleted": "حُذف الطلب.",
      "error": "تعذّر تنفيذ العملية. حاول مجددًا."
    }
  }
```

- [ ] **Step 5: Add the `collect.*` public block to BOTH `ar.json` and `en.json`.** Arabic (into `ar.json`, top-level, after `public`):

```json
  "collect": {
    "loading": "جارٍ التحميل…",
    "error": "تعذّر فتح هذا الرابط. حاول مجددًا.",
    "notFound": "هذا الرابط غير موجود.",
    "closed": "هذا الطلب مغلق حاليًا.",
    "heading": "طلب تجميع عبر مِرسال",
    "titleLabel": "الطلب",
    "downloadTemplate": "تنزيل النموذج",
    "departmentLabel": "القسم",
    "departmentPlaceholder": "اختر قسمك",
    "departmentRequired": "اختر القسم.",
    "filesLabel": "ملفات الرد",
    "filesPick": "اختيار الملفات",
    "filesHint": "حتى {{max}} ملفات، ولا يزيد كل ملف عن ١٠٠ ميغابايت.",
    "filesRequired": "أرفق ملفًا واحدًا على الأقل.",
    "tooManyFiles": "الحد الأقصى {{max}} ملفات.",
    "tooLarge": "الحد الأقصى ١٠٠ ميغابايت للملف: {{name}}.",
    "noteLabel": "ملاحظة (اختياري)",
    "submit": "إرسال الرد",
    "submitting": "جارٍ الإرسال…",
    "success": "تم استلام ردّك. شكرًا لك.",
    "successAgain": "يمكنك الإرسال مجددًا لاستبدال ردّك السابق.",
    "sendAnother": "إرسال رد آخر",
    "quotaExceeded": "لا تتوفر مساحة كافية لدى المُستلِم. تواصل معه.",
    "submitError": "تعذّر إرسال الرد. حاول مجددًا.",
    "passwordGate": "هذا الطلب محمي بكلمة مرور.",
    "passwordLabel": "كلمة المرور",
    "unlock": "فتح",
    "wrongPassword": "كلمة مرور غير صحيحة. المحاولات المتبقية: {{count}}.",
    "wrongPasswordNoCount": "كلمة مرور غير صحيحة.",
    "tooManyAttempts": "محاولات كثيرة. انتظر قليلًا ثم حاول مجددًا.",
    "toEnglish": "English",
    "toArabic": "العربية"
  }
```

English (into `en.json`, same keys):

```json
  "collect": {
    "loading": "Loading…",
    "error": "Couldn't open this link. Try again.",
    "notFound": "This link doesn't exist.",
    "closed": "This request is currently closed.",
    "heading": "A collection request via Mirsal",
    "titleLabel": "Request",
    "downloadTemplate": "Download template",
    "departmentLabel": "Department",
    "departmentPlaceholder": "Choose your department",
    "departmentRequired": "Choose a department.",
    "filesLabel": "Response files",
    "filesPick": "Choose files",
    "filesHint": "Up to {{max}} files, each no larger than 100 MB.",
    "filesRequired": "Attach at least one file.",
    "tooManyFiles": "At most {{max}} files.",
    "tooLarge": "100 MB max per file: {{name}}.",
    "noteLabel": "Note (optional)",
    "submit": "Send response",
    "submitting": "Sending…",
    "success": "Your response was received. Thank you.",
    "successAgain": "You can submit again to replace your previous response.",
    "sendAnother": "Send another response",
    "quotaExceeded": "The recipient is out of space. Please contact them.",
    "submitError": "Couldn't send your response. Try again.",
    "passwordGate": "This request is password-protected.",
    "passwordLabel": "Password",
    "unlock": "Unlock",
    "wrongPassword": "Incorrect password. {{count}} attempts left.",
    "wrongPasswordNoCount": "Incorrect password.",
    "tooManyAttempts": "Too many attempts. Please wait and try again.",
    "toEnglish": "English",
    "toArabic": "العربية"
  }
```

- [ ] **Step 6: Run the test, verify green** — `cd web && npx vitest run test/collections-i18n.test.ts` → PASS. Also `npx vitest run test/pwa.test.ts` if it validates JSON, and confirm the whole app still builds: `npm run typecheck`.

- [ ] **Step 7: Commit**

```bash
cd /var/www/projects/mirsal
git add web/src/i18n/ar.json web/src/i18n/en.json web/test/collections-i18n.test.ts
git commit -m "feat(collections): i18n — owner AR keys + bilingual collect.* keys"
```

---

## Task 3: CollectionsView (owner list) + nav pill + routes

**Files:**
- Create: `web/src/features/collections/CollectionsView.tsx`
- Modify: `web/src/features/dashboard/AppNav.tsx` (add the Collections pill)
- Modify: `web/src/app/router.tsx` (add `/collections`, `/collections/:id`, `/c/:token` routes — CollectionDetail/CollectPage are stubbed to unblock routing, filled in Tasks 5 & 7)
- Test: `web/test/collections-view.test.tsx`

**Interfaces:**
- Consumes: `useCollections`, `collectionsKey` (Task 1); `DashboardShell`; `StatusChip` (maps `open→active`, `closed→stopped`, `expired→expired`); `useToast`; `formatDate`.
- Produces: `CollectionsView` default export; a `<Link to={/collections/:id}>` per row; a "new collection" button that mounts `CreateCollectionModal` (Task 4) — until Task 4 lands, wire the button to open a placeholder Modal or leave the modal import for Task 4. To keep this task self-contained and testable, render the button and track `open` state, mounting `CreateCollectionModal` (create the file as a minimal stub in Task 4; here import it and gate on state).

> To avoid a forward-reference that won't compile: in this task, create `CreateCollectionModal.tsx` as a MINIMAL stub (`export default function CreateCollectionModal({ onClose }: { onClose: () => void }) { return <Modal open onClose={onClose} title="…"><span/></Modal>; }`) and flesh it out in Task 4. Likewise create minimal stubs for `CollectionDetail.tsx` and `collect/CollectPage.tsx` so the router imports resolve. Each stub is replaced (not appended) by its owning task.

- [ ] **Step 1: Add the nav pill to `AppNav.tsx`** — extend `NAV_ITEMS`:

```ts
const NAV_ITEMS: ReadonlyArray<{ to: string; end?: boolean; key: string }> = [
  { to: '/', end: true, key: 'dashboard.nav.myFiles' },
  { to: '/shared', key: 'dashboard.nav.shared' },
  { to: '/collections', key: 'dashboard.nav.collections' },
  { to: '/trash', key: 'dashboard.nav.trash' },
];
```

- [ ] **Step 2: Create minimal stubs** so routes/imports resolve:
  - `web/src/features/collections/CreateCollectionModal.tsx`, `web/src/features/collections/CollectionDetail.tsx`, `web/src/features/collect/CollectPage.tsx` — each a trivial component (a single element) exported default. (Replaced in Tasks 4/5/7.)

- [ ] **Step 3: Add routes to `router.tsx`** — import the three components and add:

```tsx
<Route path="/collections" element={<RequireAuth><CollectionsView /></RequireAuth>} />
<Route path="/collections/:id" element={<RequireAuth><CollectionDetail /></RequireAuth>} />
<Route path="/c/:token" element={<CollectPage />} />
```

(`/c/:token` sits beside `/s/:token` as a public, no-auth route.)

- [ ] **Step 4: Write the failing view test** (`web/test/collections-view.test.tsx`) — mirror `test/share.test.tsx` providers (QueryClient + I18nextProvider + ToastProvider + AuthProvider + MemoryRouter). Render `<CollectionsView />` at `/collections`:

```ts
// helper: render CollectionsView inside the full provider stack at /collections
// with a fetch stub for GET /api/collections.
test('lists collections with X/N count and status; empty state when none', async () => {
  // stub GET /api/collections -> [{ id:1, title:'مسح ربعي', responded_count:2, department_count:5,
  //   status:'open', token:'tok', url:'https://.../c/tok', is_active:true, ... }]
  // expect the title, '2/5' count text, and a StatusChip label 'نشط' to render.
});
test('empty state shows the authored copy', async () => {
  // stub GET /api/collections -> []  → expect t('collections.empty') text.
});
test('clicking "new" opens the create modal', async () => {
  // stub [] ; click the t('collections.new') button → a dialog appears.
});
```

- [ ] **Step 5: Run it, verify it fails** — `cd web && npx vitest run test/collections-view.test.tsx` → FAIL (CollectionsView missing).

- [ ] **Step 6: Write `CollectionsView.tsx`** — DashboardShell-framed, following `SharedView` structure (desktop table `hidden md:block` + mobile cards `md:hidden`), a header with title/subtitle, a "new collection" button (top-end) toggling `CreateCollectionModal`, loading/error/empty states, and per-row: title (link to `/collections/:id`), `t('collections.count', { responded, total })`, `<StatusChip status={mapStatus(status)} />`, and a copy-link button (`navigator.clipboard.writeText(url)` + toast). Map collection status → chip: `open→'active'`, `closed→'stopped'`, `expired→'expired'`. Use `Link` from react-router-dom for the title.

- [ ] **Step 7: Run test + typecheck, verify green** — `cd web && npx vitest run test/collections-view.test.tsx && npm run typecheck` → PASS.

- [ ] **Step 8: Commit**

```bash
cd /var/www/projects/mirsal
git add web/src/features/collections/CollectionsView.tsx web/src/features/collections/CreateCollectionModal.tsx web/src/features/collections/CollectionDetail.tsx web/src/features/collect/CollectPage.tsx web/src/features/dashboard/AppNav.tsx web/src/app/router.tsx web/test/collections-view.test.tsx
git commit -m "feat(collections): owner list view + nav pill + routes (detail/collect stubbed)"
```

---

## Task 4: CreateCollectionModal (create flow)

**Files:**
- Modify (replace stub): `web/src/features/collections/CreateCollectionModal.tsx`
- Test: `web/test/collections-create.test.tsx`

**Interfaces:**
- Consumes: `useCreateCollection` (Task 1); `uploadFile` from `../dashboard/api` (template upload → node id); `Modal`, `Button`, `Seal`, `useToast`, `Copy` icon; `damascusInputToUtcMs` from `../dashboard/share/datetime`; `MAX_FILE_BYTES` from `../dashboard/format`.
- Produces: `CreateCollectionModal({ onClose }: { onClose: () => void })` default export.

**Flow:** two visual steps in one modal (mirror ShareModal's Configure→Published). Step 1 form: title (required); departments `<textarea>` (split on `\n`, trim, drop empties, dedupe for the live count — send the raw trimmed array, server re-normalizes); optional template file `<input type="file">` (single; client-side ≤100 MB guard using `MAX_FILE_BYTES`); optional password; optional deadline `<input type="datetime-local">` → `damascusInputToUtcMs` (reject past/invalid inline). On submit: if a template file is chosen, `await uploadFile({ file, parentId: null })` first, capture `node.id`; then `createCollection({ title, departments, templateNodeId, password, deadlineAt })`. On success show Step 2: the returned `url` in a mono `<bdi dir="ltr">` + copy button + a "done" button (calls `onClose`). Toast on create + copy.

- [ ] **Step 1: Write the failing create test** (`web/test/collections-create.test.tsx`):

```ts
test('requires a title and at least one department before POSTing', async () => {
  // render modal; click submit with empty fields → no POST issued; inline errors shown.
});
test('splits the departments textarea into a trimmed, de-duplicated array and POSTs', async () => {
  // type title 'مسح'; textarea 'المالية\n المالية \n\nالموارد';
  // stub POST /api/collections -> { id:7, url:'https://.../c/tok7', token:'tok7', ... }
  // submit → assert the POST body.departments === ['المالية','الموارد'] (dedup+trim) and title==='مسح'.
});
test('when a template file is picked it is uploaded first, then its node id is sent as template_node_id', async () => {
  // stub POST /api/nodes/upload -> { id: 42, kind:'file', ... }  (uploadFile uses XHR — see note)
  // stub POST /api/collections -> { id:7, url:'…', token:'tok7' }
  // choose a File via the file input; submit → assert upload happened and create body.template_node_id === 42.
});
test('shows the copyable /c link on success', async () => {
  // after a successful create, the returned url renders and a copy button is present.
});
```

> **XHR note:** `uploadFile` uses `XMLHttpRequest`, not `fetch`. The template-upload test must stub `XMLHttpRequest` (a minimal fake with `open`/`setRequestHeader`/`send`/`upload`/`addEventListener('load')` firing a 201 with `responseText` JSON), mirroring how `test/dashboard.test.tsx` exercises uploads. If `test/dashboard.test.tsx` has an XHR mock helper, reuse its shape.

- [ ] **Step 2: Run it, verify it fails** — `cd web && npx vitest run test/collections-create.test.tsx` → FAIL.

- [ ] **Step 3: Implement `CreateCollectionModal.tsx`** per the flow above. Departments parse helper:

```ts
function parseDepartments(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    const name = line.trim();
    if (name && !seen.has(name)) { seen.add(name); out.push(name); }
  }
  return out;
}
```

Submit handler skeleton:

```ts
async function submit(e?: FormEvent) {
  e?.preventDefault();
  const depts = parseDepartments(departmentsRaw);
  if (!title.trim()) { setError(t('collections.create.titleRequired')); return; }
  if (depts.length === 0) { setError(t('collections.create.departmentsRequired')); return; }
  let deadlineAt: number | null | undefined;
  if (deadline) {
    const ms = damascusInputToUtcMs(deadline);
    if (ms === null) { setError(t('collections.create.deadlineInvalid')); return; }
    if (ms <= Date.now()) { setError(t('collections.create.deadlinePast')); return; }
    deadlineAt = ms;
  }
  setError(null);
  try {
    let templateNodeId: number | undefined;
    if (file) {
      if (file.size > MAX_FILE_BYTES) { setError(t('upload.tooLarge')); return; }
      const node = await uploadFile({ file, parentId: null });
      templateNodeId = node.id;
    }
    const created = await create.mutateAsync({
      title: title.trim(), departments: depts,
      templateNodeId, password: password.trim() || undefined, deadlineAt,
    });
    toast({ kind: 'success', message: t('collections.toast.created') });
    setResult(created); // flips to Step 2 (link + copy)
  } catch {
    toast({ kind: 'error', message: t('collections.create.error') });
  }
}
```

- [ ] **Step 4: Run test + typecheck, verify green** — `cd web && npx vitest run test/collections-create.test.tsx && npm run typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
cd /var/www/projects/mirsal
git add web/src/features/collections/CreateCollectionModal.tsx web/test/collections-create.test.tsx
git commit -m "feat(collections): create-collection modal (title/departments/template/password/deadline + link)"
```

---

## Task 5: CollectionDetail (roster + lifecycle console)

**Files:**
- Modify (replace stub): `web/src/features/collections/CollectionDetail.tsx`
- Test: `web/test/collections-detail.test.tsx`

**Interfaces:**
- Consumes: `useCollection`, `usePatchCollection`, `useDeleteCollection`, `useAddDepartment`, `useRemoveDepartment` (Task 1); `listNodes` from `../dashboard/api` + `downloadUrl` (per-file download); `NodeDto`; `DashboardShell`, `Modal`, `Button`, `StatusChip`, `useToast`; `formatDate`, `formatBytes`; `useParams`, `useNavigate`, `Link`.
- Produces: `CollectionDetail` default export (reads `:id` from the route).

**Layout:** DashboardShell-framed. Header: back-link to `/collections`, title, `<StatusChip status={mapStatus}/>`, `{responded}/{total}` headline, and the `/c/<token>` link + copy. Two sections:
- **Responded** (`departments.filter(d => d.responded)`): per department — name, `t('collections.detail.files', { count: file_count })`, submitted time (`formatDate(submitted_at)` in `<bdi dir="ltr">`), note (if any), and a "show files" toggle. On expand, lazily `listNodes(folder_node_id)` (a local `useQuery` keyed `['nodes', folder_node_id]`, enabled only when expanded) and render each file with `formatBytes(size_bytes)` + a download anchor `href={downloadUrl(file.id)}` (plain `<a>` — carries the session cookie, RFC-6266 attachment).
- **Missing** (`!d.responded`): per department — name + a remove button (calls `useRemoveDepartment`; a `409 has_response` maps to the `removeBlocked` toast — belt-and-braces even though missing ones have no response).

**Controls:** open/close toggle (`usePatchCollection({ id, isActive })`), add-department (inline input → `useAddDepartment`; `409 duplicate` → `duplicateDepartment` toast), delete-collection (confirm `Modal` → `useDeleteCollection` → navigate to `/collections`). (Editing password/deadline/title reuse the same `usePatchCollection` tri-state; include a minimal password-set + deadline-edit + title-edit affordance behind an "edit" toggle, mirroring ShareModal's sections. Keep each small.)

- [ ] **Step 1: Write the failing detail test** (`web/test/collections-detail.test.tsx`), rendering `<CollectionDetail/>` at `/collections/7` with a stubbed `GET /api/collections/7`:

```ts
const detail = {
  id: 7, token: 'tok7', title: 'مسح ربعي', is_active: true, has_password: false, has_template: true,
  deadline_at: null, created_at: NOW, status: 'open', department_count: 3, responded_count: 1,
  url: 'https://project4.system.mow.gov.sy/c/tok7',
  template: { node_id: 9, name: 'template.xlsx' },
  departments: [
    { id: 1, name: 'المالية', responded: true, file_count: 2, submitted_at: NOW, note: 'مرفق', folder_node_id: 50 },
    { id: 2, name: 'الموارد', responded: false, file_count: 0, submitted_at: null, note: null, folder_node_id: null },
    { id: 3, name: 'الشؤون', responded: false, file_count: 0, submitted_at: null, note: null, folder_node_id: null },
  ],
};

test('renders X/N, the responded department with its file count and note, and the missing ones', async () => { /* … */ });
test('expanding a responded department lists its files (GET /api/nodes?parent=50) with download links', async () => {
  // stub GET /api/nodes -> [{ id:60, kind:'file', name:'a.pdf', size_bytes:2048, ... }]
  // click "show files" → a download anchor with href '/api/nodes/60/download' appears.
});
test('close toggles is_active via PATCH', async () => { /* stub PATCH /api/collections/7 → {…is_active:false} ; click close → assert PATCH body { is_active:false } */ });
test('add department POSTs; duplicate (409) shows the duplicate toast', async () => { /* … */ });
test('remove a missing department DELETEs it', async () => { /* click remove on الموارد → DELETE /api/collections/7/departments/2 */ });
test('delete collection confirms then navigates back to /collections', async () => { /* … */ });
```

- [ ] **Step 2: Run it, verify it fails** — `cd web && npx vitest run test/collections-detail.test.tsx` → FAIL.

- [ ] **Step 3: Implement `CollectionDetail.tsx`** per the layout above. A small `DepartmentFiles` sub-component owns the lazy `listNodes` query:

```tsx
function DepartmentFiles({ folderNodeId }: { folderNodeId: number }) {
  const { t } = useTranslation();
  const { data, isPending, isError } = useQuery({
    queryKey: ['nodes', folderNodeId],
    queryFn: () => listNodes(folderNodeId),
  });
  if (isPending) return <p className="font-body text-xs text-ink-2">{t('collections.detail.filesLoading')}</p>;
  if (isError) return <p role="alert" className="font-body text-xs text-clay">{t('collections.detail.filesError')}</p>;
  return (
    <ul className="mt-1 flex flex-col gap-1">
      {(data ?? []).filter((n) => n.kind === 'file').map((f) => (
        <li key={f.id} className="flex items-center justify-between gap-2">
          <bdi className="min-w-0 truncate font-body text-sm text-ink">{f.name}</bdi>
          <a href={downloadUrl(f.id)} className="inline-flex items-center gap-1 text-teal">
            <DownloadArrow size={16} />{t('collections.detail.download')}
          </a>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 4: Run test + typecheck, verify green** — `cd web && npx vitest run test/collections-detail.test.tsx && npm run typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
cd /var/www/projects/mirsal
git add web/src/features/collections/CollectionDetail.tsx web/test/collections-detail.test.tsx
git commit -m "feat(collections): roster/detail view — responded/missing, per-file download, lifecycle controls"
```

---

## Task 6: Public collect data layer (api + queries)

**Files:**
- Create: `web/src/features/collect/api.ts`
- Create: `web/src/features/collect/queries.ts`
- Test: `web/test/collect-api.test.ts`

**Interfaces:**
- Consumes: raw `fetch`/`XMLHttpRequest` (the ONE unauthenticated surface — no `lib/api`, no CSRF). `MAX_FILE_BYTES` for the client cap.
- Produces:
  - `CollectMeta { title; hasTemplate: boolean; templateName: string | null; departments: { id: number; name: string }[]; needsPassword: boolean }`.
  - `CollectMetaResult = { state:'open'; meta: CollectMeta } | { state:'password' } | { state:'closed' } | { state:'notFound' } | { state:'error' }`.
  - `fetchCollectMeta(token, opts?: { reveal?: boolean }): Promise<CollectMetaResult>`.
  - `UnlockResult = { kind:'ok' } | { kind:'wrong'; remaining: number | null } | { kind:'rateLimited' } | { kind:'error' }`; `unlockCollection(token, password): Promise<UnlockResult>`.
  - `SubmitResult = { kind:'ok' } | { kind:'tooManyFiles' } | { kind:'tooLarge' } | { kind:'quota' } | { kind:'closed' } | { kind:'locked' } | { kind:'error' }`; `submitResponse(token, { departmentId; files: File[]; note?: string }): Promise<SubmitResult>`.
  - `templateUrl(token): string` → `/api/collect/<token>/template`.
  - `useCollectMeta(token, reveal)` hook + `collectMetaKey`.

**Meta mapping (from `server/src/routes/collect.ts` GET):** 404 → `notFound`; 200 with `isOpen===false` → `closed`; 200 with `departments` present → `open`; 200 with `needsPassword && !departments` → `password`; else `error`. Omit the unlock cookie unless `reveal` (so the gate re-appears each fresh open, mirroring `fetchPublicMeta`).

**Unlock mapping (POST /unlock):** 200 → ok; 429 → rateLimited; 401 → wrong (read `x-ratelimit-remaining` for the count, like `unlockShare`); else error.

**Submit mapping (POST /submit, multipart):** build `FormData` with `departmentId`, optional `note`, and each `File` appended as `files`. `fetch(..., { method:'POST', credentials:'include', body: form })` (browser sets the multipart boundary; NO CSRF). 200 → ok; 400 `too_many_files` → tooManyFiles; 413 `file_too_large` → tooLarge; 413 `quota_exceeded` → quota; 404 → closed; 401 → locked; else error. (Read `body.error` to distinguish the two 400/413 codes.)

- [ ] **Step 1: Write the failing api test** (`web/test/collect-api.test.ts`) — stub `fetch`, assert each mapping:

```ts
test('meta: 404 → notFound; isOpen:false → closed; needsPassword → password; departments → open', async () => { /* four fetch stubs */ });
test('meta omits credentials until reveal (gate re-appears each fresh open)', async () => {
  // spy fetch; call fetchCollectMeta(token) → init.credentials === 'omit';
  // call fetchCollectMeta(token,{reveal:true}) → 'include'.
});
test('unlock: 200→ok, 401 reads x-ratelimit-remaining→wrong{remaining}, 429→rateLimited', async () => { /* … */ });
test('submit: builds multipart with departmentId + files + note and maps status codes', async () => {
  // stub fetch returning 200 {ok:true}; call submitResponse; assert init.body is FormData containing the fields;
  // then stub 413 {error:'quota_exceeded'} → kind 'quota'; 400 {error:'too_many_files'} → 'tooManyFiles'.
});
```

- [ ] **Step 2: Run it, verify it fails** — `cd web && npx vitest run test/collect-api.test.ts` → FAIL.

- [ ] **Step 3: Write `api.ts`** (mirror `features/public/api.ts` structure/comments; `tokenPath` uses `encodeURIComponent`). Include the discriminated meta parse, `unlockCollection` (raw fetch to read the rate-limit header), `submitResponse` (FormData), `templateUrl`.

- [ ] **Step 4: Write `queries.ts`**:

```ts
import { useQuery } from '@tanstack/react-query';
import { fetchCollectMeta } from './api';

export const collectMetaKey = (token: string, reveal: boolean) =>
  ['collect', token, 'meta', reveal ? 'reveal' : 'gate'] as const;

export function useCollectMeta(token: string, reveal: boolean) {
  return useQuery({
    queryKey: collectMetaKey(token, reveal),
    queryFn: () => fetchCollectMeta(token, { reveal }),
    enabled: token.length > 0,
  });
}
```

- [ ] **Step 5: Run test + typecheck, verify green** — `cd web && npx vitest run test/collect-api.test.ts && npm run typecheck` → PASS.

- [ ] **Step 6: Commit**

```bash
cd /var/www/projects/mirsal
git add web/src/features/collect/api.ts web/src/features/collect/queries.ts web/test/collect-api.test.ts
git commit -m "feat(collect): public data layer — meta/unlock/submit/template + query hook"
```

---

## Task 7: Public CollectPage + password gate + upload form

**Files:**
- Modify (replace stub): `web/src/features/collect/CollectPage.tsx`
- Create: `web/src/features/collect/CollectPasswordGate.tsx`
- Create: `web/src/features/collect/CollectForm.tsx`
- Test: `web/test/collect.test.tsx`

**Interfaces:**
- Consumes: `useCollectMeta`, `unlockCollection`, `submitResponse`, `templateUrl` (Task 6); `DispatchFrame`, `SealHeader` (reuse from `../public/DispatchFrame`); `PrimaryLink`, `DownloadGlyph` from `../public/controls`; `Button`; `i18n`, `dirForLang`; `useParams`; `COLLECTION_MAX_FILES_PER_RESPONSE` client mirror + `MAX_FILE_BYTES`.
- Produces: `CollectPage` default export (route `/c/:token`).

**CollectPage** mirrors `SealedDispatch`: `initialLang()` from `navigator.language`, `useEffect` applying `i18n.changeLanguage(lang)` + `document.documentElement.dir/lang`, cleanup restoring AR/RTL on unmount, a `revealed` state (false on mount → meta omits the unlock cookie), and the AR/EN toggle in `DispatchFrame`. Branch on `useCollectMeta(token, revealed)`:
- `isPending` → loading line.
- `isError` / `state:'error'` → `t('collect.error')`.
- `state:'notFound'` → `t('collect.notFound')`.
- `state:'closed'` → `t('collect.closed')` (neutral).
- `state:'password'` → `<CollectPasswordGate token onUnlocked={() => { setRevealed(true); void meta.refetch(); }} />`.
- `state:'open'` → `<CollectForm token meta={result.meta} />`.

**CollectPasswordGate** mirrors `PasswordGate` but calls `unlockCollection`; wrong→`collect.wrongPassword`/`collect.wrongPasswordNoCount`, 429→`collect.tooManyAttempts`.

**CollectForm:** `SealHeader stamp`, the title, a template download `PrimaryLink href={templateUrl(token)}` (only if `meta.hasTemplate`), a required department `<select>` (options from `meta.departments`, placeholder `collect.departmentPlaceholder`), a multi-file `<input type="file" multiple>` (client guards: ≤ `COLLECTION_MAX_FILES_PER_RESPONSE`, each ≤ `MAX_FILE_BYTES` → inline `collect.tooManyFiles`/`collect.tooLarge`; ≥1 required → `collect.filesRequired`), an optional note `<textarea maxLength=2000>`, and a submit button. On submit call `submitResponse`; map results to copy; on `ok` show the confirmation (`collect.success` + `collect.successAgain` + a "send another" reset). Show a "sending…" busy state while pending.

> Add a local const `COLLECTION_MAX_FILES_PER_RESPONSE = 10` in `collect/api.ts` (exported) so the form and its hint/guards share one source (the server value from `server/src/config.ts`).

- [ ] **Step 1: Write the failing page test** (`web/test/collect.test.tsx`) — mirror `test/public.test.tsx` (QueryClient + I18nextProvider + MemoryRouter at `/c/:token`, `jsonResponse` helper, `setNavigatorLanguage`, isolate-strip). Cases:

```ts
test('open: renders title, department select, file input; AR default then EN toggle flips dir + copy', async () => { /* stub GET meta open */ });
test('closed meta → neutral closed copy (AR + EN)', async () => { /* isOpen:false */ });
test('notFound (404) → not-found copy', async () => {});
test('password state → gate; unlock success re-fetches and shows the form', async () => { /* meta password, then POST /unlock 200, refetch → open */ });
test('submitting files issues a multipart POST and shows the confirmation', async () => {
  // meta open; choose a File; pick a department; submit;
  // stub POST /api/collect/tok/submit -> {ok:true}; assert the POST fired multipart and t('collect.success') renders.
});
test('client guards: >10 files and a >100MB file are rejected before any request', async () => {});
```

- [ ] **Step 2: Run it, verify it fails** — `cd web && npx vitest run test/collect.test.tsx` → FAIL.

- [ ] **Step 3: Implement `CollectPasswordGate.tsx`, `CollectForm.tsx`, and `CollectPage.tsx`** per the specs above.

- [ ] **Step 4: Run test + typecheck, verify green** — `cd web && npx vitest run test/collect.test.tsx && npm run typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
cd /var/www/projects/mirsal
git add web/src/features/collect/CollectPage.tsx web/src/features/collect/CollectPasswordGate.tsx web/src/features/collect/CollectForm.tsx web/test/collect.test.tsx
git commit -m "feat(collect): bilingual public uploader page (/c/:token) — gate, form, submit, confirmation"
```

---

## Task 8: Full-suite verification + phase checkpoint

**Files:** none (verification only).

- [ ] **Step 1: Run the ENTIRE web suite** — `cd web && npm test` → all green (existing + 6 new files). Fix any regression before proceeding.
- [ ] **Step 2: Typecheck the whole web workspace** — `cd web && npm run typecheck` → clean.
- [ ] **Step 3: Production build sanity** — `cd web && npm run build` → succeeds (catches an import/route mistake tests miss).
- [ ] **Step 4: Confirm server is untouched** — `cd /var/www/projects/mirsal && git diff --name-only main -- server/ | grep .` returns nothing (frontend-only invariant). The full server suite is unchanged from Phase 2 (419/419); no need to re-run, but `cd server && npm test` if in doubt.
- [ ] **Step 5: Update the plan checkboxes + write the phase-3 memory note**, then STOP (feedback_phase_pause) — do NOT merge to main or deploy; report status and await the user's "go" for merge + Phase 4.

```bash
cd /var/www/projects/mirsal
git add docs/superpowers/plans/2026-08-03-mirsal-collections-phase3.md
git commit -m "docs(collections): Phase 3 plan checkboxes complete"
```

---

## Self-Review (spec coverage)

- **§10 owner UI** (nav entry, list, create modal, roster) → Tasks 3/4/5. **§10 uploader** (bilingual `/c/:token`, gate, select, multi-file, note, submit, confirmation, closed) → Tasks 6/7. **§10 wiring** (router `/c/*`, nav) → Task 3.
- **§4.1 create fields** (title, template, departments, password, deadline) → Task 4. **§4.2 roster** (X/N, responded/missing, file counts, notes, add/remove dept, close/reopen, delete) → Task 5. **§4.3 uploader** (title, template download, department dropdown, multi-file, note, upload, confirmation, closed/expired, password gate) → Task 7.
- **§7.1 owner routes** consumed → Task 1. **§7.2 public routes** consumed → Task 6. **§11 web tests** (create modal, roster, public page incl. both ar/en labels) → Tasks 4/5/7 + parity Task 2.
- **Bilingual constraint** (collect.* in ar+en) → Task 2 parity test.
- **Deferred to Phase 4 (flagged):** per-department ZIP + whole-collection ZIP download (no owner ZIP route exists — needs server work); upload-progress bar; whole-collection E2E sweep; RUNBOOK "Collections" note. These are exactly the spec §12 Phase-4 items.
- **Not needed:** template inline-upload endpoint (worked around via existing `/api/nodes/upload`).
```
