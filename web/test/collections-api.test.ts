import { describe, test, expect, vi, afterEach } from 'vitest';
import * as api from '../src/features/collections/api';

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
function stubFetch(map: Record<string, unknown>) {
  const mock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url).split('?')[0];
    const method = (init?.method ?? 'GET').toUpperCase();
    const keyed = `${method} ${path}`;
    const record = { path, method, body: init?.body };
    calls.push(record);
    if (keyed in map) return jsonResponse(method === 'POST' ? 201 : 200, map[keyed]);
    if (path in map) return jsonResponse(200, map[path]);
    return jsonResponse(404, { error: 'not_found' });
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}
const calls: Array<{ path: string; method: string; body: BodyInit | null | undefined }> = [];
afterEach(() => {
  vi.unstubAllGlobals();
  calls.length = 0;
});

describe('collections api', () => {
  test('createCollection POSTs /api/collections with the mapped snake_case body', async () => {
    stubFetch({ 'POST /api/collections': { id: 5, token: 'tok', title: 't', departments: [], url: 'u' } });
    await api.createCollection({ title: 'مسح', departments: ['المالية', 'الموارد'], deadlineAt: 123, password: 'pw' });
    const call = calls.find((c) => c.method === 'POST');
    expect(call?.path).toBe('/api/collections');
    expect(JSON.parse(String(call?.body))).toEqual({
      title: 'مسح',
      departments: ['المالية', 'الموارد'],
      deadline_at: 123,
      password: 'pw',
    });
  });

  test('patchCollection sends ONLY the provided keys (tri-state), snake_cased', async () => {
    stubFetch({ 'PATCH /api/collections/9': { id: 9 } });
    await api.patchCollection({ id: 9, isActive: false, password: null });
    const call = calls.find((c) => c.method === 'PATCH');
    expect(call?.path).toBe('/api/collections/9');
    expect(JSON.parse(String(call?.body))).toEqual({ is_active: false, password: null });
  });

  test('addDepartment / removeDepartment hit the department subroutes', async () => {
    stubFetch({ 'POST /api/collections/9/departments': { id: 2, name: 'x', position: 1 } });
    await api.addDepartment(9, 'الشؤون');
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: '/api/collections/9/departments' });
    stubFetch({ 'DELETE /api/collections/9/departments/2': { ok: true } });
    await api.removeDepartment(9, 2);
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/api/collections/9/departments/2' });
  });
});
