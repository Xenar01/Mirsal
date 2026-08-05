/**
 * Direct-fetch client for the public share endpoints (spec §3.5 / §7). This is
 * the ONE unauthenticated surface: no session cookie, no CSRF header — only the
 * short-lived, path-scoped `mirsal_unlock` cookie (for password shares) rides
 * along, which is why every call is `credentials:'include'` but nothing echoes
 * a CSRF token.
 *
 * The metadata fetch returns a discriminated {@link PublicMetaResult} rather
 * than throwing, so the page can render the distinct §4.9 states (live /
 * password / 404 / 410-stopped / 410-expired) declaratively. The unlock POST is
 * a raw `fetch` (not the shared api client) specifically so it can read the
 * `x-ratelimit-remaining` response header — the api client discards headers on
 * a non-2xx response, and the per-token limiter's remaining count is exactly
 * what the "attempts left" copy (§4.9) needs.
 */

const PUBLIC_BASE = '/api/public';

/** Live-share metadata (server never leaks internal columns; a password share pre-unlock reveals none of this). */
export interface PublicMeta {
  token: string;
  kind: 'file' | 'folder';
  name: string;
  size_bytes: number;
  isFolder: boolean;
  allow_download: boolean;
  /** null = unlimited; ≥1 = capped. With download_count, drives the recipient's live "N remaining" counter. */
  download_limit: number | null;
  /** Completed downloads against the cap (0 when unlimited). */
  download_count: number;
}

/** One node in a folder-share listing (the server's `PublicNodeDto`). */
export interface PublicNodeDto {
  id: number;
  kind: 'file' | 'folder';
  name: string;
  size_bytes: number;
  mime_type: string | null;
}

/** The outcome of a metadata fetch — one branch per §3.5/§4.9 screen. */
export type PublicMetaResult =
  | { state: 'live'; meta: PublicMeta }
  | { state: 'password' }
  | { state: 'notFound' }
  | { state: 'stopped' }
  | { state: 'expired'; expiresAt: number | null }
  | { state: 'error' };

function tokenPath(token: string): string {
  // Share tokens are URL-safe base64 (A–Z a–z 0–9 - _), all left intact by
  // encodeURIComponent — but encode defensively so a malformed path segment can
  // never break out of the intended URL.
  return `${PUBLIC_BASE}/${encodeURIComponent(token)}`;
}

export async function fetchPublicMeta(token: string, opts?: { reveal?: boolean }): Promise<PublicMetaResult> {
  const res = await fetch(tokenPath(token), {
    // Until the recipient unlocks IN THIS page-load, omit the unlock cookie so a
    // still-valid cookie can't silently reveal a password share — the gate must
    // re-appear on every fresh open (#11). After unlock we pass reveal:true to
    // send the cookie and receive the live metadata.
    credentials: opts?.reveal ? 'include' : 'omit',
    headers: { accept: 'application/json' },
  });
  if (res.status === 200) {
    return { state: 'live', meta: (await res.json()) as PublicMeta };
  }
  if (res.status === 401) {
    // Password required — the body carries NO metadata by design.
    return { state: 'password' };
  }
  if (res.status === 410) {
    const body = (await res.json().catch(() => ({}))) as {
      reason?: string;
      expires_at?: number | null;
    };
    if (body.reason === 'expired') {
      return { state: 'expired', expiresAt: body.expires_at ?? null };
    }
    // Any other 410 (reason:'stopped', or an older server without a reason).
    return { state: 'stopped' };
  }
  if (res.status === 404) {
    // Unknown token AND gone-node both land here — ambiguous by design.
    return { state: 'notFound' };
  }
  return { state: 'error' };
}

/** Lists a folder within the shared subtree. `path === null` lists the share root (server default). */
export async function fetchPublicList(token: string, path: number | null): Promise<PublicNodeDto[]> {
  const query = path === null ? '' : `?path=${encodeURIComponent(String(path))}`;
  const res = await fetch(`${tokenPath(token)}/list${query}`, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`public_list_failed_${res.status}`);
  }
  return (await res.json()) as PublicNodeDto[];
}

/** The result of a password-unlock attempt. `remaining` is the per-token attempts left (from the header), or null if unreadable. */
export type UnlockResult =
  { kind: 'ok' } | { kind: 'wrong'; remaining: number | null } | { kind: 'rateLimited' } | { kind: 'error' };

export async function unlockShare(token: string, password: string): Promise<UnlockResult> {
  const res = await fetch(`${tokenPath(token)}/unlock`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (res.status === 200) return { kind: 'ok' };
  if (res.status === 429) return { kind: 'rateLimited' };
  if (res.status === 401) {
    // The per-token limiter is registered last, so this header reflects the
    // per-token attempts remaining. Degrade to a no-count message if absent.
    const header = res.headers.get('x-ratelimit-remaining');
    const parsed = header === null ? NaN : Number(header);
    const remaining = Number.isFinite(parsed) ? parsed : null;
    return { kind: 'wrong', remaining };
  }
  return { kind: 'error' };
}

/**
 * Same-origin URL for a file download, triggered via a plain anchor so the
 * browser handles the file (RFC-6266 attachment) and the unlock cookie rides
 * along. For a FILE share omit `nodeId` (server defaults to the shared file);
 * for a FOLDER share pass the specific file id as `?node=`.
 */
export function downloadUrl(token: string, nodeId?: number): string {
  const base = `${tokenPath(token)}/download`;
  return nodeId === undefined ? base : `${base}?node=${encodeURIComponent(String(nodeId))}`;
}

/** Same-origin URL for the streamed "Download all as ZIP" of a folder share. */
export function zipUrl(token: string): string {
  return `${tokenPath(token)}/zip`;
}
