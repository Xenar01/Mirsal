import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyHelmet from '@fastify/helmet';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type Database from 'better-sqlite3';
import { MAX_FILE_BYTES, type Config } from './config.js';
import type { Clock } from './clock.js';
import healthRoute from './routes/health.js';
import authRoutes from './routes/auth.js';
import nodesRoutes from './routes/nodes.js';
import sharesRoutes from './routes/shares.js';
import publicRoutes from './routes/public.js';
import { createPasswordService } from './auth/passwords.js';
import { makeGuards } from './auth/guards.js';
import { createBlobStore } from './storage/blobs.js';

export interface AppDeps {
  db: Database.Database;
  config: Config;
  now: Clock;
}

/**
 * Locates the `server` package root — the nearest ancestor directory
 * containing a `package.json` — starting from `startDir`. This is used
 * instead of a hard-coded number of `..` hops because the directory depth of
 * this module changes between environments: as TS source it lives at
 * `server/src/app.ts` (one level under the server root), but under this
 * project's own `tsconfig.json` (`rootDir: "."`, `outDir: "dist"`) a
 * `tsc`-compiled build emits it at `server/dist/src/app.js` (two levels
 * under the server root). Counting hops silently breaks in the compiled
 * case; searching for the `package.json` marker works in both.
 */
export function findServerRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not locate server package root (no package.json found above ${startDir})`
      );
    }
    dir = parent;
  }
}

/**
 * The built SPA (`web/dist`, produced by Phase I/J's Vite build), resolved
 * relative to the server package root (a sibling of `server/` in the repo) —
 * so it resolves correctly whether this module is running from TS source or
 * from a `tsc`-compiled `dist/` build (see `findServerRoot` above). It does
 * not exist yet in this phase — `buildApp` guards on it below so the API
 * boots and its tests pass without a frontend build.
 */
const WEB_DIST = path.resolve(
  findServerRoot(path.dirname(fileURLToPath(import.meta.url))),
  '..',
  'web',
  'dist'
);

/**
 * Registers every route plugin onto `app`. `health` was H1's only route;
 * H2 adds `auth`; H3–H6 add their own route plugins here onto the same
 * instance, keeping registration composable.
 *
 * `passwordService` and `guards` are built once, here, from the `config`/`db`/
 * `now` injected into `buildApp` — every route plugin below is handed the
 * same instances rather than each constructing its own (a fresh
 * `createPasswordService` per route would mean a fresh argon2 concurrency
 * semaphore per route, defeating its purpose of bounding *total* concurrent
 * argon2 memory use across the whole app).
 */
async function registerRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  await app.register(healthRoute);

  const passwordService = createPasswordService(deps.config);
  const guards = makeGuards({ db: deps.db, csrfSecret: deps.config.CSRF_SECRET, now: deps.now });

  await app.register(authRoutes, {
    db: deps.db,
    now: deps.now,
    passwordService,
    guards,
    csrfSecret: deps.config.CSRF_SECRET,
  });

  const blobStore = createBlobStore({ storageDir: deps.config.STORAGE_DIR });
  await app.register(nodesRoutes, { db: deps.db, now: deps.now, guards, blobStore });

  // H4: owner-scoped share management (requireAuth + CSRF via guard).
  await app.register(sharesRoutes, { db: deps.db, now: deps.now, guards, config: deps.config });

  // H4: the public access gate — NO auth, NO CSRF; every response under
  // `/api/public/*` gets `Referrer-Policy: no-referrer` (set inside the
  // plugin's own encapsulated onSend hook, so it never leaks onto the
  // authenticated routes above).
  await app.register(publicRoutes, {
    db: deps.db,
    now: deps.now,
    passwordService,
    blobStore,
    config: deps.config,
  });
}

/**
 * Builds (but does not `.listen()`) the Fastify instance: security headers,
 * cookies, multipart uploads, rate-limit scaffolding, API routes, and the
 * static SPA with a history fallback. `deps.now` is the sole clock source
 * passed down to route plugins.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  // `trustProxy: true` would trust the ENTIRE X-Forwarded-For chain
  // unboundedly — including hops an attacker fully controls — letting a
  // remote client spoof a fresh `req.ip` on every request (defeating
  // IP-keyed rate limiting; see routes/auth.ts's login limiter). The only
  // real proxy in front of this app is the host nginx vhost, reverse-proxying
  // from 127.0.0.1 (global-constraints.md: "Host nginx reverse-proxies
  // 127.0.0.1:8084"), so trust is bounded to exactly that: `'loopback'`
  // trusts just 127.0.0.0/8 and ::1, and Fastify (via @fastify/proxy-addr)
  // walks the X-Forwarded-For chain from the socket address inward only
  // while each hop is itself loopback, stopping at — and using — the first
  // untrusted (i.e. real client) address. Anything an attacker prepends
  // further left in the header is never consulted.
  const app = Fastify({ trustProxy: 'loopback' });

  // Strict CSP: self-only, no `unsafe-inline` scripts, no framing. `useDefaults:
  // false` means only the directives listed below apply (Helmet's own bundled
  // defaults, e.g. `form-action 'self'`, are intentionally not added).
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  });

  // Session tokens are already unguessable opaque values read straight from
  // `req.cookies` (see auth/guards.ts) — no signing secret needed here.
  await app.register(fastifyCookie);

  await app.register(fastifyMultipart, {
    limits: { fileSize: MAX_FILE_BYTES },
  });

  // Opt-in via a route's own `config.rateLimit` — available to future
  // single-cap routes (e.g. H4's `/unlock`). H2's `/login` needs TWO
  // independent caps (per-IP and per-username+ip) and registers its own
  // dedicated `@fastify/rate-limit` instances directly in routes/auth.ts
  // instead, since two limiters can't share one route's `config.rateLimit`
  // object without collapsing into a single, identical cap (see the comment
  // there).
  await app.register(fastifyRateLimit, { global: false });

  await registerRoutes(app, deps);

  const distExists = fs.existsSync(WEB_DIST);
  if (distExists) {
    await app.register(fastifyStatic, { root: WEB_DIST });
  }

  // Single catch-all: JSON 404 for unmatched /api/* (never let the SPA
  // fallback swallow API errors); index.html for other GETs so client-side
  // routing works, EXCEPT under /s/* (reserved for a dedicated route with its
  // own `Referrer-Policy: no-referrer`, added in a later task); a plain JSON
  // 404 otherwise (including when the SPA hasn't been built yet).
  app.setNotFoundHandler((req, reply) => {
    const pathname = req.url.split('?')[0];

    if (pathname.startsWith('/api/')) {
      reply.code(404).send({ error: 'Not Found' });
      return;
    }

    if (distExists && req.method === 'GET' && !pathname.startsWith('/s/')) {
      reply.sendFile('index.html');
      return;
    }

    reply.code(404).send({ error: 'Not Found' });
  });

  return app;
}
