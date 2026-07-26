/**
 * Typed, CSRF-aware fetch client for the Mirsal API.
 *
 * - Same-origin only: every path is resolved under the relative base `/api`
 *   (the server CSP is `connect-src 'self'`; an absolute origin would be
 *   blocked).
 * - Always `credentials: 'include'` so the httpOnly `mirsal_session` cookie
 *   rides along.
 * - Double-submit CSRF: on mutating methods the non-httpOnly `mirsal_csrf`
 *   cookie value is echoed back in the `x-csrf-token` header (server requires
 *   it on anything that isn't GET/HEAD/OPTIONS).
 * - Non-2xx responses throw a typed {@link ApiError}.
 */

const API_BASE = '/api';
const CSRF_COOKIE = 'mirsal_csrf';
const CSRF_HEADER = 'x-csrf-token';

/** Methods the server treats as safe (no CSRF header required). */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ApiErrorInit {
  status: number;
  code?: string;
  message?: string;
  body?: unknown;
}

/**
 * Error thrown for any non-2xx API response. `code` mirrors the server's
 * machine-readable `body.error` when present; `isUnauthorized` lets the auth
 * layer special-case a 401 (clear session + redirect to /login).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly body?: unknown;

  constructor(init: ApiErrorInit) {
    super(init.message ?? `API request failed (${init.status})`);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.body = init.body;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

/**
 * Reads the double-submit CSRF token from `document.cookie` (may be absent).
 * Exported so the multipart-upload path (which uses `XMLHttpRequest` for
 * upload-progress events — `fetch` has none) can echo the same
 * `mirsal_csrf` cookie into its `x-csrf-token` header, exactly like
 * {@link request} does.
 */
export function readCsrfToken(): string | null {
  const match = document.cookie.match(
    new RegExp('(?:^|;\\s*)' + CSRF_COOKIE + '=([^;]*)')
  );
  return match ? decodeURIComponent(match[1]) : null;
}

export async function request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  let payload: BodyInit | undefined;

  if (body !== undefined && body !== null) {
    if (body instanceof FormData) {
      // Let the browser set the multipart Content-Type (with boundary).
      payload = body;
    } else {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
  }

  if (!SAFE_METHODS.has(method)) {
    const csrf = readCsrfToken();
    if (csrf) headers[CSRF_HEADER] = csrf;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: 'include',
    headers,
    body: payload,
  });

  if (!res.ok) {
    throw await toApiError(res);
  }

  // 204 No Content (and any empty body) → no JSON to parse.
  if (res.status === 204) {
    return undefined as T;
  }
  const text = await res.text();
  if (!text) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

/** Builds a typed ApiError from a non-ok Response, tolerating empty/non-JSON bodies. */
async function toApiError(res: Response): Promise<ApiError> {
  let parsed: unknown;
  let code: string | undefined;
  let message: string | undefined;
  try {
    const text = await res.text();
    if (text) {
      parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        if (typeof obj.error === 'string') code = obj.error;
        if (typeof obj.message === 'string') message = obj.message;
      }
    }
  } catch {
    // Non-JSON error body (e.g. an empty 401/403) — leave code/message unset.
  }
  return new ApiError({ status: res.status, code, message, body: parsed });
}

export const apiGet = <T>(path: string): Promise<T> => request<T>('GET', path);
export const apiPost = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>('POST', path, body);
export const apiPatch = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>('PATCH', path, body);
export const apiDelete = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>('DELETE', path, body);
