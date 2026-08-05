import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ReadStream } from 'node:fs';
import type {} from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import type Database from 'better-sqlite3';
import { ZipArchive } from 'archiver';
import { z } from 'zod';
import type { Clock } from '../clock.js';
import type { PasswordService } from '../auth/passwords.js';
import type { BlobStore } from '../storage/blobs.js';
import type { Config } from '../config.js';
import { writeAudit } from '../audit.js';
import { isShareLive } from '../shares/gate.js';
import { ForbiddenError, listPublic, resolveInSubtree } from '../shares/resolver.js';
import type { Node } from '../nodes/tree.js';
import type { Share } from '../shares/shares.js';
import { buildContentDisposition } from '../util/content-disposition.js';
import { createReservations } from '../shares/download-reservations.js';
import { applyExhaustion } from '../shares/exhaustion.js';
import { appendFilesToArchive, collectSubtreeFiles, zipFileName, ZIP_COMPRESSION_LEVEL } from '../util/zip.js';

export interface PublicRouteDeps {
  db: Database.Database;
  now: Clock;
  passwordService: PasswordService;
  blobStore: BlobStore;
  config: Config;
}

/** Public projection of a node row — omits `storage_path`/`owner_id`/`auto_delete_at` and any other internal column. */
interface PublicNodeDto {
  id: number;
  kind: Node['kind'];
  name: string;
  size_bytes: number;
  mime_type: string | null;
}

function toPublicNodeDto(node: Node): PublicNodeDto {
  return { id: node.id, kind: node.kind, name: node.name, size_bytes: node.size_bytes, mime_type: node.mime_type };
}

/** Name of the short-lived, path-scoped cookie that marks a password share as unlocked. */
const UNLOCK_COOKIE = 'mirsal_unlock';
/**
 * Unlock cookie server-side lifetime (10 min). A short transport bridge only —
 * the client re-prompts on every fresh open (#11) by omitting this cookie until
 * an in-session unlock; this bounds how long the cookie can authorize the
 * download/list requests of a single page interaction.
 */
const UNLOCK_COOKIE_MAX_AGE_S = 600;

/**
 * Per-token cap on `/unlock` attempts within the window — the tighter of the
 * two caps, so a single share is defended against distributed guessing (many
 * IPs against one token). Trips before the looser per-IP cap under a
 * same-token brute-force.
 */
const UNLOCK_TOKEN_RATE_LIMIT_MAX = 5;
/** Per-IP cap on `/unlock` attempts — bounds one IP spraying many different tokens. */
const UNLOCK_IP_RATE_LIMIT_MAX = 20;
/** Shared `/unlock` rate-limit window. */
const UNLOCK_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/**
 * `/download` and `/zip` are unauthenticated (anyone holding the share link
 * can call them) and stream bytes/do real work per request, so both get the
 * same two-ceiling (per-IP + per-token) rate-limit shape as `/unlock` below.
 * `/zip` additionally gets a tighter cap plus a hard concurrency bound
 * (`MAX_CONCURRENT_ZIPS`) and a much cheaper compression level, since it is
 * by far the most expensive of the two (it reads and re-compresses every
 * file in the subtree, not just one).
 */
const DOWNLOAD_IP_RATE_LIMIT_MAX = 60;
const DOWNLOAD_TOKEN_RATE_LIMIT_MAX = 120;
const DOWNLOAD_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

const ZIP_IP_RATE_LIMIT_MAX = 10;
const ZIP_TOKEN_RATE_LIMIT_MAX = 20;
const ZIP_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

/**
 * Hard cap on `/zip` requests running at once, server-wide. A rate-limit
 * window alone doesn't bound a *burst* of concurrent requests (e.g. several
 * recipients — or several tabs — opening `/zip` at the same instant, well
 * within the window); this caps how many archiver runs + blob reads can be
 * in flight at any one time regardless of the window.
 */
const MAX_CONCURRENT_ZIPS = 4;

const unlockSchema = z.object({ password: z.string().min(1) });

/** Waits for `stream`'s `open`, or rejects with its `error` (e.g. ENOENT). Mirrors routes/nodes.ts. */
function waitForOpen(stream: ReadStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once('open', () => resolve());
    stream.once('error', (err) => reject(err));
  });
}

/**
 * The public access gate. NO auth, NO CSRF. Registered under `/api/public`.
 * Every response gets `Referrer-Policy: no-referrer` via an encapsulated
 * onSend hook (scoped to this plugin only). Constant-shape failures are a
 * deliberate anti-oracle carry from Phase F: an unknown token and a resolver
 * rejection never differ in a way that reveals whether a node exists.
 */
export default async function publicRoutes(app: FastifyInstance, deps: PublicRouteDeps): Promise<void> {
  const { db, now, passwordService, blobStore, config } = deps;

  // Every response under this plugin (including the rate-limited child scope
  // and error responses) is stamped no-referrer, so a shared token never
  // leaks in a Referer header to an off-site link the recipient clicks.
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Referrer-Policy', 'no-referrer');
    // Share state (live / stopped / expired / exhausted — and the meta itself)
    // changes out from under a recipient, so their browser must never serve a
    // cached view: a stopped-then-restarted link would otherwise stay "off" on
    // reload, and an exhausted/expired one could keep appearing live. no-store
    // forces every load to reflect the current server state.
    reply.header('Cache-Control', 'no-store');
    return payload;
  });

  /**
   * base64url HMAC-SHA256 over `token`, the share's CURRENT `password_hash`,
   * and a caller-supplied `issuedAtMs` (as a string, so it's covered by the
   * MAC). Binding the password hash means a cookie issued against an old
   * password stops verifying the instant the owner rotates or clears it
   * (setShareState writes a new/NULL `password_hash`, so the same HMAC input
   * can never be reproduced) — the cookie is never a pure function of the
   * token alone. `issuedAtMs` lets {@link isUnlocked} enforce the 1800s
   * lifetime itself, server-side, rather than trusting the client-honored
   * cookie `Max-Age` attribute.
   */
  function signUnlock(token: string, passwordHash: string | null, issuedAtMs: string): string {
    const payload = `${token}.${passwordHash ?? ''}.${issuedAtMs}`;
    return createHmac('sha256', config.SESSION_SECRET).update(payload).digest('base64url');
  }

  /** Builds the unlock cookie's value: `<issuedAtMs>.<signUnlock(...)>`. */
  function unlockCookieValue(token: string, passwordHash: string | null, issuedAtMs: number): string {
    const issuedAtStr = String(issuedAtMs);
    return `${issuedAtStr}.${signUnlock(token, passwordHash, issuedAtStr)}`;
  }

  /**
   * True iff the request carries a matching, still-live unlock cookie for
   * `share`. Re-derives the expected value from `share.password_hash` as it
   * stands RIGHT NOW (so a rotated/cleared password invalidates every
   * previously-issued cookie) and independently checks `issuedAtMs` against
   * `now()` (so the 1800s lifetime is enforced here, not only via the
   * cookie's `Max-Age`). Constant-time compare on the full cookie string.
   */
  function isUnlocked(req: FastifyRequest, share: Share): boolean {
    const cookie = req.cookies[UNLOCK_COOKIE];
    if (!cookie) return false;

    const dot = cookie.indexOf('.');
    if (dot <= 0) return false;
    const issuedAtStr = cookie.slice(0, dot);
    const issuedAtMs = Number(issuedAtStr);
    if (!Number.isInteger(issuedAtMs)) return false;

    const nowMs = now();
    // Server-side lifetime enforcement — a client can always resend a cookie
    // past its Max-Age; this is what actually bounds it.
    if (issuedAtMs > nowMs || nowMs - issuedAtMs > UNLOCK_COOKIE_MAX_AGE_S * 1000) return false;

    const expected = Buffer.from(unlockCookieValue(share.token, share.password_hash, issuedAtMs));
    const actual = Buffer.from(cookie);
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }

  /**
   * Looks the share up by token and runs the request-time liveness gate.
   * Returns the live share, or sends the response and returns `null`:
   *  - unknown token -> 404 generic (no oracle; indistinguishable from `gone`)
   *  - stopped/expired -> 410; gone (node trashed/auto-deleted/missing) -> 404
   */
  function loadLiveShare(reply: FastifyReply, token: string): Share | null {
    const share = db.prepare('SELECT * FROM shares WHERE token = @token').get({ token }) as Share | undefined;
    if (!share) {
      reply.code(404).send({ error: 'not_found' });
      return null;
    }
    const liveness = isShareLive(db, share, now());
    if (!liveness.live) {
      if (liveness.reason === 'stopped' || liveness.reason === 'expired') {
        // The 410 already reveals the token exists, so carrying WHY (stopped vs
        // expired) + the expiry epoch is not a new oracle — it lets the public
        // page render the distinct §3.5/§4.9 copy ("turned this link off" vs
        // "expired on <date>"). `gone` (trashed/auto-deleted/missing node)
        // deliberately stays an ambiguous 404 below, so a live-but-off link is
        // never distinguishable from a deleted one.
        reply.code(410).send({ error: 'gone', reason: liveness.reason, expires_at: share.expires_at });
      } else {
        reply.code(404).send({ error: 'not_found' });
      }
      return null;
    }
    return share;
  }

  /**
   * For a password share, requires the unlock cookie. Sends `401
   * {needsPassword:true}` (with NO node metadata) and returns false when the
   * share is password-protected but not unlocked; returns true otherwise.
   */
  function requireUnlocked(req: FastifyRequest, reply: FastifyReply, share: Share): boolean {
    if (share.password_hash !== null && !isUnlocked(req, share)) {
      reply.code(401).send({ needsPassword: true });
      return false;
    }
    return true;
  }

  /** Records one public access (download/zip) in `share_access_log`. */
  function logShareAccess(shareId: number, req: FastifyRequest): void {
    const ua = req.headers['user-agent'];
    db.prepare('INSERT INTO share_access_log(share_id, ip, ua, accessed_at) VALUES (?, ?, ?, ?)').run(
      shareId,
      req.ip,
      typeof ua === 'string' ? ua : null,
      now()
    );
  }

  // --- GET meta -----------------------------------------------------------
  app.get('/api/public/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const share = loadLiveShare(reply, token);
    if (!share) return;
    if (!requireUnlocked(req, reply, share)) return;

    // isShareLive already proved the node exists and is live.
    const node = db
      .prepare('SELECT kind, name, size_bytes FROM nodes WHERE id = @nodeId')
      .get({ nodeId: share.node_id }) as { kind: Node['kind']; name: string; size_bytes: number };

    reply.code(200).send({
      token: share.token,
      kind: node.kind,
      name: node.name,
      size_bytes: node.size_bytes,
      isFolder: node.kind === 'folder',
      allow_download: !!share.allow_download,
      // The per-download cap (null = unlimited) and how many downloads have
      // completed. Together they drive the recipient's live "N of M — K
      // remaining" counter. NOTE: exposing the live count makes it a
      // delivery-confirmation signal (a recipient can tell others downloaded) —
      // consciously accepted here because the owner wants the counter visible on
      // this internal tool (supersedes the original static-label anti-oracle stance).
      download_limit: share.download_limit,
      download_count: share.download_limit == null ? 0 : share.download_count,
    });
  });

  // --- POST unlock (rate-limited per-IP AND per-token) --------------------
  // Two independent @fastify/rate-limit instances in a dedicated child scope,
  // each with its own keyGenerator (per-IP and per-token) — the same
  // two-registration pattern routes/auth.ts uses for login, and for the same
  // reason: a single instance can't enforce two independent ceilings.
  await app.register(async function unlockScope(scope) {
    await scope.register(fastifyRateLimit, {
      max: UNLOCK_IP_RATE_LIMIT_MAX,
      timeWindow: UNLOCK_RATE_LIMIT_WINDOW_MS,
      hook: 'preHandler',
      keyGenerator: (req) => req.ip,
    });
    await scope.register(fastifyRateLimit, {
      max: UNLOCK_TOKEN_RATE_LIMIT_MAX,
      timeWindow: UNLOCK_RATE_LIMIT_WINDOW_MS,
      hook: 'preHandler',
      keyGenerator: (req) => (req.params as { token?: string }).token ?? '',
    });

    scope.post('/api/public/:token/unlock', async (req, reply) => {
      const { token } = req.params as { token: string };
      const parsed = unlockSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send({ error: 'invalid_body' });
        return;
      }

      const share = loadLiveShare(reply, token);
      if (!share) return;

      if (share.password_hash === null) {
        // Nothing to unlock — a no-op the caller shouldn't be making.
        reply.code(400).send({ code: 'no_password' });
        return;
      }

      const ok = await passwordService.verifyPassword(share.password_hash, parsed.data.password);
      if (!ok) {
        writeAudit(db, { actorId: share.owner_id, action: 'share_unlock_failure', target: token }, now);
        reply.code(401).send({ error: 'invalid_password' });
        return;
      }

      // Path-scoped to THIS token's public subtree so the cookie is only ever
      // presented back to this share's own endpoints (not other shares).
      // Bound to THIS verification's password_hash + issuedAt (see
      // `signUnlock`/`isUnlocked`) so a later password rotation/removal
      // invalidates it, and its lifetime is enforced server-side too.
      // No `maxAge`/`expires` → a SESSION cookie (dropped when the browser
      // session ends). Its lifetime is still enforced server-side via the signed
      // issuedAt in `isUnlocked` (UNLOCK_COOKIE_MAX_AGE_S), independent of the
      // client honoring any attribute.
      reply.setCookie(UNLOCK_COOKIE, unlockCookieValue(token, share.password_hash, now()), {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: `/api/public/${token}`,
      });
      reply.code(200).send({ ok: true });
    });
  });

  // --- GET list -----------------------------------------------------------
  app.get('/api/public/:token/list', async (req, reply) => {
    const { token } = req.params as { token: string };
    const share = loadLiveShare(reply, token);
    if (!share) return;
    if (!requireUnlocked(req, reply, share)) return;

    // #10: a folder share exposes ONLY the ZIP — its contents are never listed.
    const listNode = db.prepare('SELECT kind FROM nodes WHERE id = @id').get({ id: share.node_id }) as
      | { kind: string }
      | undefined;
    if (listNode?.kind === 'folder') {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }

    const pathParam = (req.query as { path?: string }).path;
    const folderId = pathParam ?? share.node_id;

    try {
      const children = listPublic(db, share, folderId);
      reply.code(200).send(children.map(toPublicNodeDto));
    } catch (e) {
      if (e instanceof ForbiddenError) {
        reply.code(403).send({ error: 'forbidden' });
        return;
      }
      throw e;
    }
  });

  // --- Per-file download-limit reservation state (counted POST /download) --
  // Created EXACTLY ONCE per plugin registration (here, in the publicRoutes
  // function body — the same lexical level as the `/zip` `activeZipCount`
  // below), so every in-flight download of a share consults the SAME registry.
  // The concurrency bound is only meaningful if it is shared across requests: a
  // per-request map would see itself empty every time and silently defeat the
  // cap. The POST route and its release backstop close over this instance.
  const reservations = createReservations();
  const reservationHolders = new WeakSet<FastifyRequest>();
  const reservedShareId = new WeakMap<FastifyRequest, number>();
  /**
   * Releases a request's in-flight reservation AT MOST ONCE (idempotent via the
   * WeakSet membership check), so wiring it to BOTH the raw-response `'close'`
   * event (fires on normal finish AND mid-stream abort) and the `onResponse`
   * backstop can never double-release. Mirrors the `/zip` `releaseZipSlot`.
   */
  function releaseReservation(req: FastifyRequest): void {
    if (reservationHolders.delete(req)) {
      const sid = reservedShareId.get(req);
      if (sid !== undefined) reservations.release(sid);
    }
  }

  /**
   * Shared authz/resolve/open path for BOTH the GET and POST download routes —
   * single-sourced so these two public, unauthenticated handlers can never
   * drift apart. Runs, in order: `allow_download` (403), subtree resolution
   * (403 on `ForbiddenError` — same shape as an out-of-subtree/unknown node, no
   * existence oracle), file-kind + storage presence (403, same shape), then
   * blob open (404 on a missing on-disk blob — reverse-orphan, never a 500).
   * Returns the resolved `{ node, stream }`, or sends the error response and
   * returns `null`. The caller owns the response tail
   * (headers/`logShareAccess`/reserve/`send`), which differs between GET and
   * POST — only the authz/resolve/open path is shared here.
   */
  async function resolveDownloadableFile(
    req: FastifyRequest,
    reply: FastifyReply,
    share: Share
  ): Promise<{ node: Node; stream: ReadStream } | null> {
    if (!share.allow_download) {
      reply.code(403).send({ error: 'forbidden' });
      return null;
    }

    // #10: a folder share allows no per-file download (with or without ?node=) —
    // only the ZIP. Constant-shape 403, identical to an out-of-subtree rejection.
    const shareNode = db.prepare('SELECT kind FROM nodes WHERE id = @id').get({ id: share.node_id }) as
      | { kind: string }
      | undefined;
    if (shareNode?.kind === 'folder') {
      reply.code(403).send({ error: 'forbidden' });
      return null;
    }

    // Default to the shared node itself so a file share is downloadable
    // without the recipient ever learning an internal node id.
    const nodeParam = (req.query as { node?: string }).node ?? share.node_id;

    let node: Node;
    try {
      node = resolveInSubtree(db, share, nodeParam);
    } catch (e) {
      if (e instanceof ForbiddenError) {
        reply.code(403).send({ error: 'forbidden' });
        return null;
      }
      throw e;
    }

    // A folder (or a storage-less row) isn't downloadable here — keep the
    // shape identical to the out-of-subtree rejection (no existence oracle).
    if (node.kind !== 'file' || !node.storage_path) {
      reply.code(403).send({ error: 'forbidden' });
      return null;
    }

    const stream = blobStore.readBlob(node.storage_path);
    try {
      await waitForOpen(stream);
    } catch (e) {
      // Row exists but its blob is gone from disk (reverse-orphan) -> 404, never 500.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        reply.code(404).send({ error: 'not_found' });
        return null;
      }
      throw e;
    }

    return { node, stream };
  }

  // --- GET download (rate-limited per-IP AND per-token) --------------------
  await app.register(async function downloadScope(scope) {
    await scope.register(fastifyRateLimit, {
      max: DOWNLOAD_IP_RATE_LIMIT_MAX,
      timeWindow: DOWNLOAD_RATE_LIMIT_WINDOW_MS,
      hook: 'preHandler',
      keyGenerator: (req) => req.ip,
    });
    await scope.register(fastifyRateLimit, {
      max: DOWNLOAD_TOKEN_RATE_LIMIT_MAX,
      timeWindow: DOWNLOAD_RATE_LIMIT_WINDOW_MS,
      hook: 'preHandler',
      keyGenerator: (req) => (req.params as { token?: string }).token ?? '',
    });

    // The recipient triggers the counted download with a <form method="post">
    // submit (so a passive GET can't burn the cap). A browser posts that form as
    // `application/x-www-form-urlencoded` with an empty body — but Fastify has no
    // default parser for that media type and would reject it with 415 *before*
    // the handler runs. The token is in the URL and the body is never read, so
    // register a no-op parser (bounded, drained, ignored) for this download
    // scope only. Any other content type still 415s as before.
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 1024 },
      (_req, _body, done) => done(null, undefined)
    );

    scope.get('/api/public/:token/download', async (req, reply) => {
      const { token } = req.params as { token: string };
      const share = loadLiveShare(reply, token);
      if (!share) return;
      if (!requireUnlocked(req, reply, share)) return;

      // A limited share must be downloaded via POST (an explicit human action);
      // a passive GET can neither burn nor bypass the cap. Unlimited shares
      // (`download_limit === null`) keep the streaming behavior unchanged.
      if (share.download_limit !== null) {
        reply.code(405).send({ error: 'method_not_allowed' });
        return;
      }

      const resolved = await resolveDownloadableFile(req, reply, share);
      if (!resolved) return;
      const { node, stream } = resolved;

      reply.header('Content-Disposition', buildContentDisposition(node.name));
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Type', node.mime_type ?? 'application/octet-stream');

      logShareAccess(share.id, req);

      return reply.send(stream);
    });

    // Counted download. A limited share is spent ONLY through this POST (an
    // explicit human action), one completed transfer at a time, bounded by the
    // in-memory reservation registry so `completed + in-flight` can never
    // exceed the limit even under concurrent requests.
    scope.post('/api/public/:token/download', async (req, reply) => {
      const { token } = req.params as { token: string };
      const share = loadLiveShare(reply, token);
      if (!share) return;
      if (!requireUnlocked(req, reply, share)) return;

      const resolved = await resolveDownloadableFile(req, reply, share);
      if (!resolved) return;
      const { node, stream } = resolved;

      // --- Reserve (limited shares only). The DB read and `tryReserve` run
      //     with NO await between them, so they are atomic under Node's single
      //     thread: `completed + in-flight` can never exceed the limit. ---
      if (share.download_limit !== null) {
        const completed = (
          db.prepare('SELECT download_count FROM shares WHERE id = @id').get({ id: share.id }) as {
            download_count: number;
          }
        ).download_count;
        if (!reservations.tryReserve(share.id, completed, share.download_limit)) {
          stream.destroy();
          // Byte-identical to a stopped share — never a "live-but-reserved" oracle.
          reply.code(410).send({ error: 'gone', reason: 'stopped', expires_at: share.expires_at });
          return;
        }
        reservationHolders.add(req);
        reservedShareId.set(req, share.id);
        // The raw `'close'` event is the SOLE release + count site (there is
        // deliberately NO `onResponse` backstop). It fires on BOTH a normal
        // finish AND a mid-stream abort, and the count already depends entirely
        // on it firing — so releasing ONLY here keeps the reservation held
        // until the count reflects the completion. Doing release-then-count
        // together with NO `await` between makes the pair atomic: it closes the
        // Fastify finish->close window in which an `onResponse`-time release
        // would free the slot a tick BEFORE this UPDATE commits (while the DB
        // count still read 0), letting a concurrent limit-1 request reserve
        // against the stale count and over-deliver a second body. Only a
        // fully-flushed SUCCESSFUL response (`writableFinished` && status < 400)
        // counts — a thrown-error 500 that delivered no bytes (e.g. a late
        // `logShareAccess`/`send` failure) must never burn the file. The guarded
        // UPDATE (`download_count < download_limit`) lets exactly ONE completion
        // cross the threshold, so `applyExhaustion` fires at most once per share
        // even under concurrency (and is idempotent regardless).
        reply.raw.once('close', () => {
          try {
            releaseReservation(req);
            if (reply.raw.writableFinished && reply.raw.statusCode < 400) {
              const upd = db
                .prepare(
                  `UPDATE shares SET download_count = download_count + 1
                   WHERE id = @id AND download_limit IS NOT NULL AND download_count < download_limit
                   RETURNING id, owner_id, node_id, on_exhaust, download_limit, download_count`
                )
                .get({ id: share.id }) as
                | {
                    id: number;
                    owner_id: number;
                    node_id: number;
                    on_exhaust: 'stop' | 'delete';
                    download_limit: number;
                    download_count: number;
                  }
                | undefined;
              if (upd && upd.download_count === upd.download_limit) applyExhaustion(db, upd, now);
            }
          } catch (err) {
            req.log.error({ err }, 'download completion handler failed');
          }
        });
      }

      reply.header('Content-Disposition', buildContentDisposition(node.name));
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Type', node.mime_type ?? 'application/octet-stream');

      logShareAccess(share.id, req);

      return reply.send(stream);
    });
  });

  // --- GET zip (rate-limited per-IP AND per-token, plus a hard concurrency
  // bound) ------------------------------------------------------------------
  // Tracks `/zip` requests currently streaming, server-wide, so a burst of
  // concurrent requests (which a time-window rate limit alone cannot bound)
  // can't pile up archiver runs.
  let activeZipCount = 0;
  const zipSlotHolders = new WeakSet<FastifyRequest>();

  /**
   * Releases a `/zip` concurrency slot AT MOST ONCE per request (idempotent
   * via the WeakSet membership check), so it is safe to wire to more than one
   * teardown signal without ever double-decrementing the counter.
   *
   * Correctness here is security-critical: the slot MUST be released even when
   * the client aborts the download mid-stream. Fastify's `onResponse` hook
   * does NOT fire on a mid-stream abort (verified empirically against the
   * installed fastify@5.10.0: destroying the client socket while the ZIP body
   * is still streaming never triggers `onResponse`) — relying on it alone let
   * an unauthenticated caller permanently strand a slot per cancelled request,
   * exhausting all `MAX_CONCURRENT_ZIPS` slots (and taking `/zip` down for
   * every share) in just a handful of aborted downloads. The raw-response
   * `'close'` event (wired per-request in the handler below) DOES fire on both
   * a normal finish AND a mid-stream abort, so it is the authoritative
   * release; the `onResponse` hook is kept only as idempotent defence in
   * depth.
   */
  function releaseZipSlot(req: FastifyRequest): void {
    if (zipSlotHolders.delete(req)) {
      activeZipCount--;
    }
  }

  await app.register(async function zipScope(scope) {
    await scope.register(fastifyRateLimit, {
      max: ZIP_IP_RATE_LIMIT_MAX,
      timeWindow: ZIP_RATE_LIMIT_WINDOW_MS,
      hook: 'preHandler',
      keyGenerator: (req) => req.ip,
    });
    await scope.register(fastifyRateLimit, {
      max: ZIP_TOKEN_RATE_LIMIT_MAX,
      timeWindow: ZIP_RATE_LIMIT_WINDOW_MS,
      hook: 'preHandler',
      keyGenerator: (req) => (req.params as { token?: string }).token ?? '',
    });

    scope.addHook('onResponse', async (req) => {
      releaseZipSlot(req);
    });

    scope.get('/api/public/:token/zip', async (req, reply) => {
      const { token } = req.params as { token: string };
      const share = loadLiveShare(reply, token);
      if (!share) return;
      if (!requireUnlocked(req, reply, share)) return;

      if (!share.allow_download) {
        reply.code(403).send({ error: 'forbidden' });
        return;
      }

      if (activeZipCount >= MAX_CONCURRENT_ZIPS) {
        reply.code(429).send({ error: 'too_many_requests' });
        return;
      }

      const rootNode = db.prepare('SELECT * FROM nodes WHERE id = @id').get({ id: share.node_id }) as
        | Node
        | undefined;
      if (!rootNode) {
        // isShareLive already proved liveness; defensive only.
        reply.code(404).send({ error: 'not_found' });
        return;
      }

      const files = collectSubtreeFiles(db, share.owner_id, rootNode);

      // Slot taken from here on. The authoritative release is the raw
      // response's `'close'` event, which fires on BOTH a normal finish AND a
      // mid-stream client abort (unlike `onResponse`, which does not fire on
      // abort under fastify@5.10.0 — see `releaseZipSlot`), so a cancelled
      // download can never strand a slot. `releaseZipSlot` is idempotent, so
      // the `onResponse` hook firing too (normal completions) is harmless.
      activeZipCount++;
      zipSlotHolders.add(req);
      reply.raw.once('close', () => releaseZipSlot(req));

      const archive = new ZipArchive({ zlib: { level: ZIP_COMPRESSION_LEVEL } });
      // Post-headers stream failure can't change the status — tear the response
      // down rather than leave a truncated body hanging or crash on an
      // unhandled 'error'.
      archive.on('error', (err) => {
        req.log.error({ err }, 'zip stream failed');
        reply.raw.destroy(err);
      });

      appendFilesToArchive(archive, files, blobStore);

      reply.header('Content-Type', 'application/zip');
      reply.header('Content-Disposition', buildContentDisposition(zipFileName(rootNode.name)));
      reply.header('X-Content-Type-Options', 'nosniff');

      logShareAccess(share.id, req);

      // Hand the stream to the reply BEFORE finalize so a consumer exists and
      // backpressure holds (archiver reads each source blob lazily — never
      // buffering the whole subtree in memory).
      const sent = reply.send(archive);
      void archive.finalize();
      return sent;
    });
  });
}
