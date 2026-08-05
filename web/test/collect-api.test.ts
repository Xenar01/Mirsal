import { describe, test, expect, vi, afterEach } from 'vitest';
import {
  fetchCollectMeta,
  unlockCollection,
  submitResponse,
  templateUrl,
  COLLECTION_MAX_FILES_PER_RESPONSE,
} from '../src/features/collect/api';

const TOKEN = 'tok-123';

/** Build a minimal same-shape Response the client can consume (mirrors public.test.tsx). */
function jsonResponse(status: number, body?: unknown, headers?: Record<string, string>): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('collect api — fetchCollectMeta', () => {
  test('404 → notFound; isOpen:false → closed; needsPassword&&!departments → password; departments → open', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(404, { error: 'not_found' })));
    expect(await fetchCollectMeta(TOKEN)).toEqual({ state: 'notFound' });

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { isOpen: false })));
    expect(await fetchCollectMeta(TOKEN)).toEqual({ state: 'closed' });

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { isOpen: true, needsPassword: true })));
    expect(await fetchCollectMeta(TOKEN)).toEqual({ state: 'password' });

    const openBody = {
      isOpen: true,
      needsPassword: false,
      title: 'مسح الاحتياجات',
      hasTemplate: true,
      templateName: 'template.xlsx',
      departments: [{ id: 1, name: 'المالية' }, { id: 2, name: 'الموارد' }],
    };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, openBody)));
    expect(await fetchCollectMeta(TOKEN)).toEqual({
      state: 'open',
      meta: {
        title: 'مسح الاحتياجات',
        hasTemplate: true,
        templateName: 'template.xlsx',
        departments: [{ id: 1, name: 'المالية' }, { id: 2, name: 'الموارد' }],
        needsPassword: false,
      },
    });
  });

  test('an unexpected status maps to error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, {})));
    expect(await fetchCollectMeta(TOKEN)).toEqual({ state: 'error' });
  });

  test('meta omits credentials until reveal (gate re-appears each fresh open)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { isOpen: false }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchCollectMeta(TOKEN);
    expect((fetchMock.mock.calls[0][1] as RequestInit).credentials).toBe('omit');

    await fetchCollectMeta(TOKEN, { reveal: true });
    expect((fetchMock.mock.calls[1][1] as RequestInit).credentials).toBe('include');
  });

  test('the request path is /api/collect/<encoded token>', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(404, { error: 'not_found' }));
    vi.stubGlobal('fetch', fetchMock);
    await fetchCollectMeta('a/b c');
    expect(String(fetchMock.mock.calls[0][0])).toBe(`/api/collect/${encodeURIComponent('a/b c')}`);
  });
});

describe('collect api — unlockCollection', () => {
  test('200 → ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { ok: true })));
    expect(await unlockCollection(TOKEN, 'pw')).toEqual({ kind: 'ok' });
  });

  test('401 reads x-ratelimit-remaining → wrong{remaining}', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(401, { error: 'invalid_password' }, { 'x-ratelimit-remaining': '3' }))
    );
    expect(await unlockCollection(TOKEN, 'pw')).toEqual({ kind: 'wrong', remaining: 3 });
  });

  test('401 without a readable header degrades to remaining:null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: 'invalid_password' })));
    expect(await unlockCollection(TOKEN, 'pw')).toEqual({ kind: 'wrong', remaining: null });
  });

  test('429 → rateLimited', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(429, {})));
    expect(await unlockCollection(TOKEN, 'pw')).toEqual({ kind: 'rateLimited' });
  });

  test('anything else → error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, {})));
    expect(await unlockCollection(TOKEN, 'pw')).toEqual({ kind: 'error' });
  });

  test('POSTs JSON {password} with credentials:include and no CSRF header', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await unlockCollection(TOKEN, 'secret');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(String(init.body))).toEqual({ password: 'secret' });
    const headers = init.headers as Record<string, string>;
    expect(headers['x-csrf-token']).toBeUndefined();
  });
});

describe('collect api — submitResponse', () => {
  test('builds multipart with departmentId + files + note and lets the browser set content-type', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const file = new File(['hello'], 'a.txt', { type: 'text/plain' });

    const result = await submitResponse(TOKEN, { departmentId: 5, files: [file], note: 'ملاحظة' });
    expect(result).toEqual({ kind: 'ok' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit];
    expect(String(url)).toBe(`/api/collect/${TOKEN}/submit`);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    // No manual content-type — the browser must set the multipart boundary.
    expect(init.headers).toBeUndefined();

    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('departmentId')).toBe('5');
    expect(form.get('note')).toBe('ملاحظة');
    expect(form.getAll('files')).toEqual([file]);
  });

  test('omits the note field entirely when not provided', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const file = new File(['hello'], 'a.txt');
    await submitResponse(TOKEN, { departmentId: 1, files: [file] });
    const form = (fetchMock.mock.calls[0][1] as RequestInit).body as FormData;
    expect(form.has('note')).toBe(false);
  });

  test('400 too_many_files → tooManyFiles', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(400, { error: 'too_many_files' })));
    expect(await submitResponse(TOKEN, { departmentId: 1, files: [] })).toEqual({ kind: 'tooManyFiles' });
  });

  test('413 file_too_large → tooLarge', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(413, { error: 'file_too_large' })));
    expect(await submitResponse(TOKEN, { departmentId: 1, files: [] })).toEqual({ kind: 'tooLarge' });
  });

  test('413 quota_exceeded → quota', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(413, { error: 'quota_exceeded' })));
    expect(await submitResponse(TOKEN, { departmentId: 1, files: [] })).toEqual({ kind: 'quota' });
  });

  test('404 → closed; 401 → locked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(404, { error: 'not_found' })));
    expect(await submitResponse(TOKEN, { departmentId: 1, files: [] })).toEqual({ kind: 'closed' });

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { needsPassword: true })));
    expect(await submitResponse(TOKEN, { departmentId: 1, files: [] })).toEqual({ kind: 'locked' });
  });

  test('an unrecognized 400/413 body or any other status maps to error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(400, { error: 'no_files' })));
    expect(await submitResponse(TOKEN, { departmentId: 1, files: [] })).toEqual({ kind: 'error' });

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, {})));
    expect(await submitResponse(TOKEN, { departmentId: 1, files: [] })).toEqual({ kind: 'error' });
  });
});

describe('collect api — misc', () => {
  test('templateUrl builds the encoded /api/collect/<token>/template path', () => {
    expect(templateUrl(TOKEN)).toBe(`/api/collect/${TOKEN}/template`);
    expect(templateUrl('a/b')).toBe(`/api/collect/${encodeURIComponent('a/b')}/template`);
  });

  test('COLLECTION_MAX_FILES_PER_RESPONSE matches the server cap', () => {
    expect(COLLECTION_MAX_FILES_PER_RESPONSE).toBe(10);
  });
});
