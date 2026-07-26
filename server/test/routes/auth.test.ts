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

test('rate limit: a standalone per-IP cap trips even across distinct usernames (spraying), which the username+ip cap alone cannot catch', async () => {
  const built = await makeApp();
  // No seeded users needed — every attempt is against a distinct, nonexistent
  // username, so the per-(username+ip) cap's key differs every time and can
  // never trip; only a standalone per-IP cap can catch this pattern.
  const attempts = 21; // LOGIN_IP_RATE_LIMIT_MAX (20) + 1
  const statuses: number[] = [];
  for (let i = 0; i < attempts; i++) {
    const res = await built.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: `sprayed-user-${i}`, password: 'whatever' },
    });
    statuses.push(res.statusCode);
  }

  expect(statuses.slice(0, -1)).toEqual(statuses.slice(0, -1).map(() => 401));
  expect(statuses.at(-1)).toBe(429);
});

test('rate limit: the per-IP cap keys off the address behind the trusted (loopback) proxy hop, not an attacker-spoofed X-Forwarded-For prefix', async () => {
  const built = await makeApp();
  const attempts = 21; // LOGIN_IP_RATE_LIMIT_MAX (20) + 1
  const statuses: number[] = [];
  for (let i = 0; i < attempts; i++) {
    const res = await built.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: `sprayed-user-${i}`, password: 'whatever' },
      remoteAddress: '127.0.0.1', // arriving via the trusted local nginx hop
      // A different attacker-supplied prefix on every request, but nginx's
      // own appended (real, constant) client address is always last.
      headers: { 'x-forwarded-for': `fake-hop-${i}, 198.51.100.9` },
    });
    statuses.push(res.statusCode);
  }

  // If a spoofed, ever-changing X-Forwarded-For prefix could reset/evade the
  // per-IP counter, every one of these would stay 401. It must still trip,
  // because req.ip resolves to the stable 198.51.100.9, not the fake prefix.
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

test('password change: the update+revoke+recreate+audit sequence is atomic — a mid-sequence failure rolls back everything, including the already-applied password UPDATE', async () => {
  const built = await makeApp();
  await seedUser('admin', 'pw', { role: 'admin' });
  const a = await login(built, 'admin', 'pw');

  // Force the session INSERT (createSession, inside the write sequence) to
  // fail, simulating a mid-transaction error *after* the password_hash
  // UPDATE and the revoke-all DELETE have already run. If those two writes
  // aren't in the same db.transaction() as this INSERT, they'd survive the
  // failure; wrapped correctly, they must be rolled back too.
  const originalPrepare = db!.prepare.bind(db!);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).prepare = (sql: string, ...rest: unknown[]) => {
    if (sql.includes('INSERT INTO sessions')) {
      throw new Error('simulated failure mid password-change transaction');
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalPrepare as any)(sql, ...rest);
  };

  const res = await built.inject({
    method: 'POST',
    url: '/api/auth/password',
    cookies: { mirsal_session: a.session! },
    headers: { 'x-csrf-token': a.csrf! },
    payload: { current: 'pw', new: 'a-new-password-123' },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).prepare = originalPrepare;

  expect(res.statusCode).toBe(500); // unhandled throw -> Fastify's default error handler

  // The session used to make the request must still be valid: revokeAllForUser's
  // DELETE was rolled back along with the failed INSERT.
  const me = await built.inject({
    method: 'GET',
    url: '/api/auth/me',
    cookies: { mirsal_session: a.session! },
  });
  expect(me.statusCode).toBe(200);

  // The password itself must have reverted too: the OLD password still logs in.
  const reLogin = await login(built, 'admin', 'pw');
  expect(reLogin.statusCode).toBe(200);
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

// ── rootNodeId: non-null for any active user, even one never materialized ──
// A brand-new admin-created user has root_node_id = NULL until their first node
// op. Both /login and /me must still return a concrete synthetic-root id
// (resolved via ensureUserRoots) so the web can create a folder / move-to-root
// at an EMPTY root without waiting for a first child to exist.

test('login: rootNodeId is a positive id backed by a real kind=root node owned by the user (roots not pre-materialized)', async () => {
  const built = await makeApp();
  const userId = await seedUser('freshuser', 'pw', { role: 'user' });

  // Precondition: this user's roots were never materialized.
  const before = db!
    .prepare('SELECT root_node_id, trash_node_id FROM users WHERE id = ?')
    .get(userId) as { root_node_id: number | null; trash_node_id: number | null };
  expect(before.root_node_id).toBeNull();

  const res = await built.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'freshuser', password: 'pw' },
  });

  expect(res.statusCode).toBe(200);
  const body = res.json() as { user: { id: number; rootNodeId: number } };
  expect(typeof body.user.rootNodeId).toBe('number');
  expect(body.user.rootNodeId).toBeGreaterThan(0);

  // It corresponds to a real synthetic root node owned by that user.
  const rootRow = db!
    .prepare('SELECT owner_id, kind FROM nodes WHERE id = ?')
    .get(body.user.rootNodeId) as { owner_id: number; kind: string } | undefined;
  expect(rootRow).toBeDefined();
  expect(rootRow!.kind).toBe('root');
  expect(rootRow!.owner_id).toBe(userId);

  // And it was persisted onto the user row (ensureUserRoots materialized it).
  const after = db!
    .prepare('SELECT root_node_id FROM users WHERE id = ?')
    .get(userId) as { root_node_id: number | null };
  expect(after.root_node_id).toBe(body.user.rootNodeId);
});

test('GET /me: returns the same rootNodeId as login for the same user', async () => {
  const built = await makeApp();
  await seedUser('freshuser', 'pw', { role: 'user' });

  const loginRes = await login(built, 'freshuser', 'pw');
  const loginRoot = (loginRes.body as { user: { rootNodeId: number } }).user.rootNodeId;
  expect(typeof loginRoot).toBe('number');
  expect(loginRoot).toBeGreaterThan(0);

  const me = await built.inject({
    method: 'GET',
    url: '/api/auth/me',
    cookies: { mirsal_session: loginRes.session! },
  });
  expect(me.statusCode).toBe(200);
  const meBody = me.json() as { rootNodeId: number };
  expect(meBody.rootNodeId).toBe(loginRoot);
});
