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
import { listChildren, type Node } from '../nodes/tree.js';
import type { Share } from '../shares/shares.js';
import { buildContentDisposition } from '../util/content-disposition.js';

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
/** Unlock cookie lifetime (30 min) — a re-prompt after this is acceptable. */
const UNLOCK_COOKIE_MAX_AGE_S = 1800;

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

/** Hard cap on files walked into a `/zip` (loop/DoS-safety on a public endpoint). */
const MAX_ZIP_ENTRIES = 10_000;

const unlockSchema = z.object({ password: z.string().min(1) });

/** Waits for `stream`'s `open`, or rejects with its `error` (e.g. ENOENT). Mirrors routes/nodes.ts. */
function waitForOpen(stream: ReadStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once('open', () => resolve());
    stream.once('error', (err) => reject(err));
  });
}

/** Sanitizes a shared node's name into a `<name>.zip` download filename (CR/LF and separators stripped). */
function zipFileName(rawName: string): string {
  // eslint-disable-next-line no-control-regex
  const base = rawName.replace(/[\r\n\x00-\x1F\x7F/\\]/g, '_').trim();
  return `${base.length > 0 ? base : 'download'}.zip`;
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
    return payload;
  });

  /** base64url HMAC-SHA256(SESSION_SECRET, token) — the unlock cookie's value for `token`. */
  function unlockValue(token: string): string {
    return createHmac('sha256', config.SESSION_SECRET).update(token).digest('base64url');
  }

  /** True iff the request carries the matching unlock cookie for `token` (constant-time compare). */
  function isUnlocked(req: FastifyRequest, token: string): boolean {
    const cookie = req.cookies[UNLOCK_COOKIE];
    if (!cookie) return false;
    const expected = Buffer.from(unlockValue(token));
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
        reply.code(410).send({ error: 'gone' });
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
    if (share.password_hash !== null && !isUnlocked(req, share.token)) {
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
      reply.setCookie(UNLOCK_COOKIE, unlockValue(token), {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: `/api/public/${token}`,
        maxAge: UNLOCK_COOKIE_MAX_AGE_S,
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

  // --- GET download -------------------------------------------------------
  app.get('/api/public/:token/download', async (req, reply) => {
    const { token } = req.params as { token: string };
    const share = loadLiveShare(reply, token);
    if (!share) return;
    if (!requireUnlocked(req, reply, share)) return;

    if (!share.allow_download) {
      reply.code(403).send({ error: 'forbidden' });
      return;
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
        return;
      }
      throw e;
    }

    // A folder (or a storage-less row) isn't downloadable here — keep the
    // shape identical to the out-of-subtree rejection (no existence oracle).
    if (node.kind !== 'file' || !node.storage_path) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }

    const stream = blobStore.readBlob(node.storage_path);
    try {
      await waitForOpen(stream);
    } catch (e) {
      // Row exists but its blob is gone from disk (reverse-orphan) -> 404, never 500.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        reply.code(404).send({ error: 'not_found' });
        return;
      }
      throw e;
    }

    reply.header('Content-Disposition', buildContentDisposition(node.name));
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Type', node.mime_type ?? 'application/octet-stream');

    logShareAccess(share.id, req);

    return reply.send(stream);
  });

  // --- GET zip ------------------------------------------------------------
  app.get('/api/public/:token/zip', async (req, reply) => {
    const { token } = req.params as { token: string };
    const share = loadLiveShare(reply, token);
    if (!share) return;
    if (!requireUnlocked(req, reply, share)) return;

    if (!share.allow_download) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }

    const rootNode = db.prepare('SELECT * FROM nodes WHERE id = @id').get({ id: share.node_id }) as Node | undefined;
    if (!rootNode) {
      // isShareLive already proved liveness; defensive only.
      reply.code(404).send({ error: 'not_found' });
      return;
    }

    const files = collectSubtreeFiles(db, share.owner_id, rootNode);

    const archive = new ZipArchive({ zlib: { level: 9 } });
    // Post-headers stream failure can't change the status — tear the response
    // down rather than leave a truncated body hanging or crash on an
    // unhandled 'error'.
    archive.on('error', (err) => {
      req.log.error({ err }, 'zip stream failed');
      reply.raw.destroy(err);
    });

    for (const f of files) {
      archive.append(blobStore.readBlob(f.storagePath), { name: f.name });
    }

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

  /**
   * Collects every live file under `root` as `{storagePath, name}` where
   * `name` is the path relative to the shared node (the shared folder itself
   * is not a prefix; its children sit at the zip root). Iterative + bounded
   * (`MAX_ZIP_ENTRIES`) to stay loop/DoS-safe on this unauthenticated route.
   * Uses `listChildren`, which already excludes trashed rows.
   */
  function collectSubtreeFiles(
    database: Database.Database,
    ownerId: number,
    root: Node
  ): Array<{ storagePath: string; name: string }> {
    const out: Array<{ storagePath: string; name: string }> = [];

    if (root.kind === 'file') {
      if (root.storage_path) out.push({ storagePath: root.storage_path, name: root.name });
      return out;
    }

    const stack: Array<{ folderId: number; prefix: string }> = [{ folderId: root.id, prefix: '' }];
    while (stack.length > 0 && out.length < MAX_ZIP_ENTRIES) {
      const { folderId, prefix } = stack.pop()!;
      for (const child of listChildren(database, ownerId, folderId)) {
        if (child.kind === 'file') {
          if (child.storage_path) {
            out.push({ storagePath: child.storage_path, name: prefix + child.name });
            if (out.length >= MAX_ZIP_ENTRIES) break;
          }
        } else if (child.kind === 'folder') {
          stack.push({ folderId: child.id, prefix: `${prefix}${child.name}/` });
        }
      }
    }

    return out;
  }
}
