import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { Clock } from '../clock.js';
import type { Guards } from '../auth/guards.js';
import type { Config } from '../config.js';
import {
  createShare,
  ownerStatus,
  revokeShare,
  setShareState,
  type SetShareStatePatch,
  type Share,
} from '../shares/shares.js';

export interface SharesRouteDeps {
  db: Database.Database;
  now: Clock;
  guards: Guards;
  config: Config;
}

/**
 * Owner-facing projection of a share row. Deliberately omits `password_hash`
 * (and every other column that could leak a secret): the presence of a
 * password is exposed only as the boolean `has_password`, never the hash
 * itself. `status` is derived fresh via {@link ownerStatus} against the
 * current clock; `url` is the shareable public link.
 */
interface ShareDto {
  id: number;
  node_id: number;
  token: string;
  is_active: boolean;
  has_password: boolean;
  expires_at: number | null;
  allow_download: boolean;
  created_at: number;
  status: 'active' | 'stopped' | 'expired';
  url: string;
}

function toShareDto(share: Share, publicBaseUrl: string, nowMs: number): ShareDto {
  return {
    id: share.id,
    node_id: share.node_id,
    token: share.token,
    is_active: !!share.is_active,
    has_password: share.password_hash !== null,
    expires_at: share.expires_at,
    allow_download: !!share.allow_download,
    created_at: share.created_at,
    status: ownerStatus(share, nowMs),
    url: `${publicBaseUrl}/s/${share.token}`,
  };
}

function parseIdParam(req: FastifyRequest): number | null {
  const raw = (req.params as { id?: string }).id;
  const id = Number(raw);
  return Number.isInteger(id) ? id : null;
}

const createShareSchema = z.object({
  node_id: z.number().int(),
  // Absent/empty => no password (createShare treats a falsy value as unset).
  password: z.string().optional(),
  // epoch-ms; null/absent => never expires.
  expires_at: z.number().int().nullable().optional(),
});

const patchShareSchema = z
  .object({
    is_active: z.boolean().optional(),
    // Tri-state: absent = unchanged, null = clear the password, string = set it.
    password: z.string().nullable().optional(),
    // Tri-state: absent = unchanged, null = never-expires, number = new deadline.
    expires_at: z.number().int().nullable().optional(),
  })
  .refine((v) => v.is_active !== undefined || v.password !== undefined || v.expires_at !== undefined, {
    message: 'at least one field is required',
  });

/**
 * Owner-scoped share management. Every handler runs behind
 * `guards.requireAuth` (which also enforces the CSRF double-submit on the
 * mutating verbs), and every DB access is scoped to `req.user.id` so a share
 * owned by another user is never confirmed to exist (404, never 403).
 */
export default async function sharesRoutes(app: FastifyInstance, deps: SharesRouteDeps): Promise<void> {
  const { db, now, guards, config } = deps;
  const publicBaseUrl = config.PUBLIC_BASE_URL;

  app.get('/api/shares', { preHandler: guards.requireAuth }, async (req, reply) => {
    const uid = req.user!.id;
    const nowMs = now();
    const rows = db
      .prepare('SELECT * FROM shares WHERE owner_id = @uid ORDER BY created_at DESC, id DESC')
      .all({ uid }) as Share[];
    reply.code(200).send(rows.map((s) => toShareDto(s, publicBaseUrl, nowMs)));
  });

  app.post('/api/shares', { preHandler: guards.requireAuth }, async (req, reply) => {
    const parsed = createShareSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid_body' });
      return;
    }
    const uid = req.user!.id;
    const { node_id: nodeId, password, expires_at: expiresAt } = parsed.data;

    // FIRM SECURITY GUARD (CARRY from F): a synthetic `root`/`trash` node must
    // never be shareable — sharing the root would expose the whole tree
    // through the public subtree resolver. Checked BEFORE createShare, scoped
    // to the owner so a foreign/missing node reveals nothing here (it falls
    // through to createShare, which throws -> generic 404 below).
    const node = db.prepare('SELECT owner_id, kind FROM nodes WHERE id = @nodeId').get({ nodeId }) as
      | { owner_id: number; kind: string }
      | undefined;
    if (node && node.owner_id === uid && (node.kind === 'root' || node.kind === 'trash')) {
      reply.code(400).send({ code: 'unshareable' });
      return;
    }

    try {
      const share = await createShare(db, uid, nodeId, { password, expiresAt }, now());
      reply.code(201).send(toShareDto(share, publicBaseUrl, now()));
    } catch {
      // createShare only throws when the node is missing, foreign, or trashed.
      // Owner-scoped: never distinguish those — a plain 404.
      reply.code(404).send({ error: 'not_found' });
    }
  });

  app.patch('/api/shares/:id', { preHandler: guards.requireAuth }, async (req, reply) => {
    const id = parseIdParam(req);
    if (id === null) {
      reply.code(404).send({ error: 'not_found' });
      return;
    }
    const parsed = patchShareSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid_body' });
      return;
    }

    // Only forward the keys that were actually present, so setShareState's
    // tri-state (undefined = leave alone) is preserved exactly.
    const patch: SetShareStatePatch = {};
    if (parsed.data.is_active !== undefined) patch.isActive = parsed.data.is_active;
    if (parsed.data.password !== undefined) patch.password = parsed.data.password;
    if (parsed.data.expires_at !== undefined) patch.expiresAt = parsed.data.expires_at;

    const uid = req.user!.id;
    const updated = await setShareState(db, uid, id, patch);
    if (!updated) {
      reply.code(404).send({ error: 'not_found' });
      return;
    }
    reply.code(200).send(toShareDto(updated, publicBaseUrl, now()));
  });

  app.delete('/api/shares/:id', { preHandler: guards.requireAuth }, async (req, reply) => {
    const id = parseIdParam(req);
    if (id === null) {
      reply.code(404).send({ error: 'not_found' });
      return;
    }
    const uid = req.user!.id;

    // Confirm ownership first so a missing/foreign share is a 404. The lookup
    // and the delete are both synchronous with no await between them, so no
    // other request can interleave — the check is effectively atomic.
    const existing = db.prepare('SELECT id FROM shares WHERE id = @id AND owner_id = @uid').get({ id, uid }) as
      | { id: number }
      | undefined;
    if (!existing) {
      reply.code(404).send({ error: 'not_found' });
      return;
    }
    revokeShare(db, uid, id);
    reply.code(200).send({ ok: true });
  });
}
