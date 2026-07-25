import type {} from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { validateSession } from './sessions.js';
import { createCsrf } from './csrf.js';

/** Session cookie name — httpOnly, holds the opaque session token. */
export const SESSION_COOKIE = 'mirsal_session';
/** CSRF cookie name — non-httpOnly, the double-submit companion to SESSION_COOKIE. */
export const CSRF_COOKIE = 'mirsal_csrf';
/** Header a client echoes the CSRF token back in on mutating requests. */
export const CSRF_HEADER = 'x-csrf-token';

/** Methods exempt from the CSRF header check. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface RequestUser {
  id: number;
  role: string;
  mustChangePassword: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: RequestUser;
  }
}

export interface GuardDeps {
  db: Database.Database;
  csrfSecret: string;
  now: () => number;
}

export interface Guards {
  requireAuth(req: FastifyRequest, reply: FastifyReply): void;
  requireAdmin(req: FastifyRequest, reply: FastifyReply): void;
}

/**
 * Builds the `requireAuth`/`requireAdmin` Fastify preHandlers from their
 * dependencies (db, CSRF secret, clock) — mirrors the createCsrf/
 * createPasswordService factory shape so the guards are testable without a
 * running server. Route wiring happens in Phase H.
 */
export function makeGuards({ db, csrfSecret, now }: GuardDeps): Guards {
  const { verifyCsrf } = createCsrf(csrfSecret);

  function requireAuth(req: FastifyRequest, reply: FastifyReply): void {
    const token = req.cookies[SESSION_COOKIE];
    const session = token ? validateSession(db, token, now()) : null;

    if (!session) {
      reply.code(401).send();
      return;
    }

    req.user = {
      id: session.userId,
      role: session.role,
      mustChangePassword: session.mustChangePassword,
    };

    if (!SAFE_METHODS.has(req.method)) {
      const header = req.headers[CSRF_HEADER];
      const csrf = Array.isArray(header) ? header[0] : header;
      if (!token || !csrf || !verifyCsrf(token, csrf)) {
        reply.code(403).send();
      }
    }
  }

  function requireAdmin(req: FastifyRequest, reply: FastifyReply): void {
    requireAuth(req, reply);
    if (reply.sent) return;

    if (req.user?.role !== 'admin') {
      reply.code(403).send();
    }
  }

  return { requireAuth, requireAdmin };
}
