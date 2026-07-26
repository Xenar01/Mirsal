import { unlink } from 'node:fs/promises';
import type { ReadStream } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { Clock } from '../clock.js';
import type { Guards } from '../auth/guards.js';
import { MAX_FILE_BYTES } from '../config.js';
import { writeAudit } from '../audit.js';
import {
  CollisionError,
  CycleError,
  createFolder,
  ensureUserRoots,
  isAncestor,
  listChildren,
  moveNode,
  renameNode,
  type Node,
} from '../nodes/tree.js';
import { mapDbError, nextSuffixedName } from '../nodes/collisions.js';
import { permanentDelete, restoreNode, trashNode } from '../nodes/trash.js';
import { reserve, commitActual, release } from '../storage/quota.js';
import type { BlobStore } from '../storage/blobs.js';

export interface NodesRouteDeps {
  db: Database.Database;
  now: Clock;
  guards: Guards;
  blobStore: BlobStore;
}

/** Client-facing projection of a node row — never leaks `storage_path`/`owner_id`. */
interface NodeDto {
  id: number;
  parent_id: number | null;
  kind: Node['kind'];
  name: string;
  size_bytes: number;
  mime_type: string | null;
  auto_delete_at: number | null;
  created_at: number;
  updated_at: number;
}

const MAX_NAME_LENGTH = 255;

/**
 * Sanitizes a client-supplied node name (folder name, upload filename, or a
 * rename target): strips CR/LF and other control characters, trims, caps
 * length, and rejects anything empty, containing a path separator, or equal
 * to `.`/`..`. Returns `null` if the result is unusable. Used everywhere a
 * client name is accepted (spec §8 — names are trusted display strings, not
 * path segments; storage paths are always `${ownerId}/${nodeId}`, never the
 * client name).
 */
function sanitizeNodeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  let name = raw.replace(/[\x00-\x1F\x7F]/g, '');
  name = name.trim();
  if (name.length === 0) return null;
  if (name.length > MAX_NAME_LENGTH) {
    name = name.slice(0, MAX_NAME_LENGTH);
  }
  if (name.includes('/') || name.includes('\\')) return null;
  if (name === '.' || name === '..') return null;
  return name;
}

/** ASCII-only fallback for the RFC 6266 `filename=` parameter (quoted-string safe). */
function asciiFallbackName(name: string): string {
  const out = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return out.length > 0 ? out : 'download';
}

/** Percent-encodes every UTF-8 byte outside RFC 5987's `attr-char` unreserved set. */
function percentEncodeUtf8(str: string): string {
  const bytes = Buffer.from(str, 'utf8');
  let out = '';
  for (const byte of bytes) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(ch)) {
      out += ch;
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

/**
 * Builds an RFC 6266 `Content-Disposition: attachment` header value. CR/LF
 * and other control characters are stripped from the name FIRST (header-
 * injection guard) before either encoding is derived.
 */
function buildContentDisposition(rawName: string): string {
  // eslint-disable-next-line no-control-regex
  const stripped = rawName.replace(/[\r\n\x00-\x1F\x7F]/g, '');
  const ascii = asciiFallbackName(stripped);
  const encoded = percentEncodeUtf8(stripped);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Owner-scoped raw row fetch — `undefined` if absent OR owned by someone else (never distinguish the two). */
function getOwnedNode(db: Database.Database, ownerId: number, nodeId: number): Node | undefined {
  const row = db.prepare('SELECT * FROM nodes WHERE id = @nodeId').get({ nodeId }) as Node | undefined;
  if (!row || row.owner_id !== ownerId) return undefined;
  return row;
}

/**
 * Cap on the total number of nodes a single size-rollup query will traverse
 * before its recursive CTE stops (loop/DoS-safety — mirrors
 * shares/resolver.ts's `MAX_CHAIN_DEPTH` pattern). Review H3 finding #5: an
 * unbounded per-folder recursive-CTE rollup, run once per folder returned by
 * `GET /api/nodes`, let any authenticated user freeze this single-process app
 * with a pathologically deep/wide tree. The `LIMIT` sits inside the
 * recursive term of the CTE itself (not the outer `SELECT`), which bounds how
 * many rows the CTE ever produces, not merely how many the final query
 * returns — confirmed empirically against this exact better-sqlite3 version
 * (see https://www.sqlite.org/lang_with.html, "Outer LIMIT and OFFSET"). A
 * subtree larger than this cap yields an under-count rather than an
 * unbounded scan — an acceptable trade-off for a pathological case that
 * should never occur in normal usage.
 */
const MAX_ROLLUP_NODES = 10_000;

/**
 * Sums `size_bytes` over `nodeId`'s subtree, bounded to at most
 * `MAX_ROLLUP_NODES` nodes total.
 *  - `includeTrashed=false` (a LIVE folder, as returned by `GET /api/nodes`):
 *    the walk stops at any already-trashed descendant and only live files are
 *    summed — same contract as `nodes/tree.ts`'s `rollupSize`.
 *  - `includeTrashed=true` (a TRASHED folder, as returned by `GET
 *    /api/nodes/trash` — review H3 finding #1): `trashNode()` stamps a
 *    node's whole live subtree with the identical `trashed_at` in one shot,
 *    so a trashed folder's own descendants also read as trashed and
 *    `rollupSize`'s live-only walk (which only descends through
 *    `trashed_at IS NULL` children) stops immediately at the top node,
 *    always summing to 0. The walk here instead descends the full physical
 *    subtree unconditionally (matching what `permanentDelete` would free)
 *    and sums every file regardless of its own `trashed_at`.
 */
function rollupSizeBounded(db: Database.Database, nodeId: number, includeTrashed: boolean): number {
  const sql = includeTrashed
    ? `WITH RECURSIVE sub(id) AS (
         SELECT id FROM nodes WHERE id = @nodeId
         UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id
         LIMIT @cap
       )
       SELECT COALESCE(SUM(size_bytes), 0) AS total FROM nodes
       WHERE id IN (SELECT id FROM sub) AND kind = 'file'`
    : `WITH RECURSIVE sub(id) AS (
         SELECT id FROM nodes WHERE id = @nodeId
         UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id WHERE n.trashed_at IS NULL
         LIMIT @cap
       )
       SELECT COALESCE(SUM(size_bytes), 0) AS total FROM nodes
       WHERE id IN (SELECT id FROM sub) AND kind = 'file' AND trashed_at IS NULL`;

  const row = db.prepare(sql).get({ nodeId, cap: MAX_ROLLUP_NODES }) as { total: number };
  return row.total;
}

/** Folders roll up their size on read (their own `size_bytes` column is always 0). */
function toDto(db: Database.Database, node: Node): NodeDto {
  const sizeBytes =
    node.kind === 'folder' ? rollupSizeBounded(db, node.id, node.trashed_at !== null) : node.size_bytes;
  return {
    id: node.id,
    parent_id: node.parent_id,
    kind: node.kind,
    name: node.name,
    size_bytes: sizeBytes,
    mime_type: node.mime_type,
    auto_delete_at: node.auto_delete_at,
    created_at: node.created_at,
    updated_at: node.updated_at,
  };
}

function parseIdParam(req: FastifyRequest): number | null {
  const raw = (req.params as { id?: string }).id;
  const id = Number(raw);
  return Number.isInteger(id) ? id : null;
}

/**
 * Maps an error thrown by nodes/tree.js or nodes/trash.js to an HTTP
 * response. `CycleError` -> 409 cycle. `CollisionError`/raw SQLite UNIQUE
 * (via `mapDbError`) -> 409 name_conflict. Anything else thrown by those
 * modules means the node/parent was missing, foreign, wrong kind, or
 * otherwise invalid (they never throw for any other reason) -> 404, never
 * 403 (owner-scoped: never confirm existence).
 */
function handleServiceError(e: unknown, reply: FastifyReply): void {
  if (e instanceof CycleError) {
    reply.code(409).send({ code: 'cycle' });
    return;
  }
  const mapped = mapDbError(e);
  if (mapped.http !== 500) {
    reply.code(mapped.http).send({ code: mapped.code });
    return;
  }
  if (e instanceof Error) {
    reply.code(404).send({ error: 'not_found' });
    return;
  }
  throw e;
}

/**
 * Performs a combined move+rename as ONE `UPDATE` that sets `parent_id`,
 * `name`, and `updated_at` together (review H3 findings #2/#4). Calling
 * `moveNode` then `renameNode` as two separate dependent UPDATEs persists an
 * INTERMEDIATE state (new parent, OLD name) that can spuriously collide with
 * an existing live sibling even when the caller's actual final request (new
 * parent, NEW name) collides with nothing at all. Mirrors `moveNode`'s own
 * validation (node + destination ownership/kind, live destination, cycle
 * check via `isAncestor`) so every rejection reason it can throw is
 * unchanged; a UNIQUE-constraint violation on the single combined `UPDATE`
 * is left as a raw SQLite error for the caller's shared `mapDbError`/
 * `handleServiceError` path to map to `409 name_conflict`, exactly like
 * `moveNode`/`renameNode`'s own raw-error fallback already does.
 */
function moveAndRename(
  db: Database.Database,
  ownerId: number,
  nodeId: number,
  newParentId: number,
  newName: string,
  now: number
): Node {
  const node = db.prepare('SELECT owner_id, kind FROM nodes WHERE id = @nodeId').get({ nodeId }) as
    | { owner_id: number; kind: Node['kind'] }
    | undefined;
  if (!node || node.owner_id !== ownerId || (node.kind !== 'folder' && node.kind !== 'file')) {
    throw new Error(`Invalid node for moveAndRename: ${nodeId}`);
  }

  const newParent = db
    .prepare('SELECT owner_id, kind, trashed_at FROM nodes WHERE id = @newParentId')
    .get({ newParentId }) as
    | { owner_id: number; kind: Node['kind']; trashed_at: number | null }
    | undefined;
  if (
    !newParent ||
    newParent.owner_id !== ownerId ||
    (newParent.kind !== 'root' && newParent.kind !== 'folder') ||
    newParent.trashed_at !== null
  ) {
    throw new Error(`Invalid destination for moveAndRename: ${newParentId}`);
  }

  if (nodeId === newParentId || isAncestor(db, nodeId, newParentId)) {
    throw new CycleError();
  }

  db.prepare(
    'UPDATE nodes SET parent_id = @newParentId, name = @newName, updated_at = @now WHERE id = @nodeId AND owner_id = @ownerId'
  ).run({ nodeId, newParentId, newName, now, ownerId });

  return db.prepare('SELECT * FROM nodes WHERE id = @nodeId').get({ nodeId }) as Node;
}

/** Waits for `stream`'s `open` event, or rejects with the `error` event's error (e.g. ENOENT). */
function waitForOpen(stream: ReadStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once('open', () => resolve());
    stream.once('error', (err) => reject(err));
  });
}

const folderBodySchema = z.object({
  parent_id: z.number().int(),
  name: z.string(),
});

const patchBodySchema = z
  .object({
    name: z.string().optional(),
    parent_id: z.number().int().optional(),
  })
  .refine((v) => v.name !== undefined || v.parent_id !== undefined, {
    message: 'at least one of name/parent_id is required',
  });

const autoDeleteBodySchema = z.object({
  auto_delete_at: z.number().int().nullable(),
});

/**
 * Registers `/api/nodes/*` — every handler `requireAuth` + owner-scoped.
 * `deps.blobStore` MUST be built from the same injected config as the rest of
 * the app (`createBlobStore({ storageDir: config.STORAGE_DIR })` in
 * `app.ts`), never the bare `storage/blobs.js` exports — those bind to a
 * lazily-cached default store keyed off `process.env`, which would silently
 * diverge from a test's (or a future multi-instance run's) injected config.
 */
export default async function nodesRoutes(app: FastifyInstance, deps: NodesRouteDeps): Promise<void> {
  const { db, now, guards, blobStore } = deps;

  app.get('/api/nodes', { preHandler: guards.requireAuth }, async (req, reply) => {
    const uid = req.user!.id;
    const nowMs = now();
    const { rootId } = ensureUserRoots(db, uid, nowMs);

    const query = req.query as { parent?: string };
    const parentId = query.parent !== undefined ? Number(query.parent) : rootId;
    if (!Number.isInteger(parentId)) {
      reply.code(400).send({ error: 'invalid_parent' });
      return;
    }

    const parent = getOwnedNode(db, uid, parentId);
    if (!parent || (parent.kind !== 'root' && parent.kind !== 'folder')) {
      reply.code(404).send({ error: 'not_found' });
      return;
    }

    const children = listChildren(db, uid, parentId);
    reply.code(200).send(children.map((n) => toDto(db, n)));
  });

  app.get('/api/nodes/trash', { preHandler: guards.requireAuth }, async (req, reply) => {
    const uid = req.user!.id;
    const rows = db
      .prepare('SELECT * FROM nodes WHERE owner_id = @uid AND trashed_at IS NOT NULL ORDER BY trashed_at DESC')
      .all({ uid }) as Node[];
    reply.code(200).send(rows.map((n) => toDto(db, n)));
  });

  app.post('/api/nodes/folder', { preHandler: guards.requireAuth }, async (req, reply) => {
    const parsed = folderBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid_body' });
      return;
    }

    const name = sanitizeNodeName(parsed.data.name);
    if (name === null) {
      reply.code(400).send({ error: 'invalid_name' });
      return;
    }

    const uid = req.user!.id;
    const nowMs = now();
    try {
      const node = createFolder(db, uid, parsed.data.parent_id, name, nowMs);
      reply.code(201).send(toDto(db, node));
    } catch (e) {
      handleServiceError(e, reply);
    }
  });

  app.post('/api/nodes/upload', { preHandler: guards.requireAuth }, async (req, reply) => {
    const uid = req.user!.id;
    const nowMs = now();

    let data;
    try {
      data = await req.file();
    } catch {
      reply.code(400).send({ error: 'invalid_upload' });
      return;
    }
    if (!data) {
      reply.code(400).send({ error: 'invalid_upload' });
      return;
    }

    const query = req.query as { parent_id?: string };
    const parentField = data.fields.parent_id;
    const parentFieldValue =
      parentField && !Array.isArray(parentField) && parentField.type === 'field'
        ? String(parentField.value)
        : undefined;
    const parentIdRaw = query.parent_id ?? parentFieldValue;

    const { rootId } = ensureUserRoots(db, uid, nowMs);
    const parentId = parentIdRaw !== undefined ? Number(parentIdRaw) : rootId;
    if (!Number.isInteger(parentId)) {
      data.file.resume();
      reply.code(400).send({ error: 'invalid_parent' });
      return;
    }

    const parent = getOwnedNode(db, uid, parentId);
    if (!parent || (parent.kind !== 'root' && parent.kind !== 'folder')) {
      data.file.resume();
      reply.code(404).send({ error: 'not_found' });
      return;
    }

    // reserve `min(Content-Length, MAX_FILE_BYTES)` up front (spec §8) — a
    // conservative upper bound reconciled to the real byte count below.
    const declaredRaw = req.headers['content-length'];
    const declared = declaredRaw !== undefined ? Number(declaredRaw) : NaN;
    const reserveBytes = Math.min(Number.isFinite(declared) && declared > 0 ? declared : MAX_FILE_BYTES, MAX_FILE_BYTES);

    const reserved = reserve(db, uid, reserveBytes, nowMs);
    if (!reserved) {
      data.file.resume();
      reply.code(413).send({ code: 'quota_exceeded' });
      return;
    }

    let tempPath: string;
    let bytes: number;
    try {
      const written = await blobStore.writeStreamToTemp(String(uid), data.file, MAX_FILE_BYTES);
      tempPath = written.tempPath;
      bytes = written.bytes;
    } catch {
      release(db, uid, reserveBytes);
      reply.code(413).send({ code: 'file_too_large' });
      return;
    }

    // @fastify/multipart's own `limits.fileSize` (app.ts, the same
    // MAX_FILE_BYTES) truncates the part's stream at exactly that many bytes
    // instead of erroring it — writeStreamToTemp's own over-limit Transform
    // never sees more than MAX_FILE_BYTES bytes, so it resolves normally
    // above with `bytes === MAX_FILE_BYTES` even though the real upload was
    // larger. `data.file.truncated` is the only signal that this happened
    // (review H3 finding #3, critical) and must be checked explicitly, or an
    // over-limit upload is silently accepted (200) instead of rejected (413).
    if (data.file.truncated) {
      release(db, uid, reserveBytes);
      await unlink(tempPath).catch(() => {});
      reply.code(413).send({ code: 'file_too_large' });
      return;
    }

    const base = sanitizeNodeName(data.filename) ?? 'file';
    const finalName = nextSuffixedName(db, parentId, base);

    // Row-first (CARRY from G): the node row (with its final storage_path
    // already set) is committed BEFORE commitTemp renames the blob into its
    // final name, so the scheduler's orphanBlobs walk never sees a
    // final-named blob with no matching row.
    let nodeId: number;
    try {
      const insertFile = db.transaction((): number => {
        const info = db
          .prepare(
            `INSERT INTO nodes(owner_id, parent_id, kind, name, size_bytes, mime_type, storage_path, created_at, updated_at)
             VALUES (@ownerId, @parentId, 'file', @name, @sizeBytes, @mimeType, NULL, @now, @now)`
          )
          .run({
            ownerId: uid,
            parentId,
            name: finalName,
            sizeBytes: bytes,
            mimeType: data.mimetype ?? null,
            now: nowMs,
          });
        const id = Number(info.lastInsertRowid);
        db.prepare('UPDATE nodes SET storage_path = @storagePath WHERE id = @id').run({
          storagePath: `${uid}/${id}`,
          id,
        });
        return id;
      });
      nodeId = insertFile();
    } catch (e) {
      release(db, uid, reserveBytes);
      await unlink(tempPath).catch(() => {});
      handleServiceError(e, reply);
      return;
    }

    try {
      blobStore.commitTemp(tempPath, String(uid), String(nodeId));
    } catch {
      db.prepare('DELETE FROM nodes WHERE id = @nodeId').run({ nodeId });
      release(db, uid, reserveBytes);
      await unlink(tempPath).catch(() => {});
      reply.code(500).send({ error: 'internal' });
      return;
    }

    commitActual(db, uid, reserveBytes, bytes);
    writeAudit(db, { actorId: uid, action: 'upload', target: String(nodeId) }, now);

    const finalNode = getOwnedNode(db, uid, nodeId)!;
    reply.code(200).send(toDto(db, finalNode));
  });

  app.patch('/api/nodes/:id', { preHandler: guards.requireAuth }, async (req, reply) => {
    const id = parseIdParam(req);
    if (id === null) {
      reply.code(404).send({ error: 'not_found' });
      return;
    }

    const parsed = patchBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid_body' });
      return;
    }

    let sanitizedName: string | null = null;
    if (parsed.data.name !== undefined) {
      sanitizedName = sanitizeNodeName(parsed.data.name);
      if (sanitizedName === null) {
        reply.code(400).send({ error: 'invalid_name' });
        return;
      }
    }

    const uid = req.user!.id;
    const nowMs = now();
    try {
      const run = db.transaction((): Node => {
        const wantsMove = parsed.data.parent_id !== undefined;
        const wantsRename = sanitizedName !== null;
        // Combined move+rename runs as ONE update (moveAndRename) — never
        // moveNode-then-renameNode — so a collision check only ever sees the
        // final (new parent, new name) state, never the intermediate one
        // (review H3 findings #2/#4).
        if (wantsMove && wantsRename) {
          return moveAndRename(db, uid, id, parsed.data.parent_id!, sanitizedName!, nowMs);
        }
        if (wantsMove) {
          return moveNode(db, uid, id, parsed.data.parent_id!, nowMs);
        }
        return renameNode(db, uid, id, sanitizedName!, nowMs);
      });
      const node = run();
      reply.code(200).send(toDto(db, node));
    } catch (e) {
      handleServiceError(e, reply);
    }
  });

  app.post('/api/nodes/:id/trash', { preHandler: guards.requireAuth }, async (req, reply) => {
    const id = parseIdParam(req);
    if (id === null) {
      reply.code(404).send({ error: 'not_found' });
      return;
    }
    const uid = req.user!.id;
    try {
      const node = trashNode(db, uid, id, now());
      reply.code(200).send(toDto(db, node));
    } catch (e) {
      handleServiceError(e, reply);
    }
  });

  app.post('/api/nodes/:id/restore', { preHandler: guards.requireAuth }, async (req, reply) => {
    const id = parseIdParam(req);
    if (id === null) {
      reply.code(404).send({ error: 'not_found' });
      return;
    }
    const uid = req.user!.id;
    try {
      const node = restoreNode(db, uid, id, now());
      reply.code(200).send(toDto(db, node));
    } catch (e) {
      handleServiceError(e, reply);
    }
  });

  app.delete('/api/nodes/:id', { preHandler: guards.requireAuth }, async (req, reply) => {
    const id = parseIdParam(req);
    if (id === null) {
      reply.code(404).send({ error: 'not_found' });
      return;
    }
    const uid = req.user!.id;
    let result: { freedBytes: number; storagePaths: string[] };
    try {
      result = permanentDelete(db, uid, id);
    } catch (e) {
      handleServiceError(e, reply);
      return;
    }

    // Outside the try/catch above on purpose: permanentDelete already
    // committed (the row and used_bytes are gone for good), so a failure
    // here must never be mis-mapped to a 404 by handleServiceError — that
    // would falsely read as "node never existed" for something that already
    // succeeded.
    for (const p of result.storagePaths) {
      blobStore.deleteBlob(p);
    }
    writeAudit(db, { actorId: uid, action: 'permanent_delete', target: String(id) }, now);
    reply.code(200).send({ freedBytes: result.freedBytes });
  });

  app.patch('/api/nodes/:id/auto-delete', { preHandler: guards.requireAuth }, async (req, reply) => {
    const id = parseIdParam(req);
    if (id === null) {
      reply.code(404).send({ error: 'not_found' });
      return;
    }

    const parsed = autoDeleteBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid_body' });
      return;
    }

    const uid = req.user!.id;
    const node = getOwnedNode(db, uid, id);
    if (!node || (node.kind !== 'folder' && node.kind !== 'file')) {
      reply.code(404).send({ error: 'not_found' });
      return;
    }

    const nowMs = now();
    const { auto_delete_at: autoDeleteAt } = parsed.data;
    if (autoDeleteAt !== null && autoDeleteAt <= nowMs) {
      reply.code(400).send({ code: 'past_date' });
      return;
    }

    db.prepare('UPDATE nodes SET auto_delete_at = @autoDeleteAt, updated_at = @now WHERE id = @id AND owner_id = @uid').run({
      autoDeleteAt,
      now: nowMs,
      id,
      uid,
    });

    const updated = getOwnedNode(db, uid, id)!;
    reply.code(200).send(toDto(db, updated));
  });

  app.get('/api/nodes/:id/download', { preHandler: guards.requireAuth }, async (req, reply) => {
    const id = parseIdParam(req);
    if (id === null) {
      reply.code(404).send({ error: 'not_found' });
      return;
    }

    const uid = req.user!.id;
    const node = getOwnedNode(db, uid, id);
    if (!node || node.kind !== 'file' || !node.storage_path) {
      reply.code(404).send({ error: 'not_found' });
      return;
    }

    const stream = blobStore.readBlob(node.storage_path);
    try {
      await waitForOpen(stream);
    } catch (e) {
      // Reverse-orphan (CARRY from G): the row exists but its blob is gone
      // from disk — never a 500.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        reply.code(404).send({ error: 'not_found' });
        return;
      }
      throw e;
    }

    reply.header('Content-Disposition', buildContentDisposition(node.name));
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Type', node.mime_type ?? 'application/octet-stream');

    writeAudit(db, { actorId: uid, action: 'download', target: String(id) }, now);

    // Streams need the handler's own promise to resolve to the reply (not
    // undefined) — Fastify only reliably pipes a stream payload set via
    // `reply.send()` inside an async handler when that call is also
    // `return`ed, confirmed empirically against this Fastify version.
    return reply.send(stream);
  });
}
