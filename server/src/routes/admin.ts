import type { FastifyInstance, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { Clock } from '../clock.js';
import type { Guards } from '../auth/guards.js';
import type { PasswordService } from '../auth/passwords.js';
import { revokeAllForUser } from '../auth/sessions.js';
import { randomToken } from '../util/ids.js';
import { writeAudit } from '../audit.js';
import { ownerStatus, type Share } from '../shares/shares.js';

export interface AdminRouteDeps {
  db: Database.Database;
  now: Clock;
  guards: Guards;
  passwordService: PasswordService;
}

/**
 * Admin-facing projection of a user row. Deliberately omits `password_hash`
 * (and the internal `root_node_id`/`trash_node_id`/`created_by` bookkeeping):
 * an admin manages accounts and sees usage, never a secret. `is_active` /
 * `must_change_password` are returned as their raw 0/1 INTEGER (matching the
 * DB column) so the panel can render them without a lossy boolean cast.
 */
interface AdminUserDto {
  id: number;
  username: string;
  role: string;
  is_active: number;
  quota_bytes: number | null;
  used_bytes: number;
  must_change_password: number;
  created_at: number;
}

interface UserRow extends AdminUserDto {
  // no extra fields projected — the SELECT below lists exactly the DTO columns
  [key: string]: unknown;
}

/** Row shape for the last-admin / self guards: only what the guards read. */
interface GuardUserRow {
  id: number;
  role: string;
  is_active: number;
}

const USER_DTO_COLUMNS =
  'id, username, role, is_active, quota_bytes, used_bytes, must_change_password, created_at';

/** Metadata-only node projection (spec §7): NEVER `storage_path`, never `owner_id`. */
interface AdminNodeDto {
  id: number;
  parent_id: number | null;
  kind: string;
  name: string;
  size_bytes: number;
  mime_type: string | null;
  trashed_at: number | null;
  auto_delete_at: number | null;
  created_at: number;
}

const NODE_METADATA_COLUMNS =
  'id, parent_id, kind, name, size_bytes, mime_type, trashed_at, auto_delete_at, created_at';

// Username: a safe display+login handle (spec §8 — trusted display strings,
// never path segments). Bounded length; ASCII letters/digits and a small set
// of separators only, so it can never contain control chars, whitespace, or
// path metacharacters.
const USERNAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

const createUserSchema = z.object({
  username: z.string().trim().regex(USERNAME_RE),
  password: z.string().min(1),
  role: z.enum(['admin', 'user']),
  // Absent/undefined => NULL (unlimited). Explicit null also allowed.
  quota_bytes: z.number().int().nonnegative().nullable().optional(),
});

const patchUserSchema = z
  .object({
    is_active: z.boolean().optional(),
    role: z.enum(['admin', 'user']).optional(),
    quota_bytes: z.number().int().nonnegative().nullable().optional(),
  })
  .refine((v) => v.is_active !== undefined || v.role !== undefined || v.quota_bytes !== undefined, {
    message: 'at least one field is required',
  });

const passwordResetSchema = z.object({
  // Admin may supply an explicit password; omitted => a generated one is used.
  password: z.string().min(1).optional(),
});

const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const DEFAULT_AUDIT_LIMIT = 100;
/** Byte length of a generated reset/initial password (base64url => ~16 chars). */
const GENERATED_PASSWORD_BYTES = 12;

function parseIdParam(req: FastifyRequest): number | null {
  const raw = (req.params as { id?: string }).id;
  const id = Number(raw);
  return Number.isInteger(id) ? id : null;
}

/** Number of admins that are currently active — the quantity the last-admin invariant protects. */
function activeAdminCount(db: Database.Database): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND is_active = 1").get() as {
    c: number;
  };
  return row.c;
}

/** True when the caught error is a SQLite UNIQUE-constraint violation (duplicate username). */
function isUniqueViolation(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const code = (e as NodeJS.ErrnoException).code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/i.test(e.message);
}

/**
 * Registers `/api/admin/*` — every handler runs behind `guards.requireAdmin`
 * (which chains `requireAuth`, so the CSRF double-submit is enforced on the
 * mutating verbs too). Every state-changing action writes an `audit_log` row
 * via {@link writeAudit} with the acting admin's id as actor — never any
 * secret in the detail. `deps.passwordService` / `deps.guards` are the single
 * app-wide instances built in `buildApp`, never re-instantiated here.
 */
export default async function adminRoutes(app: FastifyInstance, deps: AdminRouteDeps): Promise<void> {
  const { db, now, guards, passwordService } = deps;

  // --- Users ---------------------------------------------------------------

  app.get('/api/admin/users', { preHandler: guards.requireAdmin }, async (_req, reply) => {
    const rows = db
      .prepare(`SELECT ${USER_DTO_COLUMNS} FROM users ORDER BY created_at ASC, id ASC`)
      .all() as AdminUserDto[];
    reply.code(200).send(rows);
  });

  app.post('/api/admin/users', { preHandler: guards.requireAdmin }, async (req, reply) => {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid_body' });
      return;
    }
    const { username, password, role } = parsed.data;
    const quotaBytes = parsed.data.quota_bytes ?? null;
    const nowMs = now();

    const hash = await passwordService.hashPassword(password);

    let userId: number;
    try {
      const info = db
        .prepare(
          `INSERT INTO users(username, password_hash, role, quota_bytes, used_bytes, is_active, must_change_password, created_by, created_at, updated_at)
           VALUES (@username, @hash, @role, @quotaBytes, 0, 1, 1, @actor, @now, @now)`
        )
        .run({ username, hash, role, quotaBytes, actor: req.user!.id, now: nowMs });
      userId = Number(info.lastInsertRowid);
    } catch (e) {
      if (isUniqueViolation(e)) {
        reply.code(409).send({ code: 'username_taken' });
        return;
      }
      throw e;
    }

    writeAudit(db, { actorId: req.user!.id, action: 'user_create', target: String(userId) }, now);

    const dto = db.prepare(`SELECT ${USER_DTO_COLUMNS} FROM users WHERE id = ?`).get(userId) as AdminUserDto;
    reply.code(201).send(dto);
  });

  app.patch('/api/admin/users/:id', { preHandler: guards.requireAdmin }, async (req, reply) => {
    const id = parseIdParam(req);
    if (id === null) {
      reply.code(404).send({ error: 'not_found' });
      return;
    }

    const parsed = patchUserSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid_body' });
      return;
    }

    const target = db.prepare('SELECT id, role, is_active FROM users WHERE id = ?').get(id) as
      | GuardUserRow
      | undefined;
    if (!target) {
      reply.code(404).send({ error: 'not_found' });
      return;
    }

    const wantsLower = parsed.data.is_active === false || parsed.data.role === 'user';
    const targetIsActiveAdmin = target.role === 'admin' && target.is_active === 1;

    // LAST-ADMIN GUARD checked before the self guard: refusing to drop the
    // active-admin count below 1 is the stronger invariant (spec §3.1). A
    // deactivate/demote of the last active admin is *necessarily* a self
    // action (the actor is itself an active admin, so any OTHER active admin
    // would keep the count >= 1) — so this ordering is what makes such a
    // request report `last_admin` rather than the incidental `self`.
    if (wantsLower && targetIsActiveAdmin && activeAdminCount(db) === 1) {
      reply.code(409).send({ code: 'last_admin' });
      return;
    }
    if (wantsLower && id === req.user!.id) {
      reply.code(409).send({ code: 'self' });
      return;
    }

    const sets: string[] = [];
    const params: Record<string, unknown> = { id, now: now() };
    if (parsed.data.is_active !== undefined) {
      sets.push('is_active = @isActive');
      params.isActive = parsed.data.is_active ? 1 : 0;
    }
    if (parsed.data.role !== undefined) {
      sets.push('role = @role');
      params.role = parsed.data.role;
    }
    if (parsed.data.quota_bytes !== undefined) {
      sets.push('quota_bytes = @quotaBytes');
      params.quotaBytes = parsed.data.quota_bytes;
    }
    sets.push('updated_at = @now');

    const deactivated = parsed.data.is_active === false && target.is_active === 1;

    const run = db.transaction(() => {
      db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = @id`).run(params);
      // Deactivation must sever every live session immediately (spec §7).
      if (deactivated) {
        revokeAllForUser(db, id);
      }
      writeAudit(db, { actorId: req.user!.id, action: 'user_update', target: String(id) }, now);
    });
    run();

    const dto = db.prepare(`SELECT ${USER_DTO_COLUMNS} FROM users WHERE id = ?`).get(id) as AdminUserDto;
    reply.code(200).send(dto);
  });

  app.post('/api/admin/users/:id/password', { preHandler: guards.requireAdmin }, async (req, reply) => {
    const id = parseIdParam(req);
    if (id === null) {
      reply.code(404).send({ error: 'not_found' });
      return;
    }

    const parsed = passwordResetSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid_body' });
      return;
    }

    const target = db.prepare('SELECT id FROM users WHERE id = ?').get(id) as { id: number } | undefined;
    if (!target) {
      reply.code(404).send({ error: 'not_found' });
      return;
    }

    // Generate one iff the admin did not supply an explicit password. A
    // generated password is returned ONCE below; an admin-supplied one is
    // NEVER echoed back (the admin already has it). Neither is ever logged
    // or written to the audit detail.
    const generated = parsed.data.password === undefined ? randomToken(GENERATED_PASSWORD_BYTES) : null;
    const plaintext = parsed.data.password ?? generated!;
    const hash = await passwordService.hashPassword(plaintext);
    const nowMs = now();

    const run = db.transaction(() => {
      db.prepare(
        'UPDATE users SET password_hash = @hash, must_change_password = 1, updated_at = @now WHERE id = @id'
      ).run({ hash, now: nowMs, id });
      // Reset severs every existing session — the old password is dead.
      revokeAllForUser(db, id);
      writeAudit(db, { actorId: req.user!.id, action: 'user_password_reset', target: String(id) }, now);
    });
    run();

    reply.code(200).send(generated !== null ? { password: generated } : { ok: true });
  });

  app.delete('/api/admin/users/:id', { preHandler: guards.requireAdmin }, async (req, reply) => {
    const id = parseIdParam(req);
    if (id === null) {
      reply.code(404).send({ error: 'not_found' });
      return;
    }

    const target = db.prepare('SELECT id, role, is_active FROM users WHERE id = ?').get(id) as
      | GuardUserRow
      | undefined;
    if (!target) {
      reply.code(404).send({ error: 'not_found' });
      return;
    }

    const targetIsActiveAdmin = target.role === 'admin' && target.is_active === 1;
    // Same ordering rationale as PATCH: last-admin first (deleting the last
    // active admin is necessarily a self action).
    if (targetIsActiveAdmin && activeAdminCount(db) === 1) {
      reply.code(409).send({ code: 'last_admin' });
      return;
    }
    if (id === req.user!.id) {
      reply.code(409).send({ code: 'self' });
      return;
    }

    // FK cascade removes the user's nodes/sessions/shares. Blobs on disk
    // become orphans, reclaimed by the scheduler's orphan sweep (spec §9) —
    // acceptable; there is no synchronous blob unlink here.
    const run = db.transaction(() => {
      db.prepare('DELETE FROM users WHERE id = @id').run({ id });
      writeAudit(db, { actorId: req.user!.id, action: 'user_delete', target: String(id) }, now);
    });
    run();

    reply.code(200).send({ ok: true });
  });

  // METADATA ONLY — the admin can browse another user's structure but NEVER
  // its content. The projection excludes `storage_path` (and `owner_id`), and
  // there is deliberately NO admin download/content endpoint anywhere.
  app.get('/api/admin/users/:id/nodes', { preHandler: guards.requireAdmin }, async (req, reply) => {
    const id = parseIdParam(req);
    if (id === null) {
      reply.code(404).send({ error: 'not_found' });
      return;
    }

    const target = db.prepare('SELECT id FROM users WHERE id = ?').get(id) as { id: number } | undefined;
    if (!target) {
      reply.code(404).send({ error: 'not_found' });
      return;
    }

    const nodes = db
      .prepare(
        `SELECT ${NODE_METADATA_COLUMNS} FROM nodes
         WHERE owner_id = @id AND kind IN ('folder','file')
         ORDER BY parent_id ASC, created_at ASC, id ASC`
      )
      .all({ id }) as AdminNodeDto[];

    // Spec §3.1: admin-any cross-user metadata access is an audited action.
    writeAudit(db, { actorId: req.user!.id, action: 'user_nodes_view', target: String(id) }, now);

    reply.code(200).send(nodes);
  });

  // --- Shares --------------------------------------------------------------

  app.get('/api/admin/shares', { preHandler: guards.requireAdmin }, async (_req, reply) => {
    const nowMs = now();
    const rows = db
      .prepare(
        `SELECT s.id AS id, s.node_id AS node_id, s.owner_id AS owner_id, s.token AS token,
                s.password_hash AS password_hash, s.is_active AS is_active, s.expires_at AS expires_at,
                s.allow_download AS allow_download, s.created_at AS created_at,
                u.username AS owner_username, u.is_active AS owner_is_active, n.name AS node_name
         FROM shares s
         JOIN users u ON u.id = s.owner_id
         LEFT JOIN nodes n ON n.id = s.node_id
         ORDER BY s.created_at DESC, s.id DESC`
      )
      .all() as Array<
      Share & { owner_username: string; owner_is_active: number; node_name: string | null }
    >;

    const dtos = rows.map((r) => ({
      id: r.id,
      node_id: r.node_id,
      owner_id: r.owner_id,
      owner_username: r.owner_username,
      // Whether the share's owner is currently active — an admin viewing all
      // shares wants to see shares belonging to deactivated users too.
      owner_active: !!r.owner_is_active,
      node_name: r.node_name,
      token: r.token,
      is_active: !!r.is_active,
      has_password: r.password_hash !== null,
      expires_at: r.expires_at,
      allow_download: !!r.allow_download,
      created_at: r.created_at,
      status: ownerStatus(r, nowMs),
    }));
    reply.code(200).send(dtos);
  });

  app.delete('/api/admin/shares/:id', { preHandler: guards.requireAdmin }, async (req, reply) => {
    const id = parseIdParam(req);
    if (id === null) {
      reply.code(404).send({ error: 'not_found' });
      return;
    }

    // NOT owner-scoped — admin can force-revoke ANY share (spec §3.1).
    const existing = db.prepare('SELECT id FROM shares WHERE id = ?').get(id) as { id: number } | undefined;
    if (!existing) {
      reply.code(404).send({ error: 'not_found' });
      return;
    }

    const run = db.transaction(() => {
      db.prepare('DELETE FROM shares WHERE id = @id').run({ id });
      writeAudit(db, { actorId: req.user!.id, action: 'share_revoke', target: String(id) }, now);
    });
    run();

    reply.code(200).send({ ok: true });
  });

  // --- Audit ---------------------------------------------------------------

  app.get('/api/admin/audit', { preHandler: guards.requireAdmin }, async (req, reply) => {
    const parsed = auditQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid_query' });
      return;
    }
    const limit = parsed.data.limit ?? DEFAULT_AUDIT_LIMIT;
    const offset = parsed.data.offset ?? 0;

    const rows = db
      .prepare(
        'SELECT id, actor_id, action, target, detail, created_at FROM audit_log ORDER BY id DESC LIMIT @limit OFFSET @offset'
      )
      .all({ limit, offset });
    reply.code(200).send(rows);
  });
}
