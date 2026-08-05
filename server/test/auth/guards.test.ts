import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { openDb } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { createSession } from '../../src/auth/sessions.js';
import { createCsrf } from '../../src/auth/csrf.js';
import { CSRF_HEADER, SESSION_COOKIE, makeGuards } from '../../src/auth/guards.js';

const CSRF_SECRET = 'a-test-secret-16+chars';
const { issueCsrf } = createCsrf(CSRF_SECRET);

let db: Database.Database | undefined;
let dir: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsal-c3-'));
  const dbPath = path.join(dir, 't.db');
  db = openDb(dbPath);
  migrate(db);
});

afterEach(() => {
  db?.close();
  db = undefined;
  if (dir) {
    fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

function seedUser(role: string): number {
  const t = Date.now();
  const info = db!
    .prepare(
      `INSERT INTO users(username, password_hash, role, is_active, must_change_password, created_at, updated_at)
       VALUES (?, 'x', ?, 1, 0, ?, ?)`,
    )
    .run(`user-${role}-${t}`, role, t, t);
  return Number(info.lastInsertRowid);
}

/** Minimal stand-in for FastifyRequest — just what the guards read. */
function makeReq(opts: { cookie?: string; method?: string; csrf?: string }): FastifyRequest {
  return {
    cookies: opts.cookie === undefined ? {} : { [SESSION_COOKIE]: opts.cookie },
    method: opts.method ?? 'GET',
    headers: opts.csrf === undefined ? {} : { [CSRF_HEADER]: opts.csrf },
  } as unknown as FastifyRequest;
}

/** Minimal stand-in for FastifyReply — records code()/send() calls. */
function makeReply(): FastifyReply & { codes: number[] } {
  const reply = {
    codes: [] as number[],
    sent: false,
    code(code: number) {
      reply.codes.push(code);
      return reply;
    },
    send() {
      reply.sent = true;
      return reply;
    },
  };
  return reply as unknown as FastifyReply & { codes: number[] };
}

test('requireAuth: missing session cookie -> 401, req.user unset', async () => {
  const { requireAuth } = makeGuards({ db: db!, csrfSecret: CSRF_SECRET, now: () => Date.now() });
  const req = makeReq({});
  const reply = makeReply();

  await requireAuth(req, reply);

  expect(reply.codes).toEqual([401]);
  expect(req.user).toBeUndefined();
});

test('requireAuth: unknown/invalid session token -> 401', async () => {
  const { requireAuth } = makeGuards({ db: db!, csrfSecret: CSRF_SECRET, now: () => Date.now() });
  const req = makeReq({ cookie: 'not-a-real-token' });
  const reply = makeReply();

  await requireAuth(req, reply);

  expect(reply.codes).toEqual([401]);
});

test('requireAuth: valid session + GET (safe method) -> sets req.user, no CSRF required', async () => {
  const uid = seedUser('user');
  const now = Date.now();
  const { token } = createSession(db!, uid, now);
  const { requireAuth } = makeGuards({ db: db!, csrfSecret: CSRF_SECRET, now: () => now });
  const req = makeReq({ cookie: token, method: 'GET' });
  const reply = makeReply();

  await requireAuth(req, reply);

  expect(reply.codes).toEqual([]);
  expect(req.user).toEqual({ id: uid, role: 'user', mustChangePassword: false });
});

test('requireAuth: valid session + POST without CSRF header -> 403', async () => {
  const uid = seedUser('user');
  const now = Date.now();
  const { token } = createSession(db!, uid, now);
  const { requireAuth } = makeGuards({ db: db!, csrfSecret: CSRF_SECRET, now: () => now });
  const req = makeReq({ cookie: token, method: 'POST' });
  const reply = makeReply();

  await requireAuth(req, reply);

  expect(reply.codes).toEqual([403]);
});

test('requireAuth: valid session + POST with a forged CSRF header -> 403', async () => {
  const uid = seedUser('user');
  const now = Date.now();
  const { token } = createSession(db!, uid, now);
  const { requireAuth } = makeGuards({ db: db!, csrfSecret: CSRF_SECRET, now: () => now });
  const req = makeReq({ cookie: token, method: 'POST', csrf: 'forged' });
  const reply = makeReply();

  await requireAuth(req, reply);

  expect(reply.codes).toEqual([403]);
});

test('requireAuth: valid session + POST with the matching CSRF header -> passes', async () => {
  const uid = seedUser('user');
  const now = Date.now();
  const { token } = createSession(db!, uid, now);
  const { requireAuth } = makeGuards({ db: db!, csrfSecret: CSRF_SECRET, now: () => now });
  const req = makeReq({ cookie: token, method: 'POST', csrf: issueCsrf(token) });
  const reply = makeReply();

  await requireAuth(req, reply);

  expect(reply.codes).toEqual([]);
  expect(req.user).toEqual({ id: uid, role: 'user', mustChangePassword: false });
});

test('requireAdmin: valid session with role "user" -> 403', async () => {
  const uid = seedUser('user');
  const now = Date.now();
  const { token } = createSession(db!, uid, now);
  const { requireAdmin } = makeGuards({ db: db!, csrfSecret: CSRF_SECRET, now: () => now });
  const req = makeReq({ cookie: token, method: 'GET' });
  const reply = makeReply();

  await requireAdmin(req, reply);

  expect(reply.codes).toEqual([403]);
});

test('requireAdmin: valid session with role "admin" -> passes', async () => {
  const uid = seedUser('admin');
  const now = Date.now();
  const { token } = createSession(db!, uid, now);
  const { requireAdmin } = makeGuards({ db: db!, csrfSecret: CSRF_SECRET, now: () => now });
  const req = makeReq({ cookie: token, method: 'GET' });
  const reply = makeReply();

  await requireAdmin(req, reply);

  expect(reply.codes).toEqual([]);
  expect(req.user?.role).toBe('admin');
});

test('requireAdmin: missing session -> 401 (not 403 — requireAuth short-circuits first)', async () => {
  const { requireAdmin } = makeGuards({ db: db!, csrfSecret: CSRF_SECRET, now: () => Date.now() });
  const req = makeReq({});
  const reply = makeReply();

  await requireAdmin(req, reply);

  expect(reply.codes).toEqual([401]);
});

test('requireAuth/requireAdmin return real Promises so a real Fastify preHandler chain awaits them instead of hanging forever', async () => {
  // Regression test for the review finding: a 2-arg Fastify preHandler that
  // never calls `done` and never returns a Promise is never awaited by
  // Fastify — the request hangs forever (route handler never runs, no
  // response is ever sent). Asserting a genuine thenable is returned (and
  // that it resolves) is what guarantees real wiring in Phase H won't hang.
  const { requireAuth, requireAdmin } = makeGuards({
    db: db!,
    csrfSecret: CSRF_SECRET,
    now: () => Date.now(),
  });

  const authResult = requireAuth(makeReq({}), makeReply());
  expect(authResult).toBeInstanceOf(Promise);
  await expect(authResult).resolves.toBeUndefined();

  const adminResult = requireAdmin(makeReq({}), makeReply());
  expect(adminResult).toBeInstanceOf(Promise);
  await expect(adminResult).resolves.toBeUndefined();
});
