import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import i18n from '../src/i18n';
import { AuthProvider } from '../src/features/auth/auth-context';
import { ToastProvider } from '../src/components/Toast';
import {
  damascusInputToUtcMs,
  utcMsToDamascusInput,
} from '../src/features/dashboard/share/datetime';
import ShareModal from '../src/features/dashboard/share/ShareModal';
import SharedView from '../src/features/dashboard/share/SharedView';
import AutoDeleteMenu from '../src/features/dashboard/share/AutoDeleteMenu';
import type { ShareDto } from '../src/features/dashboard/share/types';
import type { NodeDto } from '../src/features/dashboard/types';

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

/**
 * A path+method aware fetch stub. `map` keys are `"<METHOD> <path>"`; a bare
 * path is treated as GET. Any unmapped call 404s so a stray request is visible.
 * Records every call so tests can assert a PATCH was (or was NOT) issued.
 */
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

function mkShare(over: Partial<ShareDto> = {}): ShareDto {
  return {
    id: 1,
    node_id: 100,
    token: 'Tok3nAbc',
    is_active: true,
    has_password: false,
    expires_at: null,
    allow_download: true,
    created_at: NOW,
    status: 'active',
    url: 'https://project4.system.mow.gov.sy/s/Tok3nAbc',
    ...over,
  };
}

function mkNode(over: Partial<NodeDto> = {}): NodeDto {
  return {
    id: 100,
    parent_id: 1,
    kind: 'file',
    name: 'تقرير.pdf',
    size_bytes: 2048,
    mime_type: 'application/pdf',
    auto_delete_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

function renderModal(node: NodeDto) {
  const client = makeQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <ToastProvider>
          <ShareModal node={node} onClose={() => {}} />
        </ToastProvider>
      </I18nextProvider>
    </QueryClientProvider>
  );
}

function renderAutoDelete(node: NodeDto) {
  const client = makeQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <ToastProvider>
          <AutoDeleteMenu node={node} onClose={() => {}} />
        </ToastProvider>
      </I18nextProvider>
    </QueryClientProvider>
  );
}

function renderShared(node: ReactNode = <SharedView />) {
  const client = makeQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <AuthProvider>
          <ToastProvider>
            <MemoryRouter initialEntries={['/shared']}>{node}</MemoryRouter>
          </ToastProvider>
        </AuthProvider>
      </I18nextProvider>
    </QueryClientProvider>
  );
}

/** True iff any recorded fetch was a PATCH to the given path prefix. */
function patchedPath(fetchMock: ReturnType<typeof vi.fn>, prefix: string): boolean {
  return fetchMock.mock.calls.some(([u, init]) => {
    const path = String(u).split('?')[0];
    const method = ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase();
    return method === 'PATCH' && path.startsWith(prefix);
  });
}

beforeEach(() => {
  document.cookie = 'mirsal_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Damascus <-> UTC conversion (§4.5 / Global Constraints)', () => {
  test('a Damascus wall-clock datetime-local converts to the correct UTC epoch-ms (+03:00)', () => {
    // Syria is a fixed UTC+3 year-round (DST abolished 2022), so 14:30 in
    // Damascus is 11:30 UTC regardless of the machine running the test.
    expect(damascusInputToUtcMs('2026-08-01T14:30')).toBe(Date.UTC(2026, 7, 1, 11, 30));
    // A winter date is STILL +3 (no DST) — this is the whole point of not
    // assuming the browser TZ.
    expect(damascusInputToUtcMs('2026-01-15T09:00')).toBe(Date.UTC(2026, 0, 15, 6, 0));
  });

  test('round-trips a UTC epoch back to a Damascus wall-clock input value', () => {
    expect(utcMsToDamascusInput(Date.UTC(2026, 7, 1, 11, 30))).toBe('2026-08-01T14:30');
  });

  test('rejects a malformed datetime-local value with null', () => {
    expect(damascusInputToUtcMs('not-a-date')).toBeNull();
    expect(damascusInputToUtcMs('')).toBeNull();
  });
});

describe('ShareModal — expiry picker (§3.3 / §4.5)', () => {
  test('a PAST Damascus datetime shows an inline error and does NOT PATCH the share', async () => {
    const fetchMock = stubFetch({ '/api/shares': [mkShare()], '/api/auth/me': USER });
    renderModal(mkNode());

    const input = (await screen.findByLabelText(
      i18n.t('share.expiry.label')
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2020-01-01T00:00' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: i18n.t('share.expiry.apply') }));
    });

    expect(screen.getByText(i18n.t('share.expiry.past'))).toBeInTheDocument();
    // The past deadline was rejected client-side — nothing hit the share PATCH.
    expect(patchedPath(fetchMock, '/api/shares/')).toBe(false);
  });

  test('a FUTURE Damascus datetime is PATCHed as the correct UTC epoch-ms', async () => {
    const fetchMock = stubFetch({
      '/api/shares': [mkShare()],
      'PATCH /api/shares/1': mkShare({ expires_at: Date.UTC(2099, 5, 1, 9, 0) }),
      '/api/auth/me': USER,
    });
    renderModal(mkNode());

    const input = (await screen.findByLabelText(
      i18n.t('share.expiry.label')
    )) as HTMLInputElement;
    // 2099-06-01 12:00 Damascus (+3) => 09:00 UTC.
    fireEvent.change(input, { target: { value: '2099-06-01T12:00' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: i18n.t('share.expiry.apply') }));
    });

    const patch = fetchMock.mock.calls.find(([u, init]) => {
      const path = String(u).split('?')[0];
      const method = ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase();
      return method === 'PATCH' && path === '/api/shares/1';
    });
    expect(patch).toBeDefined();
    const body = JSON.parse(String((patch![1] as RequestInit).body));
    expect(body).toEqual({ expires_at: Date.UTC(2099, 5, 1, 9, 0) });
  });
});

describe('Shared view — owner status chips (§3.3)', () => {
  test('renders a DISTINCT StatusChip label for each of active / stopped / expired', async () => {
    stubFetch({
      '/api/shares': [
        mkShare({ id: 1, node_id: 100, token: 'aaa', status: 'active', is_active: true }),
        mkShare({ id: 2, node_id: 101, token: 'bbb', status: 'stopped', is_active: false }),
        mkShare({
          id: 3,
          node_id: 102,
          token: 'ccc',
          status: 'expired',
          expires_at: NOW - 1000,
        }),
      ],
      '/api/nodes': [],
      '/api/nodes/trash': [],
      '/api/auth/me': USER,
    });

    renderShared();

    const active = await screen.findByText(i18n.t('status.active'));
    const stopped = screen.getByText(i18n.t('status.stopped'));
    const expired = screen.getByText(i18n.t('status.expired'));
    expect(active).toBeInTheDocument();
    expect(stopped).toBeInTheDocument();
    expect(expired).toBeInTheDocument();
    // The three labels are genuinely different strings (§3.3 distinctness).
    expect(new Set([active.textContent, stopped.textContent, expired.textContent]).size).toBe(3);
  });

  test('an empty shares list shows the authored §4.9 empty-state copy verbatim', async () => {
    stubFetch({
      '/api/shares': [],
      '/api/nodes': [],
      '/api/nodes/trash': [],
      '/api/auth/me': USER,
    });

    renderShared();

    expect(await screen.findByText('لم تُشارك أي عنصر بعد.')).toBeInTheDocument();
  });
});

describe('AutoDeleteMenu — warns before enabling (§3.4)', () => {
  test('surfaces the trash + 7-day-grace warning BEFORE any PATCH is issued', async () => {
    const fetchMock = stubFetch({});
    renderAutoDelete(mkNode({ auto_delete_at: null }));

    // The consequence warning is visible immediately, before scheduling.
    expect(screen.getByText(i18n.t('autoDelete.warning'))).toBeInTheDocument();
    // Nothing has been scheduled yet — no auto-delete PATCH went out.
    expect(patchedPath(fetchMock, '/api/nodes/')).toBe(false);
  });

  test('a PAST auto-delete datetime is rejected client-side (no PATCH)', async () => {
    const fetchMock = stubFetch({});
    renderAutoDelete(mkNode({ auto_delete_at: null }));

    const input = screen.getByLabelText(i18n.t('autoDelete.label')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2020-01-01T00:00' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: i18n.t('autoDelete.set') }));
    });

    expect(screen.getByText(i18n.t('autoDelete.past'))).toBeInTheDocument();
    expect(patchedPath(fetchMock, '/api/nodes/')).toBe(false);
  });
});
