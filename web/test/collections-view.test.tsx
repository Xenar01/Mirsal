import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '../src/i18n';
import { AuthProvider } from '../src/features/auth/auth-context';
import { ToastProvider } from '../src/components/Toast';
import CollectionsView from '../src/features/collections/CollectionsView';
import type { CollectionSummaryDto } from '../src/features/collections/types';

/*
 * CollectionsView — owner list (Collections Phase 3 / Task 3).
 *
 * Mirrors test/share.test.tsx's provider stack (QueryClient + I18next +
 * AuthProvider + ToastProvider + MemoryRouter) and its path+method aware
 * fetch stub, adapted to GET /api/collections.
 */

const USER = { id: 1, username: 'sara', role: 'user', mustChangePassword: false };
const NOW = 1_750_000_000_000; // fixed epoch-ms

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(map: Record<string, unknown>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url).split('?')[0];
    const method = (init?.method ?? 'GET').toUpperCase();
    const keyed = `${method} ${path}`;
    if (keyed in map) return jsonResponse(method === 'POST' ? 201 : 200, map[keyed]);
    if (path in map) return jsonResponse(200, map[path]);
    return jsonResponse(404, { error: 'not_found' });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function mkCollection(over: Partial<CollectionSummaryDto> = {}): CollectionSummaryDto {
  return {
    id: 1,
    token: 'tok',
    title: 'مسح ربعي',
    is_active: true,
    has_password: false,
    has_template: false,
    deadline_at: null,
    created_at: NOW,
    status: 'open',
    department_count: 5,
    responded_count: 2,
    url: 'https://project4.system.mow.gov.sy/c/tok',
    ...over,
  };
}

function renderView() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <AuthProvider>
          <ToastProvider>
            <MemoryRouter initialEntries={['/collections']}>
              <CollectionsView />
            </MemoryRouter>
          </ToastProvider>
        </AuthProvider>
      </I18nextProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  document.cookie = 'mirsal_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CollectionsView — owner list (Collections Phase 3)', () => {
  test('lists collections with X/N count and status', async () => {
    stubFetch({
      '/api/collections': [mkCollection()],
      '/api/auth/me': USER,
    });
    renderView();

    // Scope to the register table — the mobile card list (mounted alongside
    // the table in jsdom, hidden only via CSS) repeats the same content, so
    // an unscoped query would match twice (§M2b two-layout pattern).
    const register = await screen.findByRole('table');
    expect(within(register).getByText('مسح ربعي')).toBeInTheDocument();
    expect(within(register).getByText('2/5 قسمًا')).toBeInTheDocument();
    expect(within(register).getByText(i18n.t('status.active'))).toBeInTheDocument();
  });

  test('empty state shows the authored copy', async () => {
    stubFetch({ '/api/collections': [], '/api/auth/me': USER });
    renderView();

    expect(await screen.findByText(i18n.t('collections.empty'))).toBeInTheDocument();
  });

  test('clicking "new" opens the create modal', async () => {
    stubFetch({ '/api/collections': [], '/api/auth/me': USER });
    renderView();

    const newBtn = await screen.findByRole('button', { name: i18n.t('collections.new') });
    fireEvent.click(newBtn);

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});
