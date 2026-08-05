# Collections — Phase 1 (Data + Owner API) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the data layer (three new tables via a v3→v4 migration) and the authenticated owner-facing API for **Collections (طلب تجميع)** — create a collection, manage its department roster, view the responded/missing roster, and delete it. No public/uploader surface and no file-submission yet (Phase 2).

**Architecture:** Mirror the existing `shares` feature exactly. A `collections/` domain module (pure DB functions, no HTTP) + a `routes/collections.ts` Fastify plugin registered in `app.ts`. Collection responses are ordinary `nodes` file rows under an owner-owned folder, so download/quota/ZIP are reused untouched (those come in Phase 2). This phase only creates the tables and the owner CRUD.

**Tech Stack:** TypeScript (ESM, `NodeNext`, strict) · Fastify 5 · better-sqlite3 (synchronous) · Zod 4 · vitest 4 · argon2 (via the shared `hashPassword`).

## Global Constraints

Every task's requirements implicitly include these (copied from the spec + verified in code):

- **Module system:** ESM with `NodeNext`; **every relative import ends in `.js`** (e.g. `from '../audit.js'`) even though the source is `.ts`. TS strict.
- **better-sqlite3 is synchronous.** Never `await` inside a `db.transaction(() => …)` callback. Any argon2 password hashing (`await hashPassword`) happens **before** opening a transaction (see `createShare` precedent).
- **Passwords:** hash via the bare `hashPassword` export from `../auth/passwords.js` (bound to the shared, semaphore-limited service). Never store or echo a plaintext or a hash.
- **Owner-scoping / no oracle:** every query filters `owner_id = req.user!.id`. A missing **or** foreign resource returns **404** (never 403), identical shape `{ error: 'not_found' }`.
- **Tokens:** `randomToken(32)` from `../util/ids.js` → URL-safe base64url, ≥43 chars. This token IS the public URL; stored in plaintext, looked up directly (never hashed — unlike session tokens).
- **Timestamps:** epoch-ms via the injected `now: Clock`. Never call `Date.now()` in domain/route code — use the injected clock.
- **Validation:** Zod `safeParse`; on failure `reply.code(400).send({ error: 'invalid_body' })`.
- **Auth guard:** every route uses `preHandler: guards.requireAuth` (this also enforces the CSRF double-submit on POST/PATCH/DELETE).
- **Audit:** `writeAudit(db, { actorId, action, target, detail }, now)` from `../audit.js`. `now` is passed as the **Clock function**, not `now()`. Never put secrets/tokens-as-secrets in `detail`.
- **Migration:** additive, **create-only** (no ALTER/DROP). Bump `LATEST_VERSION`; add the DDL to **both** `schema.sql` (fresh DBs) and a new `STEPS` entry (existing DBs). Live production DB is at `schema_version = 3`.
- **Quality gates (run from the workspace):** `cd server && npm run typecheck && npm test`. **There is no eslint/`lint` script — do not run `npm run lint` (it does not exist).**
- **Commits:** one per task on branch `feat/collections`; the repo's `post-commit` hook auto-pushes to origin. Use the `Co-Authored-By` trailer the repo uses.

**Arabic copy** used by this phase (owner app is Arabic-only, but Phase 1 has almost no user-visible strings — the folder name is the only one):

- Collection folder name prefix: `طلب تجميع: ` (note trailing space), e.g. `طلب تجميع: تقرير الربع الأول`.

---

### Task 1: Migration v4 — three collections tables

**Files:**

- Modify: `server/src/db/schema.sql` (append three `CREATE TABLE` + indexes)
- Modify: `server/src/db/migrate.ts` (`LATEST_VERSION = 4`; add a `{ version: 4, up }` step)
- Test: `server/test/db/migrate.test.ts` (add a v4 `describe`; update existing terminal-version assertions)

**Interfaces:**

- Produces: three tables — `collections`, `collection_departments`, `collection_responses` — plus indexes `ix_collections_owner`, `ix_collection_responses_collection`. Consumed by every later task.

- [ ] **Step 1: Write the failing test** — append to `server/test/db/migrate.test.ts` (after the existing v3 describe block):

```ts
function tableNames(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
    (r) => r.name,
  );
}

describe('migrate v4 collections tables', () => {
  it('a fresh DB has the three collections tables and lands at version 4', () => {
    const db = new Database(':memory:');
    migrate(db);
    const names = tableNames(db);
    expect(names).toEqual(expect.arrayContaining(['collections', 'collection_departments', 'collection_responses']));
    expect((db.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }).v).toBe(4);
  });

  it('adds the three tables to a v3 DB and records version 4', () => {
    const db = new Database(':memory:');
    // v3 baseline: has users (+display_name) and shares, version row = 3.
    db.exec(V1_SHARES);
    db.exec(V2_USERS);
    db.exec('ALTER TABLE users ADD COLUMN display_name TEXT');
    db.exec('ALTER TABLE shares ADD COLUMN download_limit INTEGER');
    db.exec('ALTER TABLE shares ADD COLUMN download_count INTEGER NOT NULL DEFAULT 0');
    db.exec("ALTER TABLE shares ADD COLUMN on_exhaust TEXT NOT NULL DEFAULT 'delete'");
    db.exec('CREATE TABLE schema_version(version INTEGER NOT NULL, applied_at INTEGER NOT NULL)');
    db.prepare('INSERT INTO schema_version(version, applied_at) VALUES (3, 0)').run();
    migrate(db);
    expect(tableNames(db)).toEqual(
      expect.arrayContaining(['collections', 'collection_departments', 'collection_responses']),
    );
    expect((db.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }).v).toBe(4);
  });

  it('fresh and upgraded collections schemas converge (identical sqlite_master DDL)', () => {
    const fresh = new Database(':memory:');
    migrate(fresh);
    const upgraded = new Database(':memory:');
    upgraded.exec(V1_SHARES);
    upgraded.exec(V1_USERS);
    upgraded.exec('CREATE TABLE schema_version(version INTEGER NOT NULL, applied_at INTEGER NOT NULL)');
    upgraded.prepare('INSERT INTO schema_version(version, applied_at) VALUES (1, 0)').run();
    migrate(upgraded);
    const ddl = (db: Database.Database) =>
      (
        db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE name IN ('collections','collection_departments','collection_responses') ORDER BY name",
          )
          .all() as { sql: string }[]
      ).map((r) => r.sql);
    expect(ddl(fresh)).toEqual(ddl(upgraded));
  });

  it('is idempotent at v4', () => {
    const db = new Database(':memory:');
    migrate(db);
    expect(() => {
      migrate(db);
      migrate(db);
    }).not.toThrow();
    expect((db.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }).v).toBe(4);
  });
});
```

Then **update the existing terminal-version assertions** in this file: every occurrence of `.v).toBe(3)` (there are 6 — in the `migrate v2` and `migrate v3` describe blocks, all asserting `MAX(version)` = the latest version) becomes `.v).toBe(4)`. Leave the `COUNT(*) … .c).toBe(1)` idempotency assertion untouched. (Reword the three v3-block test titles that say "version 3"/"at v3" to "the latest version" if desired — cosmetic.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/db/migrate.test.ts`
Expected: FAIL — the new v4 tests fail (`collections` table absent; `MAX(version)` is 3), and the six edited `.toBe(4)` assertions fail.

- [ ] **Step 3: Implement — append the DDL to `schema.sql`** (after the `share_access_log` table, at the end of the file):

```sql
CREATE TABLE IF NOT EXISTS collections(
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,                    -- 32-byte CSPRNG, URL-safe (public URL)
  title TEXT NOT NULL,
  template_node_id INTEGER REFERENCES nodes(id) ON DELETE SET NULL,  -- NULL = no template
  folder_node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, -- the collection's Drive folder
  password_hash TEXT,                            -- NULL = no password
  is_active INTEGER NOT NULL DEFAULT 1,          -- owner open/close toggle
  deadline_at INTEGER,                           -- NULL = no deadline; <= now => closed (request-time)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_collections_owner ON collections(owner_id);

CREATE TABLE IF NOT EXISTS collection_departments(
  id INTEGER PRIMARY KEY,
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(collection_id, name)
);

CREATE TABLE IF NOT EXISTS collection_responses(
  id INTEGER PRIMARY KEY,
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  department_id INTEGER NOT NULL REFERENCES collection_departments(id) ON DELETE CASCADE,
  folder_node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, -- the department's response subfolder
  note TEXT,
  submitted_at INTEGER NOT NULL,
  submitted_ip TEXT
);
-- NAMED unique index (not an inline UNIQUE) so fresh (schema.sql) and upgraded
-- (migration up) DBs produce byte-identical DDL — an inline UNIQUE would emit a
-- divergent auto-named index. One-response-per-department lives here.
CREATE UNIQUE INDEX IF NOT EXISTS ux_collection_response_dept
  ON collection_responses(collection_id, department_id);
CREATE INDEX IF NOT EXISTS ix_collection_responses_collection ON collection_responses(collection_id);
```

Then **edit `migrate.ts`:** change `export const LATEST_VERSION = 3;` → `= 4;` and append this step to the `STEPS` array (after the `version: 3` step). The `up` body must be the **exact same DDL** as above so fresh and upgraded DBs converge:

```ts
  {
    version: 4,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS collections(
          id INTEGER PRIMARY KEY,
          owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token TEXT UNIQUE NOT NULL,
          title TEXT NOT NULL,
          template_node_id INTEGER REFERENCES nodes(id) ON DELETE SET NULL,
          folder_node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
          password_hash TEXT,
          is_active INTEGER NOT NULL DEFAULT 1,
          deadline_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_collections_owner ON collections(owner_id);
        CREATE TABLE IF NOT EXISTS collection_departments(
          id INTEGER PRIMARY KEY,
          collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          position INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          UNIQUE(collection_id, name)
        );
        CREATE TABLE IF NOT EXISTS collection_responses(
          id INTEGER PRIMARY KEY,
          collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
          department_id INTEGER NOT NULL REFERENCES collection_departments(id) ON DELETE CASCADE,
          folder_node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
          note TEXT,
          submitted_at INTEGER NOT NULL,
          submitted_ip TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ux_collection_response_dept ON collection_responses(collection_id, department_id);
        CREATE INDEX IF NOT EXISTS ix_collection_responses_collection ON collection_responses(collection_id);
      `);
    },
  },
```

**Convergence note (important):** an inline `UNIQUE(collection_id, department_id)` in `schema.sql` produces an auto-named index (`sqlite_autoindex_*`), while a migration cannot restate the table — so for the `collection_responses` uniqueness, use a **named** `CREATE UNIQUE INDEX ux_collection_response_dept` in **both** `schema.sql` (replace the inline `UNIQUE(...)` line with the table having no inline unique, then add the `CREATE UNIQUE INDEX` after it) **and** the migration `up`, so fresh and upgraded schemas are byte-identical. Apply the same for any other constraint that would otherwise auto-name. (The `collection_departments` `UNIQUE(collection_id, name)` is fine to keep inline since both fresh and upgraded go through identical `CREATE TABLE` text.)

Concretely, in `schema.sql` the `collection_responses` table should read **without** the inline `UNIQUE(...)`, followed by:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS ux_collection_response_dept
  ON collection_responses(collection_id, department_id);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/db/migrate.test.ts`
Expected: PASS (all v4 tests green; the six updated `.toBe(4)` assertions pass; convergence identical).

Then run the whole suite to confirm nothing else keyed on version 3: `cd server && npm test`
Expected: PASS (any test asserting the terminal version was updated in Step 1).

- [ ] **Step 5: Commit**

```bash
git add server/src/db/schema.sql server/src/db/migrate.ts server/test/db/migrate.test.ts
git commit -m "feat(collections): v4 migration — collections, departments, responses tables

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `collections.ts` model — `Collection`, `collectionStatus`, `createCollection`, `getCollection`

**Files:**

- Create: `server/src/collections/collections.ts`
- Test: `server/test/collections/collections.test.ts`

**Interfaces:**

- Consumes: `randomToken` (`util/ids.js`), `hashPassword` (`auth/passwords.js`), `ensureUserRoots` (`nodes/tree.js`), `nextSuffixedName` (`nodes/collisions.js`).
- Produces:
  - `interface Collection` — verbatim row (see code).
  - `collectionStatus(c: Pick<Collection,'is_active'|'deadline_at'>, now: number): 'open'|'closed'|'expired'`
  - `normalizeDepartments(input: string[]): string[]` (trim, drop empty, dedupe, order-preserving)
  - `createCollection(db, ownerId: number, options: CreateCollectionOptions, now: number): Promise<Collection>`
  - `getCollection(db, ownerId: number, collectionId: number): Collection | undefined`
  - `interface CreateCollectionOptions { title; departments; templateNodeId?; password?; deadlineAt? }`

- [ ] **Step 1: Write the failing test** — create `server/test/collections/collections.test.ts`. Use the model-test harness from `test/shares/shares.test.ts` (openDb+migrate per test; env vars for the lazy password service; a `seedUser()` that inserts a user row; a `seedFileNode()` that inserts a live file under root).

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { ensureUserRoots } from '../../src/nodes/tree.js';
import { verifyPassword } from '../../src/auth/passwords.js';
import {
  createCollection,
  getCollection,
  collectionStatus,
  normalizeDepartments,
} from '../../src/collections/collections.js';

let db: Database.Database | undefined;
let dir: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-col-'));
  db = openDb(path.join(dir, 't.db'));
  migrate(db);
});
afterEach(() => {
  db?.close();
  db = undefined;
  if (dir) {
    fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

const keys = ['DB_PATH', 'STORAGE_DIR', 'SESSION_SECRET', 'CSRF_SECRET', 'PUBLIC_BASE_URL'] as const;
const originals: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of keys) originals[k] = process.env[k];
  process.env.DB_PATH = '/tmp/mirsal-test/db.sqlite';
  process.env.STORAGE_DIR = '/tmp/mirsal-test/storage';
  process.env.SESSION_SECRET = 'a'.repeat(32);
  process.env.CSRF_SECRET = 'b'.repeat(32);
  process.env.PUBLIC_BASE_URL = 'https://mirsal.example.com';
});
afterAll(() => {
  for (const k of keys) originals[k] === undefined ? delete process.env[k] : (process.env[k] = originals[k]!);
});

function seedUser(): number {
  const t = Date.now();
  const info = db!
    .prepare(
      `INSERT INTO users(username, password_hash, role, is_active, must_change_password, created_at, updated_at)
       VALUES (?, 'x', 'user', 1, 0, ?, ?)`,
    )
    .run(`user-${Math.random()}`, t, t);
  return Number(info.lastInsertRowid);
}
function seedFileNode(uid: number, now: number, trashedAt: number | null = null): number {
  const { rootId } = ensureUserRoots(db!, uid, now);
  const info = db!
    .prepare(
      `INSERT INTO nodes(owner_id, parent_id, kind, name, size_bytes, storage_path, trashed_at, created_at, updated_at)
       VALUES (@ownerId, @parentId, 'file', @name, 5, 'u/1', @trashedAt, @now, @now)`,
    )
    .run({ ownerId: uid, parentId: rootId, name: `f-${Math.random()}`, trashedAt, now });
  return Number(info.lastInsertRowid);
}

// --- collectionStatus (pure) ---
test('collectionStatus: closed beats expired beats open', () => {
  const now = 1000;
  expect(collectionStatus({ is_active: 0, deadline_at: null }, now)).toBe('closed');
  expect(collectionStatus({ is_active: 0, deadline_at: 500 }, now)).toBe('closed'); // closed wins
  expect(collectionStatus({ is_active: 1, deadline_at: 500 }, now)).toBe('expired');
  expect(collectionStatus({ is_active: 1, deadline_at: 5000 }, now)).toBe('open');
  expect(collectionStatus({ is_active: 1, deadline_at: null }, now)).toBe('open');
});

// --- normalizeDepartments (pure) ---
test('normalizeDepartments trims, drops empties, dedupes, preserves order', () => {
  expect(normalizeDepartments([' HR ', 'HR', '', '  ', 'Finance', 'Finance'])).toEqual(['HR', 'Finance']);
});

// --- createCollection ---
test('createCollection: token >= 43, is_active=1, folder under root, departments positioned', async () => {
  const uid = seedUser();
  const now = 1_700_000_000_000;
  const { rootId } = ensureUserRoots(db!, uid, now);

  const c = await createCollection(db!, uid, { title: 'تقرير الربع الأول', departments: ['HR', 'Finance', 'IT'] }, now);

  expect(c.token.length).toBeGreaterThanOrEqual(43);
  expect(c.is_active).toBe(1);
  expect(c.password_hash).toBeNull();
  expect(c.deadline_at).toBeNull();
  expect(c.owner_id).toBe(uid);

  const folder = db!.prepare('SELECT parent_id, kind, name FROM nodes WHERE id = ?').get(c.folder_node_id) as {
    parent_id: number;
    kind: string;
    name: string;
  };
  expect(folder.parent_id).toBe(rootId);
  expect(folder.kind).toBe('folder');
  expect(folder.name).toBe('طلب تجميع: تقرير الربع الأول');

  const depts = db!
    .prepare('SELECT name, position FROM collection_departments WHERE collection_id = ? ORDER BY position')
    .all(c.id) as { name: string; position: number }[];
  expect(depts).toEqual([
    { name: 'HR', position: 0 },
    { name: 'Finance', position: 1 },
    { name: 'IT', position: 2 },
  ]);
});

test('createCollection with a password: hashed and verifies; empty password => no hash', async () => {
  const uid = seedUser();
  const now = Date.now();
  const c = await createCollection(db!, uid, { title: 'T', departments: ['A'], password: 'secret' }, now);
  expect(c.password_hash).not.toBeNull();
  await expect(verifyPassword(c.password_hash!, 'secret')).resolves.toBe(true);

  const c2 = await createCollection(db!, uid, { title: 'U', departments: ['A'], password: '' }, now);
  expect(c2.password_hash).toBeNull();
});

test('createCollection accepts a valid template file; rejects foreign/trashed/folder', async () => {
  const uid = seedUser();
  const other = seedUser();
  const now = Date.now();
  const good = seedFileNode(uid, now);
  const c = await createCollection(db!, uid, { title: 'T', departments: ['A'], templateNodeId: good }, now);
  expect(c.template_node_id).toBe(good);

  const foreign = seedFileNode(other, now);
  await expect(
    createCollection(db!, uid, { title: 'T2', departments: ['A'], templateNodeId: foreign }, now),
  ).rejects.toThrow('bad_template');

  const trashed = seedFileNode(uid, now, now);
  await expect(
    createCollection(db!, uid, { title: 'T3', departments: ['A'], templateNodeId: trashed }, now),
  ).rejects.toThrow('bad_template');

  const { rootId } = ensureUserRoots(db!, uid, now); // a folder is not a file
  await expect(
    createCollection(db!, uid, { title: 'T4', departments: ['A'], templateNodeId: rootId }, now),
  ).rejects.toThrow('bad_template');
});

test('createCollection rejects an all-empty department list', async () => {
  const uid = seedUser();
  await expect(createCollection(db!, uid, { title: 'T', departments: ['', '  '] }, Date.now())).rejects.toThrow(
    'no_departments',
  );
});

test('createCollection dedupes duplicate department names', async () => {
  const uid = seedUser();
  const c = await createCollection(db!, uid, { title: 'T', departments: ['HR', 'HR', 'Finance'] }, Date.now());
  const count = db!.prepare('SELECT COUNT(*) c FROM collection_departments WHERE collection_id = ?').get(c.id) as {
    c: number;
  };
  expect(count.c).toBe(2);
});

test('createCollection twice with the same title auto-suffixes the folder (no collision)', async () => {
  const uid = seedUser();
  const now = Date.now();
  const a = await createCollection(db!, uid, { title: 'Same', departments: ['A'] }, now);
  const b = await createCollection(db!, uid, { title: 'Same', departments: ['A'] }, now);
  const nameA = (db!.prepare('SELECT name FROM nodes WHERE id = ?').get(a.folder_node_id) as { name: string }).name;
  const nameB = (db!.prepare('SELECT name FROM nodes WHERE id = ?').get(b.folder_node_id) as { name: string }).name;
  expect(nameA).toBe('طلب تجميع: Same');
  expect(nameB).toBe('طلب تجميع: Same (1)');
});

// --- getCollection (owner-scoped) ---
test('getCollection is owner-scoped', async () => {
  const uid = seedUser();
  const other = seedUser();
  const c = await createCollection(db!, uid, { title: 'T', departments: ['A'] }, Date.now());
  expect(getCollection(db!, uid, c.id)?.id).toBe(c.id);
  expect(getCollection(db!, other, c.id)).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/collections/collections.test.ts`
Expected: FAIL — `Cannot find module '../../src/collections/collections.js'`.

- [ ] **Step 3: Write minimal implementation** — create `server/src/collections/collections.ts`:

```ts
import type Database from 'better-sqlite3';
import { randomToken } from '../util/ids.js';
import { hashPassword } from '../auth/passwords.js';
import { ensureUserRoots } from '../nodes/tree.js';
import { nextSuffixedName } from '../nodes/collisions.js';

/** Prefix for the auto-created Drive folder that holds a collection's responses. */
export const COLLECTION_FOLDER_PREFIX = 'طلب تجميع: ';

/** Mirrors a row of the `collections` table verbatim. */
export interface Collection {
  id: number;
  owner_id: number;
  token: string;
  title: string;
  template_node_id: number | null;
  folder_node_id: number;
  password_hash: string | null;
  is_active: number;
  deadline_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface CreateCollectionOptions {
  title: string;
  /** Raw list; normalized (trim/drop-empty/dedupe) internally. Must yield ≥1. */
  departments: string[];
  /** Owner-owned live file node id, or null/undefined for no template. */
  templateNodeId?: number | null;
  /** Non-empty string => hashed; null/undefined/'' => no password. */
  password?: string | null;
  /** epoch-ms deadline; null/undefined => no deadline. */
  deadlineAt?: number | null;
}

/**
 * Pure status: `is_active = 0` → 'closed' (checked first); else a past
 * `deadline_at` → 'expired'; else 'open'. Mirrors shares' `ownerStatus`.
 */
export function collectionStatus(
  c: Pick<Collection, 'is_active' | 'deadline_at'>,
  now: number,
): 'open' | 'closed' | 'expired' {
  if (!c.is_active) return 'closed';
  if (c.deadline_at != null && c.deadline_at < now) return 'expired';
  return 'open';
}

/** Trim, drop empties, dedupe (case-sensitive), preserve first-seen order. */
export function normalizeDepartments(input: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const name = raw.trim();
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Creates a collection owned by `ownerId`: an auto-named response folder under
 * the owner's root, a URL-safe token, and one `collection_departments` row per
 * normalized name. Throws `Error('invalid_title')`, `Error('no_departments')`,
 * or `Error('bad_template')` (template must be an owner-owned, live, `file`
 * node). Password (if a non-empty string) is hashed BEFORE the transaction
 * (better-sqlite3 transactions are synchronous). The folder name is suffixed
 * via `nextSuffixedName` inside the txn so duplicate titles never collide.
 */
export async function createCollection(
  db: Database.Database,
  ownerId: number,
  options: CreateCollectionOptions,
  now: number,
): Promise<Collection> {
  const title = options.title.trim();
  if (title.length === 0) throw new Error('invalid_title');

  const departments = normalizeDepartments(options.departments);
  if (departments.length === 0) throw new Error('no_departments');

  const templateNodeId = options.templateNodeId ?? null;
  if (templateNodeId !== null) {
    const t = db.prepare('SELECT owner_id, kind, trashed_at FROM nodes WHERE id = @id').get({ id: templateNodeId }) as
      { owner_id: number; kind: string; trashed_at: number | null } | undefined;
    if (!t || t.owner_id !== ownerId || t.kind !== 'file' || t.trashed_at !== null) {
      throw new Error('bad_template');
    }
  }

  const { rootId } = ensureUserRoots(db, ownerId, now);
  const passwordHash = options.password && options.password.length > 0 ? await hashPassword(options.password) : null;
  const token = randomToken(32);
  const deadlineAt = options.deadlineAt ?? null;

  const run = db.transaction((): Collection => {
    const folderName = nextSuffixedName(db, rootId, `${COLLECTION_FOLDER_PREFIX}${title}`);
    const folderInfo = db
      .prepare(
        `INSERT INTO nodes(owner_id, parent_id, kind, name, size_bytes, created_at, updated_at)
         VALUES (@ownerId, @rootId, 'folder', @folderName, 0, @now, @now)`,
      )
      .run({ ownerId, rootId, folderName, now });
    const folderNodeId = Number(folderInfo.lastInsertRowid);

    const cInfo = db
      .prepare(
        `INSERT INTO collections(owner_id, token, title, template_node_id, folder_node_id, password_hash, is_active, deadline_at, created_at, updated_at)
         VALUES (@ownerId, @token, @title, @templateNodeId, @folderNodeId, @passwordHash, 1, @deadlineAt, @now, @now)`,
      )
      .run({ ownerId, token, title, templateNodeId, folderNodeId, passwordHash, deadlineAt, now });
    const collectionId = Number(cInfo.lastInsertRowid);

    const insertDept = db.prepare(
      `INSERT INTO collection_departments(collection_id, name, position, created_at)
       VALUES (@collectionId, @name, @position, @now)`,
    );
    departments.forEach((name, i) => insertDept.run({ collectionId, name, position: i, now }));

    return db.prepare('SELECT * FROM collections WHERE id = @id').get({ id: collectionId }) as Collection;
  });

  return run();
}

/** Owner-scoped fetch of one collection row, or undefined. */
export function getCollection(db: Database.Database, ownerId: number, collectionId: number): Collection | undefined {
  return db
    .prepare('SELECT * FROM collections WHERE id = @id AND owner_id = @ownerId')
    .get({ id: collectionId, ownerId }) as Collection | undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/collections/collections.test.ts && npx tsc -p . --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/collections/collections.ts server/test/collections/collections.test.ts
git commit -m "feat(collections): model — createCollection, getCollection, status, normalize

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `collections.ts` model — `listCollections`, `setCollectionState`, `deleteCollection`

**Files:**

- Modify: `server/src/collections/collections.ts` (add three functions + two interfaces)
- Test: `server/test/collections/collections.test.ts` (add cases)

**Interfaces:**

- Consumes: `permanentDelete` (`nodes/trash.js`), `hashPassword` (`auth/passwords.js`).
- Produces:
  - `interface CollectionSummaryRow extends Collection { department_count: number; responded_count: number }`
  - `listCollections(db, ownerId: number): CollectionSummaryRow[]`
  - `interface SetCollectionStatePatch { title?: string; isActive?: boolean; password?: string | null; deadlineAt?: number | null }`
  - `setCollectionState(db, ownerId, collectionId, patch: SetCollectionStatePatch, now): Promise<Collection | undefined>`
  - `deleteCollection(db, ownerId, collectionId): { deleted: boolean; storagePaths: string[] }`

- [ ] **Step 1: Write the failing test** — add to `server/test/collections/collections.test.ts`. (Add imports for the three new functions; add a helper that seeds a response with a real file under a real subfolder.)

```ts
import { listCollections, setCollectionState, deleteCollection } from '../../src/collections/collections.js';

/** Seeds a department response: a subfolder under the collection folder holding `fileBytes` file. */
function seedResponse(
  collectionId: number,
  departmentId: number,
  collectionFolderId: number,
  uid: number,
  now: number,
  fileBytes = 10,
): number {
  const subInfo = db!
    .prepare(
      `INSERT INTO nodes(owner_id, parent_id, kind, name, size_bytes, created_at, updated_at)
              VALUES (@uid, @parent, 'folder', @name, 0, @now, @now)`,
    )
    .run({ uid, parent: collectionFolderId, name: `dept-${departmentId}`, now });
  const subId = Number(subInfo.lastInsertRowid);
  db!
    .prepare(
      `INSERT INTO nodes(owner_id, parent_id, kind, name, size_bytes, storage_path, created_at, updated_at)
               VALUES (@uid, @parent, 'file', @name, @bytes, @sp, @now, @now)`,
    )
    .run({ uid, parent: subId, name: `r-${Math.random()}`, bytes: fileBytes, sp: `${uid}/${Math.random()}`, now });
  db!
    .prepare(
      `INSERT INTO collection_responses(collection_id, department_id, folder_node_id, note, submitted_at)
               VALUES (?, ?, ?, NULL, ?)`,
    )
    .run(collectionId, departmentId, subId, now);
  return subId;
}

test('listCollections returns owner rows newest-first with department + responded counts', async () => {
  const uid = seedUser();
  const now = Date.now();
  const c = await createCollection(db!, uid, { title: 'T', departments: ['A', 'B', 'C'] }, now);
  const deptA = (
    db!.prepare('SELECT id FROM collection_departments WHERE collection_id=? ORDER BY position').get(c.id) as {
      id: number;
    }
  ).id;
  seedResponse(c.id, deptA, c.folder_node_id, uid, now);

  const rows = listCollections(db!, uid);
  expect(rows.length).toBe(1);
  expect(rows[0]).toMatchObject({ id: c.id, department_count: 3, responded_count: 1 });
});

test('setCollectionState updates title/isActive/deadline, clears password with null, bumps updated_at, owner-scoped', async () => {
  const uid = seedUser();
  const other = seedUser();
  const now = 1000;
  const c = await createCollection(db!, uid, { title: 'Old', departments: ['A'], password: 'pw' }, now);

  const u1 = await setCollectionState(db!, uid, c.id, { title: 'New', isActive: false, deadlineAt: 5000 }, 2000);
  expect(u1).toMatchObject({ title: 'New', is_active: 0, deadline_at: 5000 });
  expect(u1!.updated_at).toBe(2000);

  const u2 = await setCollectionState(db!, uid, c.id, { password: null }, 3000);
  expect(u2!.password_hash).toBeNull();

  // Foreign owner cannot touch it.
  const u3 = await setCollectionState(db!, other, c.id, { isActive: true }, 4000);
  expect(u3).toBeUndefined();
  expect(
    (db!.prepare('SELECT is_active FROM collections WHERE id=?').get(c.id) as { is_active: number }).is_active,
  ).toBe(0);
});

test('deleteCollection removes the collection, its folder subtree, departments/responses, and returns blob paths', async () => {
  const uid = seedUser();
  const now = Date.now();
  const c = await createCollection(db!, uid, { title: 'T', departments: ['A'] }, now);
  const deptA = (db!.prepare('SELECT id FROM collection_departments WHERE collection_id=?').get(c.id) as { id: number })
    .id;
  seedResponse(c.id, deptA, c.folder_node_id, uid, now, 42);

  const res = deleteCollection(db!, uid, c.id);
  expect(res.deleted).toBe(true);
  expect(res.storagePaths.length).toBe(1);

  expect(db!.prepare('SELECT COUNT(*) c FROM collections WHERE id=?').get(c.id)).toMatchObject({ c: 0 });
  expect(db!.prepare('SELECT COUNT(*) c FROM collection_departments WHERE collection_id=?').get(c.id)).toMatchObject({
    c: 0,
  });
  expect(db!.prepare('SELECT COUNT(*) c FROM collection_responses WHERE collection_id=?').get(c.id)).toMatchObject({
    c: 0,
  });
  expect(db!.prepare('SELECT COUNT(*) c FROM nodes WHERE id=?').get(c.folder_node_id)).toMatchObject({ c: 0 });
});

test('deleteCollection on a foreign/missing collection returns deleted=false', () => {
  const uid = seedUser();
  expect(deleteCollection(db!, uid, 999999)).toEqual({ deleted: false, storagePaths: [] });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/collections/collections.test.ts`
Expected: FAIL — the three new functions are not exported.

- [ ] **Step 3: Write minimal implementation** — append to `server/src/collections/collections.ts`:

```ts
import { permanentDelete } from '../nodes/trash.js';

/** A collection row plus aggregate counts, for the owner list view. */
export interface CollectionSummaryRow extends Collection {
  department_count: number;
  responded_count: number;
}

/** Owner's collections, newest-first, each with department + responded counts. */
export function listCollections(db: Database.Database, ownerId: number): CollectionSummaryRow[] {
  return db
    .prepare(
      `SELECT c.*,
         (SELECT COUNT(*) FROM collection_departments d WHERE d.collection_id = c.id) AS department_count,
         (SELECT COUNT(*) FROM collection_responses r WHERE r.collection_id = c.id) AS responded_count
       FROM collections c
       WHERE c.owner_id = @ownerId
       ORDER BY c.created_at DESC, c.id DESC`,
    )
    .all({ ownerId }) as CollectionSummaryRow[];
}

/** Tri-state patch: omitted key = unchanged; `null` clears password/deadline. */
export interface SetCollectionStatePatch {
  title?: string;
  isActive?: boolean;
  password?: string | null;
  deadlineAt?: number | null;
}

/**
 * Applies `patch` to `collectionId`, scoped to `ownerId`. Always bumps
 * `updated_at`. A string `password` is hashed via the shared service (before
 * the synchronous UPDATE). Returns the updated row, or undefined if no
 * owner-scoped row matched.
 */
export async function setCollectionState(
  db: Database.Database,
  ownerId: number,
  collectionId: number,
  patch: SetCollectionStatePatch,
  now: number,
): Promise<Collection | undefined> {
  const sets: string[] = ['updated_at = @now'];
  const params: Record<string, unknown> = { collectionId, ownerId, now };

  if (patch.title !== undefined) {
    sets.push('title = @title');
    params.title = patch.title.trim();
  }
  if (patch.isActive !== undefined) {
    sets.push('is_active = @isActive');
    params.isActive = patch.isActive ? 1 : 0;
  }
  if (patch.password !== undefined) {
    sets.push('password_hash = @passwordHash');
    params.passwordHash = patch.password === null ? null : await hashPassword(patch.password);
  }
  if (patch.deadlineAt !== undefined) {
    sets.push('deadline_at = @deadlineAt');
    params.deadlineAt = patch.deadlineAt;
  }

  db.prepare(`UPDATE collections SET ${sets.join(', ')} WHERE id = @collectionId AND owner_id = @ownerId`).run(params);

  return db
    .prepare('SELECT * FROM collections WHERE id = @collectionId AND owner_id = @ownerId')
    .get({ collectionId, ownerId }) as Collection | undefined;
}

/**
 * Deletes `collectionId` (owner-scoped) by permanently deleting its response
 * folder subtree — which cascades (via `collections.folder_node_id ON DELETE
 * CASCADE`) to the collection row, its departments, and its responses.
 * Returns the blob `storagePaths` the caller must unlink AFTER the DB commit
 * (mirrors `permanentDelete`; this function never touches the filesystem).
 */
export function deleteCollection(
  db: Database.Database,
  ownerId: number,
  collectionId: number,
): { deleted: boolean; storagePaths: string[] } {
  const row = db
    .prepare('SELECT folder_node_id FROM collections WHERE id = @id AND owner_id = @ownerId')
    .get({ id: collectionId, ownerId }) as { folder_node_id: number } | undefined;
  if (!row) return { deleted: false, storagePaths: [] };

  const { storagePaths } = permanentDelete(db, ownerId, row.folder_node_id);
  return { deleted: true, storagePaths };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/collections/collections.test.ts && npx tsc -p . --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/collections/collections.ts server/test/collections/collections.test.ts
git commit -m "feat(collections): model — list, setState, delete (cascade + blob paths)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `departments.ts` model — add / remove / list / roster

**Files:**

- Create: `server/src/collections/departments.ts`
- Test: `server/test/collections/departments.test.ts`

**Interfaces:**

- Produces:
  - `interface Department { id; collection_id; name; position; created_at }`
  - `class DuplicateDepartmentError extends Error`
  - `listDepartments(db, collectionId): Department[]`
  - `addDepartment(db, ownerId, collectionId, name: string, now): Department` (throws `Error('not_found')` if the collection isn't the owner's, `Error('invalid_name')` on blank, `DuplicateDepartmentError` on a dup name)
  - `removeDepartment(db, ownerId, collectionId, departmentId): 'removed' | 'not_found' | 'has_response'`
  - `interface RosterEntry { id; name; position; responded: boolean; file_count: number; submitted_at: number|null; note: string|null; folder_node_id: number|null }`
  - `getRoster(db, collectionId): RosterEntry[]`

- [ ] **Step 1: Write the failing test** — create `server/test/collections/departments.test.ts` (same harness/`seedUser` as Task 2; import `createCollection` to set up a collection, plus the new functions).

```ts
// … same imports/harness/seedUser as collections.test.ts …
import { createCollection } from '../../src/collections/collections.js';
import {
  addDepartment,
  removeDepartment,
  listDepartments,
  getRoster,
  DuplicateDepartmentError,
} from '../../src/collections/departments.js';

async function mkCollection(uid: number, depts: string[], now = Date.now()) {
  return createCollection(db!, uid, { title: 'T', departments: depts }, now);
}

test('addDepartment appends with the next position; duplicate name throws DuplicateDepartmentError', async () => {
  const uid = seedUser();
  const c = await mkCollection(uid, ['A', 'B']);
  const d = addDepartment(db!, uid, c.id, ' C ', Date.now());
  expect(d).toMatchObject({ name: 'C', position: 2 });
  expect(() => addDepartment(db!, uid, c.id, 'A', Date.now())).toThrow(DuplicateDepartmentError);
});

test('addDepartment on a foreign collection throws not_found; blank name throws invalid_name', async () => {
  const uid = seedUser();
  const other = seedUser();
  const c = await mkCollection(uid, ['A']);
  expect(() => addDepartment(db!, other, c.id, 'X', Date.now())).toThrow('not_found');
  expect(() => addDepartment(db!, uid, c.id, '   ', Date.now())).toThrow('invalid_name');
});

test('removeDepartment removes a response-less department; foreign => not_found', async () => {
  const uid = seedUser();
  const other = seedUser();
  const c = await mkCollection(uid, ['A', 'B']);
  const b = listDepartments(db!, c.id).find((d) => d.name === 'B')!;
  expect(removeDepartment(db!, other, c.id, b.id)).toBe('not_found');
  expect(removeDepartment(db!, uid, c.id, b.id)).toBe('removed');
  expect(listDepartments(db!, c.id).some((d) => d.name === 'B')).toBe(false);
});

test('removeDepartment refuses a department that already has a response', async () => {
  const uid = seedUser();
  const now = Date.now();
  const c = await mkCollection(uid, ['A']);
  const a = listDepartments(db!, c.id)[0];
  // seed a response subfolder + row for dept A
  const sub = Number(
    db!
      .prepare(
        `INSERT INTO nodes(owner_id,parent_id,kind,name,size_bytes,created_at,updated_at)
    VALUES (?,?,'folder','A',0,?,?)`,
      )
      .run(uid, c.folder_node_id, now, now).lastInsertRowid,
  );
  db!
    .prepare(
      `INSERT INTO collection_responses(collection_id,department_id,folder_node_id,note,submitted_at)
    VALUES (?,?,?,NULL,?)`,
    )
    .run(c.id, a.id, sub, now);
  expect(removeDepartment(db!, uid, c.id, a.id)).toBe('has_response');
});

test('getRoster lists every department, marks responded + file_count, ordered by position', async () => {
  const uid = seedUser();
  const now = Date.now();
  const c = await mkCollection(uid, ['A', 'B']);
  const [a] = listDepartments(db!, c.id);
  // dept A responds with 2 files under its subfolder; B stays missing.
  const sub = Number(
    db!
      .prepare(
        `INSERT INTO nodes(owner_id,parent_id,kind,name,size_bytes,created_at,updated_at)
    VALUES (?,?,'folder','A',0,?,?)`,
      )
      .run(uid, c.folder_node_id, now, now).lastInsertRowid,
  );
  for (let i = 0; i < 2; i++)
    db!
      .prepare(
        `INSERT INTO nodes(owner_id,parent_id,kind,name,size_bytes,storage_path,created_at,updated_at)
      VALUES (?,?,'file',?,3,?,?,?)`,
      )
      .run(uid, sub, `f${i}`, `${uid}/${i}`, now, now);
  db!
    .prepare(
      `INSERT INTO collection_responses(collection_id,department_id,folder_node_id,note,submitted_at)
    VALUES (?,?,?,'hi',?)`,
    )
    .run(c.id, a.id, sub, now);

  const roster = getRoster(db!, c.id);
  expect(roster.map((r) => r.name)).toEqual(['A', 'B']);
  expect(roster[0]).toMatchObject({ responded: true, file_count: 2, note: 'hi', folder_node_id: sub });
  expect(roster[1]).toMatchObject({ responded: false, file_count: 0, note: null, folder_node_id: null });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/collections/departments.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation** — create `server/src/collections/departments.ts`:

```ts
import type Database from 'better-sqlite3';

export interface Department {
  id: number;
  collection_id: number;
  name: string;
  position: number;
  created_at: number;
}

/** Thrown by addDepartment when the (collection_id, name) pair already exists. */
export class DuplicateDepartmentError extends Error {
  constructor() {
    super('duplicate department');
    this.name = 'DuplicateDepartmentError';
  }
}

function isUniqueConstraintError(e: unknown): boolean {
  return (
    e instanceof Error &&
    ((e as NodeJS.ErrnoException).code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/i.test(e.message))
  );
}

/** Departments of `collectionId`, ordered by position then id. */
export function listDepartments(db: Database.Database, collectionId: number): Department[] {
  return db
    .prepare('SELECT * FROM collection_departments WHERE collection_id = @collectionId ORDER BY position ASC, id ASC')
    .all({ collectionId }) as Department[];
}

/**
 * Adds a department to `collectionId` (owner-scoped). Throws `Error('not_found')`
 * if the collection isn't owned by `ownerId`, `Error('invalid_name')` if the
 * trimmed name is empty, or `DuplicateDepartmentError` on a name clash.
 */
export function addDepartment(
  db: Database.Database,
  ownerId: number,
  collectionId: number,
  name: string,
  now: number,
): Department {
  const owned = db
    .prepare('SELECT id FROM collections WHERE id = @collectionId AND owner_id = @ownerId')
    .get({ collectionId, ownerId });
  if (!owned) throw new Error('not_found');

  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error('invalid_name');

  const pos = (
    db
      .prepare(
        'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM collection_departments WHERE collection_id = @collectionId',
      )
      .get({ collectionId }) as { p: number }
  ).p;

  try {
    const info = db
      .prepare(
        `INSERT INTO collection_departments(collection_id, name, position, created_at)
         VALUES (@collectionId, @name, @position, @now)`,
      )
      .run({ collectionId, name: trimmed, position: pos, now });
    return db
      .prepare('SELECT * FROM collection_departments WHERE id = @id')
      .get({ id: Number(info.lastInsertRowid) }) as Department;
  } catch (e) {
    if (isUniqueConstraintError(e)) throw new DuplicateDepartmentError();
    throw e;
  }
}

export type RemoveDepartmentResult = 'removed' | 'not_found' | 'has_response';

/**
 * Removes `departmentId` from `collectionId` (owner-scoped). Returns
 * 'not_found' if the department/collection isn't the owner's, 'has_response'
 * if the department already has a submitted response (never orphan files), or
 * 'removed' on success.
 */
export function removeDepartment(
  db: Database.Database,
  ownerId: number,
  collectionId: number,
  departmentId: number,
): RemoveDepartmentResult {
  const dept = db
    .prepare(
      `SELECT d.id FROM collection_departments d
       JOIN collections c ON c.id = d.collection_id
       WHERE d.id = @departmentId AND d.collection_id = @collectionId AND c.owner_id = @ownerId`,
    )
    .get({ departmentId, collectionId, ownerId });
  if (!dept) return 'not_found';

  const resp = db
    .prepare('SELECT 1 FROM collection_responses WHERE department_id = @departmentId LIMIT 1')
    .get({ departmentId });
  if (resp) return 'has_response';

  db.prepare('DELETE FROM collection_departments WHERE id = @departmentId').run({ departmentId });
  return 'removed';
}

export interface RosterEntry {
  id: number;
  name: string;
  position: number;
  responded: boolean;
  file_count: number;
  submitted_at: number | null;
  note: string | null;
  folder_node_id: number | null;
}

/**
 * Every department of `collectionId`, left-joined to its response. A responded
 * department carries its live file count (direct `file` children of its
 * response subfolder), submitted time, note, and folder id; a missing one
 * reports responded=false / file_count=0 / nulls. Ordered by position.
 */
export function getRoster(db: Database.Database, collectionId: number): RosterEntry[] {
  const rows = db
    .prepare(
      `SELECT d.id AS id, d.name AS name, d.position AS position,
              r.folder_node_id AS folder_node_id, r.submitted_at AS submitted_at, r.note AS note,
              (SELECT COUNT(*) FROM nodes n
                 WHERE n.parent_id = r.folder_node_id AND n.kind = 'file' AND n.trashed_at IS NULL) AS file_count
       FROM collection_departments d
       LEFT JOIN collection_responses r ON r.department_id = d.id AND r.collection_id = d.collection_id
       WHERE d.collection_id = @collectionId
       ORDER BY d.position ASC, d.id ASC`,
    )
    .all({ collectionId }) as Array<{
    id: number;
    name: string;
    position: number;
    folder_node_id: number | null;
    submitted_at: number | null;
    note: string | null;
    file_count: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    position: r.position,
    responded: r.folder_node_id !== null,
    file_count: r.folder_node_id !== null ? r.file_count : 0,
    submitted_at: r.submitted_at,
    note: r.note,
    folder_node_id: r.folder_node_id,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/collections/departments.test.ts && npx tsc -p . --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/collections/departments.ts server/test/collections/departments.test.ts
git commit -m "feat(collections): departments model — add/remove/list + roster

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `routes/collections.ts` — GET list, POST create, GET :id; wire into app.ts

**Files:**

- Create: `server/src/routes/collections.ts`
- Modify: `server/src/app.ts` (import + register the plugin with the shared `blobStore`)
- Test: `server/test/routes/collections.test.ts`

**Interfaces:**

- Consumes: everything from Tasks 2–4; `Guards`, `Config`, `Clock`, `BlobStore`, `writeAudit`.
- Produces: `default async function collectionsRoutes(app, deps: CollectionsRouteDeps)` and the DTO shapes below. `POST`/`GET :id` return a `CollectionDetailDto`; `GET /api/collections` returns `CollectionSummaryDto[]`.

- [ ] **Step 1: Write the failing test** — create `server/test/routes/collections.test.ts`. Reuse the route harness from `test/routes/shares.test.ts` verbatim (the `makeApp`, `seedUser` via `createPasswordService`, `login` for `{session, csrf}`, `rootIdFor`, `seedFileNode` helpers). Add these tests:

```ts
test('POST /api/collections -> 201 detail with /c/<token> url, open status, departments; GET lists it', async () => {
  const built = await makeApp();
  await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');

  const res = await built.inject({
    method: 'POST',
    url: '/api/collections',
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { title: 'Q1', departments: ['HR', 'Finance', 'IT'] },
  });
  expect(res.statusCode).toBe(201);
  const c = res.json();
  expect(c.url).toBe(`${PUBLIC_BASE_URL}/c/${c.token}`);
  expect(c.status).toBe('open');
  expect(c.has_password).toBe(false);
  expect(c.department_count).toBe(3);
  expect(c.responded_count).toBe(0);
  expect(c.departments.map((d: any) => d.name)).toEqual(['HR', 'Finance', 'IT']);
  expect(c.departments.every((d: any) => d.responded === false)).toBe(true);

  const list = (
    await built.inject({ method: 'GET', url: '/api/collections', cookies: { mirsal_session: session } })
  ).json();
  expect(list.some((x: any) => x.id === c.id && x.department_count === 3)).toBe(true);
});

test('POST with a password -> has_password true, secret never echoed', async () => {
  const built = await makeApp();
  await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const res = await built.inject({
    method: 'POST',
    url: '/api/collections',
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { title: 'P', departments: ['A'], password: 'secret-pw' },
  });
  expect(res.statusCode).toBe(201);
  expect(res.json().has_password).toBe(true);
  expect(JSON.stringify(res.json())).not.toContain('secret-pw');
});

test('POST with a foreign/non-file template -> 400 bad_template', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  await seedUser('bob', 'pw');
  const bobId = (db!.prepare('SELECT id FROM users WHERE username=?').get('bob') as { id: number }).id;
  const { session, csrf } = await login(built, 'alice', 'pw');
  const foreign = seedFileNodeFor(bobId); // a file owned by bob (helper below)
  const res = await built.inject({
    method: 'POST',
    url: '/api/collections',
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { title: 'T', departments: ['A'], template_node_id: foreign },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toMatchObject({ code: 'bad_template' });
});

test('POST with only blank departments -> 400', async () => {
  const built = await makeApp();
  await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const res = await built.inject({
    method: 'POST',
    url: '/api/collections',
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { title: 'T', departments: ['', '  '] },
  });
  expect(res.statusCode).toBe(400);
});

test('POST /api/collections requires auth -> 401', async () => {
  const built = await makeApp();
  const res = await built.inject({
    method: 'POST',
    url: '/api/collections',
    payload: { title: 'T', departments: ['A'] },
  });
  expect(res.statusCode).toBe(401);
});

test('GET /api/collections/:id is owner-scoped -> 404 for another user', async () => {
  const built = await makeApp();
  await seedUser('alice', 'pw');
  await seedUser('bob', 'pw');
  const a = await login(built, 'alice', 'pw');
  const b = await login(built, 'bob', 'pw');
  const c = (
    await built.inject({
      method: 'POST',
      url: '/api/collections',
      cookies: { mirsal_session: a.session },
      headers: { 'x-csrf-token': a.csrf },
      payload: { title: 'T', departments: ['A'] },
    })
  ).json();

  expect(
    (await built.inject({ method: 'GET', url: `/api/collections/${c.id}`, cookies: { mirsal_session: a.session } }))
      .statusCode,
  ).toBe(200);
  expect(
    (await built.inject({ method: 'GET', url: `/api/collections/${c.id}`, cookies: { mirsal_session: b.session } }))
      .statusCode,
  ).toBe(404);
});
```

Add this helper near the other seeders in the test file (a file owned by an arbitrary uid):

```ts
function seedFileNodeFor(uid: number): number {
  const { rootId } = ensureUserRoots(db!, uid, NOW);
  const info = db!
    .prepare(
      `INSERT INTO nodes(owner_id, parent_id, kind, name, size_bytes, storage_path, created_at, updated_at)
              VALUES (@uid, @rootId, 'file', @name, 5, 'u/1', @now, @now)`,
    )
    .run({ uid, rootId, name: `f-${Math.random()}`, now: NOW });
  return Number(info.lastInsertRowid);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/routes/collections.test.ts`
Expected: FAIL — 404s everywhere (route plugin not registered / module missing).

- [ ] **Step 3: Write minimal implementation** — create `server/src/routes/collections.ts`:

```ts
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { Clock } from '../clock.js';
import type { Guards } from '../auth/guards.js';
import type { Config } from '../config.js';
import type { BlobStore } from '../storage/blobs.js';
import { writeAudit } from '../audit.js';
import {
  createCollection,
  getCollection,
  listCollections,
  setCollectionState,
  deleteCollection,
  collectionStatus,
  normalizeDepartments,
  type Collection,
  type CollectionSummaryRow,
  type SetCollectionStatePatch,
} from '../collections/collections.js';
import { addDepartment, removeDepartment, getRoster, DuplicateDepartmentError } from '../collections/departments.js';

export interface CollectionsRouteDeps {
  db: Database.Database;
  now: Clock;
  guards: Guards;
  config: Config;
  blobStore: BlobStore;
}

interface CollectionSummaryDto {
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
interface RosterDeptDto {
  id: number;
  name: string;
  responded: boolean;
  file_count: number;
  submitted_at: number | null;
  note: string | null;
  folder_node_id: number | null;
}
interface CollectionDetailDto {
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

function toSummaryDto(row: CollectionSummaryRow, base: string, nowMs: number): CollectionSummaryDto {
  return {
    id: row.id,
    token: row.token,
    title: row.title,
    is_active: !!row.is_active,
    has_password: row.password_hash !== null,
    has_template: row.template_node_id !== null,
    deadline_at: row.deadline_at,
    created_at: row.created_at,
    status: collectionStatus(row, nowMs),
    department_count: row.department_count,
    responded_count: row.responded_count,
    url: `${base}/c/${row.token}`,
  };
}

function buildDetailDto(db: Database.Database, c: Collection, base: string, nowMs: number): CollectionDetailDto {
  const roster = getRoster(db, c.id);
  const departments: RosterDeptDto[] = roster.map((r) => ({
    id: r.id,
    name: r.name,
    responded: r.responded,
    file_count: r.file_count,
    submitted_at: r.submitted_at,
    note: r.note,
    folder_node_id: r.folder_node_id,
  }));
  let template: { node_id: number; name: string } | null = null;
  if (c.template_node_id !== null) {
    const t = db.prepare('SELECT name FROM nodes WHERE id = @id').get({ id: c.template_node_id }) as
      { name: string } | undefined;
    if (t) template = { node_id: c.template_node_id, name: t.name };
  }
  return {
    id: c.id,
    token: c.token,
    title: c.title,
    is_active: !!c.is_active,
    has_password: c.password_hash !== null,
    has_template: c.template_node_id !== null,
    deadline_at: c.deadline_at,
    created_at: c.created_at,
    status: collectionStatus(c, nowMs),
    department_count: departments.length,
    responded_count: departments.filter((d) => d.responded).length,
    departments,
    template,
    url: `${base}/c/${c.token}`,
  };
}

function parseIdParam(req: FastifyRequest, key = 'id'): number | null {
  const raw = (req.params as Record<string, string | undefined>)[key];
  const id = Number(raw);
  return Number.isInteger(id) ? id : null;
}

const createSchema = z.object({
  title: z.string().min(1).max(200),
  template_node_id: z.number().int().nullable().optional(),
  departments: z.array(z.string()).min(1),
  password: z.string().min(1).nullable().optional(),
  deadline_at: z.number().int().nullable().optional(),
});

/** Owner-scoped collection management. requireAuth (+ CSRF on mutating verbs). */
export default async function collectionsRoutes(app: FastifyInstance, deps: CollectionsRouteDeps): Promise<void> {
  const { db, now, guards, config, blobStore } = deps;
  const base = config.PUBLIC_BASE_URL;

  app.get('/api/collections', { preHandler: guards.requireAuth }, async (req, reply) => {
    const uid = req.user!.id;
    const nowMs = now();
    reply.code(200).send(listCollections(db, uid).map((r) => toSummaryDto(r, base, nowMs)));
  });

  app.post('/api/collections', { preHandler: guards.requireAuth }, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid_body' });
      return;
    }
    const uid = req.user!.id;
    if (normalizeDepartments(parsed.data.departments).length === 0) {
      reply.code(400).send({ code: 'no_departments' });
      return;
    }
    try {
      const c = await createCollection(
        db,
        uid,
        {
          title: parsed.data.title,
          departments: parsed.data.departments,
          templateNodeId: parsed.data.template_node_id ?? null,
          password: parsed.data.password ?? null,
          deadlineAt: parsed.data.deadline_at ?? null,
        },
        now(),
      );
      writeAudit(
        db,
        {
          actorId: uid,
          action: 'collection_created',
          target: c.token,
          detail: JSON.stringify({
            collection_id: c.id,
            departments: normalizeDepartments(parsed.data.departments).length,
          }),
        },
        now,
      );
      reply.code(201).send(buildDetailDto(db, c, base, now()));
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      if (msg === 'bad_template') {
        reply.code(400).send({ code: 'bad_template' });
        return;
      }
      if (msg === 'no_departments' || msg === 'invalid_title') {
        reply.code(400).send({ error: 'invalid_body' });
        return;
      }
      throw e;
    }
  });

  app.get('/api/collections/:id', { preHandler: guards.requireAuth }, async (req, reply) => {
    const id = parseIdParam(req);
    if (id === null) {
      reply.code(404).send({ error: 'not_found' });
      return;
    }
    const uid = req.user!.id;
    const c = getCollection(db, uid, id);
    if (!c) {
      reply.code(404).send({ error: 'not_found' });
      return;
    }
    reply.code(200).send(buildDetailDto(db, c, base, now()));
  });
}
```

Then **wire it into `app.ts`** — add the import beside the other route imports:

```ts
import collectionsRoutes from './routes/collections.js';
```

and register it inside `registerRoutes`, right after the `sharesRoutes` registration (the shared `blobStore` is in scope there):

```ts
await app.register(collectionsRoutes, { db: deps.db, now: deps.now, guards, config: deps.config, blobStore });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/routes/collections.test.ts && npx tsc -p . --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/collections.ts server/src/app.ts server/test/routes/collections.test.ts
git commit -m "feat(collections): owner routes — GET list, POST create, GET detail; wire app

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `routes/collections.ts` — PATCH and DELETE a collection

**Files:**

- Modify: `server/src/routes/collections.ts` (add PATCH + DELETE handlers + patch schema)
- Test: `server/test/routes/collections.test.ts` (add cases)

**Interfaces:**

- Consumes: `setCollectionState`, `deleteCollection`, `getCollection` (Task 3), `writeAudit`, `blobStore.deleteBlob`.
- Produces: `PATCH /api/collections/:id` → `CollectionDetailDto`; `DELETE /api/collections/:id` → `{ ok: true }`.

- [ ] **Step 1: Write the failing test** — add to `server/test/routes/collections.test.ts`:

```ts
async function mkCollection(built: FastifyInstance, session: string, csrf: string, payload: any) {
  return (
    await built.inject({
      method: 'POST',
      url: '/api/collections',
      cookies: { mirsal_session: session },
      headers: { 'x-csrf-token': csrf },
      payload,
    })
  ).json();
}

test('PATCH is_active:false -> closed; past deadline -> expired; title updates', async () => {
  const built = await makeApp();
  await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const c = await mkCollection(built, session, csrf, { title: 'Old', departments: ['A'] });

  const stop = await built.inject({
    method: 'PATCH',
    url: `/api/collections/${c.id}`,
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { is_active: false, title: 'New' },
  });
  expect(stop.statusCode).toBe(200);
  expect(stop.json()).toMatchObject({ status: 'closed', title: 'New' });

  const exp = await built.inject({
    method: 'PATCH',
    url: `/api/collections/${c.id}`,
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
    payload: { is_active: true, deadline_at: NOW - 1000 },
  });
  expect(exp.json()).toMatchObject({ status: 'expired' });
});

test('PATCH with an empty body -> 400; foreign collection -> 404', async () => {
  const built = await makeApp();
  await seedUser('alice', 'pw');
  await seedUser('bob', 'pw');
  const a = await login(built, 'alice', 'pw');
  const b = await login(built, 'bob', 'pw');
  const c = await mkCollection(built, a.session, a.csrf, { title: 'T', departments: ['A'] });

  expect(
    (
      await built.inject({
        method: 'PATCH',
        url: `/api/collections/${c.id}`,
        cookies: { mirsal_session: a.session },
        headers: { 'x-csrf-token': a.csrf },
        payload: {},
      })
    ).statusCode,
  ).toBe(400);

  expect(
    (
      await built.inject({
        method: 'PATCH',
        url: `/api/collections/${c.id}`,
        cookies: { mirsal_session: b.session },
        headers: { 'x-csrf-token': b.csrf },
        payload: { is_active: false },
      })
    ).statusCode,
  ).toBe(404);
});

test('DELETE removes the collection (gone from list, folder node gone); 2nd DELETE -> 404', async () => {
  const built = await makeApp();
  await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const c = await mkCollection(built, session, csrf, { title: 'T', departments: ['A'] });
  const folderId = (db!.prepare('SELECT folder_node_id f FROM collections WHERE id=?').get(c.id) as { f: number }).f;

  const del = await built.inject({
    method: 'DELETE',
    url: `/api/collections/${c.id}`,
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
  });
  expect(del.statusCode).toBe(200);
  expect(db!.prepare('SELECT COUNT(*) c FROM nodes WHERE id=?').get(folderId)).toMatchObject({ c: 0 });

  const list = (
    await built.inject({ method: 'GET', url: '/api/collections', cookies: { mirsal_session: session } })
  ).json();
  expect(list.some((x: any) => x.id === c.id)).toBe(false);

  const again = await built.inject({
    method: 'DELETE',
    url: `/api/collections/${c.id}`,
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
  });
  expect(again.statusCode).toBe(404);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/routes/collections.test.ts`
Expected: FAIL — PATCH/DELETE return 404 (handlers not defined).

- [ ] **Step 3: Write minimal implementation** — in `server/src/routes/collections.ts`, add the patch schema near `createSchema`:

```ts
const patchSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    // Tri-state: absent = unchanged, null = clear, non-empty string = set.
    password: z.string().min(1).nullable().optional(),
    // Tri-state: absent = unchanged, null = no deadline, number = deadline.
    deadline_at: z.number().int().nullable().optional(),
    is_active: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined || v.password !== undefined || v.deadline_at !== undefined || v.is_active !== undefined,
    { message: 'at least one field is required' },
  );
```

and add both handlers inside `collectionsRoutes` (after the `GET :id` handler):

```ts
app.patch('/api/collections/:id', { preHandler: guards.requireAuth }, async (req, reply) => {
  const id = parseIdParam(req);
  if (id === null) {
    reply.code(404).send({ error: 'not_found' });
    return;
  }
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400).send({ error: 'invalid_body' });
    return;
  }
  const uid = req.user!.id;

  const patch: SetCollectionStatePatch = {};
  if (parsed.data.title !== undefined) patch.title = parsed.data.title;
  if (parsed.data.is_active !== undefined) patch.isActive = parsed.data.is_active;
  if (parsed.data.password !== undefined) patch.password = parsed.data.password;
  if (parsed.data.deadline_at !== undefined) patch.deadlineAt = parsed.data.deadline_at;

  const updated = await setCollectionState(db, uid, id, patch, now());
  if (!updated) {
    reply.code(404).send({ error: 'not_found' });
    return;
  }
  reply.code(200).send(buildDetailDto(db, updated, base, now()));
});

app.delete('/api/collections/:id', { preHandler: guards.requireAuth }, async (req, reply) => {
  const id = parseIdParam(req);
  if (id === null) {
    reply.code(404).send({ error: 'not_found' });
    return;
  }
  const uid = req.user!.id;
  const c = getCollection(db, uid, id);
  if (!c) {
    reply.code(404).send({ error: 'not_found' });
    return;
  }

  const { storagePaths } = deleteCollection(db, uid, id);
  for (const p of storagePaths) blobStore.deleteBlob(p);
  writeAudit(
    db,
    { actorId: uid, action: 'collection_deleted', target: c.token, detail: JSON.stringify({ collection_id: id }) },
    now,
  );
  reply.code(200).send({ ok: true });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/routes/collections.test.ts && npx tsc -p . --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/collections.ts server/test/routes/collections.test.ts
git commit -m "feat(collections): owner routes — PATCH + DELETE a collection

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: `routes/collections.ts` — add / remove a department

**Files:**

- Modify: `server/src/routes/collections.ts` (two handlers + add-dept schema)
- Test: `server/test/routes/collections.test.ts` (add cases)

**Interfaces:**

- Consumes: `addDepartment`, `removeDepartment`, `DuplicateDepartmentError` (Task 4).
- Produces: `POST /api/collections/:id/departments` → `201 { id, name, position }`; `DELETE /api/collections/:id/departments/:deptId` → `{ ok: true }` / `409 { code: 'has_response' }` / `409 { code: 'duplicate' }`.

- [ ] **Step 1: Write the failing test** — add to `server/test/routes/collections.test.ts`:

```ts
test('POST department -> 201; duplicate -> 409; foreign collection -> 404', async () => {
  const built = await makeApp();
  await seedUser('alice', 'pw');
  await seedUser('bob', 'pw');
  const a = await login(built, 'alice', 'pw');
  const b = await login(built, 'bob', 'pw');
  const c = await mkCollection(built, a.session, a.csrf, { title: 'T', departments: ['A'] });

  const add = await built.inject({
    method: 'POST',
    url: `/api/collections/${c.id}/departments`,
    cookies: { mirsal_session: a.session },
    headers: { 'x-csrf-token': a.csrf },
    payload: { name: 'B' },
  });
  expect(add.statusCode).toBe(201);
  expect(add.json()).toMatchObject({ name: 'B', position: 1 });

  const dup = await built.inject({
    method: 'POST',
    url: `/api/collections/${c.id}/departments`,
    cookies: { mirsal_session: a.session },
    headers: { 'x-csrf-token': a.csrf },
    payload: { name: 'A' },
  });
  expect(dup.statusCode).toBe(409);
  expect(dup.json()).toMatchObject({ code: 'duplicate' });

  const foreign = await built.inject({
    method: 'POST',
    url: `/api/collections/${c.id}/departments`,
    cookies: { mirsal_session: b.session },
    headers: { 'x-csrf-token': b.csrf },
    payload: { name: 'Z' },
  });
  expect(foreign.statusCode).toBe(404);
});

test('DELETE department -> 200; a department with a response -> 409 has_response', async () => {
  const built = await makeApp();
  const uid = await seedUser('alice', 'pw');
  const { session, csrf } = await login(built, 'alice', 'pw');
  const c = await mkCollection(built, session, csrf, { title: 'T', departments: ['A', 'B'] });
  const depts = db!
    .prepare('SELECT id, name FROM collection_departments WHERE collection_id=? ORDER BY position')
    .all(c.id) as { id: number; name: string }[];
  const b = depts.find((d) => d.name === 'B')!;

  const del = await built.inject({
    method: 'DELETE',
    url: `/api/collections/${c.id}/departments/${b.id}`,
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
  });
  expect(del.statusCode).toBe(200);

  // Give dept A a response, then try to delete it.
  const a = depts.find((d) => d.name === 'A')!;
  const folderId = (db!.prepare('SELECT folder_node_id f FROM collections WHERE id=?').get(c.id) as { f: number }).f;
  const sub = Number(
    db!
      .prepare(
        `INSERT INTO nodes(owner_id,parent_id,kind,name,size_bytes,created_at,updated_at)
    VALUES (?,?,'folder','A',0,?,?)`,
      )
      .run(uid, folderId, NOW, NOW).lastInsertRowid,
  );
  db!
    .prepare(
      `INSERT INTO collection_responses(collection_id,department_id,folder_node_id,note,submitted_at)
    VALUES (?,?,?,NULL,?)`,
    )
    .run(c.id, a.id, sub, NOW);

  const blocked = await built.inject({
    method: 'DELETE',
    url: `/api/collections/${c.id}/departments/${a.id}`,
    cookies: { mirsal_session: session },
    headers: { 'x-csrf-token': csrf },
  });
  expect(blocked.statusCode).toBe(409);
  expect(blocked.json()).toMatchObject({ code: 'has_response' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/routes/collections.test.ts`
Expected: FAIL — department routes 404.

- [ ] **Step 3: Write minimal implementation** — in `server/src/routes/collections.ts`, add the schema near the others:

```ts
const addDeptSchema = z.object({ name: z.string().min(1).max(200) });
```

and the two handlers inside `collectionsRoutes` (after DELETE collection):

```ts
app.post('/api/collections/:id/departments', { preHandler: guards.requireAuth }, async (req, reply) => {
  const id = parseIdParam(req);
  if (id === null) {
    reply.code(404).send({ error: 'not_found' });
    return;
  }
  const parsed = addDeptSchema.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400).send({ error: 'invalid_body' });
    return;
  }
  const uid = req.user!.id;
  try {
    const dept = addDepartment(db, uid, id, parsed.data.name, now());
    reply.code(201).send({ id: dept.id, name: dept.name, position: dept.position });
  } catch (e) {
    if (e instanceof DuplicateDepartmentError) {
      reply.code(409).send({ code: 'duplicate' });
      return;
    }
    const msg = e instanceof Error ? e.message : '';
    if (msg === 'not_found') {
      reply.code(404).send({ error: 'not_found' });
      return;
    }
    if (msg === 'invalid_name') {
      reply.code(400).send({ error: 'invalid_body' });
      return;
    }
    throw e;
  }
});

app.delete('/api/collections/:id/departments/:deptId', { preHandler: guards.requireAuth }, async (req, reply) => {
  const id = parseIdParam(req, 'id');
  const deptId = parseIdParam(req, 'deptId');
  if (id === null || deptId === null) {
    reply.code(404).send({ error: 'not_found' });
    return;
  }
  const uid = req.user!.id;
  const result = removeDepartment(db, uid, id, deptId);
  if (result === 'not_found') {
    reply.code(404).send({ error: 'not_found' });
    return;
  }
  if (result === 'has_response') {
    reply.code(409).send({ code: 'has_response' });
    return;
  }
  reply.code(200).send({ ok: true });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run the full server suite + typecheck (this is the last Phase 1 task — everything must be green together):

Run: `cd server && npm run typecheck && npm test`
Expected: PASS — full server suite green (existing + all new collections tests), tsc clean. Confirm the total test count rose by the new tests and NO existing test regressed.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/collections.ts server/test/routes/collections.test.ts
git commit -m "feat(collections): owner routes — add/remove a department

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Phase 1 Definition of Done

- `schema_version` migrates cleanly v3→v4 (create-only; convergence test green); live-data-safe.
- Owner API complete: create (with template/password/deadline/departments), list (with counts), detail (roster: responded + file_count + missing), patch (title/open-close/deadline/password), delete (cascades + blob cleanup), department add/remove (409 on dup / on responded).
- Everything owner-scoped (404, no oracle), CSRF-guarded, audited on create + delete.
- `cd server && npm run typecheck && npm test` fully green; **no `npm run lint`** (script does not exist).
- 7 commits on `feat/collections`, each auto-pushed.
- **STOP for user review** before Phase 2 (public intake) — per the phase-pause workflow. No web/UI and no file-submission in this phase.

## Self-Review (completed by the plan author)

- **Spec coverage (Phase-1 slice of the spec):** §5 data model → Task 1 (+ models 2–4); §6 migration → Task 1; §7.1 owner routes → Tasks 5–7; §4.1/§4.2 owner create + roster → Tasks 2/4/5; delete/cascade + quota reclaim → Task 3. Public routes (§7.2), submit (§8), inbound-write security (§9), and all frontend (§10) are **intentionally deferred to Phases 2–3** and NOT in this plan.
- **Placeholder scan:** none — every step carries real code.
- **Type consistency:** `Collection`/`CollectionSummaryRow`/`SetCollectionStatePatch` defined in Task 2/3 and consumed with the same names in Tasks 5–7; `RosterEntry`→`RosterDeptDto` mapping explicit; `deleteCollection` returns `{deleted, storagePaths}` consumed in Task 6; `removeDepartment`'s `'removed'|'not_found'|'has_response'` union consumed in Task 7; `DuplicateDepartmentError` thrown in Task 4, caught in Task 7.
- **Migration hazard:** the convergence test (Task 1) guards the auto-index-naming trap by using a **named** unique index (`ux_collection_response_dept`) in both `schema.sql` and the migration `up`.
