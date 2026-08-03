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
 * The public intake gate for Collections. NO auth, NO CSRF. Each route carries
 * its full `/api/collect/...` path. Every response is stamped
 * `Referrer-Policy: no-referrer` (so a link token never leaks via Referer) and
 * `Cache-Control: no-store` (a collection's open/closed state changes out from
 * under a recipient) via an encapsulated onSend hook scoped to THIS plugin
 * only. Mirrors routes/public.ts.
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
