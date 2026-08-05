import { unlink } from 'node:fs/promises';
import type { ReadStream } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { Clock } from '../clock.js';
import type { PasswordService } from '../auth/passwords.js';
import type { BlobStore } from '../storage/blobs.js';
import type { Config } from '../config.js';
import { MAX_FILE_BYTES, COLLECTION_MAX_FILES_PER_RESPONSE, MAX_NOTE_LENGTH } from '../config.js';
import { writeAudit } from '../audit.js';
import { collectionStatus, type Collection } from '../collections/collections.js';
import { listDepartments } from '../collections/departments.js';
import { createUnlockGate } from '../collections/unlock.js';
import { commitResponse, responseHeadroom, QuotaExceededError, type StagedFile } from '../collections/responses.js';
import { sanitizeNodeName } from '../util/names.js';
import { buildContentDisposition } from '../util/content-disposition.js';

export interface CollectRouteDeps {
  db: Database.Database;
  now: Clock;
  passwordService: PasswordService;
  blobStore: BlobStore;
  config: Config;
}

const UNLOCK_IP_RATE_LIMIT_MAX = 20;
const UNLOCK_TOKEN_RATE_LIMIT_MAX = 5;
const UNLOCK_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const unlockSchema = z.object({ password: z.string().min(1) });

const READ_IP_RATE_LIMIT_MAX = 60;
const READ_TOKEN_RATE_LIMIT_MAX = 120;
const READ_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

const SUBMIT_IP_RATE_LIMIT_MAX = 20;
const SUBMIT_TOKEN_RATE_LIMIT_MAX = 40;
const SUBMIT_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

/** Waits for `stream`'s `open`, or rejects with its `error` (e.g. ENOENT). */
function waitForOpen(stream: ReadStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once('open', () => resolve());
    stream.once('error', (err) => reject(err));
  });
}

/**
 * The public intake gate for Collections. NO auth, NO CSRF. Each route carries
 * its full `/api/collect/...` path. Every response is stamped
 * `Referrer-Policy: no-referrer` (so a link token never leaks via Referer) and
 * `Cache-Control: no-store` (a collection's open/closed state changes out from
 * under a recipient) via an encapsulated onSend hook scoped to THIS plugin
 * only. Mirrors routes/public.ts.
 */
export default async function collectRoutes(app: FastifyInstance, deps: CollectRouteDeps): Promise<void> {
  const { db, now, config, passwordService, blobStore } = deps;
  const gate = createUnlockGate(config.SESSION_SECRET);

  /**
   * For a password collection, requires a valid unlock cookie. Sends
   * `401 {needsPassword:true}` and returns false when locked; true otherwise.
   */
  function requireUnlocked(req: FastifyRequest, reply: FastifyReply, c: Collection): boolean {
    if (c.password_hash !== null && !gate.isUnlocked(req.cookies[gate.cookieName], c.token, c.password_hash, now())) {
      reply.code(401).send({ needsPassword: true });
      return false;
    }
    return true;
  }

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
        .prepare(
          "SELECT name FROM nodes WHERE id = @id AND owner_id = @ownerId AND kind = 'file' AND trashed_at IS NULL",
        )
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

  // --- POST unlock (rate-limited per-IP AND per-token) --------------------
  // Two independent @fastify/rate-limit instances (per-IP + per-token) in a
  // dedicated child scope — same two-registration pattern as routes/public.ts.
  await app.register(async function collectUnlockScope(scope) {
    await scope.register(fastifyRateLimit, {
      max: UNLOCK_IP_RATE_LIMIT_MAX,
      timeWindow: UNLOCK_RATE_LIMIT_WINDOW_MS,
      hook: 'preHandler',
      keyGenerator: (req) => req.ip,
    });
    await scope.register(fastifyRateLimit, {
      max: UNLOCK_TOKEN_RATE_LIMIT_MAX,
      timeWindow: UNLOCK_RATE_LIMIT_WINDOW_MS,
      hook: 'preHandler',
      keyGenerator: (req) => (req.params as { token?: string }).token ?? '',
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
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: gate.cookiePath(token),
      });
      reply.code(200).send({ ok: true });
    });
  });

  // --- GET template (rate-limited per-IP AND per-token) -------------------
  await app.register(async function collectTemplateScope(scope) {
    await scope.register(fastifyRateLimit, {
      max: READ_IP_RATE_LIMIT_MAX,
      timeWindow: READ_RATE_LIMIT_WINDOW_MS,
      hook: 'preHandler',
      keyGenerator: (req) => req.ip,
    });
    await scope.register(fastifyRateLimit, {
      max: READ_TOKEN_RATE_LIMIT_MAX,
      timeWindow: READ_RATE_LIMIT_WINDOW_MS,
      hook: 'preHandler',
      keyGenerator: (req) => (req.params as { token?: string }).token ?? '',
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
        | {
            owner_id: number;
            kind: string;
            name: string;
            mime_type: string | null;
            storage_path: string | null;
            trashed_at: number | null;
          }
        | undefined;
      if (
        !node ||
        node.owner_id !== c.owner_id ||
        node.kind !== 'file' ||
        node.trashed_at !== null ||
        !node.storage_path
      ) {
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

  // --- POST submit (the inbound write; rate-limited per-IP AND per-token) --
  await app.register(async function collectSubmitScope(scope) {
    await scope.register(fastifyRateLimit, {
      max: SUBMIT_IP_RATE_LIMIT_MAX,
      timeWindow: SUBMIT_RATE_LIMIT_WINDOW_MS,
      hook: 'preHandler',
      keyGenerator: (req) => req.ip,
    });
    await scope.register(fastifyRateLimit, {
      max: SUBMIT_TOKEN_RATE_LIMIT_MAX,
      timeWindow: SUBMIT_RATE_LIMIT_WINDOW_MS,
      hook: 'preHandler',
      keyGenerator: (req) => (req.params as { token?: string }).token ?? '',
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
      const cleanupTemps = async (): Promise<void> => {
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
        result = commitResponse(
          db,
          ownerId,
          { id: c.id, folder_node_id: c.folder_node_id },
          dept,
          staged,
          note,
          req.ip,
          now(),
        );
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
          detail: JSON.stringify({
            collection_id: c.id,
            department_id: dept.id,
            department_name: dept.name,
            file_count: staged.length,
          }),
        },
        now,
      );

      reply.code(200).send({ ok: true });
    });
  });
}
