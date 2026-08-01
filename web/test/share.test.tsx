import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
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
    download_limit: null,
    download_count: 0,
    on_exhaust: 'delete',
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

/**
 * The wizard's published step keeps the management sections (password / expiry
 * / download-limit) behind an explicit "Edit settings" toggle. Reveal them.
 */
async function openEditSettings() {
  fireEvent.click(
    await screen.findByRole('button', { name: i18n.t('share.wizard.editSettings') })
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
    await openEditSettings();

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
    await openEditSettings();

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

describe('ShareModal — restart-on-expired reports the SERVER status (§3.3)', () => {
  test('starting a share whose expiry already lapsed reports still-expired guidance, not a false "started"', async () => {
    // A stopped share whose deadline is already in the past. Flipping is_active
    // true does NOT un-expire it — the server derives 'expired', not 'active'.
    const stopped = mkShare({ is_active: false, status: 'stopped', expires_at: NOW - 1000 });
    const restartedButExpired = mkShare({
      is_active: true,
      status: 'expired',
      expires_at: NOW - 1000,
    });
    stubFetch({
      '/api/shares': [stopped],
      'PATCH /api/shares/1': restartedButExpired,
    });
    renderModal(mkNode());

    const startBtn = await screen.findByRole('button', { name: i18n.t('share.start') });
    await act(async () => {
      fireEvent.click(startBtn);
    });

    // The guidance toast is shown; the false-positive "started" toast is NOT.
    expect(await screen.findByText(i18n.t('share.toast.startedExpired'))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t('share.toast.started'))).toBeNull();
  });

  test('starting a non-expired stopped share DOES report "started"', async () => {
    const stopped = mkShare({ is_active: false, status: 'stopped', expires_at: null });
    const restarted = mkShare({ is_active: true, status: 'active', expires_at: null });
    stubFetch({
      '/api/shares': [stopped],
      'PATCH /api/shares/1': restarted,
    });
    renderModal(mkNode());

    const startBtn = await screen.findByRole('button', { name: i18n.t('share.start') });
    await act(async () => {
      fireEvent.click(startBtn);
    });

    expect(await screen.findByText(i18n.t('share.toast.started'))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t('share.toast.startedExpired'))).toBeNull();
  });
});

describe('ShareModal — a failed shares fetch never masquerades as "unshared" (dedup safety)', () => {
  test('when GET /api/shares errors, the modal surfaces an error and does NOT offer "create share"', async () => {
    // /api/shares is intentionally unmapped => 404 => useShares().isError.
    stubFetch({});
    renderModal(mkNode());

    expect(await screen.findByText(i18n.t('share.error'))).toBeInTheDocument();
    // Offering "create" on an errored fetch would let the owner mint a
    // duplicate share for an already-shared node.
    expect(screen.queryByRole('button', { name: i18n.t('share.create') })).toBeNull();
  });
});

describe('Shared register — quick-toggle reports the SERVER status (§3.3)', () => {
  test('restarting a lapsed share from the register reports still-expired guidance, not a false "started"', async () => {
    const stopped = mkShare({
      id: 1,
      node_id: 100,
      is_active: false,
      status: 'stopped',
      expires_at: NOW - 1000,
    });
    const restartedButExpired = mkShare({
      id: 1,
      node_id: 100,
      is_active: true,
      status: 'expired',
      expires_at: NOW - 1000,
    });
    stubFetch({
      '/api/shares': [stopped],
      'PATCH /api/shares/1': restartedButExpired,
      '/api/nodes': [],
      '/api/nodes/trash': [],
      '/api/auth/me': USER,
    });
    renderShared();

    // Scope to the register table — jsdom renders BOTH the desktop table and
    // the (hidden below md, but still mounted) mobile card list (§M2b
    // two-layout pattern), which repeats the same Start button, so an
    // unscoped query would match twice.
    const register = await screen.findByRole('table');
    const startBtn = within(register).getByRole('button', { name: i18n.t('share.start') });
    await act(async () => {
      fireEvent.click(startBtn);
    });

    expect(await screen.findByText(i18n.t('share.toast.startedExpired'))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t('share.toast.started'))).toBeNull();
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

    // Scope to the register table — the mobile card list (mounted alongside
    // the table in jsdom, hidden only via CSS) repeats the same StatusChip
    // labels, so unscoped queries would match twice (§M2b two-layout pattern).
    const register = await screen.findByRole('table');
    const active = within(register).getByText(i18n.t('status.active'));
    const stopped = within(register).getByText(i18n.t('status.stopped'));
    const expired = within(register).getByText(i18n.t('status.expired'));
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

  test('the mobile card list renders the same share alongside the desktop table (§M2b two-layout pattern)', async () => {
    stubFetch({
      '/api/shares': [mkShare({ id: 4, node_id: 103, token: 'MobileTok9' })],
      '/api/nodes': [],
      '/api/nodes/trash': [],
      '/api/auth/me': USER,
    });

    renderShared();

    // jsdom has no viewport, so both layouts mount; the `md:hidden` card list
    // is present in the DOM with a stable per-share testid and shows the same
    // token as the (CSS-hidden) desktop row.
    const card = await screen.findByTestId('shared-card-4');
    expect(within(card).getByText('MobileTok9')).toBeInTheDocument();
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

describe('ShareModal — download limit (creator console, §4 / §9)', () => {
  test('a file share shows the Unlimited state and applies a numeric cap as a camel→snake PATCH', async () => {
    const fetchMock = stubFetch({
      '/api/shares': [mkShare()], // download_limit null ⇒ unlimited
      'PATCH /api/shares/1': mkShare({ download_limit: 3, on_exhaust: 'delete' }),
      '/api/auth/me': USER,
    });
    renderModal(mkNode()); // file node
    await openEditSettings();

    expect(await screen.findByText(i18n.t('share.downloadLimit.unlimited'))).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(i18n.t('share.downloadLimit.label')), {
      target: { value: '3' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: i18n.t('share.downloadLimit.apply') }));
    });

    const patch = fetchMock.mock.calls.find(([u, init]) => {
      const path = String(u).split('?')[0];
      const method = ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase();
      return method === 'PATCH' && path === '/api/shares/1';
    });
    expect(patch).toBeDefined();
    // Default terminal action is the fixture's on_exhaust: 'delete'; the web→api
    // mapping (Task 7) is camelCase → snake_case.
    expect(JSON.parse(String((patch![1] as RequestInit).body))).toEqual({
      download_limit: 3,
      on_exhaust: 'delete',
    });
  });

  test('the destructive delete warning shows by default and disappears when Stop is chosen', async () => {
    stubFetch({ '/api/shares': [mkShare()], '/api/auth/me': USER });
    renderModal(mkNode());
    await openEditSettings();

    // on_exhaust defaults to 'delete' ⇒ the trash-after-last-download warning is visible up front.
    expect(
      await screen.findByText(i18n.t('share.downloadLimit.deleteWarning'))
    ).toBeInTheDocument();

    // Choosing "stop the link" instead removes the destructive consequence.
    fireEvent.click(screen.getByLabelText(i18n.t('share.downloadLimit.modeStop')));
    expect(screen.queryByText(i18n.t('share.downloadLimit.deleteWarning'))).toBeNull();
  });

  test('the section is ABSENT for a folder share (v1 = single-file shares only)', async () => {
    stubFetch({ '/api/shares': [mkShare()], '/api/auth/me': USER });
    renderModal(mkNode({ kind: 'folder' }));
    await openEditSettings();

    // The modal has loaded (the expiry section renders under Edit settings) …
    expect(await screen.findByText(i18n.t('share.expiry.heading'))).toBeInTheDocument();
    // … but the per-file download-limit console is not offered for a folder.
    expect(screen.queryByText(i18n.t('share.downloadLimit.heading'))).toBeNull();
  });

  test('StatusChip shows a distinct exhausted label once a cap is reached', async () => {
    stubFetch({
      '/api/shares': [mkShare({ status: 'exhausted', download_limit: 1, download_count: 1 })],
      '/api/auth/me': USER,
    });
    renderModal(mkNode());

    // Verbatim Arabic (like the §4.9 empty-state test) so a missing translation is a real failure.
    expect(await screen.findByText('نُفِدت التنزيلات')).toBeInTheDocument();
  });
});
