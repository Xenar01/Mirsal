import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import argon2 from 'argon2';
import type Database from 'better-sqlite3';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { openDb } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { loadConfig } from '../../src/config.js';
import { buildApp } from '../../src/app.js';
import { createPasswordService } from '../../src/auth/passwords.js';
import { ensureUserRoots } from '../../src/nodes/tree.js';

const NOW = 1_700_000_000_000;
const clock = () => NOW;

const TEST_ARGON = {
  ARGON_MEMORY_KIB: 19456,
  ARGON_TIME: 2,
  ARGON_PARALLELISM: 1,
  ARGON_MAX_CONCURRENCY: 2,
};

const PUBLIC_BASE_URL = 'https://mirsal.example.test';

interface InjectedCookie {
  name: string;
  value: string;
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-h5-admin-'));
  const dbPath = path.join(dir, 't.db');
  db = openDb(dbPath);
  migrate(db);

  const config = loadConfig({
    DB_PATH: dbPath,
    STORAGE_DIR: path.join(dir, 'storage'),
    SESSION_SECRET: 'a-test-session-secret-16+',
    CSRF_SECRET: 'a-test-csrf-secret-16chars+',
    PUBLIC_BASE_URL,
  });

  app = await buildApp({ db, config, now: clock });
  return app;
}

/** Seeds a user with a real argon2 hash; must_change_password=0 so it can act cleanly. */
async function seedUser(
  username: string,
  password: string,
  overrides: Partial<{ role: string; isActive: number; quotaBytes: number | null }> = {}
): Promise<number> {
  const passwordService = createPasswordService(TEST_ARGON);
  const hash = await passwordService.hashPassword(password);
  const info = db!
    .prepare(
      `INSERT INTO users(username, password_hash, role, is_active, must_change_password, quota_bytes, used_bytes, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, 0, ?, ?)`
    )
    .run(
      username,
      hash,
      overrides.role ?? 'admin',
      overrides.isActive ?? 1,
      overrides.quotaBytes === undefined ? null : overrides.quotaBytes,
      NOW,
      NOW
    );
  return Number(info.lastInsertRowid);
}

function findCookie(cookies: InjectedCookie[], name: string): InjectedCookie | undefined {
  return cookies.find((c) => c.name === name);
}

async function login(
  built: FastifyInstance,
  username: string,
  password: string
): Promise<{ statusCode: number; session?: string; csrf?: string }> {
  const res = await built.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  const session = findCookie(res.cookies as InjectedCookie[], 'mirsal_session')?.value;
  const csrf = findCookie(res.cookies as InjectedCookie[], 'mirsal_csrf')?.value;
  return { statusCode: res.statusCode, session, csrf };
}

/** Convenience for a mutating admin call carrying the session + CSRF header. */
function adminReq(
  built: FastifyInstance,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  auth: { session: string; csrf: string },
  payload?: unknown
) {
  const opts: InjectOptions = {
    method,
    url,
    cookies: { mirsal_session: auth.session },
    headers: { 'x-csrf-token': auth.csrf },
  };
  if (payload !== undefined) opts.payload = payload as InjectOptions['payload'];
  return built.inject(opts);
}

// ---------------------------------------------------------------------------
// Create user + forced password change
// ---------------------------------------------------------------------------

test('POST /api/admin/users creates a user (must_change_password=1) who can then log in and is forced to change; DTO omits password_hash', async () => {
  const built = await makeApp();
  await seedUser('root', 'adminpw', { role: 'admin' });
  const admin = await login(built, 'root', 'adminpw');

  const createRes = await adminReq(built, 'POST', '/api/admin/users', admin as any, {
    username: 'u1',
    password: 'user-password-1',
    role: 'user',
  });
  expect(createRes.statusCode).toBe(201);
  const created = createRes.json();
  expect(created).toMatchObject({ username: 'u1', role: 'user', is_active: 1, must_change_password: 1, used_bytes: 0 });
  expect(created).not.toHaveProperty('password_hash');

  // That user can now log in with the initial password...
  const u1 = await login(built, 'u1', 'user-password-1');
  expect(u1.statusCode).toBe(200);
  expect(u1.session).toBeDefined();

  // ...and /me shows they are forced to change their password.
  const me = await built.inject({
    method: 'GET',
    url: '/api/auth/me',
    cookies: { mirsal_session: u1.session! },
  });
  expect(me.statusCode).toBe(200);
  expect(me.json()).toMatchObject({ username: 'u1', mustChangePassword: true });
});

test('POST /api/admin/users with a duplicate username -> 409, no second row', async () => {
  const built = await makeApp();
  await seedUser('root', 'adminpw', { role: 'admin' });
  const admin = await login(built, 'root', 'adminpw');

  const first = await adminReq(built, 'POST', '/api/admin/users', admin as any, {
    username: 'dupe',
    password: 'password-aaa',
    role: 'user',
  });
  expect(first.statusCode).toBe(201);

  const second = await adminReq(built, 'POST', '/api/admin/users', admin as any, {
    username: 'dupe',
    password: 'password-bbb',
    role: 'user',
  });
  expect(second.statusCode).toBe(409);

  const count = db!.prepare("SELECT COUNT(*) AS c FROM users WHERE username = 'dupe'").get() as { c: number };
  expect(count.c).toBe(1);
});

test('POST /api/admin/users with an invalid role -> 400', async () => {
  const built = await makeApp();
  await seedUser('root', 'adminpw', { role: 'admin' });
  const admin = await login(built, 'root', 'adminpw');

  const res = await adminReq(built, 'POST', '/api/admin/users', admin as any, {
    username: 'weird',
    password: 'password-aaa',
    role: 'superuser',
  });
  expect(res.statusCode).toBe(400);
});

test('POST /users persists and returns display_name (trimmed)', async () => {
  const built = await makeApp();
  await seedUser('admin', 'admin-pass-123', { role: 'admin' });
  const auth = await login(built, 'admin', 'admin-pass-123');
  const res = await adminReq(built, 'POST', '/api/admin/users', auth as { session: string; csrf: string }, {
    username: 'labeled',
    password: 'user-pass-123',
    role: 'user',
    display_name: '  أحمد الموظف  ',
  });
  expect(res.statusCode).toBe(201);
  expect(JSON.parse(res.body).display_name).toBe('أحمد الموظف');
});

test('POST /users without display_name stores null', async () => {
  const built = await makeApp();
  await seedUser('admin', 'admin-pass-123', { role: 'admin' });
  const auth = await login(built, 'admin', 'admin-pass-123');
  const res = await adminReq(built, 'POST', '/api/admin/users', auth as { session: string; csrf: string }, {
    username: 'nolabel',
    password: 'user-pass-123',
    role: 'user',
  });
  expect(res.statusCode).toBe(201);
  expect(JSON.parse(res.body).display_name).toBeNull();
});

// ---------------------------------------------------------------------------
// List users + usage
// ---------------------------------------------------------------------------

test('GET /api/admin/users lists every user with usage fields and never a password_hash', async () => {
  const built = await makeApp();
  await seedUser('root', 'adminpw', { role: 'admin' });
  await seedUser('alice', 'pw', { role: 'user', quotaBytes: 1000 });
  const admin = await login(built, 'root', 'adminpw');

  const res = await built.inject({
    method: 'GET',
    url: '/api/admin/users',
    cookies: { mirsal_session: admin.session! },
  });
  expect(res.statusCode).toBe(200);
  const users = res.json() as Array<Record<string, unknown>>;
  expect(users.length).toBe(2);
  for (const u of users) {
    expect(u).toHaveProperty('used_bytes');
    expect(u).toHaveProperty('quota_bytes');
    expect(u).toHaveProperty('is_active');
    expect(u).toHaveProperty('created_at');
    expect(u).not.toHaveProperty('password_hash');
  }
  expect(JSON.stringify(users)).not.toContain('password_hash');
});

// ---------------------------------------------------------------------------
// Last-admin guard + self guard
// ---------------------------------------------------------------------------

test('PATCH deactivate: fine while another active admin remains, but 409 last_admin once it would drop below one active admin', async () => {
  const built = await makeApp();
  await seedUser('root', 'adminpw', { role: 'admin' });
  const admin2Id = await seedUser('root2', 'adminpw2', { role: 'admin' });
  const admin = await login(built, 'root', 'adminpw');

  // Two active admins -> deactivating the SECOND one is allowed.
  const okRes = await adminReq(built, 'PATCH', `/api/admin/users/${admin2Id}`, admin as any, { is_active: false });
  expect(okRes.statusCode).toBe(200);

  // Now 'root' is the last active admin -> deactivating it (self) is refused.
  const selfId = (db!.prepare("SELECT id FROM users WHERE username = 'root'").get() as { id: number }).id;
  const lastRes = await adminReq(built, 'PATCH', `/api/admin/users/${selfId}`, admin as any, { is_active: false });
  expect(lastRes.statusCode).toBe(409);
  expect(lastRes.json()).toMatchObject({ code: 'last_admin' });

  // 'root' is still active (the refused change never applied).
  const stillActive = db!.prepare("SELECT is_active FROM users WHERE username = 'root'").get() as { is_active: number };
  expect(stillActive.is_active).toBe(1);
});

test('PATCH demote the last active admin -> 409 last_admin', async () => {
  const built = await makeApp();
  const rootId = await seedUser('root', 'adminpw', { role: 'admin' });
  const admin = await login(built, 'root', 'adminpw');

  const res = await adminReq(built, 'PATCH', `/api/admin/users/${rootId}`, admin as any, { role: 'user' });
  expect(res.statusCode).toBe(409);
  expect(res.json()).toMatchObject({ code: 'last_admin' });
  const role = db!.prepare('SELECT role FROM users WHERE id = ?').get(rootId) as { role: string };
  expect(role.role).toBe('admin');
});

test('PATCH self-deactivate while another admin still exists -> 409 self (not last_admin)', async () => {
  const built = await makeApp();
  const rootId = await seedUser('root', 'adminpw', { role: 'admin' });
  await seedUser('root2', 'adminpw2', { role: 'admin' });
  const admin = await login(built, 'root', 'adminpw');

  const res = await adminReq(built, 'PATCH', `/api/admin/users/${rootId}`, admin as any, { is_active: false });
  expect(res.statusCode).toBe(409);
  expect(res.json()).toMatchObject({ code: 'self' });
});

test('DELETE self while another admin still exists -> 409 self, row untouched', async () => {
  const built = await makeApp();
  const rootId = await seedUser('root', 'adminpw', { role: 'admin' });
  await seedUser('root2', 'adminpw2', { role: 'admin' });
  const admin = await login(built, 'root', 'adminpw');

  const res = await adminReq(built, 'DELETE', `/api/admin/users/${rootId}`, admin as any);
  expect(res.statusCode).toBe(409);
  expect(res.json()).toMatchObject({ code: 'self' });
  const row = db!.prepare('SELECT id FROM users WHERE id = ?').get(rootId);
  expect(row).toBeDefined();
});

test('PATCH quota_bytes on the last admin is allowed (not a lowering change)', async () => {
  const built = await makeApp();
  const rootId = await seedUser('root', 'adminpw', { role: 'admin' });
  const admin = await login(built, 'root', 'adminpw');

  const res = await adminReq(built, 'PATCH', `/api/admin/users/${rootId}`, admin as any, { quota_bytes: 5000 });
  expect(res.statusCode).toBe(200);
  const row = db!.prepare('SELECT quota_bytes FROM users WHERE id = ?').get(rootId) as { quota_bytes: number };
  expect(row.quota_bytes).toBe(5000);
});

test('PATCH /users/:id sets and then clears display_name', async () => {
  const built = await makeApp();
  await seedUser('admin', 'admin-pass-123', { role: 'admin' });
  const uid = await seedUser('target', 'x', { role: 'user' });
  const auth = (await login(built, 'admin', 'admin-pass-123')) as { session: string; csrf: string };

  const setRes = await adminReq(built, 'PATCH', `/api/admin/users/${uid}`, auth, { display_name: 'سارة' });
  expect(setRes.statusCode).toBe(200);
  expect(JSON.parse(setRes.body).display_name).toBe('سارة');

  const clearRes = await adminReq(built, 'PATCH', `/api/admin/users/${uid}`, auth, { display_name: null });
  expect(clearRes.statusCode).toBe(200);
  expect(JSON.parse(clearRes.body).display_name).toBeNull();
});

test('PATCH /users/:id with only display_name is accepted (refine allows it)', async () => {
  const built = await makeApp();
  await seedUser('admin', 'admin-pass-123', { role: 'admin' });
  const uid = await seedUser('target2', 'x', { role: 'user' });
  const auth = (await login(built, 'admin', 'admin-pass-123')) as { session: string; csrf: string };
  const res = await adminReq(built, 'PATCH', `/api/admin/users/${uid}`, auth, { display_name: 'علي' });
  expect(res.statusCode).toBe(200);
});

// ---------------------------------------------------------------------------
// Deactivate + password reset both revoke sessions
// ---------------------------------------------------------------------------

test('PATCH deactivate a user revokes all their sessions', async () => {
  const built = await makeApp();
  await seedUser('root', 'adminpw', { role: 'admin' });
  const aliceId = await seedUser('alice', 'pw', { role: 'user' });
  const admin = await login(built, 'root', 'adminpw');
  const alice = await login(built, 'alice', 'pw');
  expect(alice.session).toBeDefined();

  const res = await adminReq(built, 'PATCH', `/api/admin/users/${aliceId}`, admin as any, { is_active: false });
  expect(res.statusCode).toBe(200);

  // Alice's session no longer authenticates.
  const me = await built.inject({ method: 'GET', url: '/api/auth/me', cookies: { mirsal_session: alice.session! } });
  expect(me.statusCode).toBe(401);
  const sessions = db!.prepare('SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?').get(aliceId) as { c: number };
  expect(sessions.c).toBe(0);
});

test('POST /api/admin/users/:id/password resets to a generated password (returned once), forces change, and revokes sessions', async () => {
  const built = await makeApp();
  await seedUser('root', 'adminpw', { role: 'admin' });
  const aliceId = await seedUser('alice', 'oldpw', { role: 'user' });
  const admin = await login(built, 'root', 'adminpw');
  const alice = await login(built, 'alice', 'oldpw');
  expect(alice.session).toBeDefined();

  const res = await adminReq(built, 'POST', `/api/admin/users/${aliceId}/password`, admin as any, {});
  expect(res.statusCode).toBe(200);
  const body = res.json() as { password?: string };
  expect(typeof body.password).toBe('string');
  expect(body.password!.length).toBeGreaterThanOrEqual(8);

  // Old session revoked.
  const oldMe = await built.inject({ method: 'GET', url: '/api/auth/me', cookies: { mirsal_session: alice.session! } });
  expect(oldMe.statusCode).toBe(401);

  // Old password no longer works; the generated one does, and forces a change.
  const oldLogin = await login(built, 'alice', 'oldpw');
  expect(oldLogin.statusCode).toBe(401);
  const newLogin = await login(built, 'alice', body.password!);
  expect(newLogin.statusCode).toBe(200);
  const me = await built.inject({ method: 'GET', url: '/api/auth/me', cookies: { mirsal_session: newLogin.session! } });
  expect(me.json()).toMatchObject({ mustChangePassword: true });
});

test('POST /api/admin/users/:id/password with an explicit password uses it (and does not echo it back)', async () => {
  const built = await makeApp();
  await seedUser('root', 'adminpw', { role: 'admin' });
  const aliceId = await seedUser('alice', 'oldpw', { role: 'user' });
  const admin = await login(built, 'root', 'adminpw');

  const res = await adminReq(built, 'POST', `/api/admin/users/${aliceId}/password`, admin as any, {
    password: 'chosen-password-9',
  });
  expect(res.statusCode).toBe(200);
  expect(JSON.stringify(res.json())).not.toContain('chosen-password-9');

  const newLogin = await login(built, 'alice', 'chosen-password-9');
  expect(newLogin.statusCode).toBe(200);
});

test('POST /api/admin/users/:id/password: user deleted during the hashPassword await -> 404, no phantom audit row', async () => {
  const built = await makeApp();
  await seedUser('root', 'adminpw', { role: 'admin' });
  const aliceId = await seedUser('alice', 'oldpw', { role: 'user' });
  const admin = await login(built, 'root', 'adminpw');

  // The route's existence check runs, finds alice, then awaits
  // `passwordService.hashPassword`. Simulate a concurrent DELETE landing
  // precisely inside that await gap by deleting alice from inside a mocked
  // `argon2.hash` before it resolves (mirrors the createShare TOCTOU test in
  // test/shares/shares.test.ts). If the route only re-checked existence
  // before the await and blindly UPDATEd/audited afterward, this would still
  // report a fake 200 success and write a `user_password_reset` row for a
  // user that no longer exists.
  const originalHash = argon2.hash.bind(argon2);
  const spy = vi.spyOn(argon2, 'hash').mockImplementation(async (password, options) => {
    db!.prepare('DELETE FROM users WHERE id = ?').run(aliceId);
    return originalHash(password, options);
  });

  let res;
  try {
    res = await adminReq(built, 'POST', `/api/admin/users/${aliceId}/password`, admin as any, {});
  } finally {
    spy.mockRestore();
  }
  expect(res.statusCode).toBe(404);

  // No phantom user_password_reset audit row for the vanished user.
  const auditRes = await built.inject({
    method: 'GET',
    url: '/api/admin/audit',
    cookies: { mirsal_session: admin.session! },
  });
  const actions = (auditRes.json() as Array<{ action: string }>).map((r) => r.action);
  expect(actions).not.toContain('user_password_reset');
});

// ---------------------------------------------------------------------------
// Metadata-only browse + no admin content endpoint
// ---------------------------------------------------------------------------

test('GET /api/admin/users/:id/nodes returns metadata (names/sizes) but never storage_path, and there is no admin content endpoint', async () => {
  const built = await makeApp();
  await seedUser('root', 'adminpw', { role: 'admin' });
  const aliceId = await seedUser('alice', 'pw', { role: 'user' });
  const admin = await login(built, 'root', 'adminpw');

  // Give alice a real folder + a file node (with a storage_path set on disk-model).
  const { rootId } = ensureUserRoots(db!, aliceId, NOW);
  const folderId = Number(
    db!
      .prepare(
        `INSERT INTO nodes(owner_id, parent_id, kind, name, created_at, updated_at) VALUES (?, ?, 'folder', ?, ?, ?)`
      )
      .run(aliceId, rootId, 'Photos', NOW, NOW).lastInsertRowid
  );
  const fileId = Number(
    db!
      .prepare(
        `INSERT INTO nodes(owner_id, parent_id, kind, name, size_bytes, mime_type, storage_path, created_at, updated_at)
         VALUES (?, ?, 'file', ?, ?, ?, ?, ?, ?)`
      )
      .run(aliceId, folderId, 'secret.txt', 1234, 'text/plain', `${aliceId}/999`, NOW, NOW).lastInsertRowid
  );

  const res = await built.inject({
    method: 'GET',
    url: `/api/admin/users/${aliceId}/nodes`,
    cookies: { mirsal_session: admin.session! },
  });
  expect(res.statusCode).toBe(200);
  const nodes = res.json() as Array<Record<string, unknown>>;

  const file = nodes.find((n) => n.id === fileId);
  expect(file).toBeDefined();
  expect(file).toMatchObject({ name: 'secret.txt', size_bytes: 1234, mime_type: 'text/plain', kind: 'file' });
  expect(nodes.find((n) => n.id === folderId)).toMatchObject({ name: 'Photos', kind: 'folder' });

  // storage_path must never appear anywhere in the projection.
  for (const n of nodes) expect(n).not.toHaveProperty('storage_path');
  expect(JSON.stringify(nodes)).not.toContain('storage_path');
  expect(JSON.stringify(nodes)).not.toContain(`${aliceId}/999`);

  // There is deliberately NO admin download/content endpoint.
  const dl = await built.inject({
    method: 'GET',
    url: `/api/admin/users/${aliceId}/nodes/${fileId}/download`,
    cookies: { mirsal_session: admin.session! },
  });
  expect(dl.statusCode).toBe(404);
});

test('GET /api/admin/users/:id/nodes for a nonexistent user -> 404', async () => {
  const built = await makeApp();
  await seedUser('root', 'adminpw', { role: 'admin' });
  const admin = await login(built, 'root', 'adminpw');

  const res = await built.inject({
    method: 'GET',
    url: '/api/admin/users/99999/nodes',
    cookies: { mirsal_session: admin.session! },
  });
  expect(res.statusCode).toBe(404);
});

// ---------------------------------------------------------------------------
// Global shares list + force-revoke
// ---------------------------------------------------------------------------

test('GET /api/admin/shares lists shares across users with owner + node name + status; DELETE force-revokes any share', async () => {
  const built = await makeApp();
  await seedUser('root', 'adminpw', { role: 'admin' });
  const aliceId = await seedUser('alice', 'pw', { role: 'user' });
  const admin = await login(built, 'root', 'adminpw');
  const alice = await login(built, 'alice', 'pw');

  const { rootId } = ensureUserRoots(db!, aliceId, NOW);
  const folder = await built.inject({
    method: 'POST',
    url: '/api/nodes/folder',
    cookies: { mirsal_session: alice.session! },
    headers: { 'x-csrf-token': alice.csrf! },
    payload: { parent_id: rootId, name: 'Shared' },
  });
  const folderId = folder.json().id as number;

  const share = await built.inject({
    method: 'POST',
    url: '/api/shares',
    cookies: { mirsal_session: alice.session! },
    headers: { 'x-csrf-token': alice.csrf! },
    payload: { node_id: folderId },
  });
  const shareId = share.json().id as number;
  const rawToken = share.json().token as string;
  expect(typeof rawToken).toBe('string');

  const listRes = await built.inject({
    method: 'GET',
    url: '/api/admin/shares',
    cookies: { mirsal_session: admin.session! },
  });
  expect(listRes.statusCode).toBe(200);
  const shares = listRes.json() as Array<Record<string, unknown>>;
  const row = shares.find((s) => s.id === shareId)!;
  expect(row).toBeDefined();
  expect(row).toMatchObject({ owner_username: 'alice', node_name: 'Shared', status: 'active' });
  expect(row).not.toHaveProperty('password_hash');

  // The raw share token is a fully unauthenticated bearer capability for the
  // public /api/public/:token/* content routes — it must never appear in the
  // admin projection (defeats the "admin has no content path" invariant).
  expect(row).not.toHaveProperty('token');
  expect(JSON.stringify(shares)).not.toContain(rawToken);

  // Admin force-revokes another user's share.
  const delRes = await adminReq(built, 'DELETE', `/api/admin/shares/${shareId}`, admin as any);
  expect(delRes.statusCode).toBe(200);
  const gone = db!.prepare('SELECT id FROM shares WHERE id = ?').get(shareId);
  expect(gone).toBeUndefined();

  // A second revoke -> 404.
  const delAgain = await adminReq(built, 'DELETE', `/api/admin/shares/${shareId}`, admin as any);
  expect(delAgain.statusCode).toBe(404);
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

test('admin state-changing actions write audit rows; GET /api/admin/audit returns them newest-first', async () => {
  const built = await makeApp();
  const rootId = await seedUser('root', 'adminpw', { role: 'admin' });
  const admin = await login(built, 'root', 'adminpw');

  const created = await adminReq(built, 'POST', '/api/admin/users', admin as any, {
    username: 'audituser',
    password: 'password-aaa',
    role: 'user',
  });
  const newUserId = created.json().id as number;
  await adminReq(built, 'PATCH', `/api/admin/users/${newUserId}`, admin as any, { quota_bytes: 42 });

  const auditRes = await built.inject({
    method: 'GET',
    url: '/api/admin/audit',
    cookies: { mirsal_session: admin.session! },
  });
  expect(auditRes.statusCode).toBe(200);
  const rows = auditRes.json() as Array<{ action: string; actor_id: number; target: string | null; created_at: number }>;
  const actions = rows.map((r) => r.action);
  expect(actions).toContain('user_create');
  expect(actions).toContain('user_update');

  // Newest-first ordering.
  const times = rows.map((r) => r.created_at);
  const ids = rows.map((r) => (r as unknown as { id: number }).id);
  expect(ids).toEqual([...ids].sort((a, b) => b - a));
  expect(times.length).toBeGreaterThan(0);

  // The user_create row records the acting admin as actor.
  const createRow = rows.find((r) => r.action === 'user_create')!;
  expect(createRow.actor_id).toBe(rootId);
  // No secret material in the audit detail.
  expect(JSON.stringify(rows)).not.toContain('password-aaa');
});

test('GET /api/admin/audit redacts a share_unlock_failure target (routes/public.ts stores the raw share token there) but leaves ordinary targets untouched', async () => {
  const built = await makeApp();
  await seedUser('root', 'adminpw', { role: 'admin' });
  const admin = await login(built, 'root', 'adminpw');

  // Simulate two pre-existing rows exactly as routes/public.ts's failed
  // `/unlock` handler writes them: `target` is the literal share token.
  const rawToken = 'a-very-secret-public-share-bearer-token-1234567890';
  db!
    .prepare('INSERT INTO audit_log(actor_id, action, target, detail, created_at) VALUES (?, ?, ?, NULL, ?)')
    .run(1, 'share_unlock_failure', rawToken, NOW);
  db!
    .prepare('INSERT INTO audit_log(actor_id, action, target, detail, created_at) VALUES (?, ?, ?, NULL, ?)')
    .run(1, 'share_unlock_failure', rawToken, NOW);
  // An ordinary action's target (a share DB id, not a secret) must pass through unchanged.
  db!
    .prepare('INSERT INTO audit_log(actor_id, action, target, detail, created_at) VALUES (?, ?, ?, NULL, ?)')
    .run(1, 'share_revoke', '42', NOW);

  const res = await built.inject({
    method: 'GET',
    url: '/api/admin/audit',
    cookies: { mirsal_session: admin.session! },
  });
  expect(res.statusCode).toBe(200);
  const rows = res.json() as Array<{ action: string; target: string | null }>;

  const unlockRows = rows.filter((r) => r.action === 'share_unlock_failure');
  expect(unlockRows.length).toBe(2);
  for (const r of unlockRows) {
    expect(r.target).not.toBe(rawToken);
    expect(r.target).not.toBeNull();
  }
  // Same raw token -> same redacted value (still useful for correlating
  // repeated attempts against the same share), and the raw token never
  // appears anywhere in the response.
  expect(unlockRows[0].target).toBe(unlockRows[1].target);
  expect(JSON.stringify(rows)).not.toContain(rawToken);

  const revokeRow = rows.find((r) => r.action === 'share_revoke')!;
  expect(revokeRow.target).toBe('42');
});

test('audit DTO resolves actor and user-target usernames, redacts secret targets', async () => {
  const built = await makeApp();
  const adminId = await seedUser('admin', 'admin-pass-123', { role: 'admin' });
  const auth = (await login(built, 'admin', 'admin-pass-123')) as { session: string; csrf: string };

  // A real user-management action → writes a user_create audit row with the new user's id as target.
  const createRes = await adminReq(built, 'POST', '/api/admin/users', auth, {
    username: 'newbie',
    password: 'user-pass-123',
    role: 'user',
    display_name: 'المستخدم الجديد',
  });
  const newId = JSON.parse(createRes.body).id as number;

  // A secret-target row (simulate a failed share unlock) inserted directly.
  db!
    .prepare('INSERT INTO audit_log(actor_id, action, target, detail, created_at) VALUES (NULL, ?, ?, NULL, ?)')
    .run('share_unlock_failure', 'super-secret-token-value', NOW);

  const res = await adminReq(built, 'GET', '/api/admin/audit', auth);
  expect(res.statusCode).toBe(200);
  const rows = JSON.parse(res.body) as Array<Record<string, unknown>>;

  const createRow = rows.find((r) => r.action === 'user_create' && Number(r.target) === newId)!;
  expect(createRow.actor_username).toBe('admin');
  expect(createRow.actor_id).toBe(adminId);
  expect(createRow.target_username).toBe('newbie');
  expect(createRow.target_display_name).toBe('المستخدم الجديد');

  const secretRow = rows.find((r) => r.action === 'share_unlock_failure')!;
  expect(secretRow.actor_username).toBeNull();
  expect(String(secretRow.target)).toMatch(/^redacted:/); // still redacted
  expect(secretRow.target_username).toBeNull(); // never resolved
});

test('audit DTO leaves target_username null for a deleted user target', async () => {
  const built = await makeApp();
  await seedUser('admin', 'admin-pass-123', { role: 'admin' });
  const auth = (await login(built, 'admin', 'admin-pass-123')) as { session: string; csrf: string };
  // Audit row referencing a user id that does not exist.
  db!
    .prepare('INSERT INTO audit_log(actor_id, action, target, detail, created_at) VALUES (NULL, ?, ?, NULL, ?)')
    .run('user_delete', '99999', NOW);
  const res = await adminReq(built, 'GET', '/api/admin/audit', auth);
  const rows = JSON.parse(res.body) as Array<Record<string, unknown>>;
  const row = rows.find((r) => r.action === 'user_delete' && r.target === '99999')!;
  expect(row.target_username).toBeNull();
  expect(row.target_display_name).toBeNull();
});

// ---------------------------------------------------------------------------
// AuthZ: requireAdmin on every route
// ---------------------------------------------------------------------------

test('a non-admin user is refused every admin route (403); no session -> 401', async () => {
  const built = await makeApp();
  await seedUser('root', 'adminpw', { role: 'admin' });
  await seedUser('alice', 'pw', { role: 'user' });
  const alice = await login(built, 'alice', 'pw');

  const forbidden = await built.inject({
    method: 'GET',
    url: '/api/admin/users',
    cookies: { mirsal_session: alice.session! },
  });
  expect(forbidden.statusCode).toBe(403);

  const unauth = await built.inject({ method: 'GET', url: '/api/admin/users' });
  expect(unauth.statusCode).toBe(401);
});

test('mutating admin routes require the CSRF header (inherited from requireAdmin)', async () => {
  const built = await makeApp();
  await seedUser('root', 'adminpw', { role: 'admin' });
  const admin = await login(built, 'root', 'adminpw');

  const res = await built.inject({
    method: 'POST',
    url: '/api/admin/users',
    cookies: { mirsal_session: admin.session! },
    // no x-csrf-token header
    payload: { username: 'x', password: 'password-aaa', role: 'user' },
  });
  expect(res.statusCode).toBe(403);
});
