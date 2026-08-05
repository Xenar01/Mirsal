/**
 * Direct-fetch client for the public collect-intake endpoints (Collections
 * Phase 3). Same posture as `features/public/api.ts` — this is the ONE
 * unauthenticated surface a department opens without ever logging in: no
 * session cookie, no CSRF header — only the short-lived, path-scoped
 * `mirsal_unlock` cookie (for password collections) rides along, which is why
 * every call is `credentials:'include'` (or explicit `'omit'` on the gated
 * metadata read) but nothing echoes a CSRF token.
 *
 * The metadata fetch returns a discriminated {@link CollectMetaResult} rather
 * than throwing, so the uploader page can render the distinct states (open /
 * password / closed / not-found / error) declaratively. The unlock POST is a
 * raw `fetch` (not the shared api client) specifically so it can read the
 * `x-ratelimit-remaining` response header — mirrors `unlockShare`.
 */

const COLLECT_BASE = '/api/collect';

/**
 * Max files accepted in one response submission. Mirrors the server's
 * `COLLECTION_MAX_FILES_PER_RESPONSE` (server/src/config.ts) so both sides
 * agree on the cap; kept here (not re-derived) so Task 7's upload form can
 * import a single client-side source for its own pre-submit guard.
 */
export const COLLECTION_MAX_FILES_PER_RESPONSE = 10;

/** Open-collection metadata, revealed once unlocked (or when no password is set). */
export interface CollectMeta {
  title: string;
  hasTemplate: boolean;
  templateName: string | null;
  departments: { id: number; name: string }[];
  needsPassword: boolean;
}

/** The outcome of a metadata fetch — one branch per uploader screen. */
export type CollectMetaResult =
  | { state: 'open'; meta: CollectMeta }
  | { state: 'password' }
  | { state: 'closed' }
  | { state: 'notFound' }
  | { state: 'error' };

function tokenPath(token: string): string {
  // Collection tokens are URL-safe base64 (A–Z a–z 0–9 - _), all left intact
  // by encodeURIComponent — but encode defensively so a malformed path
  // segment can never break out of the intended URL.
  return `${COLLECT_BASE}/${encodeURIComponent(token)}`;
}

interface CollectMetaBody {
  isOpen: boolean;
  needsPassword?: boolean;
  title?: string;
  hasTemplate?: boolean;
  templateName?: string | null;
  departments?: { id: number; name: string }[];
}

export async function fetchCollectMeta(
  token: string,
  opts?: { reveal?: boolean }
): Promise<CollectMetaResult> {
  const res = await fetch(tokenPath(token), {
    // Until the recipient unlocks IN THIS page-load, omit the unlock cookie so
    // a still-valid cookie can't silently reveal a password collection — the
    // gate must re-appear on every fresh open (mirrors fetchPublicMeta). After
    // unlock the caller passes reveal:true to send the cookie and receive the
    // live metadata.
    credentials: opts?.reveal ? 'include' : 'omit',
    headers: { accept: 'application/json' },
  });
  if (res.status === 404) {
    return { state: 'notFound' };
  }
  if (res.status === 200) {
    const body = (await res.json()) as CollectMetaBody;
    if (!body.isOpen) {
      // Closed/expired: the server withholds everything else too.
      return { state: 'closed' };
    }
    if (body.departments) {
      return {
        state: 'open',
        meta: {
          title: body.title ?? '',
          hasTemplate: body.hasTemplate ?? false,
          templateName: body.templateName ?? null,
          departments: body.departments,
          needsPassword: body.needsPassword ?? false,
        },
      };
    }
    if (body.needsPassword) {
      // Password required — the body carries NO title/departments by design.
      return { state: 'password' };
    }
  }
  return { state: 'error' };
}

/** The result of a password-unlock attempt. `remaining` is the per-token attempts left (from the header), or null if unreadable. */
export type UnlockResult =
  | { kind: 'ok' }
  | { kind: 'wrong'; remaining: number | null }
  | { kind: 'rateLimited' }
  | { kind: 'error' };

export async function unlockCollection(token: string, password: string): Promise<UnlockResult> {
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

/** The outcome of a response submission. */
export type SubmitResult =
  | { kind: 'ok' }
  | { kind: 'tooManyFiles' }
  | { kind: 'tooLarge' }
  | { kind: 'quota' }
  | { kind: 'closed' }
  | { kind: 'locked' }
  | { kind: 'error' };

export async function submitResponse(
  token: string,
  input: { departmentId: number; files: File[]; note?: string }
): Promise<SubmitResult> {
  const form = new FormData();
  form.set('departmentId', String(input.departmentId));
  if (input.note) form.set('note', input.note);
  for (const file of input.files) form.append('files', file);

  const res = await fetch(`${tokenPath(token)}/submit`, {
    method: 'POST',
    credentials: 'include',
    // NO content-type header — the browser sets the multipart boundary
    // itself; NO CSRF (this is the unauthenticated intake surface).
    body: form,
  });
  if (res.status === 200) return { kind: 'ok' };
  if (res.status === 404) return { kind: 'closed' };
  if (res.status === 401) return { kind: 'locked' };
  if (res.status === 400 || res.status === 413) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (body.error === 'too_many_files') return { kind: 'tooManyFiles' };
    if (body.error === 'file_too_large') return { kind: 'tooLarge' };
    if (body.error === 'quota_exceeded') return { kind: 'quota' };
    return { kind: 'error' };
  }
  return { kind: 'error' };
}

/** Same-origin URL for the collection's template download (a plain link/anchor triggers it; the unlock cookie rides along). */
export function templateUrl(token: string): string {
  return `${tokenPath(token)}/template`;
}
