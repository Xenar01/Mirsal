import { createHmac, timingSafeEqual } from 'node:crypto';
import { loadConfig } from '../config.js';

export interface CsrfService {
  issueCsrf(sessionToken: string): string;
  verifyCsrf(sessionToken: string, csrf: string): boolean;
}

/**
 * Builds a CSRF service backed by HMAC-SHA256 over the session token, keyed by
 * `secret`. The issued token is a base64url-encoded digest — deterministic per
 * (secret, sessionToken) pair, so a client can be handed the value once (as a
 * non-httpOnly cookie) and later echo it back in a header for verification,
 * without the server persisting anything (double-submit pattern, spec §8).
 */
export function createCsrf(secret: string): CsrfService {
  function issueCsrf(sessionToken: string): string {
    return createHmac('sha256', secret).update(sessionToken).digest('base64url');
  }

  function verifyCsrf(sessionToken: string, csrf: string): boolean {
    try {
      const expected = Buffer.from(issueCsrf(sessionToken));
      const actual = Buffer.from(csrf);
      if (expected.length !== actual.length) return false;
      return timingSafeEqual(expected, actual);
    } catch {
      // Any unexpected failure (e.g. non-string input slipping through) is
      // treated as a failed verification — never surface the throw.
      return false;
    }
  }

  return { issueCsrf, verifyCsrf };
}

let defaultService: CsrfService | undefined;

function getDefaultService(): CsrfService {
  if (!defaultService) {
    defaultService = createCsrf(loadConfig().CSRF_SECRET);
  }
  return defaultService;
}

/** Bare signature bound to a lazily-initialized default service (built from loadConfig() on first use). */
export function issueCsrf(sessionToken: string): string {
  return getDefaultService().issueCsrf(sessionToken);
}

/** Bare signature bound to a lazily-initialized default service (built from loadConfig() on first use). */
export function verifyCsrf(sessionToken: string, csrf: string): boolean {
  return getDefaultService().verifyCsrf(sessionToken, csrf);
}
