import type { FastifyInstance } from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { Clock } from '../clock.js';
import type { PasswordService } from '../auth/passwords.js';
import type { BlobStore } from '../storage/blobs.js';
import type { Config } from '../config.js';
import { writeAudit } from '../audit.js';
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

const UNLOCK_IP_RATE_LIMIT_MAX = 20;
const UNLOCK_TOKEN_RATE_LIMIT_MAX = 5;
const UNLOCK_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const unlockSchema = z.object({ password: z.string().min(1) });

/**
 * The public intake gate for Collections. NO auth, NO CSRF. Each route carries
 * its full `/api/collect/...` path. Every response is stamped
 * `Referrer-Policy: no-referrer` (so a link token never leaks via Referer) and
 * `Cache-Control: no-store` (a collection's open/closed state changes out from
 * under a recipient) via an encapsulated onSend hook scoped to THIS plugin
 * only. Mirrors routes/public.ts.
 */
export default async function collectRoutes(app: FastifyInstance, deps: CollectRouteDeps): Promise<void> {
  const { db, now, config, passwordService } = deps;
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
}
