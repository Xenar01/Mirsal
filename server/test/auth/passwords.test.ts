import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createPasswordService, hashPassword, verifyPassword } from '../../src/auth/passwords.js';

const testArgonConfig = {
  ARGON_MEMORY_KIB: 19456,
  ARGON_TIME: 2,
  ARGON_PARALLELISM: 1,
  ARGON_MAX_CONCURRENCY: 2,
};

test('createPasswordService: round trip verifies true for the correct password', async () => {
  const service = createPasswordService(testArgonConfig);

  const hash = await service.hashPassword('x');

  expect(await service.verifyPassword(hash, 'x')).toBe(true);
});

test('createPasswordService: verify returns false for a wrong password', async () => {
  const service = createPasswordService(testArgonConfig);

  const hash = await service.hashPassword('x');

  expect(await service.verifyPassword(hash, 'wrong')).toBe(false);
});

test('createPasswordService: verify returns false (never throws) for a malformed hash string', async () => {
  const service = createPasswordService(testArgonConfig);

  await expect(service.verifyPassword('not-a-hash', 'x')).resolves.toBe(false);
});

test('createPasswordService: produces an argon2id-encoded hash using the configured params', async () => {
  const service = createPasswordService(testArgonConfig);

  const hash = await service.hashPassword('x');

  expect(hash).toMatch(/^\$argon2id\$/);
  expect(hash).toContain('m=19456');
  expect(hash).toContain('t=2');
  expect(hash).toContain('p=1');
});

// The bare hashPassword/verifyPassword exports are bound to a lazily-initialized
// default service built from loadConfig() on first use. loadConfig() requires a
// handful of unrelated fields (DB_PATH, SESSION_SECRET, ...) to be present on
// process.env before it will validate successfully, so this group provisions a
// throwaway env for the duration of the test and restores it afterwards.
describe('bare hashPassword/verifyPassword (default service)', () => {
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

  test('round trip: verifyPassword(await hashPassword("x"), "x") === true', async () => {
    const hash = await hashPassword('x');

    expect(await verifyPassword(hash, 'x')).toBe(true);
  });

  test('verifyPassword returns false for a wrong password', async () => {
    const hash = await hashPassword('x');

    expect(await verifyPassword(hash, 'wrong')).toBe(false);
  });
});
