# Collections Phase 2 — Public Intake — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the public, unauthenticated intake side of Collections — the `/api/collect/:token/*` routes (meta, unlock, template, submit) and the `/c/*` SPA shell — so an outsider holding a collection link can pick their department and upload a response set. This is Mirsal's first inbound-write surface.

**Architecture:** A new encapsulated public plugin `routes/collect.ts` (no auth, no CSRF; token-in-URL; anti-oracle constant shapes; `Cache-Control: no-store` + `Referrer-Policy: no-referrer` on every response) mirrors `routes/public.ts`. It reuses the Phase-1 collections/departments models for reads and a new transactional response model `collections/responses.ts` for the latest-replaces write. Files stream to temp via the shared `blobStore`, land as ordinary file nodes under per-department subfolders in the owner's Drive, and count against the **owner's** quota. Password unlock reuses the share HMAC-cookie mechanism via a small new gate module `collections/unlock.ts`. **No schema change** (the v3→v4 migration already shipped in Phase 1).

**Tech Stack:** Node 20 (ESM, `.js` import specifiers), TypeScript 5.9, Fastify 5.10, `@fastify/multipart` 10.1 (manual `req.parts()` streaming, not attach-to-body), `@fastify/rate-limit` 11.1 (`global:false`, per-scope registration), better-sqlite3 12.9 (synchronous transactions — **never `await` inside `db.transaction`**), zod 4.4, argon2 0.45 (via the shared `passwordService`), vitest 4.1.

## Global Constraints

Every task's requirements implicitly include this section. Values copied verbatim from the spec (`docs/superpowers/specs/2026-08-02-mirsal-collections-design.md`) and the codebase.

- **Branch:** continue on `feat/collections` (built on Phase 1 `89f17ee`, off `main` `74d8031`). Commit after every step (`feedback_save_often`). Do **not** merge to main in this phase (`feedback_phase_pause`).
- **Public routes:** NO `requireAuth`, NO CSRF. The 32-byte URL-safe token is the only credential. Every response under the plugin carries `Cache-Control: no-store` and `Referrer-Policy: no-referrer` (encapsulated `onSend` hook, scoped to the plugin only — never leaks onto authenticated routes).
- **Anti-oracle:** unknown / closed / expired / foreign-department / wrong-password rejections are **constant-shape** on the write/read-secret paths (`submit`, `template`, `unlock`): all collapse to `404 {error:'not_found'}` for any non-open collection. The **only** endpoint that distinguishes open-vs-closed is `meta` (by design — the uploader must see a "closed" page). Meta never reveals response status, roster completion, or owner identity/quota.
- **Owner is the subject:** quota (`reserve`/`subtract`, keyed on `collections.owner_id`) and audit target. The uploader is anonymous → audit `actor_id = NULL`.
- **Storage paths are always `${ownerId}/${nodeId}`** (server-generated), never derived from a client filename. Client filenames/department names become **display** node names only, after `sanitizeNodeName` (control-strip, trim, cap 255, reject empty/`/`/`\`/`.`/`..`).
- **Limits:** `MAX_FILE_BYTES = 104857600` (100 MB, already in `config.ts`); `COLLECTION_MAX_FILES_PER_RESPONSE = 10`; `MAX_NOTE_LENGTH = 2000` (both added in Task 5, imported from `config.ts`).
- **better-sqlite3 rule:** transactions are synchronous. All argon2 hashing (async) happens **outside** `db.transaction`. `blobStore.writeStreamToTemp` (async) happens **before** the response transaction; `commitTemp`/`deleteBlob` (sync fs) happen **after** it commits.
- **Blob store:** use the injected `deps.blobStore` (the single shared instance wired in `app.ts`), never the bare `storage/blobs.js` exports.
- **Gates per workspace:** `cd server && npm test` (vitest) and `npm run typecheck` (`tsc --noEmit`). **There is no eslint / `lint` script** — do not invent one. Phase 2 is server-only; the `web/` workspace is untouched (its uploader UI is Phase 3).

---

## File Structure

**New files:**
- `server/src/collections/unlock.ts` — HMAC unlock-cookie gate factory (Task 1). One responsibility: sign/verify the per-collection unlock cookie.
- `server/src/util/names.ts` — exported `sanitizeNodeName` used by the new code (Task 5). *(Deliberate: `routes/nodes.ts` keeps its own private copy so the deployed upload path is untouched; a future cleanup can DRY it onto this module — noted as a CARRY.)*
- `server/src/collections/responses.ts` — the response write model: `commitResponse` (transactional first-submit + latest-replaces + atomic quota reserve), `responseHeadroom`, `QuotaExceededError` (Task 5).
- `server/src/routes/collect.ts` — the public collect plugin: meta (Task 2), unlock (Task 3), template (Task 4), submit (Task 6).
- `server/test/collections/unlock.test.ts` (Task 1)
- `server/test/collections/responses.test.ts` (Task 5)
- `server/test/routes/collect.test.ts` (Tasks 2/3/4/6 all add to this one integration file)

**Modified files:**
- `server/src/app.ts` — register `collectRoutes` after `publicRoutes` (Task 2); add `/c/` to the not-found handler's `Referrer-Policy` branch (Task 7).
- `server/src/config.ts` — add `COLLECTION_MAX_FILES_PER_RESPONSE` and `MAX_NOTE_LENGTH` consts (Task 5).
- `server/test/app.test.ts` — add the `/c/<token>` SPA-shell test (Task 7).

---

## Task 1: Unlock-cookie gate module

A pure crypto module mirroring the share unlock logic in `routes/public.ts` (`signUnlock`/`unlockCookieValue`/`isUnlocked`), extracted into a reusable factory so the collect plugin gets identical, independently-tested behavior **without touching the deployed `public.ts`**.

**Files:**
- Create: `server/src/collections/unlock.ts`
- Test: `server/test/collections/unlock.test.ts`

**Interfaces:**
- Consumes: `node:crypto` (`createHmac`, `timingSafeEqual`).
- Produces:
  - `COLLECT_UNLOCK_COOKIE: string` (= `'mirsal_collect_unlock'`).
  - `createUnlockGate(secret: string): UnlockGate` where
    `UnlockGate = { cookieName: string; cookiePath(token: string): string; cookieValue(token: string, passwordHash: string | null, issuedAtMs: number): string; isUnlocked(cookie: string | undefined, token: string, passwordHash: string | null, nowMs: number): boolean }`.
  - Server-side cookie lifetime is 600 s, enforced inside `isUnlocked` (not via `Max-Age`).

- [ ] **Step 1: Write the failing test**

Create `server/test/collections/unlock.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { createUnlockGate, COLLECT_UNLOCK_COOKIE } from '../../src/collections/unlock.js';

const SECRET = 'x'.repeat(32);
const TOKEN = 'tok-abc';
const HASH = '$argon2id$fakehash';
const NOW = 1_700_000_000_000;

describe('createUnlockGate', () => {
  test('a freshly-issued cookie verifies for its token + password_hash', () => {
    const gate = createUnlockGate(SECRET);
    const cookie = gate.cookieValue(TOKEN, HASH, NOW);
    expect(gate.isUnlocked(cookie, TOKEN, HASH, NOW)).toBe(true);
    expect(gate.cookieName).toBe(COLLECT_UNLOCK_COOKIE);
    expect(gate.cookiePath(TOKEN)).toBe(`/api/collect/${TOKEN}`);
  });

  test('undefined / malformed cookie -> false', () => {
    const gate = createUnlockGate(SECRET);
    expect(gate.isUnlocked(undefined, TOKEN, HASH, NOW)).toBe(false);
    expect(gate.isUnlocked('no-dot', TOKEN, HASH, NOW)).toBe(false);
    expect(gate.isUnlocked('.sig', TOKEN, HASH, NOW)).toBe(false);
    expect(gate.isUnlocked('notanumber.sig', TOKEN, HASH, NOW)).toBe(false);
  });

  test('rotated/cleared password_hash invalidates a prior cookie', () => {
    const gate = createUnlockGate(SECRET);
    const cookie = gate.cookieValue(TOKEN, HASH, NOW);
    expect(gate.isUnlocked(cookie, TOKEN, 'different-hash', NOW)).toBe(false);
    expect(gate.isUnlocked(cookie, TOKEN, null, NOW)).toBe(false);
  });

  test('a different secret does not verify', () => {
    const cookie = createUnlockGate(SECRET).cookieValue(TOKEN, HASH, NOW);
    expect(createUnlockGate('y'.repeat(32)).isUnlocked(cookie, TOKEN, HASH, NOW)).toBe(false);
  });

  test('expired (older than 600s) and future issuedAt both -> false', () => {
    const gate = createUnlockGate(SECRET);
    const cookie = gate.cookieValue(TOKEN, HASH, NOW);
    expect(gate.isUnlocked(cookie, TOKEN, HASH, NOW + 601_000)).toBe(false); // aged out
    expect(gate.isUnlocked(cookie, TOKEN, HASH, NOW + 599_000)).toBe(true);  // still fresh
    const future = gate.cookieValue(TOKEN, HASH, NOW + 10_000);
    expect(gate.isUnlocked(future, TOKEN, HASH, NOW)).toBe(false);           // issued in the future
  });

  test('a tampered signature -> false', () => {
    const gate = createUnlockGate(SECRET);
    const cookie = gate.cookieValue(TOKEN, HASH, NOW);
    const tampered = `${cookie.slice(0, -1)}${cookie.at(-1) === 'A' ? 'B' : 'A'}`;
    expect(gate.isUnlocked(tampered, TOKEN, HASH, NOW)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/collections/unlock.test.ts`
Expected: FAIL — `Cannot find module '../../src/collections/unlock.js'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/collections/unlock.ts`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Name of the short-lived, path-scoped cookie that marks a collection unlocked. */
export const COLLECT_UNLOCK_COOKIE = 'mirsal_collect_unlock';

/** Server-side unlock-cookie lifetime (10 min), enforced in isUnlocked (not via Max-Age). */
const UNLOCK_COOKIE_MAX_AGE_S = 600;

export interface UnlockGate {
  cookieName: string;
  cookiePath(token: string): string;
  cookieValue(token: string, passwordHash: string | null, issuedAtMs: number): string;
  isUnlocked(cookie: string | undefined, token: string, passwordHash: string | null, nowMs: number): boolean;
}

/**
 * Builds an unlock-cookie gate bound to `secret` (the app's SESSION_SECRET).
 * Mirrors routes/public.ts's share unlock cookie exactly:
 *  - cookie value = `<issuedAtMs>.<base64url HMAC-SHA256(token.passwordHash.issuedAtMs)>`.
 *  - Binding the CURRENT password_hash means a rotated/cleared password
 *    invalidates every prior cookie. The signed issuedAt lets isUnlocked
 *    enforce the 600s lifetime server-side, independent of the client honoring
 *    any cookie attribute. Constant-time compare over the whole cookie string.
 */
export function createUnlockGate(secret: string): UnlockGate {
  function sign(token: string, passwordHash: string | null, issuedAtStr: string): string {
    return createHmac('sha256', secret).update(`${token}.${passwordHash ?? ''}.${issuedAtStr}`).digest('base64url');
  }

  function cookieValue(token: string, passwordHash: string | null, issuedAtMs: number): string {
    const issuedAtStr = String(issuedAtMs);
    return `${issuedAtStr}.${sign(token, passwordHash, issuedAtStr)}`;
  }

  function isUnlocked(cookie: string | undefined, token: string, passwordHash: string | null, nowMs: number): boolean {
    if (!cookie) return false;
    const dot = cookie.indexOf('.');
    if (dot <= 0) return false;
    const issuedAtStr = cookie.slice(0, dot);
    const issuedAtMs = Number(issuedAtStr);
    if (!Number.isInteger(issuedAtMs)) return false;
    if (issuedAtMs > nowMs || nowMs - issuedAtMs > UNLOCK_COOKIE_MAX_AGE_S * 1000) return false;
    const expected = Buffer.from(cookieValue(token, passwordHash, issuedAtMs));
    const actual = Buffer.from(cookie);
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }

  return { cookieName: COLLECT_UNLOCK_COOKIE, cookiePath: (t) => `/api/collect/${t}`, cookieValue, isUnlocked };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/collections/unlock.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/collections/unlock.ts server/test/collections/unlock.test.ts
git commit -m "feat(collections): unlock-cookie gate module (public collect)"
```

---

## Task 2: Collect plugin skeleton + GET meta + app wiring

The public plugin, its response hooks, a token loader, the `GET /api/collect/:token` meta endpoint, and registration in `app.ts`.

**Files:**
- Create: `server/src/routes/collect.ts`
- Modify: `server/src/app.ts` (import + register `collectRoutes`)
- Test: `server/test/routes/collect.test.ts`

**Interfaces:**
- Consumes: `createUnlockGate` (Task 1); Phase-1 `collectionStatus`, `type Collection` (`collections/collections.js`), `listDepartments` (`collections/departments.js`); `writeAudit`; `type Clock`, `PasswordService`, `BlobStore`, `Config`.
- Produces:
  - `export interface CollectRouteDeps { db: Database.Database; now: Clock; passwordService: PasswordService; blobStore: BlobStore; config: Config }`.
  - `export default async function collectRoutes(app: FastifyInstance, deps: CollectRouteDeps): Promise<void>`.
  - Meta response contract (all `200` unless noted), `Cache-Control: no-store` + `Referrer-Policy: no-referrer` on every response:
    - unknown token → `404 {error:'not_found'}`.
    - closed/expired → `{isOpen:false}`.
    - open + password + not-unlocked → `{isOpen:true, needsPassword:true}`.
    - open + (no password OR unlocked) → `{isOpen:true, needsPassword, title, hasTemplate, templateName, departments:[{id,name}]}`.

- [ ] **Step 1: Write the failing test**

Create `server/test/routes/collect.test.ts` with the shared harness (mirrors `test/routes/collections.test.ts`) plus meta tests:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { loadConfig } from '../../src/config.js';
import { buildApp } from '../../src/app.js';
import { createPasswordService } from '../../src/auth/passwords.js';

const NOW = 1_700_000_000_000;
const clock = () => NOW;
const TEST_ARGON = { ARGON_MEMORY_KIB: 19456, ARGON_TIME: 2, ARGON_PARALLELISM: 1, ARGON_MAX_CONCURRENCY: 2 };
const PUBLIC_BASE_URL = 'https://mirsal.example.test';

interface InjectedCookie { name: string; value: string }

let db: Database.Database | undefined;
let dir: string | undefined;
let app: FastifyInstance | undefined;

const keys = ['DB_PATH', 'STORAGE_DIR', 'SESSION_SECRET', 'CSRF_SECRET', 'PUBLIC_BASE_URL'] as const;
const originals: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of keys) originals[k] = process.env[k];
  process.env.DB_PATH = '/tmp/mirsal-collect-test/db.sqlite';
  process.env.STORAGE_DIR = '/tmp/mirsal-collect-test/storage';
  process.env.SESSION_SECRET = 'a'.repeat(32);
  process.env.CSRF_SECRET = 'b'.repeat(32);
  process.env.PUBLIC_BASE_URL = PUBLIC_BASE_URL;
});
afterAll(() => { for (const k of keys) { if (originals[k] === undefined) delete process.env[k]; else process.env[k] = originals[k]; } });
afterEach(async () => {
  await app?.close(); app = undefined;
  db?.close(); db = undefined;
  if (dir) { fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; }
});

async function makeApp(): Promise<FastifyInstance> {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-collect-'));
  const dbPath = path.join(dir, 't.db');
  const storageDir = path.join(dir, 'storage');
  db = openDb(dbPath); migrate(db);
  const config = loadConfig({
    DB_PATH: dbPath, STORAGE_DIR: storageDir,
    SESSION_SECRET: 'a-test-session-secret-16+', CSRF_SECRET: 'a-test-csrf-secret-16chars+',
    PUBLIC_BASE_URL,
  });
  app = await buildApp({ db, config, now: clock });
  return app;
}

async function seedUser(username: string, quotaBytes: number | null = null): Promise<number> {
  const hash = await createPasswordService(TEST_ARGON).hashPassword('pw');
  const info = db!
    .prepare(`INSERT INTO users(username,password_hash,role,is_active,must_change_password,quota_bytes,created_at,updated_at)
              VALUES (?, ?, 'user', 1, 0, ?, ?, ?)`)
    .run(username, hash, quotaBytes, NOW, NOW);
  return Number(info.lastInsertRowid);
}
function findCookie(cookies: InjectedCookie[], name: string) { return cookies.find((c) => c.name === name); }
async function login(built: FastifyInstance, username: string): Promise<{ session: string; csrf: string }> {
  const res = await built.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'pw' } });
  return {
    session: findCookie(res.cookies as InjectedCookie[], 'mirsal_session')!.value,
    csrf: findCookie(res.cookies as InjectedCookie[], 'mirsal_csrf')!.value,
  };
}
/** Owner-creates a collection via the Phase-1 owner API; returns its detail DTO. */
async function makeCollection(built: FastifyInstance, session: string, csrf: string, payload: Record<string, unknown>) {
  const res = await built.inject({
    method: 'POST', url: '/api/collections',
    cookies: { mirsal_session: session }, headers: { 'x-csrf-token': csrf }, payload,
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

// ── meta ──────────────────────────────────────────────────────────────────
test('GET meta unknown token -> 404, with no-store + no-referrer', async () => {
  const built = await makeApp();
  const res = await built.inject({ method: 'GET', url: '/api/collect/does-not-exist' });
  expect(res.statusCode).toBe(404);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.headers['referrer-policy']).toBe('no-referrer');
});

test('GET meta open, no password -> title + departments + isOpen', async () => {
  const built = await makeApp();
  await seedUser('alice');
  const { session, csrf } = await login(built, 'alice');
  const c = await makeCollection(built, session, csrf, { title: 'Q1 census', departments: ['HR', 'Finance'] });

  const res = await built.inject({ method: 'GET', url: `/api/collect/${c.token}` });
  expect(res.statusCode).toBe(200);
  const meta = res.json();
  expect(meta).toMatchObject({ isOpen: true, needsPassword: false, title: 'Q1 census', hasTemplate: false });
  expect(meta.departments.map((d: any) => d.name)).toEqual(['HR', 'Finance']);
  expect(meta.departments.every((d: any) => typeof d.id === 'number')).toBe(true);
  // Never leaks response status / owner.
  expect(JSON.stringify(meta)).not.toContain('owner');
  expect(JSON.stringify(meta)).not.toContain('responded');
});

test('GET meta closed -> {isOpen:false}, nothing else', async () => {
  const built = await makeApp();
  await seedUser('alice');
  const { session, csrf } = await login(built, 'alice');
  const c = await makeCollection(built, session, csrf, { title: 'T', departments: ['A'] });
  await built.inject({
    method: 'PATCH', url: `/api/collections/${c.id}`,
    cookies: { mirsal_session: session }, headers: { 'x-csrf-token': csrf }, payload: { is_active: false },
  });
  const res = await built.inject({ method: 'GET', url: `/api/collect/${c.token}` });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ isOpen: false });
});

test('GET meta open + password + no cookie -> {isOpen:true, needsPassword:true} (title/departments withheld)', async () => {
  const built = await makeApp();
  await seedUser('alice');
  const { session, csrf } = await login(built, 'alice');
  const c = await makeCollection(built, session, csrf, { title: 'Secret', departments: ['A'], password: 'hunter2' });
  const res = await built.inject({ method: 'GET', url: `/api/collect/${c.token}` });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ isOpen: true, needsPassword: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/routes/collect.test.ts`
Expected: FAIL — meta returns the app's catch-all `404 {error:'Not Found'}` (no `collect` plugin yet), so the "open, no password" test fails on status/body.

- [ ] **Step 3: Create the plugin with the meta route**

Create `server/src/routes/collect.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { Clock } from '../clock.js';
import type { PasswordService } from '../auth/passwords.js';
import type { BlobStore } from '../storage/blobs.js';
import type { Config } from '../config.js';
import { collectionStatus, type Collection } from '../collections/collections.js';
import { listDepartments } from '../collections/departments.js';
import { createUnlockGate } from '../collections/unlock.js';

export interface CollectRouteDeps {
  db: Database.Database;
  now: Clock;
  passwordService: PasswordService;
  blobStore: BlobStore;
  config: Config;
}

/**
 * The public intake gate for Collections. NO auth, NO CSRF. Registered without
 * a prefix (each route carries its full `/api/collect/...` path). Every
 * response is stamped `Referrer-Policy: no-referrer` (so a link token never
 * leaks via Referer) and `Cache-Control: no-store` (collection open/closed
 * state changes out from under a recipient), via an encapsulated onSend hook
 * scoped to THIS plugin only. Mirrors routes/public.ts.
 */
export default async function collectRoutes(app: FastifyInstance, deps: CollectRouteDeps): Promise<void> {
  const { db, now, config } = deps;
  const gate = createUnlockGate(config.SESSION_SECRET);

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
    return payload;
  });

  /** Loads a collection by token regardless of status (undefined for unknown). */
  function loadByToken(token: string): Collection | undefined {
    return db.prepare('SELECT * FROM collections WHERE token = @token').get({ token }) as Collection | undefined;
  }

  // --- GET meta -----------------------------------------------------------
  app.get('/api/collect/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const c = loadByToken(token);
    if (!c) {
      reply.code(404).send({ error: 'not_found' });
      return;
    }
    if (collectionStatus(c, now()) !== 'open') {
      // Closed/expired: the uploader sees a neutral "closed" page. Nothing else
      // is revealed (no title/roster).
      reply.code(200).send({ isOpen: false });
      return;
    }
    const needsPassword = c.password_hash !== null;
    if (needsPassword && !gate.isUnlocked(req.cookies[gate.cookieName], token, c.password_hash, now())) {
      // Withhold title/departments until unlocked (mirrors the share unlock).
      reply.code(200).send({ isOpen: true, needsPassword: true });
      return;
    }
    const departments = listDepartments(db, c.id).map((d) => ({ id: d.id, name: d.name }));
    let templateName: string | null = null;
    if (c.template_node_id !== null) {
      const t = db
        .prepare("SELECT name FROM nodes WHERE id = @id AND owner_id = @ownerId AND kind = 'file' AND trashed_at IS NULL")
        .get({ id: c.template_node_id, ownerId: c.owner_id }) as { name: string } | undefined;
      if (t) templateName = t.name;
    }
    reply.code(200).send({
      isOpen: true,
      needsPassword,
      title: c.title,
      hasTemplate: templateName !== null,
      templateName,
      departments,
    });
  });
}
```

- [ ] **Step 4: Wire the plugin in `app.ts`**

Add the import beside the others (after `publicRoutes`):

```ts
import collectRoutes from './routes/collect.js';
```

In `registerRoutes`, register it immediately after the `publicRoutes` registration (it needs the same `passwordService` + shared `blobStore`):

```ts
  // Collections Phase 2: the public intake gate — NO auth, NO CSRF; token-in-URL.
  // Same shared passwordService + blobStore as the routes above. Its own
  // encapsulated onSend hook stamps no-referrer + no-store (never leaks onto
  // the authenticated routes).
  await app.register(collectRoutes, {
    db: deps.db,
    now: deps.now,
    passwordService,
    blobStore,
    config: deps.config,
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npx vitest run test/routes/collect.test.ts && npm run typecheck`
Expected: PASS (4 meta tests) + typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/collect.ts server/src/app.ts server/test/routes/collect.test.ts
git commit -m "feat(collections): public collect plugin + GET meta + app wiring"
```

---

## Task 3: POST unlock

Password unlock for a protected collection, in a dedicated rate-limited child scope (per-IP + per-token, two `@fastify/rate-limit` registrations), mirroring `routes/public.ts`'s `/unlock`.

**Files:**
- Modify: `server/src/routes/collect.ts` (add the unlock scope inside `collectRoutes`)
- Test: `server/test/routes/collect.test.ts` (append)

**Interfaces:**
- Consumes: `deps.passwordService.verifyPassword`, `writeAudit`, `gate.cookieValue`/`cookiePath`/`cookieName`, `fastifyRateLimit`, `z`.
- Produces route `POST /api/collect/:token/unlock`:
  - bad body → `400 {error:'invalid_body'}`; non-open/unknown → `404 {error:'not_found'}`; no-password collection → `400 {code:'no_password'}`; wrong password → `401 {error:'invalid_password'}` + audit `collection_unlock_failure` (actor = owner); correct → `200 {ok:true}` + sets the path-scoped unlock cookie.

- [ ] **Step 1: Write the failing test (append to `collect.test.ts`)**

```ts
test('POST unlock: wrong pw -> 401 + audit; correct pw -> 200 + cookie; meta then reveals full', async () => {
  const built = await makeApp();
  await seedUser('alice');
  const { session, csrf } = await login(built, 'alice');
  const c = await makeCollection(built, session, csrf, { title: 'Secret', departments: ['A', 'B'], password: 'hunter2' });

  const wrong = await built.inject({ method: 'POST', url: `/api/collect/${c.token}/unlock`, payload: { password: 'nope' } });
  expect(wrong.statusCode).toBe(401);
  expect(wrong.json()).toMatchObject({ error: 'invalid_password' });
  const audit = db!.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='collection_unlock_failure'").get() as { n: number };
  expect(audit.n).toBe(1);

  const ok = await built.inject({ method: 'POST', url: `/api/collect/${c.token}/unlock`, payload: { password: 'hunter2' } });
  expect(ok.statusCode).toBe(200);
  const setCookie = (ok.cookies as InjectedCookie[]).find((k) => k.name === 'mirsal_collect_unlock');
  expect(setCookie).toBeDefined();

  const meta = await built.inject({
    method: 'GET', url: `/api/collect/${c.token}`,
    cookies: { mirsal_collect_unlock: setCookie!.value },
  });
  expect(meta.json()).toMatchObject({ isOpen: true, needsPassword: true, title: 'Secret' });
  expect(meta.json().departments.map((d: any) => d.name)).toEqual(['A', 'B']);
});

test('POST unlock: no-password collection -> 400 no_password; closed -> 404; bad body -> 400', async () => {
  const built = await makeApp();
  await seedUser('alice');
  const { session, csrf } = await login(built, 'alice');
  const open = await makeCollection(built, session, csrf, { title: 'T', departments: ['A'] });
  expect((await built.inject({ method: 'POST', url: `/api/collect/${open.token}/unlock`, payload: { password: 'x' } })).statusCode).toBe(400);
  expect((await built.inject({ method: 'POST', url: `/api/collect/${open.token}/unlock`, payload: {} })).statusCode).toBe(400);

  const withPw = await makeCollection(built, session, csrf, { title: 'P', departments: ['A'], password: 'pw2' });
  await built.inject({ method: 'PATCH', url: `/api/collections/${withPw.id}`, cookies: { mirsal_session: session }, headers: { 'x-csrf-token': csrf }, payload: { is_active: false } });
  expect((await built.inject({ method: 'POST', url: `/api/collect/${withPw.token}/unlock`, payload: { password: 'pw2' } })).statusCode).toBe(404);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run test/routes/collect.test.ts -t unlock`
Expected: FAIL — unlock returns the catch-all `404 {error:'Not Found'}`.

- [ ] **Step 3: Add the imports + unlock scope**

At the top of `collect.ts` add:

```ts
import fastifyRateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
```

Add these constants above `collectRoutes` (mirrors `public.ts`):

```ts
const UNLOCK_IP_RATE_LIMIT_MAX = 20;
const UNLOCK_TOKEN_RATE_LIMIT_MAX = 5;
const UNLOCK_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const unlockSchema = z.object({ password: z.string().min(1) });
```

Inside `collectRoutes`, after the meta route, add the destructure of `passwordService` (extend the existing `const { db, now, config } = deps;` to `const { db, now, config, passwordService } = deps;`) and register the scope:

```ts
  // --- POST unlock (rate-limited per-IP AND per-token) --------------------
  // Two independent @fastify/rate-limit instances (per-IP + per-token) in a
  // dedicated child scope — same two-registration pattern as routes/public.ts.
  await app.register(async function collectUnlockScope(scope) {
    await scope.register(fastifyRateLimit, {
      max: UNLOCK_IP_RATE_LIMIT_MAX, timeWindow: UNLOCK_RATE_LIMIT_WINDOW_MS,
      hook: 'preHandler', keyGenerator: (req) => req.ip,
    });
    await scope.register(fastifyRateLimit, {
      max: UNLOCK_TOKEN_RATE_LIMIT_MAX, timeWindow: UNLOCK_RATE_LIMIT_WINDOW_MS,
      hook: 'preHandler', keyGenerator: (req) => (req.params as { token?: string }).token ?? '',
    });

    scope.post('/api/collect/:token/unlock', async (req, reply) => {
      const { token } = req.params as { token: string };
      const parsed = unlockSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send({ error: 'invalid_body' });
        return;
      }
      const c = loadByToken(token);
      if (!c || collectionStatus(c, now()) !== 'open') {
        reply.code(404).send({ error: 'not_found' });
        return;
      }
      if (c.password_hash === null) {
        reply.code(400).send({ code: 'no_password' });
        return;
      }
      const ok = await passwordService.verifyPassword(c.password_hash, parsed.data.password);
      if (!ok) {
        writeAudit(db, { actorId: c.owner_id, action: 'collection_unlock_failure', target: token }, now);
        reply.code(401).send({ error: 'invalid_password' });
        return;
      }
      // Path-scoped to THIS token so the cookie is only presented to this
      // collection's own endpoints. Session cookie (no Max-Age); its 600s
      // lifetime is enforced server-side in gate.isUnlocked.
      reply.setCookie(gate.cookieName, gate.cookieValue(token, c.password_hash, now()), {
        httpOnly: true, secure: true, sameSite: 'lax', path: gate.cookiePath(token),
      });
      reply.code(200).send({ ok: true });
    });
  });
```

- [ ] **Step 4: Run to verify pass**

Run: `cd server && npx vitest run test/routes/collect.test.ts && npm run typecheck`
Expected: PASS + typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/collect.ts server/test/routes/collect.test.ts
git commit -m "feat(collections): public unlock route (per-IP+per-token limited)"
```

---

## Task 4: GET template

Streams the collection's template file to the recipient (uncounted, unlimited), gated by open-status and unlock, in a rate-limited scope.

**Files:**
- Modify: `server/src/routes/collect.ts`
- Test: `server/test/routes/collect.test.ts` (append)

**Interfaces:**
- Consumes: `deps.blobStore.readBlob`, `buildContentDisposition` (`util/content-disposition.js`), `type ReadStream`, `gate.isUnlocked`.
- Produces `GET /api/collect/:token/template`: no template / non-open / trashed-template / missing-blob → `404 {error:'not_found'}`; password + not-unlocked → `401 {needsPassword:true}`; success → streamed bytes + `Content-Disposition` (attachment, sanitized name) + `X-Content-Type-Options: nosniff`.

- [ ] **Step 1: Write the failing test (append)**

```ts
test('GET template: streams the attached file; missing template -> 404', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice');
  const { session, csrf } = await login(built, 'alice');

  // Upload a real file, then attach it as the template.
  const { rootId } = (await import('../../src/nodes/tree.js')).ensureUserRoots(db!, uid, NOW);
  const boundary = '----b';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="parent_id"\r\n\r\n${rootId}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="template.txt"\r\nContent-Type: text/plain\r\n\r\n`),
    Buffer.from('HELLO-TEMPLATE'),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const up = await built.inject({
    method: 'POST', url: '/api/nodes/upload',
    cookies: { mirsal_session: session }, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-csrf-token': csrf },
    payload: body,
  });
  const templateNodeId = up.json().id;

  const c = await makeCollection(built, session, csrf, { title: 'T', departments: ['A'], template_node_id: templateNodeId });
  const res = await built.inject({ method: 'GET', url: `/api/collect/${c.token}/template` });
  expect(res.statusCode).toBe(200);
  expect(res.body).toBe('HELLO-TEMPLATE');
  expect(res.headers['content-disposition']).toContain('template.txt');

  const noTpl = await makeCollection(built, session, csrf, { title: 'NoTpl', departments: ['A'] });
  expect((await built.inject({ method: 'GET', url: `/api/collect/${noTpl.token}/template` })).statusCode).toBe(404);
});

test('GET template: password-protected + not unlocked -> 401', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice');
  const { session, csrf } = await login(built, 'alice');
  const c = await makeCollection(built, session, csrf, { title: 'T', departments: ['A'], password: 'pw3' });
  const res = await built.inject({ method: 'GET', url: `/api/collect/${c.token}/template` });
  expect(res.statusCode).toBe(401);
  expect(res.json()).toMatchObject({ needsPassword: true });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run test/routes/collect.test.ts -t template`
Expected: FAIL — catch-all 404 for the streamed case / 404 vs 401 mismatch for the password case.

- [ ] **Step 3: Add imports + a `waitForOpen` helper + the template scope**

At the top of `collect.ts` add:

```ts
import type { ReadStream } from 'node:fs';
import { buildContentDisposition } from '../util/content-disposition.js';
```

Add rate-limit constants (mirror `public.ts` download caps) above `collectRoutes`:

```ts
const READ_IP_RATE_LIMIT_MAX = 60;
const READ_TOKEN_RATE_LIMIT_MAX = 120;
const READ_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
```

Add a module-level helper (mirrors `public.ts`/`nodes.ts`):

```ts
/** Waits for `stream`'s `open`, or rejects with its `error` (e.g. ENOENT). */
function waitForOpen(stream: ReadStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once('open', () => resolve());
    stream.once('error', (err) => reject(err));
  });
}
```

Extend the destructure to include `blobStore`: `const { db, now, config, passwordService, blobStore } = deps;`. Inside `collectRoutes`, after the unlock scope, add:

```ts
  /** For a password collection, requires a valid unlock cookie. Sends 401 and
   *  returns false when locked; true otherwise. */
  function requireUnlocked(req: Parameters<Parameters<typeof app.get>[1]>[0], reply: any, c: Collection): boolean {
    if (c.password_hash !== null && !gate.isUnlocked(req.cookies[gate.cookieName], c.token, c.password_hash, now())) {
      reply.code(401).send({ needsPassword: true });
      return false;
    }
    return true;
  }

  // --- GET template (rate-limited per-IP AND per-token) -------------------
  await app.register(async function collectTemplateScope(scope) {
    await scope.register(fastifyRateLimit, {
      max: READ_IP_RATE_LIMIT_MAX, timeWindow: READ_RATE_LIMIT_WINDOW_MS,
      hook: 'preHandler', keyGenerator: (req) => req.ip,
    });
    await scope.register(fastifyRateLimit, {
      max: READ_TOKEN_RATE_LIMIT_MAX, timeWindow: READ_RATE_LIMIT_WINDOW_MS,
      hook: 'preHandler', keyGenerator: (req) => (req.params as { token?: string }).token ?? '',
    });

    scope.get('/api/collect/:token/template', async (req, reply) => {
      const { token } = req.params as { token: string };
      const c = loadByToken(token);
      if (!c || collectionStatus(c, now()) !== 'open') {
        reply.code(404).send({ error: 'not_found' });
        return;
      }
      if (!requireUnlocked(req, reply, c)) return;
      if (c.template_node_id === null) {
        reply.code(404).send({ error: 'not_found' });
        return;
      }
      const node = db
        .prepare('SELECT owner_id, kind, name, mime_type, storage_path, trashed_at FROM nodes WHERE id = @id')
        .get({ id: c.template_node_id }) as
        | { owner_id: number; kind: string; name: string; mime_type: string | null; storage_path: string | null; trashed_at: number | null }
        | undefined;
      if (!node || node.owner_id !== c.owner_id || node.kind !== 'file' || node.trashed_at !== null || !node.storage_path) {
        reply.code(404).send({ error: 'not_found' });
        return;
      }
      const stream = blobStore.readBlob(node.storage_path);
      try {
        await waitForOpen(stream);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          reply.code(404).send({ error: 'not_found' }); // reverse-orphan, never 500
          return;
        }
        throw e;
      }
      reply.header('Content-Disposition', buildContentDisposition(node.name));
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Type', node.mime_type ?? 'application/octet-stream');
      return reply.send(stream);
    });
  });
```

*(Note: `requireUnlocked`'s `req`/`reply` typing above is deliberately loose to avoid over-parameterizing; if `tsc` objects, type `req: FastifyRequest`/`reply: FastifyReply` by importing those types.)*

- [ ] **Step 4: Run to verify pass**

Run: `cd server && npx vitest run test/routes/collect.test.ts && npm run typecheck`
Expected: PASS + typecheck clean. If `tsc` flags the `requireUnlocked` param types, add `import type { FastifyReply, FastifyRequest } from 'fastify';` and annotate `req: FastifyRequest, reply: FastifyReply`.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/collect.ts server/test/routes/collect.test.ts
git commit -m "feat(collections): public template download route"
```

---

## Task 5: Response write model (`commitResponse`)

The transactional core of the inbound write: first-submission and latest-replaces, with an atomic post-free quota reserve. Pure DB + quota (no filesystem, no HTTP) — the route (Task 6) streams to temp before, and `commitTemp`/`deleteBlob` after.

**Files:**
- Create: `server/src/util/names.ts`
- Create: `server/src/collections/responses.ts`
- Modify: `server/src/config.ts` (add two consts)
- Test: `server/test/collections/responses.test.ts`

**Interfaces:**
- Consumes: `reserve`, `subtract` (`storage/quota.js`); `nextSuffixedName` (`nodes/collisions.js`); `sanitizeNodeName` (new `util/names.js`).
- Produces:
  - `util/names.ts`: `export function sanitizeNodeName(raw: unknown): string | null` (identical behavior to the private copy in `routes/nodes.ts`).
  - `config.ts`: `export const COLLECTION_MAX_FILES_PER_RESPONSE = 10;` and `export const MAX_NOTE_LENGTH = 2000;`.
  - `responses.ts`:
    - `export interface StagedFile { name: string; tempPath: string; bytes: number; mimeType: string | null }`.
    - `export interface CommittedFile { tempPath: string; nodeId: number }`.
    - `export interface CommitResponseResult { removedStoragePaths: string[]; committed: CommittedFile[]; responseId: number }`.
    - `export class QuotaExceededError extends Error {}`.
    - `export function responseHeadroom(db, ownerId: number, collectionId: number, departmentId: number): number | null` (null = unlimited; accounts for the prior set that latest-replaces will free).
    - `export function commitResponse(db, ownerId: number, collection: { id: number; folder_node_id: number }, department: { id: number; name: string }, staged: StagedFile[], note: string | null, submittedIp: string | null, now: number): CommitResponseResult` (throws `QuotaExceededError` → whole txn rolled back).

- [ ] **Step 1: Write the failing test**

Create `server/test/collections/responses.test.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { ensureUserRoots } from '../../src/nodes/tree.js';
import { commitResponse, responseHeadroom, QuotaExceededError, type StagedFile } from '../../src/collections/responses.js';

const NOW = 1_700_000_000_000;
let db: Database.Database | undefined;
let dir: string | undefined;

afterEach(() => { db?.close(); db = undefined; if (dir) { fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; } });

function fresh(): Database.Database {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-resp-'));
  db = openDb(path.join(dir, 't.db'));
  migrate(db);
  return db;
}
function seedOwner(quota: number | null): number {
  const info = db!.prepare(`INSERT INTO users(username,password_hash,role,is_active,must_change_password,quota_bytes,used_bytes,created_at,updated_at)
    VALUES ('o','h','user',1,0,?,0,?,?)`).run(quota, NOW, NOW);
  return Number(info.lastInsertRowid);
}
/** Seeds a collection folder + one department; returns ids the model needs. */
function seedCollection(ownerId: number): { collectionId: number; folderNodeId: number; deptId: number } {
  const { rootId } = ensureUserRoots(db!, ownerId, NOW);
  const folderNodeId = Number(db!.prepare(`INSERT INTO nodes(owner_id,parent_id,kind,name,size_bytes,created_at,updated_at)
    VALUES (?,?,'folder','طلب تجميع: T',0,?,?)`).run(ownerId, rootId, NOW, NOW).lastInsertRowid);
  const collectionId = Number(db!.prepare(`INSERT INTO collections(owner_id,token,title,template_node_id,folder_node_id,password_hash,is_active,deadline_at,created_at,updated_at)
    VALUES (?,?,?,NULL,?,NULL,1,NULL,?,?)`).run(ownerId, `tok-${Math.random()}`, 'T', folderNodeId, NOW, NOW).lastInsertRowid);
  const deptId = Number(db!.prepare(`INSERT INTO collection_departments(collection_id,name,position,created_at) VALUES (?,?,0,?)`)
    .run(collectionId, 'HR', NOW).lastInsertRowid);
  return { collectionId, folderNodeId, deptId };
}
function staged(name: string, bytes: number): StagedFile {
  return { name, tempPath: `/tmp/fake-${name}-${Math.random()}`, bytes, mimeType: 'application/octet-stream' };
}

test('first submission: creates the dept subfolder + file nodes; response row + used_bytes', () => {
  const database = fresh();
  const owner = seedOwner(null);
  const { collectionId, folderNodeId, deptId } = seedCollection(owner);

  const res = commitResponse(database, owner, { id: collectionId, folder_node_id: folderNodeId },
    { id: deptId, name: 'HR' }, [staged('a.txt', 100), staged('b.txt', 50)], 'my note', '1.2.3.4', NOW);

  expect(res.committed).toHaveLength(2);
  expect(res.removedStoragePaths).toEqual([]);
  const sub = database.prepare("SELECT id FROM nodes WHERE parent_id=? AND kind='folder'").get(folderNodeId) as { id: number };
  const files = database.prepare("SELECT name, storage_path, size_bytes FROM nodes WHERE parent_id=? AND kind='file' ORDER BY name").all(sub.id) as any[];
  expect(files.map((f) => f.name)).toEqual(['a.txt', 'b.txt']);
  expect(files.every((f) => f.storage_path === `${owner}/${res.committed.find((c) => true) && f.storage_path.split('/')[0] === String(owner)}` || f.storage_path.startsWith(`${owner}/`))).toBe(true);
  const row = database.prepare('SELECT * FROM collection_responses WHERE collection_id=? AND department_id=?').get(collectionId, deptId) as any;
  expect(row.folder_node_id).toBe(sub.id);
  expect(row.note).toBe('my note');
  expect(row.submitted_ip).toBe('1.2.3.4');
  const used = database.prepare('SELECT used_bytes FROM users WHERE id=?').get(owner) as { used_bytes: number };
  expect(used.used_bytes).toBe(150);
});

test('latest-replaces: second submit removes the prior set, reclaims quota, keeps one row/slot', () => {
  const database = fresh();
  const owner = seedOwner(null);
  const { collectionId, folderNodeId, deptId } = seedCollection(owner);

  const first = commitResponse(database, owner, { id: collectionId, folder_node_id: folderNodeId },
    { id: deptId, name: 'HR' }, [staged('old.txt', 200)], null, null, NOW);
  // Simulate the blobs being committed so storage_path values are real-looking (not needed for the model).
  const second = commitResponse(database, owner, { id: collectionId, folder_node_id: folderNodeId },
    { id: deptId, name: 'HR' }, [staged('new.txt', 30)], 'updated', null, NOW + 1);

  // The prior file's storage_path is reported for the caller to unlink.
  expect(second.removedStoragePaths).toHaveLength(1);
  expect(second.removedStoragePaths[0]).toBe(first.committed[0] ? `${owner}/${first.committed[0].nodeId}` : '');
  // Exactly one response row, one live file (new.txt), quota reflects only the new set.
  const rows = database.prepare('SELECT COUNT(*) n FROM collection_responses WHERE collection_id=? AND department_id=?').get(collectionId, deptId) as { n: number };
  expect(rows.n).toBe(1);
  const sub = (database.prepare('SELECT folder_node_id f FROM collection_responses WHERE collection_id=? AND department_id=?').get(collectionId, deptId) as { f: number }).f;
  const files = database.prepare("SELECT name FROM nodes WHERE parent_id=? AND kind='file'").all(sub) as any[];
  expect(files.map((f) => f.name)).toEqual(['new.txt']);
  const used = database.prepare('SELECT used_bytes FROM users WHERE id=?').get(owner) as { used_bytes: number };
  expect(used.used_bytes).toBe(30);
});

test('over quota: throws QuotaExceededError and rolls back (no new nodes, used_bytes unchanged)', () => {
  const database = fresh();
  const owner = seedOwner(100); // 100-byte quota
  const { collectionId, folderNodeId, deptId } = seedCollection(owner);

  expect(() => commitResponse(database, owner, { id: collectionId, folder_node_id: folderNodeId },
    { id: deptId, name: 'HR' }, [staged('big.bin', 500)], null, null, NOW)).toThrow(QuotaExceededError);

  expect((database.prepare("SELECT COUNT(*) n FROM nodes WHERE kind='file'").get() as { n: number }).n).toBe(0);
  expect((database.prepare('SELECT used_bytes FROM users WHERE id=?').get(owner) as { used_bytes: number }).used_bytes).toBe(0);
  expect((database.prepare('SELECT COUNT(*) n FROM collection_responses').get() as { n: number }).n).toBe(0);
});

test('over quota on REPLACE rolls back and preserves the prior response', () => {
  const database = fresh();
  const owner = seedOwner(250);
  const { collectionId, folderNodeId, deptId } = seedCollection(owner);
  commitResponse(database, owner, { id: collectionId, folder_node_id: folderNodeId }, { id: deptId, name: 'HR' }, [staged('a', 200)], null, null, NOW);
  // Replacing 200 with 300: post-free headroom = 250 - 200 + 200 = 250 < 300 -> reject, keep old.
  expect(() => commitResponse(database, owner, { id: collectionId, folder_node_id: folderNodeId }, { id: deptId, name: 'HR' }, [staged('b', 300)], null, null, NOW + 1)).toThrow(QuotaExceededError);
  const sub = (database.prepare('SELECT folder_node_id f FROM collection_responses WHERE collection_id=? AND department_id=?').get(collectionId, deptId) as { f: number }).f;
  const files = database.prepare("SELECT name, size_bytes FROM nodes WHERE parent_id=? AND kind='file'").all(sub) as any[];
  expect(files).toHaveLength(1);
  expect(files[0].name).toBe('a');
  expect((database.prepare('SELECT used_bytes FROM users WHERE id=?').get(owner) as { used_bytes: number }).used_bytes).toBe(200);
});

test('responseHeadroom: unlimited -> null; bounded accounts for the prior set', () => {
  const database = fresh();
  const owner = seedOwner(null);
  const { collectionId, folderNodeId, deptId } = seedCollection(owner);
  expect(responseHeadroom(database, owner, collectionId, deptId)).toBeNull();

  const owner2 = (() => { const info = database.prepare(`INSERT INTO users(username,password_hash,role,is_active,must_change_password,quota_bytes,used_bytes,created_at,updated_at) VALUES ('o2','h','user',1,0,1000,0,?,?)`).run(NOW, NOW); return Number(info.lastInsertRowid); })();
  const c2 = seedCollectionFor(database, owner2);
  commitResponse(database, owner2, { id: c2.collectionId, folder_node_id: c2.folderNodeId }, { id: c2.deptId, name: 'HR' }, [staged('x', 400)], null, null, NOW);
  // used=400, quota=1000, prior set=400 -> headroom = 1000 - 400 + 400 = 1000.
  expect(responseHeadroom(database, owner2, c2.collectionId, c2.deptId)).toBe(1000);

  function seedCollectionFor(dbi: Database.Database, ownerId: number) {
    const { rootId } = ensureUserRoots(dbi, ownerId, NOW);
    const folderNodeId = Number(dbi.prepare(`INSERT INTO nodes(owner_id,parent_id,kind,name,size_bytes,created_at,updated_at) VALUES (?,?,'folder','f',0,?,?)`).run(ownerId, rootId, NOW, NOW).lastInsertRowid);
    const collectionId = Number(dbi.prepare(`INSERT INTO collections(owner_id,token,title,template_node_id,folder_node_id,password_hash,is_active,deadline_at,created_at,updated_at) VALUES (?,?,?,NULL,?,NULL,1,NULL,?,?)`).run(ownerId, `t2-${Math.random()}`, 'T', folderNodeId, NOW, NOW).lastInsertRowid);
    const dept = Number(dbi.prepare(`INSERT INTO collection_departments(collection_id,name,position,created_at) VALUES (?,?,0,?)`).run(collectionId, 'HR', NOW).lastInsertRowid);
    return { collectionId, folderNodeId, deptId: dept };
  }
});
```

*(The `storage_path` assertion in the first test is intentionally loose — assert only that each is `\`${owner}/<id>\``; simplify to `files.every((f) => f.storage_path.startsWith(\`${owner}/\`))` if the inline expression reads awkwardly. Keep the behavioral checks.)*

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run test/collections/responses.test.ts`
Expected: FAIL — `Cannot find module '../../src/collections/responses.js'`.

- [ ] **Step 3: Add the config consts**

In `server/src/config.ts`, below `GRACE_MS`:

```ts
/** Max files accepted in one collection response submission (spec §2.3). */
export const COLLECTION_MAX_FILES_PER_RESPONSE = 10;
/** Max length of the optional per-response note. */
export const MAX_NOTE_LENGTH = 2000;
```

- [ ] **Step 4: Add `util/names.ts`**

Create `server/src/util/names.ts` (copied verbatim from the private `sanitizeNodeName` in `routes/nodes.ts` — see the CARRY note in File Structure):

```ts
const MAX_NAME_LENGTH = 255;

/**
 * Sanitizes a client-supplied node name (upload filename or department label):
 * strips control chars, trims, caps length, rejects empty / path-separator /
 * `.` / `..`. Returns null if unusable. Names are display strings only —
 * storage paths are always `${ownerId}/${nodeId}`, never the client name.
 */
export function sanitizeNodeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  let name = raw.replace(/[\x00-\x1F\x7F]/g, '');
  name = name.trim();
  if (name.length === 0) return null;
  if (name.length > MAX_NAME_LENGTH) name = name.slice(0, MAX_NAME_LENGTH);
  if (name.includes('/') || name.includes('\\')) return null;
  if (name === '.' || name === '..') return null;
  return name;
}
```

- [ ] **Step 5: Add `collections/responses.ts`**

Create `server/src/collections/responses.ts`:

```ts
import type Database from 'better-sqlite3';
import { reserve, subtract } from '../storage/quota.js';
import { nextSuffixedName } from '../nodes/collisions.js';
import { sanitizeNodeName } from '../util/names.js';

export interface StagedFile {
  name: string;
  tempPath: string;
  bytes: number;
  mimeType: string | null;
}
export interface CommittedFile {
  tempPath: string;
  nodeId: number;
}
export interface CommitResponseResult {
  removedStoragePaths: string[];
  committed: CommittedFile[];
  responseId: number;
}

/** Thrown inside commitResponse's transaction when the owner's quota can't fit
 *  the new set — the throw rolls the whole transaction back. */
export class QuotaExceededError extends Error {
  constructor() {
    super('quota exceeded');
    this.name = 'QuotaExceededError';
  }
}

/**
 * Bytes the owner can still accept for THIS department's submission. Adds back
 * the department's CURRENT stored set, since latest-replaces frees it before
 * the new set lands — so a same-size re-submit never falsely trips. Returns
 * null when the owner's quota is unlimited.
 */
export function responseHeadroom(
  db: Database.Database,
  ownerId: number,
  collectionId: number,
  departmentId: number
): number | null {
  const u = db.prepare('SELECT quota_bytes, used_bytes FROM users WHERE id = @ownerId').get({ ownerId }) as {
    quota_bytes: number | null;
    used_bytes: number;
  };
  if (u.quota_bytes === null) return null;
  const prior = db
    .prepare(
      `SELECT COALESCE(SUM(n.size_bytes), 0) AS b
       FROM collection_responses r
       JOIN nodes n ON n.parent_id = r.folder_node_id AND n.kind = 'file'
       WHERE r.collection_id = @collectionId AND r.department_id = @departmentId`
    )
    .get({ collectionId, departmentId }) as { b: number };
  return Math.max(0, u.quota_bytes - u.used_bytes + prior.b);
}

/**
 * Records a department's response (first submission or latest-replaces) in ONE
 * synchronous transaction:
 *  1. If a prior response exists, collect its file blob paths + bytes, delete
 *     those file rows, and `subtract` the freed bytes from the owner. The
 *     department's response subfolder is REUSED (folder_node_id stays stable).
 *  2. `reserve` the new set's bytes against the owner's quota (checked AFTER
 *     the free in step 1, so the check reflects true post-replace usage). On
 *     failure, throw QuotaExceededError — the transaction rolls back, so a
 *     failed replace leaves the prior response fully intact.
 *  3. Insert the new file nodes (row-first: the row's final storage_path
 *     `${ownerId}/${nodeId}` is set before the caller renames the blob into
 *     place), de-duplicating names via nextSuffixedName.
 *  4. Upsert the collection_responses row (unique on (collection_id,
 *     department_id) via ux_collection_response_dept).
 * Returns the blob paths to unlink and the temp→final renames to perform AFTER
 * this commits — this function never touches the filesystem.
 */
export function commitResponse(
  db: Database.Database,
  ownerId: number,
  collection: { id: number; folder_node_id: number },
  department: { id: number; name: string },
  staged: StagedFile[],
  note: string | null,
  submittedIp: string | null,
  now: number
): CommitResponseResult {
  const totalBytes = staged.reduce((sum, f) => sum + f.bytes, 0);

  const run = db.transaction((): CommitResponseResult => {
    const prior = db
      .prepare('SELECT id, folder_node_id FROM collection_responses WHERE collection_id = @c AND department_id = @d')
      .get({ c: collection.id, d: department.id }) as { id: number; folder_node_id: number } | undefined;

    const removedStoragePaths: string[] = [];
    let subfolderId: number;

    if (prior) {
      const oldFiles = db
        .prepare("SELECT storage_path, size_bytes FROM nodes WHERE parent_id = @f AND kind = 'file'")
        .all({ f: prior.folder_node_id }) as { storage_path: string | null; size_bytes: number }[];
      let freed = 0;
      for (const of of oldFiles) {
        if (of.storage_path) removedStoragePaths.push(of.storage_path);
        freed += of.size_bytes;
      }
      db.prepare("DELETE FROM nodes WHERE parent_id = @f AND kind = 'file'").run({ f: prior.folder_node_id });
      subtract(db, ownerId, freed);
      subfolderId = prior.folder_node_id;
    } else {
      const folderName = nextSuffixedName(db, collection.folder_node_id, sanitizeNodeName(department.name) ?? 'قسم');
      const info = db
        .prepare(
          `INSERT INTO nodes(owner_id, parent_id, kind, name, size_bytes, created_at, updated_at)
           VALUES (@o, @p, 'folder', @n, 0, @now, @now)`
        )
        .run({ o: ownerId, p: collection.folder_node_id, n: folderName, now });
      subfolderId = Number(info.lastInsertRowid);
    }

    if (!reserve(db, ownerId, totalBytes, now)) {
      throw new QuotaExceededError();
    }

    const committed: CommittedFile[] = [];
    for (const f of staged) {
      const name = nextSuffixedName(db, subfolderId, sanitizeNodeName(f.name) ?? 'file');
      const info = db
        .prepare(
          `INSERT INTO nodes(owner_id, parent_id, kind, name, size_bytes, mime_type, storage_path, created_at, updated_at)
           VALUES (@o, @p, 'file', @n, @sz, @mt, NULL, @now, @now)`
        )
        .run({ o: ownerId, p: subfolderId, n: name, sz: f.bytes, mt: f.mimeType, now });
      const nodeId = Number(info.lastInsertRowid);
      db.prepare('UPDATE nodes SET storage_path = @sp WHERE id = @id').run({ sp: `${ownerId}/${nodeId}`, id: nodeId });
      committed.push({ tempPath: f.tempPath, nodeId });
    }

    const up = db
      .prepare(
        `INSERT INTO collection_responses(collection_id, department_id, folder_node_id, note, submitted_at, submitted_ip)
         VALUES (@c, @d, @f, @note, @now, @ip)
         ON CONFLICT(collection_id, department_id) DO UPDATE SET
           folder_node_id = excluded.folder_node_id, note = excluded.note,
           submitted_at = excluded.submitted_at, submitted_ip = excluded.submitted_ip
         RETURNING id`
      )
      .get({ c: collection.id, d: department.id, f: subfolderId, note, now, ip: submittedIp }) as { id: number };

    return { removedStoragePaths, committed, responseId: up.id };
  });

  return run();
}
```

- [ ] **Step 6: Run to verify pass**

Run: `cd server && npx vitest run test/collections/responses.test.ts && npm run typecheck`
Expected: PASS (5 tests) + typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add server/src/collections/responses.ts server/src/util/names.ts server/src/config.ts server/test/collections/responses.test.ts
git commit -m "feat(collections): response write model (first-submit + latest-replaces + quota)"
```

---

## Task 6: POST submit (the inbound write)

The multipart submit endpoint: stream file parts to temp with guards, validate the department, early-abort on quota, then `commitResponse` + move blobs + audit — all in a rate-limited scope (the tightest).

**Files:**
- Modify: `server/src/routes/collect.ts`
- Test: `server/test/routes/collect.test.ts` (append + add a multipart helper)

**Interfaces:**
- Consumes: `req.isMultipart()`, `req.parts({ limits })`, `blobStore.writeStreamToTemp`/`commitTemp`/`deleteBlob`, `commitResponse`/`responseHeadroom`/`QuotaExceededError`/`type StagedFile`, `sanitizeNodeName`, `writeAudit`, `MAX_FILE_BYTES`/`COLLECTION_MAX_FILES_PER_RESPONSE`/`MAX_NOTE_LENGTH`.
- Produces `POST /api/collect/:token/submit`:
  - non-multipart → `415 {error:'unsupported_media_type'}`; non-open/unknown → `404`; password + not-unlocked → `401 {needsPassword:true}`; malformed multipart → `400 {error:'invalid_upload'}`; `>10` files → `400 {error:'too_many_files'}`; `>100 MB` file → `413 {error:'file_too_large'}`; `0` files → `400 {error:'no_files'}`; unknown/foreign department → `404 {error:'not_found'}`; over quota → `413 {error:'quota_exceeded'}`; success → `200 {ok:true}` + audit `collection_response_submitted` (`actor_id = NULL`).

- [ ] **Step 1: Write the failing tests (append to `collect.test.ts`)**

First add a multipart body helper near the top of the file (mirrors `test/routes/nodes.test.ts`):

```ts
interface MultipartPart { name: string; value?: string; filename?: string; contentType?: string; data?: Buffer }
function buildMultipart(parts: MultipartPart[]): { body: Buffer; contentType: string } {
  const boundary = `----mirsalCollect${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (part.filename !== undefined) {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`, 'utf8'));
      chunks.push(Buffer.from(`Content-Type: ${part.contentType ?? 'application/octet-stream'}\r\n\r\n`));
      chunks.push(part.data ?? Buffer.alloc(0));
      chunks.push(Buffer.from('\r\n'));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n`));
      chunks.push(Buffer.from(`${part.value ?? ''}\r\n`));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}
async function submit(built: FastifyInstance, token: string, parts: MultipartPart[], cookies: Record<string, string> = {}) {
  const { body, contentType } = buildMultipart(parts);
  return built.inject({ method: 'POST', url: `/api/collect/${token}/submit`, headers: { 'content-type': contentType }, cookies, payload: body });
}
/** Reads the department ids for a collection straight from the DB. */
function deptIds(collectionId: number): { id: number; name: string }[] {
  return db!.prepare('SELECT id, name FROM collection_departments WHERE collection_id=? ORDER BY position').all(collectionId) as any[];
}
```

Then the tests:

```ts
import { MAX_FILE_BYTES } from '../../src/config.js';

test('submit happy path: 1 file -> 200; response row + file node + used_bytes + audit(actor null)', async () => {
  const built = await makeApp();
  const owner = await seedUser('alice');
  const { session, csrf } = await login(built, 'alice');
  const c = await makeCollection(built, session, csrf, { title: 'T', departments: ['HR', 'Finance'] });
  const hr = deptIds(c.id).find((d) => d.name === 'HR')!;

  const res = await submit(built, c.token, [
    { name: 'departmentId', value: String(hr.id) },
    { name: 'note', value: 'here is our report' },
    { name: 'files', filename: 'report.txt', contentType: 'text/plain', data: Buffer.from('THE REPORT') },
  ]);
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ ok: true });

  const folderId = (db!.prepare('SELECT folder_node_id f FROM collections WHERE id=?').get(c.id) as { f: number }).f;
  const sub = db!.prepare("SELECT id, name FROM nodes WHERE parent_id=? AND kind='folder'").get(folderId) as { id: number; name: string };
  expect(sub.name).toBe('HR');
  const files = db!.prepare("SELECT name, storage_path, size_bytes FROM nodes WHERE parent_id=? AND kind='file'").all(sub.id) as any[];
  expect(files).toHaveLength(1);
  expect(files[0].name).toBe('report.txt');
  expect(files[0].size_bytes).toBe(10);
  // Blob is on disk at ownerId/nodeId.
  const nodeId = files[0].storage_path.split('/')[1];
  expect(fs.existsSync(path.join(dir!, 'storage', String(owner), nodeId))).toBe(true);
  expect((db!.prepare('SELECT used_bytes u FROM users WHERE id=?').get(owner) as { u: number }).u).toBe(10);
  const row = db!.prepare('SELECT note FROM collection_responses WHERE collection_id=? AND department_id=?').get(c.id, hr.id) as { note: string };
  expect(row.note).toBe('here is our report');
  const audit = db!.prepare("SELECT actor_id, detail FROM audit_log WHERE action='collection_response_submitted'").get() as { actor_id: number | null; detail: string };
  expect(audit.actor_id).toBeNull();
  expect(JSON.parse(audit.detail)).toMatchObject({ collection_id: c.id, department_id: hr.id, department_name: 'HR', file_count: 1 });
});

test('submit: 3 files land as 3 nodes under the department subfolder', async () => {
  const built = await makeApp();
  await seedUser('alice');
  const { session, csrf } = await login(built, 'alice');
  const c = await makeCollection(built, session, csrf, { title: 'T', departments: ['HR'] });
  const hr = deptIds(c.id)[0];
  const res = await submit(built, c.token, [
    { name: 'departmentId', value: String(hr.id) },
    { name: 'files', filename: 'a.txt', data: Buffer.from('a') },
    { name: 'files', filename: 'b.txt', data: Buffer.from('bb') },
    { name: 'files', filename: 'c.txt', data: Buffer.from('ccc') },
  ]);
  expect(res.statusCode).toBe(200);
  const folderId = (db!.prepare('SELECT folder_node_id f FROM collections WHERE id=?').get(c.id) as { f: number }).f;
  const sub = (db!.prepare("SELECT id FROM nodes WHERE parent_id=? AND kind='folder'").get(folderId) as { id: number }).id;
  expect((db!.prepare("SELECT COUNT(*) n FROM nodes WHERE parent_id=? AND kind='file'").get(sub) as { n: number }).n).toBe(3);
});

test('submit guards: 0 files -> 400 no_files; >10 files -> 400 too_many_files (nothing stored)', async () => {
  const built = await makeApp();
  const owner = await seedUser('alice');
  const { session, csrf } = await login(built, 'alice');
  const c = await makeCollection(built, session, csrf, { title: 'T', departments: ['HR'] });
  const hr = deptIds(c.id)[0];

  const none = await submit(built, c.token, [{ name: 'departmentId', value: String(hr.id) }]);
  expect(none.statusCode).toBe(400);
  expect(none.json()).toMatchObject({ error: 'no_files' });

  const many = await submit(built, c.token, [
    { name: 'departmentId', value: String(hr.id) },
    ...Array.from({ length: 11 }, (_, i) => ({ name: 'files', filename: `f${i}.txt`, data: Buffer.from('x') })),
  ]);
  expect(many.statusCode).toBe(400);
  expect(many.json()).toMatchObject({ error: 'too_many_files' });
  expect((db!.prepare("SELECT COUNT(*) n FROM nodes WHERE kind='file'").get() as { n: number }).n).toBe(0);
  expect((db!.prepare('SELECT used_bytes u FROM users WHERE id=?').get(owner) as { u: number }).u).toBe(0);
});

test('submit guard: a file over MAX_FILE_BYTES -> 413 file_too_large, nothing stored', async () => {
  const built = await makeApp();
  const owner = await seedUser('alice');
  const { session, csrf } = await login(built, 'alice');
  const c = await makeCollection(built, session, csrf, { title: 'T', departments: ['HR'] });
  const hr = deptIds(c.id)[0];
  const res = await submit(built, c.token, [
    { name: 'departmentId', value: String(hr.id) },
    { name: 'files', filename: 'big.bin', data: Buffer.alloc(MAX_FILE_BYTES + 1024, 'a') },
  ]);
  expect(res.statusCode).toBe(413);
  expect(res.json()).toMatchObject({ error: 'file_too_large' });
  expect((db!.prepare("SELECT COUNT(*) n FROM nodes WHERE kind='file'").get() as { n: number }).n).toBe(0);
  expect((db!.prepare('SELECT used_bytes u FROM users WHERE id=?').get(owner) as { u: number }).u).toBe(0);
});

test('submit over quota -> 413 quota_exceeded, nothing stored', async () => {
  const built = await makeApp();
  const owner = await seedUser('alice', 5); // 5-byte quota
  const { session, csrf } = await login(built, 'alice');
  const c = await makeCollection(built, session, csrf, { title: 'T', departments: ['HR'] });
  const hr = deptIds(c.id)[0];
  const res = await submit(built, c.token, [
    { name: 'departmentId', value: String(hr.id) },
    { name: 'files', filename: 'a.txt', data: Buffer.from('way too big') },
  ]);
  expect(res.statusCode).toBe(413);
  expect(res.json()).toMatchObject({ error: 'quota_exceeded' });
  expect((db!.prepare("SELECT COUNT(*) n FROM nodes WHERE kind='file'").get() as { n: number }).n).toBe(0);
  expect((db!.prepare('SELECT used_bytes u FROM users WHERE id=?').get(owner) as { u: number }).u).toBe(0);
});

test('submit latest-replaces: re-submit swaps the set and reclaims the old blob', async () => {
  const built = await makeApp();
  const owner = await seedUser('alice');
  const { session, csrf } = await login(built, 'alice');
  const c = await makeCollection(built, session, csrf, { title: 'T', departments: ['HR'] });
  const hr = deptIds(c.id)[0];

  await submit(built, c.token, [{ name: 'departmentId', value: String(hr.id) }, { name: 'files', filename: 'old.txt', data: Buffer.from('OLDDATA') }]);
  const folderId = (db!.prepare('SELECT folder_node_id f FROM collections WHERE id=?').get(c.id) as { f: number }).f;
  const sub = (db!.prepare("SELECT id FROM nodes WHERE parent_id=? AND kind='folder'").get(folderId) as { id: number }).id;
  const oldNode = db!.prepare("SELECT storage_path sp FROM nodes WHERE parent_id=? AND kind='file'").get(sub) as { sp: string };
  const oldBlob = path.join(dir!, 'storage', oldNode.sp);
  expect(fs.existsSync(oldBlob)).toBe(true);

  await submit(built, c.token, [{ name: 'departmentId', value: String(hr.id) }, { name: 'files', filename: 'new.txt', data: Buffer.from('NEW') }]);
  const files = db!.prepare("SELECT name FROM nodes WHERE parent_id=? AND kind='file'").all(sub) as any[];
  expect(files.map((f) => f.name)).toEqual(['new.txt']);
  expect(fs.existsSync(oldBlob)).toBe(false); // old blob unlinked
  expect((db!.prepare('SELECT used_bytes u FROM users WHERE id=?').get(owner) as { u: number }).u).toBe(3);
  expect((db!.prepare('SELECT COUNT(*) n FROM collection_responses WHERE department_id=?').get(hr.id) as { n: number }).n).toBe(1);
});

test('submit rejects: wrong department -> 404; closed -> 404; non-multipart -> 415; password locked -> 401', async () => {
  const built = await makeApp();
  await seedUser('alice');
  const { session, csrf } = await login(built, 'alice');
  const c = await makeCollection(built, session, csrf, { title: 'T', departments: ['HR'] });
  const hr = deptIds(c.id)[0];

  expect((await submit(built, c.token, [{ name: 'departmentId', value: '999999' }, { name: 'files', filename: 'f.txt', data: Buffer.from('x') }])).statusCode).toBe(404);

  const nonMultipart = await built.inject({ method: 'POST', url: `/api/collect/${c.token}/submit`, payload: { hi: 1 } });
  expect(nonMultipart.statusCode).toBe(415);

  // Password-protected collection: submit without unlock -> 401.
  const pw = await makeCollection(built, session, csrf, { title: 'P', departments: ['HR'], password: 'pw9' });
  const pwHr = deptIds(pw.id)[0];
  expect((await submit(built, pw.token, [{ name: 'departmentId', value: String(pwHr.id) }, { name: 'files', filename: 'f.txt', data: Buffer.from('x') }])).statusCode).toBe(401);

  // Closed collection -> 404 (constant shape with unknown).
  await built.inject({ method: 'PATCH', url: `/api/collections/${c.id}`, cookies: { mirsal_session: session }, headers: { 'x-csrf-token': csrf }, payload: { is_active: false } });
  expect((await submit(built, c.token, [{ name: 'departmentId', value: String(hr.id) }, { name: 'files', filename: 'f.txt', data: Buffer.from('x') }])).statusCode).toBe(404);
  expect((await submit(built, 'unknown-token', [{ name: 'departmentId', value: '1' }, { name: 'files', filename: 'f.txt', data: Buffer.from('x') }])).statusCode).toBe(404);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run test/routes/collect.test.ts -t submit`
Expected: FAIL — submit hits the catch-all 404 (no route yet).

- [ ] **Step 3: Add imports + the submit scope**

At the top of `collect.ts` add:

```ts
import { unlink } from 'node:fs/promises';
import { MAX_FILE_BYTES, COLLECTION_MAX_FILES_PER_RESPONSE, MAX_NOTE_LENGTH } from '../config.js';
import { sanitizeNodeName } from '../util/names.js';
import { commitResponse, responseHeadroom, QuotaExceededError, type StagedFile } from '../collections/responses.js';
```

Add submit rate-limit constants above `collectRoutes` (tightest — writes):

```ts
const SUBMIT_IP_RATE_LIMIT_MAX = 20;
const SUBMIT_TOKEN_RATE_LIMIT_MAX = 40;
const SUBMIT_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
```

Inside `collectRoutes`, after the template scope, add the submit scope:

```ts
  // --- POST submit (the inbound write; rate-limited per-IP AND per-token) --
  await app.register(async function collectSubmitScope(scope) {
    await scope.register(fastifyRateLimit, {
      max: SUBMIT_IP_RATE_LIMIT_MAX, timeWindow: SUBMIT_RATE_LIMIT_WINDOW_MS,
      hook: 'preHandler', keyGenerator: (req) => req.ip,
    });
    await scope.register(fastifyRateLimit, {
      max: SUBMIT_TOKEN_RATE_LIMIT_MAX, timeWindow: SUBMIT_RATE_LIMIT_WINDOW_MS,
      hook: 'preHandler', keyGenerator: (req) => (req.params as { token?: string }).token ?? '',
    });

    scope.post('/api/collect/:token/submit', async (req, reply) => {
      const { token } = req.params as { token: string };

      // Content-type gate FIRST (before any token lookup) — a non-multipart
      // probe gets 415 regardless of token validity (no oracle). The 415-lesson
      // analog: the submit body is only ever multipart/form-data.
      if (!req.isMultipart()) {
        reply.code(415).send({ error: 'unsupported_media_type' });
        return;
      }

      const c = loadByToken(token);
      if (!c || collectionStatus(c, now()) !== 'open') {
        reply.code(404).send({ error: 'not_found' });
        return;
      }
      if (!requireUnlocked(req, reply, c)) return;

      const ownerId = c.owner_id;
      const staged: StagedFile[] = [];
      const cleanupTemps = async () => {
        await Promise.all(staged.map((s) => unlink(s.tempPath).catch(() => {})));
      };

      let departmentId: number | null = null;
      let note: string | null = null;
      let tooManyFiles = false;
      let tooLarge = false;

      // --- Phase A: stream every file part to temp; capture fields. No DB
      //     writes yet. Per-request multipart limits cap the part count so a
      //     flood can't run the loop unbounded (files cap is MAX+1 so our own
      //     count check below produces the clean neutral rejection first). ---
      try {
        const parts = req.parts({
          limits: {
            fileSize: MAX_FILE_BYTES,
            files: COLLECTION_MAX_FILES_PER_RESPONSE + 1,
            fields: 10,
            fieldSize: MAX_NOTE_LENGTH + 256,
          },
        });
        for await (const part of parts) {
          if (part.type === 'file') {
            if (staged.length >= COLLECTION_MAX_FILES_PER_RESPONSE) {
              tooManyFiles = true;
              part.file.resume(); // drain the offending part
              break;
            }
            const name = sanitizeNodeName(part.filename) ?? 'file';
            const written = await blobStore.writeStreamToTemp(String(ownerId), part.file, MAX_FILE_BYTES);
            // @fastify/multipart truncates at fileSize instead of erroring, so
            // writeStreamToTemp resolves at exactly MAX_FILE_BYTES — `truncated`
            // is the only over-limit signal (mirrors routes/nodes.ts finding #3).
            if (part.file.truncated) {
              await unlink(written.tempPath).catch(() => {});
              tooLarge = true;
              break;
            }
            staged.push({ name, tempPath: written.tempPath, bytes: written.bytes, mimeType: part.mimetype ?? null });
          } else if (part.fieldname === 'departmentId') {
            const n = Number(part.value);
            if (Number.isInteger(n)) departmentId = n;
          } else if (part.fieldname === 'note') {
            const v = String(part.value).replace(/\0/g, '').trim();
            note = v.length > 0 ? v.slice(0, MAX_NOTE_LENGTH) : null;
          }
        }
      } catch (err) {
        await cleanupTemps();
        req.log.warn({ err }, 'collection submit multipart parse failed');
        reply.code(400).send({ error: 'invalid_upload' });
        return;
      }

      if (tooManyFiles) {
        await cleanupTemps();
        reply.code(400).send({ error: 'too_many_files' });
        return;
      }
      if (tooLarge) {
        await cleanupTemps();
        reply.code(413).send({ error: 'file_too_large' });
        return;
      }
      if (staged.length === 0) {
        await cleanupTemps();
        reply.code(400).send({ error: 'no_files' });
        return;
      }

      // --- Validate the self-identified department belongs to THIS collection.
      const dept =
        departmentId === null
          ? undefined
          : (db
              .prepare('SELECT id, name FROM collection_departments WHERE id = @id AND collection_id = @c')
              .get({ id: departmentId, c: c.id }) as { id: number; name: string } | undefined);
      if (!dept) {
        await cleanupTemps();
        reply.code(404).send({ error: 'not_found' });
        return;
      }

      // --- Early quota abort (advisory; the authoritative atomic reserve is in
      //     commitResponse). Accounts for the prior set that replace will free. ---
      const headroom = responseHeadroom(db, ownerId, c.id, dept.id);
      const total = staged.reduce((sum, f) => sum + f.bytes, 0);
      if (headroom !== null && total > headroom) {
        await cleanupTemps();
        reply.code(413).send({ error: 'quota_exceeded' });
        return;
      }

      // --- Phase B: commit (transactional). On quota failure nothing persists. ---
      let result;
      try {
        result = commitResponse(db, ownerId, { id: c.id, folder_node_id: c.folder_node_id }, dept, staged, note, req.ip, now());
      } catch (e) {
        await cleanupTemps();
        if (e instanceof QuotaExceededError) {
          reply.code(413).send({ error: 'quota_exceeded' });
          return;
        }
        throw e;
      }

      // --- Move new blobs into place; unlink the superseded set. (Row-first:
      //     the rows already carry their final storage_path.) A commitTemp
      //     failure here leaves a row whose blob is still at its temp name
      //     (a reverse-orphan → the file reads as gone), logged not fatal. ---
      for (const cf of result.committed) {
        try {
          blobStore.commitTemp(cf.tempPath, String(ownerId), String(cf.nodeId));
        } catch (err) {
          req.log.error({ err, nodeId: cf.nodeId }, 'collection response commitTemp failed');
        }
      }
      for (const p of result.removedStoragePaths) {
        blobStore.deleteBlob(p);
      }

      writeAudit(
        db,
        {
          actorId: null,
          action: 'collection_response_submitted',
          target: token,
          detail: JSON.stringify({ collection_id: c.id, department_id: dept.id, department_name: dept.name, file_count: staged.length }),
        },
        now
      );

      reply.code(200).send({ ok: true });
    });
  });
```

- [ ] **Step 4: Run the full collect suite + typecheck**

Run: `cd server && npx vitest run test/routes/collect.test.ts && npm run typecheck`
Expected: PASS (all meta/unlock/template/submit tests) + typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/collect.ts server/test/routes/collect.test.ts
git commit -m "feat(collections): public submit route — inbound write with all §8/§9 guards"
```

---

## Task 7: SPA shell at `/c/*`

Serve the built SPA's `index.html` for `/c/<token>` GETs (so the Phase-3 React uploader page can client-route), with `Referrer-Policy: no-referrer` on the HTML document — parity with the existing `/s/<token>` share shell.

**Files:**
- Modify: `server/src/app.ts` (the `setNotFoundHandler` branch)
- Test: `server/test/app.test.ts` (append)

**Interfaces:**
- Consumes: nothing new. The not-found handler already serves `index.html` for any non-`/api/` GET when `distExists`; this only adds `/c/` to the explicit `Referrer-Policy` branch (helmet already sets that header globally — this is parity/self-documentation).

- [ ] **Step 1: Write the failing test (append to `app.test.ts`, in the `/s/` section)**

```ts
test('GET /c/<token> (dist present) -> 200 HTML shell with Referrer-Policy: no-referrer', async () => {
  const built = await makeApp({ webDist: makeDistDir() });
  const res = await built.inject({ method: 'GET', url: '/c/anycollecttoken123' });
  expect(res.statusCode).toBe(200);
  expect(res.body).toContain(SPA_MARKER);
  expect(res.headers['referrer-policy']).toBe('no-referrer');
});
```

*(`makeDistDir` and `SPA_MARKER` already exist in `app.test.ts` from the `/s/` tests.)*

- [ ] **Step 2: Run to verify it passes-by-accident or fails**

Run: `cd server && npx vitest run test/app.test.ts -t "/c/"`
Expected: likely PASS already (helmet sets `Referrer-Policy` globally and the catch-all serves `index.html` for any non-`/api/` GET). If it PASSES, that confirms the behavior; still add the explicit branch in Step 3 for parity and commit. If it FAILS on the header, Step 3 fixes it.

- [ ] **Step 3: Add `/c/` to the explicit branch in `app.ts`**

In `setNotFoundHandler`, extend the `/s/` special-case:

```ts
    if (distExists && req.method === 'GET') {
      if (pathname.startsWith('/s/') || pathname.startsWith('/c/')) {
        reply.header('Referrer-Policy', 'no-referrer');
      }
      reply.sendFile('index.html');
      return;
    }
```

Also update the block comment above `setNotFoundHandler` to mention `/c/<token>` alongside `/s/<token>` as a token-bearing shell path.

- [ ] **Step 4: Run to verify pass**

Run: `cd server && npx vitest run test/app.test.ts && npm run typecheck`
Expected: PASS + typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/app.ts server/test/app.test.ts
git commit -m "feat(collections): serve the SPA shell at /c/<token> (no-referrer)"
```

---

## Phase-completion verification (after all tasks)

Run the FULL server suite + typecheck (not just the collect files) and confirm green, then follow `superpowers:finishing-a-development-branch` to checkpoint (do NOT merge — `feedback_phase_pause`):

```bash
cd /var/www/projects/mirsal/server && npm test && npm run typecheck
```

Expected: all tests pass (Phase-1's 392 + the ~25 new Phase-2 tests), tsc clean. Then STOP and report to the user for review before Phase 3 (frontend). Update memory `project_mirsal_collections.md` with the Phase-2 build state (branch/commit range, test counts, CARRYs).

## Self-review — spec coverage

- §7.2 meta → Task 2. §7.2 unlock → Task 3. §7.2 template → Task 4. §7.2 submit / §8 submit flow / §9 security → Tasks 5 (model) + 6 (route). §10 `/c/*` SPA shell wiring → Task 2 (route registration) + Task 7 (shell). §11 server tests → each task's tests (migration/model/public-meta/submit-guards/latest-replaces/password/audit/constant-shape/content-type all covered; **rate-limit is configured per §9 but not asserted with a dedicated over-limit test to keep the suite fast — a deliberate, flagged gap, same posture the existing public.ts scopes take**). §6 migration → already shipped Phase 1 (no Phase-2 change). Frontend uploader UI (§10 uploader, bilingual) and whole-collection E2E → **Phase 3/4, out of scope here.**

## CARRYs → Phase 3/4 (flag to user)

- `sanitizeNodeName` now lives in both `routes/nodes.ts` (private) and `util/names.ts` (new). A future cleanup can DRY `nodes.ts` onto `util/names.ts` (behavior identical, covered by `nodes.test.ts`) — deferred to avoid touching the deployed upload path mid-feature.
- Rate-limit scopes are configured (per-IP + per-token on unlock/template/submit) but not asserted by a dedicated over-limit test (kept out for suite speed); consider one focused test if desired.
- `commitTemp` failure after the response transaction commits is logged, not compensated (leaves a reverse-orphan row → the file reads as gone; quota slightly over-counts). Rare fs failure; matches the codebase's existing reverse-orphan tolerance. Revisit only if it surfaces.
- Early quota abort (`responseHeadroom`) is advisory; the atomic guarantee is `commitResponse`'s `reserve`. Both are in place (belt-and-suspenders).
- Deploy (pre-deploy DB snapshot for the v3→v4 migration, `docker compose build && up -d`, live `schema_version=4` + HTTPS chain + headless `/c/<token>` render) is **Phase 4**, not this phase.
