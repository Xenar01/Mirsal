import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createCsrf, issueCsrf, verifyCsrf } from '../../src/auth/csrf.js';

const { issueCsrf: issue, verifyCsrf: verify } = createCsrf('a-test-secret-16+chars');

test('verifyCsrf accepts a token issued for the same session', () => {
  const sessA = 'session-token-a';

  expect(verify(sessA, issue(sessA))).toBe(true);
});

test('verifyCsrf rejects a token issued for a different session', () => {
  const sessA = 'session-token-a';
  const sessB = 'session-token-b';

  expect(verify(sessB, issue(sessA))).toBe(false);
});

test('verifyCsrf rejects garbage input without throwing', () => {
  const sessA = 'session-token-a';

  expect(() => verify(sessA, 'xxx')).not.toThrow();
  expect(verify(sessA, 'xxx')).toBe(false);
});

test('verifyCsrf rejects a tampered token', () => {
  const sessA = 'session-token-a';
  const token = issue(sessA);
  const tampered = token.slice(0, -1) + (token.at(-1) === 'a' ? 'b' : 'a');

  expect(verify(sessA, tampered)).toBe(false);
});

test('verifyCsrf rejects an empty csrf string', () => {
  const sessA = 'session-token-a';

  expect(verify(sessA, '')).toBe(false);
});

test('verifyCsrf rejects an empty session token when csrf is also empty', () => {
  expect(verify('', '')).toBe(false);
});

test('two secrets produce different tokens for the same session (keyed by secret)', () => {
  const other = createCsrf('a-different-test-secret');
  const sessA = 'session-token-a';

  expect(other.issueCsrf(sessA)).not.toBe(issue(sessA));
  expect(verify(sessA, other.issueCsrf(sessA))).toBe(false);
});

// The bare issueCsrf/verifyCsrf exports are bound to a lazily-initialized default
// service built from loadConfig() on first use. loadConfig() requires a handful of
// unrelated fields (DB_PATH, SESSION_SECRET, ...) to be present on process.env
// before it will validate successfully, so this group provisions a throwaway env
// for the duration of the test and restores it afterwards.
describe('bare issueCsrf/verifyCsrf (default service)', () => {
  const keys = ['DB_PATH', 'STORAGE_DIR', 'SESSION_SECRET', 'CSRF_SECRET', 'PUBLIC_BASE_URL'] as const;
  const originals: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const key of keys) {
      originals[key] = process.env[key];
    }
    process.env.DB_PATH = '/tmp/mirsal-test/db.sqlite';
    process.env.STORAGE_DIR = '/tmp/mirsal-test/storage';
    process.env.SESSION_SECRET = 'a'.repeat(32);
    process.env.CSRF_SECRET = 'b'.repeat(32);
    process.env.PUBLIC_BASE_URL = 'https://mirsal.example.com';
  });

  afterAll(() => {
    for (const key of keys) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
  });

  test('round trip: verifyCsrf(sess, issueCsrf(sess)) === true', () => {
    const sess = 'a-session-token';

    expect(verifyCsrf(sess, issueCsrf(sess))).toBe(true);
  });

  test('verifyCsrf rejects a token for a different session', () => {
    expect(verifyCsrf('other-session', issueCsrf('a-session-token'))).toBe(false);
  });
});
