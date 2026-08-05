import type { FastifyInstance, FastifyReply } from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { Clock } from '../clock.js';
import type { PasswordService } from '../auth/passwords.js';
import type { Guards } from '../auth/guards.js';
import { CSRF_COOKIE, SESSION_COOKIE } from '../auth/guards.js';
import { SESSION_TTL_MS, createSession, revokeAllForUser, revokeSession } from '../auth/sessions.js';
import { createCsrf } from '../auth/csrf.js';
import { ensureUserRoots } from '../nodes/tree.js';
import { writeAudit } from '../audit.js';

export interface AuthRouteDeps {
  db: Database.Database;
  now: Clock;
  passwordService: PasswordService;
  guards: Guards;
  csrfSecret: string;
}

/** Login attempt cap per (username, ip) key before a 429 (spec §8: login brute-force). */
const LOGIN_RATE_LIMIT_MAX = 5;
/**
 * Standalone per-IP login attempt cap (global-constraints.md: login must be
 * rate-limited "per-IP and per-token/user" — two independent ceilings, not
 * one). Deliberately looser than `LOGIN_RATE_LIMIT_MAX` so it isn't the one
 * that trips for a single account under normal use; its job is to bound a
 * single IP spraying many *different* usernames (or the same password across
 * many accounts), which the username+ip-keyed cap alone can never catch
 * since each such attempt gets its own distinct key.
 */
const LOGIN_IP_RATE_LIMIT_MAX = 20;
/** Login rate-limit window (shared by both the per-IP and per-username+ip caps). */
const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
/** Minimum length enforced on a new password (POST /password). */
const MIN_NEW_PASSWORD_LENGTH = 8;
/**
 * Never a real user's password. Hashed once at route registration so the
 * no-such-user and inactive-user paths still pay full argon2 verify cost —
 * constant-work anti-enumeration (spec §8): response timing must not
 * distinguish "no such user"/"inactive" from "wrong password".
 */
const DUMMY_PASSWORD = 'mirsal-constant-time-dummy-never-a-real-password';

const loginBodySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const passwordChangeSchema = z.object({
  current: z.string().min(1),
  new: z.string().min(MIN_NEW_PASSWORD_LENGTH),
});

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: string;
  is_active: number;
  must_change_password: number;
  quota_bytes: number | null;
  used_bytes: number;
}

interface PublicUser {
  id: number;
  username: string;
  role: string;
  mustChangePassword: boolean;
  rootNodeId: number;
  quotaBytes: number | null;
  usedBytes: number;
}

/**
 * `rootNodeId` is the user's synthetic root node id — always concrete for an
 * active user, even one whose roots were never materialized (a brand-new
 * admin-created account): callers resolve it via the idempotent
 * `ensureUserRoots` and pass its `rootId` in. The web needs it to create a
 * folder / move-to-root at an EMPTY root, before any child exists to derive it
 * from.
 */
function toPublicUser(
  row: Pick<UserRow, 'id' | 'username' | 'role' | 'must_change_password' | 'quota_bytes' | 'used_bytes'>,
  rootNodeId: number,
): PublicUser {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    mustChangePassword: !!row.must_change_password,
    rootNodeId,
    quotaBytes: row.quota_bytes,
    usedBytes: row.used_bytes,
  };
}

/** Cookie flags shared by both auth cookies (spec §5/§8) — differ only in httpOnly. */
function setAuthCookies(reply: FastifyReply, token: string, csrf: string): void {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge,
  });
  reply.setCookie(CSRF_COOKIE, csrf, {
    httpOnly: false,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge,
  });
}

function clearAuthCookies(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
  reply.clearCookie(CSRF_COOKIE, { path: '/' });
}

/**
 * Registers the `/api/auth/*` routes: login (rate-limited, CSRF-exempt),
 * logout, logout-all, `/me`, and password change. `deps.passwordService` and
 * `deps.guards` are built once in `buildApp` (from the injected config) and
 * handed down here rather than re-instantiated per route module.
 */
export default async function authRoutes(app: FastifyInstance, deps: AuthRouteDeps): Promise<void> {
  const { db, now, passwordService, guards } = deps;
  const { issueCsrf } = createCsrf(deps.csrfSecret);
  // Computed once at startup — every no-user/inactive-user login still pays
  // this same verify cost below.
  const dummyHash = await passwordService.hashPassword(DUMMY_PASSWORD);

  // `/login` carries TWO independent rate-limit caps (global-constraints.md:
  // login must be rate-limited "per-IP and per-token/user"): a standalone
  // per-IP cap and a per-(username+ip) cap. These are deliberately registered
  // as two SEPARATE `@fastify/rate-limit` plugin instances in a dedicated
  // nested scope, rather than one registration plus a route-level
  // `config.rateLimit` object (the original approach): every
  // `@fastify/rate-limit` instance whose `onRoute` hook sees a non-null
  // `routeOptions.config.rateLimit` merges ITS OWN default params with THAT
  // object — so a second registration sharing the route's `config.rateLimit`
  // silently collapses onto the exact same key/max as the first instead of
  // enforcing an independent cap (verified empirically: two registrations
  // both consulting one `config.rateLimit` end up byte-for-byte identical).
  // Keeping the route free of `config.rateLimit` and letting each
  // registration's own default (global-to-its-scope) params apply is what
  // keeps the two caps — and their per-key counters — genuinely independent.
  await app.register(async function loginRateLimits(scope) {
    // Cap 1: standalone per-IP — catches one IP spraying many *different*
    // usernames (or one password against many accounts), which the
    // username+ip-keyed cap below can never catch on its own since each such
    // attempt gets a distinct key there.
    await scope.register(fastifyRateLimit, {
      max: LOGIN_IP_RATE_LIMIT_MAX,
      timeWindow: LOGIN_RATE_LIMIT_WINDOW_MS,
      hook: 'preHandler',
      keyGenerator: (req) => req.ip,
    });

    // Cap 2: per-(username, ip) — catches a distributed attack against one
    // specific account from many IPs.
    await scope.register(fastifyRateLimit, {
      max: LOGIN_RATE_LIMIT_MAX,
      timeWindow: LOGIN_RATE_LIMIT_WINDOW_MS,
      // Body is only parsed by the time preHandler hooks run — onRequest
      // (the plugin's default hook) fires too early to read `username`.
      hook: 'preHandler',
      keyGenerator(req) {
        const body = req.body as { username?: unknown } | undefined;
        const username = typeof body?.username === 'string' ? body.username : '';
        return `${username}:${req.ip}`;
      },
    });

    scope.post('/api/auth/login', async (req, reply) => {
      const parsed = loginBodySchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send({ error: 'invalid_body' });
        return;
      }
      const { username, password } = parsed.data;

      const row = db
        .prepare(
          `SELECT id, username, password_hash, role, is_active, must_change_password, quota_bytes, used_bytes
           FROM users WHERE username = ?`,
        )
        .get(username) as UserRow | undefined;

      const hasUser = !!row;
      // Constant-work anti-enumeration: exactly one real argon2 verify per
      // attempt. Use the REAL hash whenever the row exists (active OR inactive)
      // so a correct password on an inactive account is detectable; the dummy
      // hash only when there is no such user — so timing can't reveal which of
      // "no such user" / "inactive" / "wrong password" occurred.
      const verified = await passwordService.verifyPassword(hasUser ? row!.password_hash : dummyHash, password);

      // Disclose "deactivated" ONLY to a fully-correct username+password — a
      // wrong password on an inactive account still gets the generic 401, so no
      // one can probe which usernames exist.
      if (hasUser && verified && row!.is_active !== 1) {
        writeAudit(db, { actorId: row!.id, action: 'login_denied_inactive', target: username }, now);
        reply.code(403).send({ error: 'account_deactivated' });
        return;
      }

      if (!hasUser || !verified || row!.is_active !== 1) {
        writeAudit(db, { actorId: row?.id ?? null, action: 'login_failure', target: username }, now);
        reply.code(401).send({ error: 'invalid_credentials' });
        return;
      }

      const { token } = createSession(db, row!.id, now());
      setAuthCookies(reply, token, issueCsrf(token));
      writeAudit(db, { actorId: row!.id, action: 'login_success', target: username }, now);

      // Materialize (idempotently) the synthetic root/trash so the returned
      // user always carries a concrete rootNodeId — even a brand-new account.
      const { rootId } = ensureUserRoots(db, row!.id, now());
      reply.code(200).send({ user: toPublicUser(row!, rootId) });
    });
  });

  app.post('/api/auth/logout', { preHandler: guards.requireAuth }, async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      revokeSession(db, token);
    }
    clearAuthCookies(reply);
    reply.code(200).send({ ok: true });
  });

  app.post('/api/auth/logout-all', { preHandler: guards.requireAuth }, async (req, reply) => {
    revokeAllForUser(db, req.user!.id);
    clearAuthCookies(reply);
    reply.code(200).send({ ok: true });
  });

  app.get('/api/auth/me', { preHandler: guards.requireAuth }, async (req, reply) => {
    // Fresh read (not the session's cached snapshot) so role/flag changes
    // since login are reflected immediately.
    const row = db
      .prepare(`SELECT id, username, role, must_change_password, quota_bytes, used_bytes FROM users WHERE id = ?`)
      .get(req.user!.id) as
      Pick<UserRow, 'id' | 'username' | 'role' | 'must_change_password' | 'quota_bytes' | 'used_bytes'> | undefined;

    if (!row) {
      reply.code(401).send();
      return;
    }
    const { rootId } = ensureUserRoots(db, row.id, now());
    reply.code(200).send(toPublicUser(row, rootId));
  });

  app.post('/api/auth/password', { preHandler: guards.requireAuth }, async (req, reply) => {
    const parsed = passwordChangeSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid_body' });
      return;
    }
    const { current, new: newPassword } = parsed.data;

    const row = db.prepare(`SELECT id, password_hash FROM users WHERE id = ?`).get(req.user!.id) as
      { id: number; password_hash: string } | undefined;
    if (!row) {
      reply.code(401).send();
      return;
    }

    const ok = await passwordService.verifyPassword(row.password_hash, current);
    if (!ok) {
      reply.code(401).send({ error: 'invalid_credentials' });
      return;
    }

    const newHash = await passwordService.hashPassword(newPassword);
    const nowMs = now();

    // The password_hash UPDATE, the revoke-all session wipe, the fresh
    // session INSERT, and the audit row are one atomic "password change"
    // state transition — wrapped in a single db.transaction() (matching
    // every other multi-statement mutation in this codebase, e.g.
    // nodes/trash.ts, nodes/tree.ts, scheduler/runner.ts) so a mid-sequence
    // failure can't leave the account with e.g. a new password hash but
    // stale/dangling sessions, or a revoked-all with no replacement session.
    const run = db.transaction((): { token: string } => {
      db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?`).run(
        newHash,
        nowMs,
        row.id,
      );

      // Revoke every session (including the one used for this request) then
      // issue a fresh one — simplest way to guarantee every OTHER session is
      // dead while this request still ends with a working, current session.
      revokeAllForUser(db, row.id);
      const created = createSession(db, row.id, nowMs);

      writeAudit(db, { actorId: row.id, action: 'password_change' }, now);

      return { token: created.token };
    });
    const { token } = run();

    setAuthCookies(reply, token, issueCsrf(token));

    reply.code(200).send({ ok: true });
  });
}
