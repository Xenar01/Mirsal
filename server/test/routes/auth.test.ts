import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { loadConfig } from '../../src/config.js';
import { buildApp } from '../../src/app.js';
import { createPasswordService } from '../../src/auth/passwords.js';

const NOW = 1_700_000_000_000;
const clock = () => NOW;

const TEST_ARGON = {
  ARGON_MEMORY_KIB: 19456,
  ARGON_TIME: 2,
  ARGON_PARALLELISM: 1,
  ARGON_MAX_CONCURRENCY: 2,
};

/** `light-my-request`'s parsed Set-Cookie shape (not individually exported by the package). */
interface InjectedCookie {
  name: string;
  value: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  path?: string;
}

let db: Database.Database | undefined;
let dir: string | undefined;
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  db?.close();
  db = undefined;
  if (dir) {
    fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

async function makeApp(): Promise<FastifyInstance> {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-h2-'));
  const dbPath = path.join(dir, 't.db');
  db = openDb(dbPath);
  migrate(db);

  const config = loadConfig({
    DB_PATH: dbPath,
    STORAGE_DIR: path.join(dir, 'storage'),
    SESSION_SECRET: 'a-test-session-secret-16+',
    CSRF_SECRET: 'a-test-csrf-secret-16chars+',
    PUBLIC_BASE_URL: 'https://mirsal.example.test',
  });

  const built = await buildApp({ db, config, now: clock });
  app = built;
  return built;
}

/** Inserts a user row with a real argon2 hash for `password`, returns its id. */
async function seedUser(
  username: string,
  password: string,
  overrides: Partial<{ role: string; isActive: number }> = {}
): Promise<number> {
  const passwordService = createPasswordService(TEST_ARGON);
  const hash = await passwordService.hashPassword(password);
  const info = db!
    .prepare(
      `INSERT INTO users(username, password_hash, role, is_active, must_change_password, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`
    )
    .run(username, hash, overrides.role ?? 'admin', overrides.isActive ?? 1, NOW, NOW);
  return Number(info.lastInsertRowid);
}

function findCookie(cookies: InjectedCookie[], name: string): InjectedCookie | undefined {
  return cookies.find((c) => c.name === name);
}

async function login(
  built: FastifyInstance,
  username: string,
  password: string
): Promise<{
  statusCode: number;
  body: unknown;
  session?: string;
  csrf?: string;
  cookies: InjectedCookie[];
}> {
  const res = await built.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  const session = findCookie(res.cookies, 'mirsal_session')?.value;
  const csrf = findCookie(res.cookies, 'mirsal_csrf')?.value;
  return { statusCode: res.statusCode, body: res.json(), session, csrf, cookies: res.cookies };
}

test('login: seeded admin with correct password -> 200, sets session+csrf cookies', async () => {
  const built = await makeApp();
  await seedUser('admin', 'pw', { role: 'admin' });

  const res = await built.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'pw' },
  });

  expect(res.statusCode).toBe(200);
  const body = res.json() as {
    user: { id: number; username: string; role: string; mustChangePassword: boolean };
  };
  expect(body.user).toMatchObject({ username: 'admin', role: 'admin', mustChangePassword: false });
  expect(typeof body.user.id).toBe('number');

  const sessionCookie = findCookie(res.cookies, 'mirsal_session');
  expect(sessionCookie).toBeDefined();
  expect(sessionCookie!.httpOnly).toBe(true);
  expect(sessionCookie!.secure).toBe(true);
  expect(sessionCookie!.sameSite?.toLowerCase()).toBe('lax');
  expect(sessionCookie!.path).toBe('/');

  const csrfCookie = findCookie(res.cookies, 'mirsal_csrf');
  expect(csrfCookie).toBeDefined();
  expect(csrfCookie!.httpOnly).toBeFalsy();
  expect(csrfCookie!.secure).toBe(true);
  expect(csrfCookie!.sameSite?.toLowerCase()).toBe('lax');
});

test('login: wrong password -> 401 invalid_credentials', async () => {
  const built = await makeApp();
  await seedUser('admin', 'pw');

  const res = await built.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'wrong' },
  });

  expect(res.statusCode).toBe(401);
  expect(res.json()).toEqual({ error: 'invalid_credentials' });
  expect(findCookie(res.cookies, 'mirsal_session')).toBeUndefined();
});

test('login: inactive user -> 401 invalid_credentials (generic, not a distinct reason)', async () => {
  const built = await makeApp();
  await seedUser('deactivated', 'pw', { isActive: 0 });

  const res = await built.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'deactivated', password: 'pw' },
  });

  expect(res.statusCode).toBe(401);
  expect(res.json()).toEqual({ error: 'invalid_credentials' });
});

test('login: unknown username -> 401 invalid_credentials (constant-work dummy verify runs, never throws)', async () => {
  const built = await makeApp();

  const res = await built.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'ghost', password: 'whatever' },
  });

  expect(res.statusCode).toBe(401);
  expect(res.json()).toEqual({ error: 'invalid_credentials' });
});

test('GET /me: with a valid session cookie -> 200 + current user fields', async () => {
  const built = await makeApp();
  await seedUser('admin', 'pw', { role: 'admin' });
  const { session } = await login(built, 'admin', 'pw');
  expect(session).toBeDefined();

  const res = await built.inject({
    method: 'GET',
    url: '/api/auth/me',
    cookies: { mirsal_session: session! },
  });

  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ username: 'admin', role: 'admin', mustChangePassword: false });
});

test('GET /me: without a session cookie -> 401', async () => {
  const built = await makeApp();

  const res = await built.inject({ method: 'GET', url: '/api/auth/me' });

  expect(res.statusCode).toBe(401);
});

test('rate limit: max+1 rapid bad logins for the same username+ip -> last is 429', async () => {
  const built = await makeApp();
  await seedUser('admin', 'pw');

  const attempts = 6; // brief's example max=5 -> the 6th must be limited
  const statuses: number[] = [];
  for (let i = 0; i < attempts; i++) {
    const res = await built.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'wrong' },
    });
    statuses.push(res.statusCode);
  }

  expect(statuses.slice(0, -1)).toEqual(statuses.slice(0, -1).map(() => 401));
  expect(statuses.at(-1)).toBe(429);
});

test('mid-flight revocation: login, then deactivate the user -> a subsequent authed request is 401', async () => {
  const built = await makeApp();
  const uid = await seedUser('admin', 'pw', { role: 'admin' });
  const { session } = await login(built, 'admin', 'pw');
  expect(session).toBeDefined();

  db!.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(uid);

  const res = await built.inject({
    method: 'GET',
    url: '/api/auth/me',
    cookies: { mirsal_session: session! },
  });

  expect(res.statusCode).toBe(401);
});

test('logout: revokes the current session (subsequent /me is 401)', async () => {
  const built = await makeApp();
  await seedUser('admin', 'pw');
  const { session, csrf } = await login(built, 'admin', 'pw');

  const res = await built.inject({
    method: 'POST',
    url: '/api/auth/logout',
    cookies: { mirsal_session: session! },
    headers: { 'x-csrf-token': csrf! },
  });
  expect(res.statusCode).toBe(200);

  const me = await built.inject({
    method: 'GET',
    url: '/api/auth/me',
    cookies: { mirsal_session: session! },
  });
  expect(me.statusCode).toBe(401);
});

test('logout-all: revokes every session for the user, not just the current one', async () => {
  const built = await makeApp();
  await seedUser('admin', 'pw');
  const a = await login(built, 'admin', 'pw');
  const b = await login(built, 'admin', 'pw');

  const res = await built.inject({
    method: 'POST',
    url: '/api/auth/logout-all',
    cookies: { mirsal_session: a.session! },
    headers: { 'x-csrf-token': a.csrf! },
  });
  expect(res.statusCode).toBe(200);

  const meA = await built.inject({
    method: 'GET',
    url: '/api/auth/me',
    cookies: { mirsal_session: a.session! },
  });
  const meB = await built.inject({
    method: 'GET',
    url: '/api/auth/me',
    cookies: { mirsal_session: b.session! },
  });
  expect(meA.statusCode).toBe(401);
  expect(meB.statusCode).toBe(401);
});

test('mutating auth routes require a matching CSRF header (guard-enforced, /login stays exempt)', async () => {
  const built = await makeApp();
  await seedUser('admin', 'pw');
  const { session } = await login(built, 'admin', 'pw');

  const res = await built.inject({
    method: 'POST',
    url: '/api/auth/logout',
    cookies: { mirsal_session: session! },
    // no x-csrf-token header
  });

  expect(res.statusCode).toBe(403);
});

test('password change: session A changes password -> 200; A (refreshed) still works, session B is revoked', async () => {
  const built = await makeApp();
  await seedUser('admin', 'pw', { role: 'admin' });
  const a = await login(built, 'admin', 'pw');
  const b = await login(built, 'admin', 'pw');

  const res = await built.inject({
    method: 'POST',
    url: '/api/auth/password',
    cookies: { mirsal_session: a.session! },
    headers: { 'x-csrf-token': a.csrf! },
    payload: { current: 'pw', new: 'a-new-password-123' },
  });

  expect(res.statusCode).toBe(200);
  const newSession = findCookie(res.cookies, 'mirsal_session')?.value;
  expect(newSession).toBeDefined();
  expect(newSession).not.toBe(a.session);

  // Session A's original token was rolled (revoke-all-then-recreate) — the OLD token is now dead.
  const meOldA = await built.inject({
    method: 'GET',
    url: '/api/auth/me',
    cookies: { mirsal_session: a.session! },
  });
  expect(meOldA.statusCode).toBe(401);

  // The refreshed session (new cookie from the /password response) still works.
  const meNewA = await built.inject({
    method: 'GET',
    url: '/api/auth/me',
    cookies: { mirsal_session: newSession! },
  });
  expect(meNewA.statusCode).toBe(200);

  // Session B (a different, previously-open session) is revoked.
  const meB = await built.inject({
    method: 'GET',
    url: '/api/auth/me',
    cookies: { mirsal_session: b.session! },
  });
  expect(meB.statusCode).toBe(401);
});

test('password change: wrong current password -> 401, nothing revoked', async () => {
  const built = await makeApp();
  await seedUser('admin', 'pw');
  const a = await login(built, 'admin', 'pw');

  const res = await built.inject({
    method: 'POST',
    url: '/api/auth/password',
    cookies: { mirsal_session: a.session! },
    headers: { 'x-csrf-token': a.csrf! },
    payload: { current: 'not-the-password', new: 'a-new-password-123' },
  });

  expect(res.statusCode).toBe(401);

  const me = await built.inject({
    method: 'GET',
    url: '/api/auth/me',
    cookies: { mirsal_session: a.session! },
  });
  expect(me.statusCode).toBe(200);
});
