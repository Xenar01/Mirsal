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

export interface AppDeps {
  db: Database.Database;
  config: Config;
  now: Clock;
}

/**
 * The built SPA (`web/dist`, produced by Phase I/J's Vite build). Resolved
 * relative to this source file (`server/src/app.ts` -> repo root -> `web/dist`).
 * It does not exist yet in this phase — `buildApp` guards on it below so the
 * API boots and its tests pass without a frontend build.
 */
const WEB_DIST = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'web',
  'dist'
);

/**
 * Registers every route plugin onto `app`. `health` is this task's only
 * route; H2–H6 add their own route plugins here onto the same instance,
 * keeping registration composable.
 */
async function registerRoutes(app: FastifyInstance, _deps: AppDeps): Promise<void> {
  await app.register(healthRoute);
}

/**
 * Builds (but does not `.listen()`) the Fastify instance: security headers,
 * cookies, multipart uploads, rate-limit scaffolding, API routes, and the
 * static SPA with a history fallback. `deps.now` is the sole clock source
 * passed down to route plugins.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ trustProxy: true });

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

  // Per-route limiters opt in later (H2/H4) via each route's own `config.rateLimit`.
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
