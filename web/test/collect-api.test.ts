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

/**
 * A controllable fake `XMLHttpRequest` for `submitResponse` (Task 5 — upload
 * progress). Unlike the auto-responding `MockXHR` in
 * `collections-create.test.tsx`, this one is driven manually via
 * `emitProgress`/`emitLoad`/`emitError`/`emitAbort` so a test can assert the
 * intermediate progress callback before resolving the request.
 */
class FakeXHR {
  static instances: FakeXHR[] = [];
  open = vi.fn();
  send = vi.fn();
  withCredentials = false;
  status = 0;
  responseText = '';
  listeners: Record<string, Array<() => void>> = {};
  uploadListeners: Record<
    string,
    Array<(e: { lengthComputable: boolean; loaded: number; total: number }) => void>
  > = {};
  upload = {
    addEventListener: (
      type: string,
      cb: (e: { lengthComputable: boolean; loaded: number; total: number }) => void
    ) => {
      (this.uploadListeners[type] ??= []).push(cb);
    },
  };

  constructor() {
    FakeXHR.instances.push(this);
  }

  addEventListener(type: string, cb: () => void) {
    (this.listeners[type] ??= []).push(cb);
  }

  /** Fires a progress event; `lengthComputable:false` mirrors an XHR upload whose total size can't be determined. */
  emitProgress(loaded: number, total: number, lengthComputable = true) {
    this.uploadListeners['progress']?.forEach((cb) => cb({ lengthComputable, loaded, total }));
  }

  emitLoad(status: number, body?: unknown) {
    this.status = status;
    this.responseText = body === undefined ? '' : JSON.stringify(body);
    this.listeners['load']?.forEach((cb) => cb());
  }

  /** Fires `load` with a raw (possibly non-JSON) response body — for the malformed-body case. */
  emitLoadRaw(status: number, rawText: string) {
    this.status = status;
    this.responseText = rawText;
    this.listeners['load']?.forEach((cb) => cb());
  }

  emitError() {
    this.listeners['error']?.forEach((cb) => cb());
  }

  emitAbort() {
    this.listeners['abort']?.forEach((cb) => cb());
  }
}

function installMockXHR(): void {
  FakeXHR.instances = [];
  vi.stubGlobal('XMLHttpRequest', FakeXHR as unknown as typeof XMLHttpRequest);
}

function lastXhr(): FakeXHR {
  return FakeXHR.instances[FakeXHR.instances.length - 1];
}

describe('collect api — submitResponse (XHR, with upload progress)', () => {
  test('builds multipart with departmentId + files + note, POSTs via XHR with credentials, no CSRF', async () => {
    installMockXHR();
    const file = new File(['hello'], 'a.txt', { type: 'text/plain' });

    const p = submitResponse(TOKEN, { departmentId: 5, files: [file], note: 'ملاحظة' });
    const xhr = lastXhr();
    xhr.emitLoad(200, { ok: true });
    expect(await p).toEqual({ kind: 'ok' });

    expect(FakeXHR.instances).toHaveLength(1);
    expect(xhr.open).toHaveBeenCalledWith('POST', `/api/collect/${TOKEN}/submit`);
    expect(xhr.withCredentials).toBe(true);

    const form = xhr.send.mock.calls[0][0] as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('departmentId')).toBe('5');
    expect(form.get('note')).toBe('ملاحظة');
    expect(form.getAll('files')).toEqual([file]);
  });

  test('omits the note field entirely when not provided', async () => {
    installMockXHR();
    const file = new File(['hello'], 'a.txt');
    const p = submitResponse(TOKEN, { departmentId: 1, files: [file] });
    const xhr = lastXhr();
    xhr.emitLoad(200, { ok: true });
    await p;
    const form = xhr.send.mock.calls[0][0] as FormData;
    expect(form.has('note')).toBe(false);
  });

  test('reports upload progress as a 0..1 fraction and resolves ok on 200', async () => {
    installMockXHR();
    const seen: number[] = [];
    const p = submitResponse(
      TOKEN,
      { departmentId: 1, files: [new File(['x'], 'a.txt')] },
      { onProgress: (f) => seen.push(f) }
    );
    const xhr = lastXhr();
    xhr.emitProgress(50, 100);
    xhr.emitLoad(200, { ok: true });
    await expect(p).resolves.toEqual({ kind: 'ok' });
    expect(seen).toContain(0.5);
  });

  test('a non-lengthComputable progress event is ignored (no NaN/undefined callback)', async () => {
    installMockXHR();
    const seen: number[] = [];
    const p = submitResponse(TOKEN, { departmentId: 1, files: [] }, { onProgress: (f) => seen.push(f) });
    const xhr = lastXhr();
    xhr.emitProgress(50, 100, false);
    xhr.emitLoad(200, { ok: true });
    await p;
    expect(seen).toEqual([]);
  });

  test('400 too_many_files → tooManyFiles', async () => {
    installMockXHR();
    const p = submitResponse(TOKEN, { departmentId: 1, files: [] });
    lastXhr().emitLoad(400, { error: 'too_many_files' });
    expect(await p).toEqual({ kind: 'tooManyFiles' });
  });

  test('413 file_too_large → tooLarge', async () => {
    installMockXHR();
    const p = submitResponse(TOKEN, { departmentId: 1, files: [] });
    lastXhr().emitLoad(413, { error: 'file_too_large' });
    expect(await p).toEqual({ kind: 'tooLarge' });
  });

  test('413 quota_exceeded → quota', async () => {
    installMockXHR();
    const p = submitResponse(TOKEN, { departmentId: 1, files: [] });
    lastXhr().emitLoad(413, { error: 'quota_exceeded' });
    expect(await p).toEqual({ kind: 'quota' });
  });

  test('404 → closed; 401 → locked', async () => {
    installMockXHR();
    const p1 = submitResponse(TOKEN, { departmentId: 1, files: [] });
    lastXhr().emitLoad(404, { error: 'not_found' });
    expect(await p1).toEqual({ kind: 'closed' });

    installMockXHR();
    const p2 = submitResponse(TOKEN, { departmentId: 1, files: [] });
    lastXhr().emitLoad(401, { needsPassword: true });
    expect(await p2).toEqual({ kind: 'locked' });
  });

  test('an unrecognized 400/413 body, a malformed body, or any other status maps to error', async () => {
    installMockXHR();
    const p1 = submitResponse(TOKEN, { departmentId: 1, files: [] });
    lastXhr().emitLoad(400, { error: 'no_files' });
    expect(await p1).toEqual({ kind: 'error' });

    installMockXHR();
    const p2 = submitResponse(TOKEN, { departmentId: 1, files: [] });
    lastXhr().emitLoad(500);
    expect(await p2).toEqual({ kind: 'error' });

    installMockXHR();
    const p3 = submitResponse(TOKEN, { departmentId: 1, files: [] });
    // Malformed JSON on a mapped error status still maps by status alone.
    lastXhr().emitLoadRaw(413, 'not json{{{');
    expect(await p3).toEqual({ kind: 'error' });
  });

  test('a network error event resolves { kind: "error" } — the promise never rejects', async () => {
    installMockXHR();
    const p = submitResponse(TOKEN, { departmentId: 1, files: [] });
    lastXhr().emitError();
    await expect(p).resolves.toEqual({ kind: 'error' });
  });

  test('an abort event resolves { kind: "error" } — the promise never rejects', async () => {
    installMockXHR();
    const p = submitResponse(TOKEN, { departmentId: 1, files: [] });
    lastXhr().emitAbort();
    await expect(p).resolves.toEqual({ kind: 'error' });
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
