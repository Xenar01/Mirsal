# Download Limit (Burn-After-Download) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-file download cap (default 1) to shares; when exhausted, run the creator's chosen terminal action — `stop` the link or `delete` the file (default → Trash, purged after 24h).

**Architecture:** Additive `shares` columns + an incremental DB migration (v1→v2). The counted download is a **POST** (passive GETs can't burn/bypass); enforcement counts only *completed* deliveries in the DB and bounds concurrency with an in-memory reservation map; a completed download that reaches the limit runs an idempotent terminal helper in one transaction. UI: a new share-console section (creator) and a static label + POST download (recipient).

**Tech Stack:** Fastify 5 + better-sqlite3 (server, ESM, `.js` import specifiers), React 19 + Vite + react-i18next + Tailwind (web), Vitest both sides, Zod validation.

## Global Constraints

- Server is ESM: **import specifiers end in `.js`** even for `.ts` files.
- Single Node process per container — the in-memory reservation map is authoritative (no multi-process support in v1).
- **No http→https redirect** anywhere (unrelated infra rule, do not touch).
- Arabic-first: creator UI strings live in **`ar.json` only** (`share.*`); the public share page is bilingual → recipient strings (`public.*`) go in **both `ar.json` and `en.json`**. `fallbackLng` is `ar`.
- Anti-oracle: reuse existing constant-shape rejections; never expose a live remaining-download count.
- TDD: write the failing test first; commit after each green task. Build on branch `feat/download-limit`; merge to `main` only when the whole suite is green.
- Spec of record: `docs/superpowers/specs/2026-07-29-download-limit-design.md`.

## File Structure

**Server**
- `server/src/db/schema.sql` — MODIFY: append 3 `shares` columns (after `revoked_at`).
- `server/src/db/migrate.ts` — MODIFY: incremental versioned runner (v2 ALTERs, `sqlite_master` fresh-detection).
- `server/src/shares/shares.ts` — MODIFY: `Share` interface (+3 cols), `ownerStatus` (+`exhausted`), `SetShareStatePatch` + `setShareState` (+`downloadLimit`/`onExhaust`, count reset).
- `server/src/shares/exhaustion.ts` — CREATE: idempotent terminal helper (`stop`/`delete` + audit, one txn).
- `server/src/shares/download-reservations.ts` — CREATE: in-memory reservation registry.
- `server/src/routes/shares.ts` — MODIFY: `ShareDto`/`toShareDto` (+3 fields+status), `patchShareSchema`+`.refine()`, folder-kind guard, field forwarding.
- `server/src/routes/public.ts` — MODIFY: `POST /download` counted path; `GET /download` → 405 for limited; meta + `download_limit`.

**Web**
- `web/src/features/dashboard/share/types.ts` — MODIFY: `ShareDto` (+3 fields, +`exhausted` status).
- `web/src/features/dashboard/share/api.ts` — MODIFY: `PatchShareVars` + `patchShare` mapping (camel→snake).
- `web/src/features/dashboard/share/ShareModal.tsx` — MODIFY: add `DownloadLimitSection`.
- `web/src/components/StatusChip.tsx` — MODIFY: render `exhausted`.
- `web/src/features/public/api.ts` — MODIFY: `PublicMeta` + `download_limit`.
- `web/src/features/public/PublicFile.tsx` — MODIFY: POST-form download + static label.
- `web/src/features/public/controls.tsx` — MODIFY: add a submit-styled `PrimaryButton` (or reuse).
- `web/src/i18n/ar.json` — MODIFY: `share.downloadLimit.*` + `public.*` keys.
- `web/src/i18n/en.json` — MODIFY: `public.*` keys only.

**Tests:** `server/test/db/migrate.test.ts`, `server/test/shares/exhaustion.test.ts` (new), `server/test/shares/download-reservations.test.ts` (new), `server/test/routes/shares.test.ts`, `server/test/routes/public.test.ts`, `web/test/share.test.tsx`, `web/test/public.test.tsx`, `web/test/api.test.ts`.

---

## Task 1: Schema + incremental migration (v1 → v2)

**Files:**
- Modify: `server/src/db/schema.sql`
- Modify: `server/src/db/migrate.ts`
- Test: `server/test/db/migrate.test.ts`

**Interfaces:**
- Produces: `LATEST_VERSION = 2`, and `shares` rows now carry `download_limit INTEGER|null`, `download_count INTEGER`, `on_exhaust 'stop'|'delete'`.

- [ ] **Step 1: Write the failing migration tests** — append to `server/test/db/migrate.test.ts`:

```ts
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { migrate } from '../../src/db/migrate.js';

/** The exact pre-v2 `shares` DDL (v1 baseline), used to simulate an old DB. */
const V1_SHARES = `CREATE TABLE shares(
  id INTEGER PRIMARY KEY, node_id INTEGER NOT NULL, owner_id INTEGER NOT NULL,
  token TEXT UNIQUE NOT NULL, password_hash TEXT, is_active INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER, allow_download INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, revoked_at INTEGER)`;

function cols(db: Database.Database): string[] {
  return (db.prepare(`PRAGMA table_info(shares)`).all() as { name: string }[]).map((r) => r.name);
}

describe('migrate v2 download-limit columns', () => {
  it('adds the 3 columns to a v1 DB and records version 2', () => {
    const db = new Database(':memory:');
    db.exec(V1_SHARES);
    db.exec('CREATE TABLE schema_version(version INTEGER NOT NULL, applied_at INTEGER NOT NULL)');
    db.prepare('INSERT INTO schema_version(version, applied_at) VALUES (1, 0)').run();
    migrate(db);
    expect(cols(db)).toEqual(expect.arrayContaining(['download_limit', 'download_count', 'on_exhaust']));
    expect((db.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }).v).toBe(2);
  });

  it('a fresh DB has the columns and lands at version 2', () => {
    const db = new Database(':memory:');
    migrate(db);
    expect(cols(db)).toEqual(expect.arrayContaining(['download_limit', 'download_count', 'on_exhaust']));
    expect((db.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }).v).toBe(2);
  });

  it('fresh and upgraded shares schemas converge (identical table_info)', () => {
    const fresh = new Database(':memory:'); migrate(fresh);
    const upgraded = new Database(':memory:');
    upgraded.exec(V1_SHARES);
    upgraded.exec('CREATE TABLE schema_version(version INTEGER NOT NULL, applied_at INTEGER NOT NULL)');
    upgraded.prepare('INSERT INTO schema_version(version, applied_at) VALUES (1, 0)').run();
    migrate(upgraded);
    expect(fresh.prepare('PRAGMA table_info(shares)').all()).toEqual(
      upgraded.prepare('PRAGMA table_info(shares)').all()
    );
  });

  it('is idempotent on repeated boots', () => {
    const db = new Database(':memory:'); migrate(db);
    expect(() => { migrate(db); migrate(db); }).not.toThrow();
    expect((db.prepare('SELECT COUNT(*) c FROM schema_version').get() as { c: number }).c).toBe(1);
  });

  it('tables present but no version row → runs the ALTERs (not the fresh path)', () => {
    const db = new Database(':memory:');
    db.exec(V1_SHARES); // tables exist, but no schema_version rows
    migrate(db);
    expect(cols(db)).toEqual(expect.arrayContaining(['download_limit']));
    expect((db.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }).v).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify they fail** — `cd server && npx vitest run test/db/migrate.test.ts` → FAIL (columns missing / migrate mismatch).

- [ ] **Step 3: Append the 3 columns in `schema.sql`** — inside `CREATE TABLE IF NOT EXISTS shares(...)`, after the `revoked_at INTEGER` line, change it to:

```sql
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  download_limit INTEGER CHECK(download_limit IS NULL OR download_limit >= 1),
  download_count INTEGER NOT NULL DEFAULT 0,
  on_exhaust TEXT NOT NULL DEFAULT 'delete' CHECK(on_exhaust IN ('stop','delete'))
);
```
(Columns MUST be last — ALTER appends at the end, so this keeps fresh and upgraded column order identical.)

- [ ] **Step 4: Rewrite `migrate.ts` as an incremental runner:**

```ts
import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';

export const LATEST_VERSION = 2;
/** Back-compat alias for any importer of the old single-shot constant. */
export const SCHEMA_VERSION = LATEST_VERSION;

interface MigrationStep { version: number; up(db: Database.Database): void; }

const STEPS: MigrationStep[] = [
  {
    version: 2,
    up(db) {
      db.exec(`
        ALTER TABLE shares ADD COLUMN download_limit INTEGER
          CHECK(download_limit IS NULL OR download_limit >= 1);
        ALTER TABLE shares ADD COLUMN download_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE shares ADD COLUMN on_exhaust TEXT NOT NULL DEFAULT 'delete'
          CHECK(on_exhaust IN ('stop','delete'));
      `);
    },
  },
];

/**
 * Applies pending migrations. "Fresh" = no core tables (probed via
 * sqlite_master) — a DB with tables but no version row is a pre-versioning v1
 * baseline (e.g. a restored dump), NOT fresh, so it gets the ALTER steps.
 */
export function migrate(db: Database.Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL, applied_at INTEGER NOT NULL)');
  let current = (db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as {
    version: number | null;
  }).version ?? 0;

  const hasCore =
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='shares'").get() !== undefined;

  if (current === 0 && !hasCore) {
    const schemaSql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
    db.transaction(() => {
      db.exec(schemaSql);
      db.prepare('INSERT INTO schema_version(version, applied_at) VALUES (?, ?)').run(LATEST_VERSION, Date.now());
    })();
    return;
  }
  if (current === 0 && hasCore) current = 1; // v1 baseline without a version row

  for (const step of STEPS) {
    if (step.version > current && step.version <= LATEST_VERSION) {
      db.transaction(() => {
        step.up(db);
        db.prepare('INSERT INTO schema_version(version, applied_at) VALUES (?, ?)').run(step.version, Date.now());
      })();
    }
  }
}
```

- [ ] **Step 5: Grep for any other importer of `SCHEMA_VERSION`** — `cd server && grep -rn "SCHEMA_VERSION" src test`. The `export const SCHEMA_VERSION` alias above keeps them compiling; confirm nothing else breaks.

- [ ] **Step 6: Run migration tests** — `npx vitest run test/db/migrate.test.ts` → PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/db/schema.sql server/src/db/migrate.ts server/test/db/migrate.test.ts
git commit -m "feat(db): incremental migration + download-limit columns (v2)"
```

---

## Task 2: Share model — interface, DTO, exhausted status

**Files:**
- Modify: `server/src/shares/shares.ts` (`Share`, `ownerStatus`)
- Modify: `server/src/routes/shares.ts` (`ShareDto`, `toShareDto`)
- Test: `server/test/routes/shares.test.ts`

**Interfaces:**
- Produces: `Share` gains `download_limit: number|null`, `download_count: number`, `on_exhaust: 'stop'|'delete'`. `ownerStatus(share, now)` return union gains `'exhausted'`. `ShareDto` gains `download_limit`, `download_count`, `on_exhaust`, and `status` union gains `'exhausted'`.

- [ ] **Step 1: Write the failing test** — add to `server/test/routes/shares.test.ts` (adapt the file's existing setup/login helpers):

```ts
it('GET /api/shares exposes download-limit fields and an exhausted status', async () => {
  // ...create a file + share via the existing helpers, then set it exhausted:
  // download_limit=1, download_count=1 (direct DB write in the test), is_active=1.
  // Expect the DTO: { download_limit: 1, download_count: 1, on_exhaust: 'delete', status: 'exhausted' }.
});
```

- [ ] **Step 2: Run to verify it fails** — `cd server && npx vitest run test/routes/shares.test.ts` → FAIL.

- [ ] **Step 3: Extend `Share` and `ownerStatus` in `shares/shares.ts`:**

```ts
export interface Share {
  // ...existing fields...
  revoked_at: number | null;
  download_limit: number | null;
  download_count: number;
  on_exhaust: 'stop' | 'delete';
}

export function ownerStatus(
  share: Pick<Share, 'is_active' | 'expires_at' | 'download_limit' | 'download_count'>,
  now: number
): 'active' | 'stopped' | 'expired' | 'exhausted' {
  if (!share.is_active) return 'stopped';
  if (share.download_limit != null && share.download_count >= share.download_limit) return 'exhausted';
  if (share.expires_at != null && share.expires_at < now) return 'expired';
  return 'active';
}
```

- [ ] **Step 4: Extend `ShareDto`/`toShareDto` in `routes/shares.ts`:**

```ts
interface ShareDto {
  // ...existing...
  status: 'active' | 'stopped' | 'expired' | 'exhausted';
  download_limit: number | null;
  download_count: number;
  on_exhaust: 'stop' | 'delete';
  url: string;
}

function toShareDto(share: Share, publicBaseUrl: string, nowMs: number): ShareDto {
  return {
    // ...existing fields...
    status: ownerStatus(share, nowMs),
    download_limit: share.download_limit,
    // Unlimited shares always report 0 (the stored count is meaningless when NULL).
    download_count: share.download_limit == null ? 0 : share.download_count,
    on_exhaust: share.on_exhaust,
    url: `${publicBaseUrl}/s/${share.token}`,
  };
}
```

- [ ] **Step 5: Run tests** — `npx vitest run test/routes/shares.test.ts` → PASS.

- [ ] **Step 6: Commit** — `git commit -am "feat(shares): model + DTO carry download-limit fields, exhausted status"`

---

## Task 3: PATCH validation + folder-kind guard + count reset

**Files:**
- Modify: `server/src/shares/shares.ts` (`SetShareStatePatch`, `setShareState`)
- Modify: `server/src/routes/shares.ts` (`patchShareSchema`, handler)
- Test: `server/test/routes/shares.test.ts`

**Interfaces:**
- Consumes: `Share`, `setShareState` (Task 2).
- Produces: PATCH `/api/shares/:id` accepts `download_limit` (int≥1|null) and `on_exhaust` ('stop'|'delete'); rejects `download_limit` on a folder share (400) / missing-foreign (404); setting a limit resets `download_count` to 0.

- [ ] **Step 1: Write failing tests** — add to `server/test/routes/shares.test.ts`:

```ts
it('PATCH accepts a download_limit-only body and resets the count', async () => {
  // create file share; direct-DB set download_count=5; PATCH { download_limit: 3 };
  // expect 200, dto.download_limit===3, dto.download_count===0.
});
it('PATCH accepts on_exhaust', async () => {
  // PATCH { download_limit: 2, on_exhaust: 'stop' } → dto.on_exhaust==='stop'.
});
it('PATCH download_limit on a FOLDER share → 400', async () => {
  // create folder share; PATCH { download_limit: 1 } → 400.
});
it('PATCH download_limit=0 → 400 (invalid_body)', async () => { /* Zod rejects */ });
it('PATCH clearing download_limit → null', async () => {
  // PATCH { download_limit: null } → dto.download_limit===null, download_count===0.
});
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run test/routes/shares.test.ts` → FAIL.

- [ ] **Step 3: Extend `SetShareStatePatch` + `setShareState` (`shares/shares.ts`):**

```ts
export interface SetShareStatePatch {
  isActive?: boolean;
  password?: string | null;
  expiresAt?: number | null;
  downloadLimit?: number | null;
  onExhaust?: 'stop' | 'delete';
}
```
Inside `setShareState`, after the existing `expiresAt` block:

```ts
  if (patch.downloadLimit !== undefined) {
    // Setting (or clearing) the limit starts a fresh budget — one atomic UPDATE.
    sets.push('download_limit = @downloadLimit', 'download_count = 0');
    params.downloadLimit = patch.downloadLimit;
  }
  if (patch.onExhaust !== undefined) {
    sets.push('on_exhaust = @onExhaust');
    params.onExhaust = patch.onExhaust;
  }
```
(The existing single `UPDATE shares SET ${sets.join(', ')} …` already applies limit + count reset together atomically.)

- [ ] **Step 4: Extend `patchShareSchema` + handler (`routes/shares.ts`):**

```ts
const patchShareSchema = z
  .object({
    is_active: z.boolean().optional(),
    password: z.string().min(1).nullable().optional(),
    expires_at: z.number().int().nullable().optional(),
    download_limit: z.number().int().min(1).max(1_000_000).nullable().optional(),
    on_exhaust: z.enum(['stop', 'delete']).optional(),
  })
  .refine(
    (v) =>
      v.is_active !== undefined || v.password !== undefined || v.expires_at !== undefined ||
      v.download_limit !== undefined || v.on_exhaust !== undefined,
    { message: 'at least one field is required' }
  );
```
In the PATCH handler, after `parsed` succeeds and before building `patch`, add the folder-kind guard (only when a limit is being set):

```ts
    const uid = req.user!.id;
    if (parsed.data.download_limit !== undefined) {
      const row = db
        .prepare(
          'SELECT n.kind AS kind FROM shares s JOIN nodes n ON n.id = s.node_id WHERE s.id = @id AND s.owner_id = @uid'
        )
        .get({ id, uid }) as { kind: string } | undefined;
      if (!row) { reply.code(404).send({ error: 'not_found' }); return; }        // missing/foreign — no oracle
      if (row.kind !== 'file') { reply.code(400).send({ code: 'not_a_file' }); return; }
    }
```
Then extend the forwarding block:

```ts
    if (parsed.data.download_limit !== undefined) patch.downloadLimit = parsed.data.download_limit;
    if (parsed.data.on_exhaust !== undefined) patch.onExhaust = parsed.data.on_exhaust;
```
(Keep the existing `const updated = await setShareState(db, uid, id, patch);` — note `uid` is now declared earlier; remove the later duplicate `const uid`.)

- [ ] **Step 5: Run tests** — `npx vitest run test/routes/shares.test.ts` → PASS.

- [ ] **Step 6: Commit** — `git commit -am "feat(shares): PATCH download_limit/on_exhaust with folder guard + count reset"`

---

## Task 4: Exhaustion terminal helper

**Files:**
- Create: `server/src/shares/exhaustion.ts`
- Test: `server/test/shares/exhaustion.test.ts`

**Interfaces:**
- Consumes: `trashNode` (`nodes/trash.js`), `writeAudit` (`audit.js`), `Clock` (`clock.js`).
- Produces: `applyExhaustion(db, share, now)` where `share: { id; owner_id; node_id; on_exhaust; download_limit }`. `EXHAUST_PURGE_GRACE_MS`.

- [ ] **Step 1: Write failing tests** — `server/test/shares/exhaustion.test.ts`:

```ts
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { applyExhaustion, EXHAUST_PURGE_GRACE_MS } from '../../src/shares/exhaustion.js';

// Build a minimal owner + file node + share; helper omitted for brevity —
// use the same fixtures the other shares tests use (seed a user, a file node).

describe('applyExhaustion', () => {
  it('stop: sets is_active=0 and writes an audit row', () => { /* … */ });
  it('delete: trashes the node, stamps purge_after ≈ now+24h, audits, in one txn', () => { /* … */
    // assert nodes.trashed_at set, purge_after === now + EXHAUST_PURGE_GRACE_MS,
    // audit_log has action 'share_download_limit_deleted' with actor_id NULL.
  });
  it('delete: already-trashed node → no-op, does not throw', () => { /* … */ });
  it('delete: foreign/missing node → no-op, does not throw', () => { /* … */ });
});
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run test/shares/exhaustion.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `exhaustion.ts`:**

```ts
import type Database from 'better-sqlite3';
import type { Clock } from '../clock.js';
import { trashNode } from '../nodes/trash.js';
import { writeAudit } from '../audit.js';

/** Trash grace for a burn-deleted file (distinct from the 7-day manual-trash grace). */
export const EXHAUST_PURGE_GRACE_MS = 24 * 60 * 60 * 1000;

export interface ExhaustibleShare {
  id: number;
  owner_id: number;
  node_id: number;
  on_exhaust: 'stop' | 'delete';
  download_limit: number | null;
}

/**
 * Runs the terminal action for a share whose download limit was just reached.
 * Idempotent and tolerant of an already-trashed/foreign node, so it can run
 * inside a raw response 'close' handler without ever throwing. All writes,
 * including the audit row, commit in one transaction. `actorId` is NULL (system).
 */
export function applyExhaustion(db: Database.Database, share: ExhaustibleShare, now: Clock): void {
  if (share.on_exhaust === 'stop') {
    db.transaction(() => {
      db.prepare('UPDATE shares SET is_active = 0 WHERE id = @id').run({ id: share.id });
      writeAudit(db, {
        actorId: null,
        action: 'share_download_limit_stopped',
        target: String(share.id),
        detail: JSON.stringify({ owner_id: share.owner_id, limit: share.download_limit }),
      }, now);
    })();
    return;
  }

  const node = db.prepare('SELECT owner_id, trashed_at FROM nodes WHERE id = @id').get({ id: share.node_id }) as
    | { owner_id: number; trashed_at: number | null }
    | undefined;
  if (!node || node.owner_id !== share.owner_id || node.trashed_at !== null) {
    return; // already trashed / foreign / gone — nothing to do
  }

  const nowMs = now();
  db.transaction(() => {
    // trashNode sets purge_after = NULL, so stamp AFTER it (mirrors the scheduler's
    // trashAndStampPurge). trashNode throws on an already-trashed/foreign node, but
    // we re-checked liveness above inside this synchronous txn.
    trashNode(db, share.owner_id, share.node_id, nowMs);
    db.prepare('UPDATE nodes SET purge_after = @deadline WHERE id = @id').run({
      deadline: nowMs + EXHAUST_PURGE_GRACE_MS,
      id: share.node_id,
    });
    writeAudit(db, {
      actorId: null,
      action: 'share_download_limit_deleted',
      target: String(share.id),
      detail: JSON.stringify({ owner_id: share.owner_id, node_id: share.node_id, limit: share.download_limit }),
    }, now);
  })();
}
```

- [ ] **Step 4: Run tests** — `npx vitest run test/shares/exhaustion.test.ts` → PASS.

- [ ] **Step 5: Commit** — `git add server/src/shares/exhaustion.ts server/test/shares/exhaustion.test.ts && git commit -m "feat(shares): idempotent exhaustion terminal helper (stop/delete + audit)"`

---

## Task 5: In-memory download reservation registry

**Files:**
- Create: `server/src/shares/download-reservations.ts`
- Test: `server/test/shares/download-reservations.test.ts`

**Interfaces:**
- Produces: `createReservations()` → `{ tryReserve(shareId, completed, limit): boolean; release(shareId): void; inFlight(shareId): number }`.

- [ ] **Step 1: Write failing tests:**

```ts
import { describe, it, expect } from 'vitest';
import { createReservations } from '../../src/shares/download-reservations.js';

describe('download reservations', () => {
  it('reserves up to (limit - completed) then rejects', () => {
    const r = createReservations();
    expect(r.tryReserve(1, 0, 1)).toBe(true);   // completed 0, limit 1 → ok, inflight 1
    expect(r.tryReserve(1, 0, 1)).toBe(false);  // 0 + inflight 1 >= 1 → reject
    expect(r.inFlight(1)).toBe(1);
  });
  it('release frees a slot and deletes the key at zero', () => {
    const r = createReservations();
    r.tryReserve(2, 0, 2); r.tryReserve(2, 0, 2);
    r.release(2); expect(r.inFlight(2)).toBe(1);
    r.release(2); expect(r.inFlight(2)).toBe(0);
  });
  it('release never goes negative', () => {
    const r = createReservations();
    r.release(9); expect(r.inFlight(9)).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run test/shares/download-reservations.test.ts` → FAIL.

- [ ] **Step 3: Implement `download-reservations.ts`:**

```ts
/**
 * Per-process in-flight download reservations, keyed by share id. Bounds
 * concurrency so completed+in-flight never exceeds a share's limit. Purely
 * in-memory and ephemeral (empty each boot — a crash can never strand one).
 * All methods are synchronous, so a caller can read the DB's completed count
 * and tryReserve in one await-free block (atomic under Node's single thread).
 */
export interface Reservations {
  /** Reserve one slot iff completed + current in-flight < limit. Returns success. */
  tryReserve(shareId: number, completed: number, limit: number): boolean;
  release(shareId: number): void;
  inFlight(shareId: number): number;
}

export function createReservations(): Reservations {
  const map = new Map<number, number>();
  return {
    tryReserve(shareId, completed, limit) {
      const inflight = map.get(shareId) ?? 0;
      if (completed + inflight >= limit) return false;
      map.set(shareId, inflight + 1);
      return true;
    },
    release(shareId) {
      const n = (map.get(shareId) ?? 0) - 1;
      if (n <= 0) map.delete(shareId);
      else map.set(shareId, n);
    },
    inFlight(shareId) {
      return map.get(shareId) ?? 0;
    },
  };
}
```

- [ ] **Step 4: Run tests** — PASS.

- [ ] **Step 5: Commit** — `git add server/src/shares/download-reservations.ts server/test/shares/download-reservations.test.ts && git commit -m "feat(shares): in-memory download reservation registry"`

---

## Task 6: Counted POST download + GET-405 + meta

**Files:**
- Modify: `server/src/routes/public.ts`
- Test: `server/test/routes/public.test.ts`

**Interfaces:**
- Consumes: `createReservations` (Task 5), `applyExhaustion` (Task 4), `Share` w/ new cols (Task 2).
- Produces: `POST /api/public/:token/download` (counted); `GET …/download` → 405 for limited shares; meta `GET /api/public/:token` includes `download_limit`.

- [ ] **Step 1: Write failing tests** — add to `server/test/routes/public.test.ts`. The concurrency/abort/crash tests MUST use a **real listening server + socket**, mirroring the existing `/zip` mid-stream-abort test in this file (search it for `listen(` / `.destroy()` and reuse that harness). Concrete cases:

```ts
it('meta includes download_limit for a limited file share', async () => { /* set limit=1; GET meta → body.download_limit===1 */ });
it('GET /download on a limited share → 405', async () => { /* limit=1; GET → 405 */ });
it('POST /download on a limited share streams the file and counts it', async () => {
  // limit=2; POST → 200 + body bytes; download_count becomes 1.
});
it('two concurrent POST /download on limit=1 → one 200, one 410; count ends at 1', async () => {
  // real-listen harness; fire both, await both; assert statuses multiset {200,410}.
});
it('aborting a POST /download mid-stream leaves count unchanged and the link live', async () => {
  // real-listen; destroy the socket mid-body; assert download_count still 0, meta still live, a later POST succeeds.
});
it('delete-mode: the limit-th completed POST trashes the file + stamps purge_after', async () => {
  // limit=1, on_exhaust='delete'; POST completes; node trashed_at set, purge_after≈now+24h.
});
it('stop-mode: the limit-th completed POST sets is_active=0 (link 410 after)', async () => {});
it('owner trashing the file mid-download does not crash on completion', async () => {
  // limit=1 delete; start POST; trash the node via DB; let it finish → no throw, process alive.
});
it('unlimited file share: GET /download still streams (unchanged)', async () => {});
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run test/routes/public.test.ts` → FAIL.

- [ ] **Step 3: Add reservation state at the top of `publicRoutes`** (next to `activeZipCount`):

```ts
  const reservations = createReservations();
  // Idempotent per-request release (mirrors the /zip WeakSet slot pattern).
  const reservationHolders = new WeakSet<FastifyRequest>();
  const reservedShareId = new WeakMap<FastifyRequest, number>();
  function releaseReservation(req: FastifyRequest): void {
    if (reservationHolders.delete(req)) {
      const sid = reservedShareId.get(req);
      if (sid !== undefined) reservations.release(sid);
    }
  }
```
Add the import at the top: `import { createReservations } from '../shares/download-reservations.js';` and `import { applyExhaustion } from '../shares/exhaustion.js';`

- [ ] **Step 4: Extend the meta response** — in `GET /api/public/:token`, widen the node SELECT and body:

```ts
    const node = db
      .prepare('SELECT kind, name, size_bytes FROM nodes WHERE id = @nodeId')
      .get({ nodeId: share.node_id }) as { kind: Node['kind']; name: string; size_bytes: number };

    reply.code(200).send({
      token: share.token,
      kind: node.kind,
      name: node.name,
      size_bytes: node.size_bytes,
      isFolder: node.kind === 'folder',
      allow_download: !!share.allow_download,
      // Static config (not a live count) — drives the recipient's "one-time / up to N" label.
      download_limit: share.download_limit,
    });
```

- [ ] **Step 5: Gate the existing GET /download** — at the top of the `scope.get('/api/public/:token/download', …)` handler, right after `if (!requireUnlocked(...)) return;`:

```ts
      // A limited share must be downloaded via POST (an explicit human action);
      // a passive GET can neither burn nor bypass the cap.
      if (share.download_limit !== null) {
        reply.code(405).send({ error: 'method_not_allowed' });
        return;
      }
```

- [ ] **Step 6: Add the counted POST /download** — inside the same `downloadScope` register block, add an `onResponse` release backstop and the POST route. The body reuses the GET handler's gate/resolve/open logic; the new parts are the reserve (before anything fallible) and the completion in the raw `'close'` handler:

```ts
    scope.addHook('onResponse', async (req) => releaseReservation(req)); // release-only backstop

    scope.post('/api/public/:token/download', async (req, reply) => {
      const { token } = req.params as { token: string };
      const share = loadLiveShare(reply, token);
      if (!share) return;
      if (!requireUnlocked(req, reply, share)) return;
      if (!share.allow_download) { reply.code(403).send({ error: 'forbidden' }); return; }

      const nodeParam = (req.query as { node?: string }).node ?? share.node_id;
      let node: Node;
      try { node = resolveInSubtree(db, share, nodeParam); }
      catch (e) { if (e instanceof ForbiddenError) { reply.code(403).send({ error: 'forbidden' }); return; } throw e; }
      if (node.kind !== 'file' || !node.storage_path) { reply.code(403).send({ error: 'forbidden' }); return; }

      const stream = blobStore.readBlob(node.storage_path);
      try { await waitForOpen(stream); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') { reply.code(404).send({ error: 'not_found' }); return; }
        throw e;
      }

      // --- Reserve (only for limited shares). Synchronous read-then-reserve, no
      //     await between, so it is atomic under Node's single thread. ---
      if (share.download_limit !== null) {
        const completed = (db.prepare('SELECT download_count FROM shares WHERE id = @id').get({ id: share.id }) as {
          download_count: number;
        }).download_count;
        if (!reservations.tryReserve(share.id, completed, share.download_limit)) {
          stream.destroy();
          // Same shape as a stopped share — no "live-but-reserved" oracle.
          reply.code(410).send({ error: 'gone', reason: 'stopped', expires_at: share.expires_at });
          return;
        }
        reservationHolders.add(req);
        reservedShareId.set(req, share.id);
        // Wire the release+completion BEFORE anything fallible (logShareAccess).
        reply.raw.once('close', () => {
          try {
            releaseReservation(req);
            if (reply.raw.writableFinished) {
              const upd = db
                .prepare(
                  `UPDATE shares SET download_count = download_count + 1
                   WHERE id = @id AND download_limit IS NOT NULL AND download_count < download_limit
                   RETURNING id, owner_id, node_id, on_exhaust, download_limit, download_count`
                )
                .get({ id: share.id }) as
                | { id: number; owner_id: number; node_id: number; on_exhaust: 'stop' | 'delete'; download_limit: number; download_count: number }
                | undefined;
              if (upd && upd.download_count === upd.download_limit) applyExhaustion(db, upd, now);
            }
          } catch (err) {
            req.log.error({ err }, 'download completion handler failed');
          }
        });
      }

      reply.header('Content-Disposition', buildContentDisposition(node.name));
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Type', node.mime_type ?? 'application/octet-stream');
      logShareAccess(share.id, req);
      return reply.send(stream);
    });
```
(If TypeScript flags `RETURNING`'s row type, cast as shown. `now` is the plugin's `Clock`.)

- [ ] **Step 7: Run tests** — `npx vitest run test/routes/public.test.ts` → PASS. If the abort/crash tests are flaky under fake timers, keep them on the real-listen harness (they must use actual sockets).

- [ ] **Step 8: Commit** — `git commit -am "feat(public): counted POST download, GET-405 for limited, meta download_limit"`

---

## Task 7: Web boundary — types + api mappings

**Files:**
- Modify: `web/src/features/dashboard/share/types.ts`
- Modify: `web/src/features/dashboard/share/api.ts`
- Modify: `web/src/features/public/api.ts`
- Test: `web/test/api.test.ts`

**Interfaces:**
- Produces: `ShareDto` (+3 fields, +`exhausted`), `PatchShareVars` (+`downloadLimit`/`onExhaust`), `patchShare` snake_case mapping, `PublicMeta` (+`download_limit`).

- [ ] **Step 1: Write failing test** — add to `web/test/api.test.ts`:

```ts
it('patchShare maps downloadLimit/onExhaust to snake_case', async () => {
  const spy = /* mock apiPatch */;
  await patchShare({ id: 1, downloadLimit: 3, onExhaust: 'stop' });
  expect(spy).toHaveBeenCalledWith('/shares/1', { download_limit: 3, on_exhaust: 'stop' });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd web && npx vitest run test/api.test.ts` → FAIL.

- [ ] **Step 3: Extend `share/types.ts`:**

```ts
export interface ShareDto {
  // ...existing...
  status: 'active' | 'stopped' | 'expired' | 'exhausted';
  download_limit: number | null;
  download_count: number;
  on_exhaust: 'stop' | 'delete';
  url: string;
}
```

- [ ] **Step 4: Extend `share/api.ts`:**

```ts
export interface PatchShareVars {
  id: number;
  isActive?: boolean;
  password?: string | null;
  expiresAt?: number | null;
  /** int ≥ 1 sets the cap; null clears it (unlimited); omit = unchanged. */
  downloadLimit?: number | null;
  onExhaust?: 'stop' | 'delete';
}

export function patchShare(vars: PatchShareVars): Promise<ShareDto> {
  const body: Record<string, unknown> = {};
  if (vars.isActive !== undefined) body.is_active = vars.isActive;
  if (vars.password !== undefined) body.password = vars.password;
  if (vars.expiresAt !== undefined) body.expires_at = vars.expiresAt;
  if (vars.downloadLimit !== undefined) body.download_limit = vars.downloadLimit;
  if (vars.onExhaust !== undefined) body.on_exhaust = vars.onExhaust;
  return apiPatch<ShareDto>(`/shares/${vars.id}`, body);
}
```

- [ ] **Step 5: Extend `public/api.ts` `PublicMeta`:**

```ts
export interface PublicMeta {
  token: string;
  kind: 'file' | 'folder';
  name: string;
  size_bytes: number;
  isFolder: boolean;
  allow_download: boolean;
  /** null = unlimited; ≥1 = capped (drives the static "one-time / up to N" label). */
  download_limit: number | null;
}
```

- [ ] **Step 6: Run tests + typecheck** — `npx vitest run test/api.test.ts` → PASS; `npx tsc -p tsconfig.json --noEmit` → clean (fix any fixture gaps in Task 8).

- [ ] **Step 7: Commit** — `git commit -am "feat(web): share/public API types carry download-limit fields"`

---

## Task 8: Creator UI — DownloadLimitSection + StatusChip + i18n(ar)

**Files:**
- Modify: `web/src/features/dashboard/share/ShareModal.tsx`
- Modify: `web/src/components/StatusChip.tsx`
- Modify: `web/src/i18n/ar.json`
- Test: `web/test/share.test.tsx`

**Interfaces:**
- Consumes: `usePatchShare` (existing; passes `PatchShareVars` through), `ShareDto` (Task 7).

- [ ] **Step 1: Write failing tests** — in `web/test/share.test.tsx`: (a) update the `mkShare` fixture to include `download_limit: null, download_count: 0, on_exhaust: 'delete'`; (b) `DownloadLimitSection` renders for a file node, shows "Unlimited", lets you Apply a limit (asserts `patchShare` called with `{ downloadLimit, onExhaust }`), shows the Delete warning when `delete` is selected, and is absent for a folder node; (c) `StatusChip` renders an "exhausted" label.

- [ ] **Step 2: Run to verify they fail** — `cd web && npx vitest run test/share.test.tsx` → FAIL.

- [ ] **Step 3: Add `exhausted` to `StatusChip.tsx`** — extend its `status` prop union and label/tone map with an `exhausted` case (Arabic label e.g. "انتهت التنزيلات"; reuse the existing non-active tone, never colour-only — include the text label like the other chips).

- [ ] **Step 4: Add `DownloadLimitSection` to `ShareModal.tsx`** — render it inside `ShareManage` (after `<ExpirySection />`, before `<RevokeSection />`), and only for file nodes. It needs the node kind; `ShareManage` receives `share` — pass the `node.kind` down from `ShareModal` (add a `nodeKind` prop threaded from the top-level `node`). Component (mirror `ExpirySection`'s structure/classes):

```tsx
function DownloadLimitSection({ share, nodeKind }: { share: ShareDto; nodeKind: NodeDto['kind'] }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const patch = usePatchShare();
  const inputId = useId();
  const [value, setValue] = useState(share.download_limit != null ? String(share.download_limit) : '');
  const [mode, setMode] = useState<'delete' | 'stop'>(share.on_exhaust);
  const [error, setError] = useState<string | null>(null);
  if (nodeKind !== 'file') return null; // v1: file shares only

  function apply(e?: FormEvent) {
    e?.preventDefault();
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) { setError(t('share.downloadLimit.invalid')); return; }
    setError(null);
    patch.mutate(
      { id: share.id, downloadLimit: n, onExhaust: mode },
      { onSuccess: () => toast({ kind: 'success', message: t('share.downloadLimit.toast.set') }),
        onError: () => toast({ kind: 'error', message: t('share.toast.error') }) }
    );
  }
  function clear() {
    setError(null);
    patch.mutate(
      { id: share.id, downloadLimit: null },
      { onSuccess: () => { toast({ kind: 'success', message: t('share.downloadLimit.toast.cleared') }); setValue(''); },
        onError: () => toast({ kind: 'error', message: t('share.toast.error') }) }
    );
  }

  const isLimited = share.download_limit != null;
  return (
    <section className="flex flex-col gap-2 border-t border-line pt-4">
      <h3 className="font-display text-sm text-ink">{t('share.downloadLimit.heading')}</h3>
      <p className="font-body text-sm text-ink-2">
        {isLimited
          ? t('share.downloadLimit.used', { used: share.download_count, limit: share.download_limit })
          : t('share.downloadLimit.unlimited')}
      </p>
      <form onSubmit={apply} className="flex flex-col gap-2">
        <label htmlFor={inputId} className="font-body text-sm text-ink-2">{t('share.downloadLimit.label')}</label>
        <input id={inputId} type="number" min={1} inputMode="numeric" value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-full rounded-lg border border-line bg-surface ps-3 pe-3 py-2 font-mono text-sm text-ink" />
        {/* Terminal action — shown only when a limit is being/So set */}
        <fieldset className="flex flex-col gap-1">
          <legend className="font-body text-sm text-ink-2">{t('share.downloadLimit.onExhaust')}</legend>
          <label className="flex items-center gap-2 font-body text-sm text-ink">
            <input type="radio" name="onExhaust" checked={mode === 'delete'} onChange={() => setMode('delete')} />
            {t('share.downloadLimit.modeDelete')}
          </label>
          <label className="flex items-center gap-2 font-body text-sm text-ink">
            <input type="radio" name="onExhaust" checked={mode === 'stop'} onChange={() => setMode('stop')} />
            {t('share.downloadLimit.modeStop')}
          </label>
          {mode === 'delete' && (
            <p role="note" className="font-body text-xs text-clay">{t('share.downloadLimit.deleteWarning')}</p>
          )}
        </fieldset>
        {error !== null && <p role="alert" className="font-body text-sm text-clay">{error}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" type="submit" disabled={patch.isPending}>{t('share.downloadLimit.apply')}</Button>
          {isLimited && (
            <Button variant="ghost" onClick={clear} disabled={patch.isPending}>{t('share.downloadLimit.clear')}</Button>
          )}
        </div>
      </form>
    </section>
  );
}
```

- [ ] **Step 5: Add `share.downloadLimit.*` keys to `ar.json` ONLY** (do NOT add to `en.json` — the app is Arabic-only): `heading`, `unlimited`, `used` ("{{used}} من {{limit}} تنزيلات"), `label`, `onExhaust`, `modeDelete`, `modeStop`, `deleteWarning` ("يُنقل الملف إلى المهملات بعد آخر تنزيل (قابل للاسترجاع ٢٤ ساعة)"), `apply`, `clear`, `invalid`, and `toast.set`/`toast.cleared`. Also add a `share.status.exhausted` label if StatusChip pulls from i18n.

- [ ] **Step 6: Run tests + typecheck** — `npx vitest run test/share.test.tsx` → PASS; `npx tsc --noEmit` clean.

- [ ] **Step 7: Commit** — `git commit -am "feat(web): download-limit share console section + exhausted status"`

---

## Task 9: Recipient UI — POST download + static label + i18n(ar/en)

**Files:**
- Modify: `web/src/features/public/PublicFile.tsx`
- Modify: `web/src/features/public/controls.tsx`
- Modify: `web/src/i18n/ar.json` and `web/src/i18n/en.json`
- Test: `web/test/public.test.tsx`

**Interfaces:**
- Consumes: `PublicMeta.download_limit` (Task 7).

- [ ] **Step 1: Write failing tests** — in `web/test/public.test.tsx`: (a) with `download_limit: 1`, the page shows the "one-time download" label; with `download_limit: 3`, shows "up to 3 downloads"; with `null`, no label; (b) the download control is a `<form method="post">` whose action is the `/api/public/:token/download` URL (not a bare GET anchor).

- [ ] **Step 2: Run to verify they fail** — `cd web && npx vitest run test/public.test.tsx` → FAIL.

- [ ] **Step 3: Add a submit-styled control in `controls.tsx`** — add `PrimaryButton` matching `PrimaryLink`'s brass styling but rendered as `<button type="submit">` (same children/props shape). (If `PrimaryLink` already forwards arbitrary props, you can instead wrap it; simplest is a sibling `PrimaryButton`.)

- [ ] **Step 4: Update `PublicFile.tsx`** — replace the anchor download with a POST form, and add the static label:

```tsx
import { downloadUrl, type PublicMeta } from './api';
import { PrimaryButton, DownloadGlyph } from './controls';
// ...
      {meta.download_limit != null && (
        <p className="font-body text-sm text-brass-ring">
          {meta.download_limit === 1
            ? t('public.limitOnce')
            : t('public.limitN', { count: meta.download_limit })}
        </p>
      )}

      {meta.allow_download && (
        // POST so passive GETs (unfurlers/scanners/prefetch) can't trigger a burn;
        // the browser still downloads natively from the streamed attachment response.
        <form method="post" action={downloadUrl(token)}>
          <PrimaryButton type="submit">
            <DownloadGlyph />
            {t('public.download')}
          </PrimaryButton>
        </form>
      )}
```
(`downloadUrl(token)` already returns `/api/public/<token>/download`; the POST form posts to it. The `mirsal_unlock` cookie is `SameSite=Lax` and same-origin, so it rides along on this same-site form POST.)

- [ ] **Step 5: Add `public.*` keys to BOTH `ar.json` and `en.json`** — `public.limitOnce` ("تنزيل لمرة واحدة" / "One-time download") and `public.limitN` ("حتى {{count}} عمليات تنزيل" / "Up to {{count}} downloads"). Missing `en` keys would fall back to Arabic on the bilingual page — a visible bug, so both files are required.

- [ ] **Step 6: Run tests + typecheck** — `npx vitest run test/public.test.tsx` → PASS; `npx tsc --noEmit` clean.

- [ ] **Step 7: Commit** — `git commit -am "feat(web): recipient static limit label + POST download (bot-safe)"`

---

## Task 10: Full green + branch ready to merge

**Files:** none (verification).

- [ ] **Step 1: Server suite** — `cd server && npx vitest run && npx tsc -p tsconfig.json --noEmit && npm run lint` → all pass.
- [ ] **Step 2: Web suite** — `cd web && npx vitest run && npx tsc -p tsconfig.json --noEmit && npm run lint` → all pass.
- [ ] **Step 3: Manual smoke against a throwaway DB (optional but recommended)** — build the image or run the server against a temp `DB_PATH`; create a file share, set limit 1 (delete), `POST /download` once → 200; second `POST` → 410; confirm the node is trashed with `purge_after` set; confirm `GET /download` on it → 405.
- [ ] **Step 4: Update `docs/RUNBOOK.md`** — add a short "Download limits" note (per-file cap, POST-only counted download, delete → Trash 24h, audit actions `share_download_limit_*`).
- [ ] **Step 5: Commit docs** — `git commit -am "docs(runbook): download-limit feature notes"`
- [ ] **Step 6: Merge to main when green** — `git checkout main && git merge --no-ff feat/download-limit && git push origin main` (only after the user confirms; take a DB snapshot first per spec §16).

---

## Self-Review (checklist run against the spec)

- **Coverage:** §4 data model → T1; §5 migration → T1; §6 enforcement (POST/GET-405/reserve/complete/terminal) → T6 (+T4/T5); §7 terminal → T4; §8 API (PATCH/DTO/meta) → T2/T3/T6; §9 creator UI → T8; §10 recipient UI → T9; §11 audit → T4; §12 validation → T3/T6; §13 edge cases → covered by T4/T6 tests; §15 tests → distributed; §16 rollout → T10. No spec section without a task.
- **Placeholders:** UI tasks (T8/T9) reference real component patterns with concrete code; test bodies for a few UI/route cases are described precisely (fixtures + assertions) rather than fully transcribed where they must adapt to each file's existing harness — the *implementation* code blocks are complete. The concurrency/abort/crash tests explicitly require the existing real-listen harness.
- **Type consistency:** `download_limit: number|null`, `download_count: number`, `on_exhaust: 'stop'|'delete'` identical across `Share` (T2), `ShareDto` server+web (T2/T7), meta (T6/T7). `ownerStatus`/`status` union `'active'|'stopped'|'expired'|'exhausted'` consistent (T2/T7/T8). `applyExhaustion`'s param matches the `RETURNING` row shape in T6. `PatchShareVars` camelCase ↔ body snake_case mapping consistent (T3/T7).
