import { createHmac, timingSafeEqual } from 'node:crypto';

/** Name of the short-lived, path-scoped cookie that marks a collection unlocked. */
export const COLLECT_UNLOCK_COOKIE = 'mirsal_collect_unlock';

/** Server-side unlock-cookie lifetime (10 min), enforced in isUnlocked (not via Max-Age). */
const UNLOCK_COOKIE_MAX_AGE_S = 600;

export interface UnlockGate {
  cookieName: string;
  cookiePath(token: string): string;
  cookieValue(token: string, passwordHash: string | null, issuedAtMs: number): string;
  isUnlocked(cookie: string | undefined, token: string, passwordHash: string | null, nowMs: number): boolean;
}

/**
 * Builds an unlock-cookie gate bound to `secret` (the app's SESSION_SECRET).
 * Mirrors routes/public.ts's share unlock cookie exactly:
 *  - cookie value = `<issuedAtMs>.<base64url HMAC-SHA256(token.passwordHash.issuedAtMs)>`.
 *  - Binding the CURRENT password_hash means a rotated/cleared password
 *    invalidates every prior cookie. The signed issuedAt lets isUnlocked
 *    enforce the 600s lifetime server-side, independent of the client honoring
 *    any cookie attribute. Constant-time compare over the whole cookie string.
 */
export function createUnlockGate(secret: string): UnlockGate {
  function sign(token: string, passwordHash: string | null, issuedAtStr: string): string {
    return createHmac('sha256', secret).update(`${token}.${passwordHash ?? ''}.${issuedAtStr}`).digest('base64url');
  }

  function cookieValue(token: string, passwordHash: string | null, issuedAtMs: number): string {
    const issuedAtStr = String(issuedAtMs);
    return `${issuedAtStr}.${sign(token, passwordHash, issuedAtStr)}`;
  }

  function isUnlocked(cookie: string | undefined, token: string, passwordHash: string | null, nowMs: number): boolean {
    if (!cookie) return false;
    const dot = cookie.indexOf('.');
    if (dot <= 0) return false;
    const issuedAtStr = cookie.slice(0, dot);
    const issuedAtMs = Number(issuedAtStr);
    if (!Number.isInteger(issuedAtMs)) return false;
    if (issuedAtMs > nowMs || nowMs - issuedAtMs > UNLOCK_COOKIE_MAX_AGE_S * 1000) return false;
    const expected = Buffer.from(cookieValue(token, passwordHash, issuedAtMs));
    const actual = Buffer.from(cookie);
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }

  return { cookieName: COLLECT_UNLOCK_COOKIE, cookiePath: (t) => `/api/collect/${t}`, cookieValue, isUnlocked };
}
