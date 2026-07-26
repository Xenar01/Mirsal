import { describe, test, expect, vi, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { AuthProvider, useAuth } from '../src/features/auth/auth-context';

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A promise plus its resolve/reject, so a test can control exactly when a fetch settles. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Drains the microtask queue. A `setTimeout` macrotask only fires after every
 * currently-queued microtask (and any microtasks they queue in turn) has run,
 * so this reliably waits out an async chain (fetch → res.text() → JSON.parse
 * → catch/finally) without guessing how many `Promise.resolve()` hops deep it is.
 */
async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const ADMIN = { id: 1, username: 'admin', role: 'admin', mustChangePassword: false };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AuthProvider — request sequencing (mount /me probe vs. login race)', () => {
  test('a late-resolving 401 from the mount /me probe does not log out a user who logged in first', async () => {
    const me = deferred<Response>();
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.endsWith('/auth/me')) return me.promise;
      if (u.endsWith('/auth/login')) return jsonResponse(200, { user: ADMIN });
      throw new Error(`unexpected fetch: ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });

    // The mount effect's /me probe is still pending (deliberately held open)
    // when the user logs in — this is the exact race the fix must resolve.
    await act(async () => {
      await result.current.login('admin', 'secret-pw-12');
    });
    expect(result.current.user).toEqual(ADMIN);

    // Now let the stale probe resolve with 401. Pre-fix, this called
    // setUser(null) unconditionally and silently signed the user back out.
    await act(async () => {
      me.resolve(jsonResponse(401));
      await flushAsync();
    });

    expect(result.current.user).toEqual(ADMIN);
  });

  test('login() clears `loading` even when it supersedes a still-pending mount /me probe', async () => {
    const me = deferred<Response>();
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.endsWith('/auth/me')) return me.promise;
      if (u.endsWith('/auth/login')) return jsonResponse(200, { user: ADMIN });
      throw new Error(`unexpected fetch: ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });

    // Mount probe held open → still loading. Login supersedes it (bumps the
    // sequence counter), so the probe's `finally` will skip setLoading(false).
    expect(result.current.loading).toBe(true);

    await act(async () => {
      await result.current.login('admin', 'secret-pw-12');
    });

    // Pre-fix, `login` never touched `loading`, so it stayed stuck `true` here
    // and RequireAuth (which renders nothing while loading) would hang forever.
    expect(result.current.user).toEqual(ADMIN);
    expect(result.current.loading).toBe(false);

    // The stale probe resolving late must not resurrect `loading` or drop the user.
    await act(async () => {
      me.resolve(jsonResponse(401));
      await flushAsync();
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.user).toEqual(ADMIN);
  });
});

describe('AuthProvider — logout() failure handling', () => {
  test('logout() leaves user state intact and rejects when the server request throws (network error)', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.endsWith('/auth/me')) return jsonResponse(401);
      if (u.endsWith('/auth/login')) return jsonResponse(200, { user: ADMIN });
      if (u.endsWith('/auth/logout')) throw new TypeError('Failed to fetch');
      throw new Error(`unexpected fetch: ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.login('admin', 'secret-pw-12');
    });
    expect(result.current.user).toEqual(ADMIN);

    await act(async () => {
      await expect(result.current.logout()).rejects.toThrow('Failed to fetch');
    });

    // The server never confirmed revocation, so the UI must keep showing the
    // user as signed in — the httpOnly mirsal_session cookie is still valid.
    expect(result.current.user).toEqual(ADMIN);
  });

  test('logout() leaves user state intact and rejects on a 403 (stale/missing CSRF)', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.endsWith('/auth/me')) return jsonResponse(401);
      if (u.endsWith('/auth/login')) return jsonResponse(200, { user: ADMIN });
      if (u.endsWith('/auth/logout')) return jsonResponse(403);
      throw new Error(`unexpected fetch: ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.login('admin', 'secret-pw-12');
    });

    await act(async () => {
      await expect(result.current.logout()).rejects.toMatchObject({ status: 403 });
    });

    expect(result.current.user).toEqual(ADMIN);
  });

  test('logout() still clears user state once the server confirms revocation', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.endsWith('/auth/me')) return jsonResponse(401);
      if (u.endsWith('/auth/login')) return jsonResponse(200, { user: ADMIN });
      if (u.endsWith('/auth/logout')) return jsonResponse(200, { ok: true });
      throw new Error(`unexpected fetch: ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.login('admin', 'secret-pw-12');
    });
    expect(result.current.user).toEqual(ADMIN);

    await act(async () => {
      await result.current.logout();
    });

    expect(result.current.user).toBeNull();
  });
});
