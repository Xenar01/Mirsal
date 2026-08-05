import type Database from 'better-sqlite3';
import { randomToken, sha256 } from '../util/ids.js';

/** Session lifetime: 7 days. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface CreatedSession {
  /** RAW token — hand to the client (cookie); never stored or logged. */
  token: string;
  id: number;
}

export interface ValidatedSession {
  userId: number;
  role: string;
  mustChangePassword: boolean;
}

interface SessionUserRow {
  is_active: number;
  revoked_at: number | null;
  expires_at: number;
  user_id: number;
  role: string;
  must_change_password: number;
}

/**
 * Creates an opaque session for `userId`. Generates a random 32-byte token,
 * stores only its sha256 hash, and returns the raw token for the caller to
 * hand to the client (e.g. as a cookie value) — it is never persisted or logged.
 */
export function createSession(
  db: Database.Database,
  userId: number,
  now: number,
  ttlMs: number = SESSION_TTL_MS,
): CreatedSession {
  const token = randomToken(32);
  const tokenHash = sha256(token);

  const info = db
    .prepare(
      `INSERT INTO sessions(user_id, token_hash, created_at, last_used_at, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    )
    .run(userId, tokenHash, now, now, now + ttlMs);

  return { token, id: Number(info.lastInsertRowid) };
}

/**
 * Validates `token` against `now`. Returns null if the session is missing,
 * revoked, expired, or the owning user is inactive. Otherwise slides the
 * session forward (last_used_at = now, expires_at = now + SESSION_TTL_MS)
 * and returns the resolved user identity.
 */
export function validateSession(db: Database.Database, token: string, now: number): ValidatedSession | null {
  const tokenHash = sha256(token);

  const row = db
    .prepare(
      `SELECT s.revoked_at AS revoked_at, s.expires_at AS expires_at,
              u.id AS user_id, u.role AS role, u.is_active AS is_active,
              u.must_change_password AS must_change_password
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .get(tokenHash) as SessionUserRow | undefined;

  if (!row) return null;
  if (row.revoked_at !== null) return null;
  if (row.expires_at <= now) return null;
  if (row.is_active === 0) return null;

  db.prepare('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE token_hash = ?').run(
    now,
    now + SESSION_TTL_MS,
    tokenHash,
  );

  return {
    userId: row.user_id,
    role: row.role,
    mustChangePassword: !!row.must_change_password,
  };
}

/** Deletes the session identified by `token` (logout: real, immediate revocation). */
export function revokeSession(db: Database.Database, token: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

/** Deletes every session belonging to `userId` (used by deactivate / password reset). */
export function revokeAllForUser(db: Database.Database, userId: number): void {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}
