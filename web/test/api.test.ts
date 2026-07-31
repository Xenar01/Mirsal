import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiGet, apiPost, ApiError } from '../src/lib/api';
import { patchShare } from '../src/features/dashboard/share/api';

/** Build a minimal same-shape Response the client can consume. */
function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Reads the init object handed to the mocked fetch on call `n`. */
function initOf(mock: ReturnType<typeof vi.fn>, n = 0): RequestInit {
  return mock.mock.calls[n][1] as RequestInit;
}
function urlOf(mock: ReturnType<typeof vi.fn>, n = 0): string {
  return String(mock.mock.calls[n][0]);
}

beforeEach(() => {
  // Clear any CSRF cookie left by a previous test.
  document.cookie = 'mirsal_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api client — CSRF (security-critical)', () => {
  test('POST attaches x-csrf-token equal to the mirsal_csrf cookie and uses credentials:include', async () => {
    document.cookie = 'mirsal_csrf=csrf-tok-abc123';
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await apiPost('/auth/logout');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(urlOf(fetchMock)).toBe('/api/auth/logout');
    const init = initOf(fetchMock);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    const headers = init.headers as Record<string, string>;
    // Assert the actual value, not just presence.
    expect(headers['x-csrf-token']).toBe('csrf-tok-abc123');
  });

  test('GET does NOT attach x-csrf-token even when the cookie is present', async () => {
    document.cookie = 'mirsal_csrf=csrf-tok-abc123';
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: 1 }));
    vi.stubGlobal('fetch', fetchMock);

    await apiGet('/auth/me');

    const init = initOf(fetchMock);
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('include');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-csrf-token']).toBeUndefined();
  });

  test('POST sends JSON body with application/json content-type', async () => {
    document.cookie = 'mirsal_csrf=t';
    const fetchMock = vi.fn(async () => jsonResponse(200, { user: {} }));
    vi.stubGlobal('fetch', fetchMock);

    await apiPost('/auth/login', { username: 'admin', password: 'pw' });

    const init = initOf(fetchMock);
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ username: 'admin', password: 'pw' });
  });
});

describe('api client — typed errors', () => {
  test('401 throws an ApiError detectable as unauthorized', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(401));
    vi.stubGlobal('fetch', fetchMock);

    let caught: unknown;
    try {
      await apiGet('/auth/me');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(401);
    expect((caught as ApiError).isUnauthorized).toBe(true);
  });

  test('400 {error:"invalid_body"} throws ApiError with code==="invalid_body"', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(400, { error: 'invalid_body' }));
    vi.stubGlobal('fetch', fetchMock);

    let caught: unknown;
    try {
      await apiPost('/auth/login', { username: '', password: '' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(400);
    expect((caught as ApiError).code).toBe('invalid_body');
    expect((caught as ApiError).isUnauthorized).toBe(false);
  });

  test('204 No Content resolves without JSON-parsing', async () => {
    document.cookie = 'mirsal_csrf=t';
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiPost('/auth/logout')).resolves.toBeUndefined();
  });
});

describe('patchShare — download-limit field mapping', () => {
  test('maps downloadLimit/onExhaust to a snake_case PATCH body', async () => {
    document.cookie = 'mirsal_csrf=t';
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: 1 }));
    vi.stubGlobal('fetch', fetchMock);

    await patchShare({ id: 1, downloadLimit: 3, onExhaust: 'stop' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(urlOf(fetchMock)).toBe('/api/shares/1');
    const init = initOf(fetchMock);
    expect(init.method).toBe('PATCH');
    // Exact match also proves untouched fields (is_active/password/expires_at) are omitted.
    expect(JSON.parse(init.body as string)).toEqual({ download_limit: 3, on_exhaust: 'stop' });
  });

  test('forwards a null downloadLimit (clear the cap) rather than dropping it', async () => {
    document.cookie = 'mirsal_csrf=t';
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: 5 }));
    vi.stubGlobal('fetch', fetchMock);

    await patchShare({ id: 5, downloadLimit: null });

    const init = initOf(fetchMock);
    expect(JSON.parse(init.body as string)).toEqual({ download_limit: null });
  });
});
