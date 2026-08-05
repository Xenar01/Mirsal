import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '../src/i18n';
import { AuthProvider } from '../src/features/auth/auth-context';
import { ToastProvider } from '../src/components/Toast';
import CollectionDetail from '../src/features/collections/CollectionDetail';
import type { CollectionDetailDto } from '../src/features/collections/types';
import type { NodeDto } from '../src/features/dashboard/types';

/*
 * CollectionDetail — owner roster + lifecycle console (Collections Phase 3 /
 * Task 5).
 *
 * Mirrors test/share.test.tsx's provider stack (QueryClient + I18next +
 * AuthProvider + ToastProvider + MemoryRouter) and its path+method aware
 * fetch stub, extended with admin.test.tsx's `overrides: [status, body]`
 * escape hatch so 409 duplicate/has_response responses can be simulated.
 */

const USER = { id: 1, username: 'sara', role: 'user', mustChangePassword: false };
const NOW = 1_750_000_000_000; // fixed epoch-ms

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

interface StubOptions {
  overrides?: Record<string, [number, unknown]>;
}

/**
 * A path+method aware fetch stub (test/share.test.tsx's pattern). `map` keys
 * are `"<METHOD> <path>"`; a bare path is treated as GET. `overrides` (keyed
 * the same way) wins over `map` and answers an explicit `[status, body]` —
 * the escape hatch needed for 409 duplicate/has_response. Any unmapped call
 * 404s so a stray request is visible. Records every call for body assertions.
 */
function stubFetch(map: Record<string, unknown>, opts: StubOptions = {}): ReturnType<typeof vi.fn> {
  const overrides = opts.overrides ?? {};
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url).split('?')[0];
    const method = (init?.method ?? 'GET').toUpperCase();
    const keyed = `${method} ${path}`;
    if (keyed in overrides) {
      const [status, body] = overrides[keyed];
      return jsonResponse(status, body);
    }
    if (keyed in map) return jsonResponse(method === 'POST' ? 201 : 200, map[keyed]);
    if (path in map) return jsonResponse(200, map[path]);
    return jsonResponse(404, { error: 'not_found' });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Finds a recorded call by exact method + path (ignoring any query string). */
function findCall(
  fetchMock: ReturnType<typeof vi.fn>,
  method: string,
  path: string,
): [RequestInfo | URL, RequestInit | undefined] | undefined {
  return fetchMock.mock.calls.find(([u, init]) => {
    const p = String(u).split('?')[0];
    const m = ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase();
    return m === method && p === path;
  }) as [RequestInfo | URL, RequestInit | undefined] | undefined;
}

function mkDetail(over: Partial<CollectionDetailDto> = {}): CollectionDetailDto {
  return {
    id: 7,
    token: 'tok7',
    title: 'مسح ربعي',
    is_active: true,
    has_password: false,
    has_template: true,
    deadline_at: null,
    created_at: NOW,
    status: 'open',
    department_count: 3,
    responded_count: 1,
    url: 'https://project4.system.mow.gov.sy/c/tok7',
    template: { node_id: 9, name: 'template.xlsx' },
    folder_node_id: 40,
    departments: [
      { id: 1, name: 'المالية', responded: true, file_count: 2, submitted_at: NOW, note: 'مرفق', folder_node_id: 50 },
      { id: 2, name: 'الموارد', responded: false, file_count: 0, submitted_at: null, note: null, folder_node_id: null },
      { id: 3, name: 'الشؤون', responded: false, file_count: 0, submitted_at: null, note: null, folder_node_id: null },
    ],
    ...over,
  };
}

function mkNode(over: Partial<NodeDto> = {}): NodeDto {
  return {
    id: 60,
    parent_id: 50,
    kind: 'file',
    name: 'a.pdf',
    size_bytes: 2048,
    mime_type: 'application/pdf',
    auto_delete_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

function renderDetail(id = 7) {
  const client = makeQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <AuthProvider>
          <ToastProvider>
            <MemoryRouter initialEntries={[`/collections/${id}`]}>
              <Routes>
                <Route path="/collections" element={<div data-testid="collections-root" />} />
                <Route path="/collections/:id" element={<CollectionDetail />} />
              </Routes>
            </MemoryRouter>
          </ToastProvider>
        </AuthProvider>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  document.cookie = 'mirsal_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CollectionDetail — roster + lifecycle (Collections Phase 3 / Task 5)', () => {
  test('renders X/N, the responded department with its file count and note, and the missing ones', async () => {
    stubFetch({ '/api/collections/7': mkDetail(), '/api/auth/me': USER });
    renderDetail();

    expect(await screen.findByText('مسح ربعي')).toBeInTheDocument();
    expect(screen.getByText(i18n.t('collections.count', { responded: 1, total: 3 }))).toBeInTheDocument();
    expect(screen.getByText(i18n.t('status.active'))).toBeInTheDocument();

    // Responded department: name, file count, note.
    const responded = screen.getByTestId('department-responded-1');
    expect(within(responded).getByText('المالية')).toBeInTheDocument();
    expect(within(responded).getByText(i18n.t('collections.detail.files', { count: 2 }))).toBeInTheDocument();
    expect(within(responded).getByText('مرفق')).toBeInTheDocument();

    // Missing departments: name + remove button, one row each.
    const missing2 = screen.getByTestId('department-missing-2');
    const missing3 = screen.getByTestId('department-missing-3');
    expect(within(missing2).getByText('الموارد')).toBeInTheDocument();
    expect(within(missing3).getByText('الشؤون')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: i18n.t('collections.detail.removeDepartment') })).toHaveLength(2);
  });

  test('expanding a responded department lists its files (GET /api/nodes?parent=50) with download links', async () => {
    const fetchMock = stubFetch({
      '/api/collections/7': mkDetail(),
      '/api/auth/me': USER,
      '/api/nodes': [mkNode()],
    });
    renderDetail();

    const showBtn = await screen.findByRole('button', { name: i18n.t('collections.detail.showFiles') });
    fireEvent.click(showBtn);

    // Exact match: the looser substring match this used before Task 4 now also
    // matches the whole-collection/per-department ZIP links ("تنزيل الكل كملف
    // مضغوط" / "تنزيل كملف مضغوط" both contain "تنزيل").
    const link = await screen.findByRole('link', { name: i18n.t('collections.detail.download') });
    expect(link).toHaveAttribute('href', '/api/nodes/60/download');

    // Assert the department's OWN folder (50) was requested — the stub's bare
    // `/api/nodes` path branch matches any parent, so without this a request
    // for the wrong folder id would still pass.
    const nodesCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/api/nodes?'));
    expect(nodesCall).toBeDefined();
    expect(String(nodesCall![0])).toContain('parent=50');
  });

  test('renders a whole-collection ZIP link pointing at the collection root folder', async () => {
    stubFetch({ '/api/collections/7': mkDetail(), '/api/auth/me': USER });
    renderDetail();

    const link = await screen.findByRole('link', { name: /تنزيل الكل/ });
    expect(link).toHaveAttribute('href', '/api/nodes/40/zip');
  });

  test('omits the whole-collection ZIP link when no department has responded', async () => {
    stubFetch({
      '/api/collections/7': mkDetail({ responded_count: 0, departments: [] }),
      '/api/auth/me': USER,
    });
    renderDetail();

    await screen.findByText('مسح ربعي');
    expect(screen.queryByRole('link', { name: /تنزيل الكل/ })).not.toBeInTheDocument();
  });

  test('renders a per-department ZIP link for a responded department', async () => {
    stubFetch({ '/api/collections/7': mkDetail(), '/api/auth/me': USER });
    renderDetail();

    const link = await screen.findByRole('link', { name: /تنزيل كملف مضغوط/ });
    expect(link).toHaveAttribute('href', '/api/nodes/50/zip');
  });

  test('close toggles is_active via PATCH', async () => {
    const fetchMock = stubFetch(
      { '/api/collections/7': mkDetail(), '/api/auth/me': USER },
      { overrides: { 'PATCH /api/collections/7': [200, mkDetail({ is_active: false, status: 'closed' })] } },
    );
    renderDetail();

    const closeBtn = await screen.findByRole('button', { name: i18n.t('collections.detail.close') });
    await act(async () => {
      fireEvent.click(closeBtn);
    });

    const patch = findCall(fetchMock, 'PATCH', '/api/collections/7');
    expect(patch).toBeDefined();
    expect(JSON.parse(String((patch![1] as RequestInit).body))).toEqual({ is_active: false });
  });

  test('add department POSTs; duplicate (409) shows the duplicate toast', async () => {
    const fetchMock = stubFetch(
      { '/api/collections/7': mkDetail(), '/api/auth/me': USER },
      { overrides: { 'POST /api/collections/7/departments': [409, { code: 'duplicate' }] } },
    );
    renderDetail();

    const input = await screen.findByLabelText(i18n.t('collections.detail.addDepartmentLabel'));
    fireEvent.change(input, { target: { value: 'المالية' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: i18n.t('collections.detail.addDepartmentSubmit') }));
    });

    expect(await screen.findByText(i18n.t('collections.detail.duplicateDepartment'))).toBeInTheDocument();
    const post = findCall(fetchMock, 'POST', '/api/collections/7/departments');
    expect(post).toBeDefined();
    expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({ name: 'المالية' });
  });

  test('remove a missing department DELETEs it', async () => {
    const fetchMock = stubFetch(
      { '/api/collections/7': mkDetail(), '/api/auth/me': USER },
      { overrides: { 'DELETE /api/collections/7/departments/2': [200, { ok: true }] } },
    );
    renderDetail();

    const row = await screen.findByTestId('department-missing-2');
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: i18n.t('collections.detail.removeDepartment') }));
    });

    expect(findCall(fetchMock, 'DELETE', '/api/collections/7/departments/2')).toBeDefined();
  });

  test('removing a department the server reports as answered shows the removeBlocked toast', async () => {
    stubFetch(
      { '/api/collections/7': mkDetail(), '/api/auth/me': USER },
      { overrides: { 'DELETE /api/collections/7/departments/2': [409, { code: 'has_response' }] } },
    );
    renderDetail();

    const row = await screen.findByTestId('department-missing-2');
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: i18n.t('collections.detail.removeDepartment') }));
    });

    expect(await screen.findByText(i18n.t('collections.detail.removeBlocked'))).toBeInTheDocument();
  });

  test('delete collection confirms then navigates back to /collections', async () => {
    const fetchMock = stubFetch(
      { '/api/collections/7': mkDetail(), '/api/auth/me': USER },
      { overrides: { 'DELETE /api/collections/7': [200, { ok: true }] } },
    );
    renderDetail();

    fireEvent.click(await screen.findByRole('button', { name: i18n.t('collections.detail.delete') }));
    const dialog = await screen.findByRole('dialog');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: i18n.t('collections.detail.deleteConfirm') }));
    });

    expect(await screen.findByTestId('collections-root')).toBeInTheDocument();
    expect(findCall(fetchMock, 'DELETE', '/api/collections/7')).toBeDefined();
  });
});
