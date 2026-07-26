import { expect, test } from 'vitest';
import { loadConfig, MAX_FILE_BYTES, GRACE_MS } from '../src/config.js';

function baseEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return {
    DB_PATH: '/data/db/mirsal.db',
    STORAGE_DIR: '/data/storage',
    SESSION_SECRET: 'a'.repeat(32),
    CSRF_SECRET: 'b'.repeat(32),
    PUBLIC_BASE_URL: 'https://mirsal.example.com',
    ...overrides,
  };
}

test('constants match the spec-mandated exact values', () => {
  expect(MAX_FILE_BYTES).toBe(104857600);
  expect(GRACE_MS).toBe(604800000);
});

test('a complete env object yields a typed config with correct field values', () => {
  const cfg = loadConfig(baseEnv({ ARGON_TIME: '3' }));

  expect(cfg.DB_PATH).toBe('/data/db/mirsal.db');
  expect(cfg.STORAGE_DIR).toBe('/data/storage');
  expect(cfg.SESSION_SECRET).toBe('a'.repeat(32));
  expect(cfg.CSRF_SECRET).toBe('b'.repeat(32));
  expect(cfg.PUBLIC_BASE_URL).toBe('https://mirsal.example.com');
  expect(typeof cfg.ARGON_TIME).toBe('number');
  expect(cfg.ARGON_TIME).toBe(3);
});

test('numeric env vars coerce from string to number', () => {
  const cfg = loadConfig(
    baseEnv({
      ARGON_MEMORY_KIB: '65536',
      ARGON_TIME: '5',
      ARGON_PARALLELISM: '4',
      ARGON_MAX_CONCURRENCY: '8',
    }),
  );

  expect(cfg.ARGON_MEMORY_KIB).toBe(65536);
  expect(cfg.ARGON_TIME).toBe(5);
  expect(cfg.ARGON_PARALLELISM).toBe(4);
  expect(cfg.ARGON_MAX_CONCURRENCY).toBe(8);
});

test('omitted argon numerics fall back to their documented defaults', () => {
  const cfg = loadConfig(baseEnv());

  expect(cfg.ARGON_MEMORY_KIB).toBe(19456);
  expect(cfg.ARGON_TIME).toBe(2);
  expect(cfg.ARGON_PARALLELISM).toBe(1);
  expect(cfg.ARGON_MAX_CONCURRENCY).toBe(2);
});

test('HOST defaults to loopback and can be overridden (container binds 0.0.0.0)', () => {
  expect(loadConfig(baseEnv()).HOST).toBe('127.0.0.1');
  expect(loadConfig(baseEnv({ HOST: '0.0.0.0' })).HOST).toBe('0.0.0.0');
});

test('TRUST_PROXY defaults to loopback and can be overridden (container trusts docker subnet)', () => {
  expect(loadConfig(baseEnv()).TRUST_PROXY).toBe('loopback');
  expect(loadConfig(baseEnv({ TRUST_PROXY: 'loopback,172.31.99.1/32' })).TRUST_PROXY).toBe(
    'loopback,172.31.99.1/32',
  );
});

test('a missing required var throws a clear error naming the field', () => {
  const env = baseEnv();
  delete env.SESSION_SECRET;

  expect(() => loadConfig(env)).toThrow();
  expect(() => loadConfig(env)).toThrow(/SESSION_SECRET/);
});

test('a too-short secret throws', () => {
  const env = baseEnv({ SESSION_SECRET: 'short' });

  expect(() => loadConfig(env)).toThrow(/SESSION_SECRET/);
});

test('an invalid PUBLIC_BASE_URL throws', () => {
  const env = baseEnv({ PUBLIC_BASE_URL: 'not-a-url' });

  expect(() => loadConfig(env)).toThrow(/PUBLIC_BASE_URL/);
});

test('the returned config is frozen', () => {
  const cfg = loadConfig(baseEnv());

  expect(Object.isFrozen(cfg)).toBe(true);
});

test('loadConfig does not read process.env at module load time (pure function of its arg)', () => {
  const originalSessionSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'x'.repeat(32);
  try {
    // A fully-specified explicit env object must be used verbatim, ignoring
    // whatever happens to be set on the real process.env at call time.
    const env = baseEnv({ SESSION_SECRET: 'y'.repeat(32) });
    const cfg = loadConfig(env);
    expect(cfg.SESSION_SECRET).toBe('y'.repeat(32));
  } finally {
    if (originalSessionSecret === undefined) {
      delete process.env.SESSION_SECRET;
    } else {
      process.env.SESSION_SECRET = originalSessionSecret;
    }
  }
});
