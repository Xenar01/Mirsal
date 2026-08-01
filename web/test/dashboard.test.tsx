import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import i18n from '../src/i18n';
import { AuthProvider } from '../src/features/auth/auth-context';
import { ToastProvider } from '../src/components/Toast';
import DriveView from '../src/features/dashboard/DriveView';
import UploadDrop from '../src/features/dashboard/UploadDrop';
import type { NodeDto } from '../src/features/dashboard/types';

const USER = { id: 1, username: 'sara', role: 'user', mustChangePassword: false };
const NOW = 1_750_000_000_000; // fixed epoch-ms

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A fresh, retry-free QueryClient per render so tests never share cache/state. */
function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

/**
 * Stubs `fetch` with a path→body map (query string ignored). Any unmapped
 * path 404s so a stray call is visible rather than silently satisfied.
 */
function stubFetch(map: Record<string, unknown>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url).split('?')[0];
    if (path in map) return jsonResponse(200, map[path]);
    return jsonResponse(404, { error: 'not_found' });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderDrive(initialEntries: string[]) {
  const client = makeQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <AuthProvider>
          <ToastProvider>
            <MemoryRouter initialEntries={initialEntries}>
              <DriveView />
            </MemoryRouter>
          </ToastProvider>
        </AuthProvider>
      </I18nextProvider>
    </QueryClientProvider>
  );
}

function withProviders(node: ReactNode) {
  const client = makeQueryClient();
  return (
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <ToastProvider>{node}</ToastProvider>
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

describe('UploadDrop — client-side size guard (§3.2 / §4.9)', () => {
  test('a file over 100 MB shows the authored copy and is NOT sent to the upload transport', async () => {
    // Capture whether the XHR upload transport is ever opened/sent.
    const xhrOpen = vi.fn();
    const xhrSend = vi.fn();
    class MockXHR {
      open = xhrOpen;
      send = xhrSend;
      setRequestHeader = vi.fn();
      addEventListener = vi.fn();
      withCredentials = false;
      upload = { addEventListener: vi.fn() };
    }
    vi.stubGlobal('XMLHttpRequest', MockXHR as unknown as typeof XMLHttpRequest);

    render(withProviders(<UploadDrop parentId={null} />));

    const input = screen.getByTestId('upload-input') as HTMLInputElement;
    const tooBig = new File(['x'], 'huge.zip', { type: 'application/zip' });
    Object.defineProperty(tooBig, 'size', { value: 104857601 }); // 100 MB + 1 byte

    await act(async () => {
      fireEvent.change(input, { target: { files: [tooBig] } });
    });

    // Authored §4.9 copy, verbatim.
    expect(
      screen.getByText('الحد الأقصى ١٠٠ ميغابايت للملف. قسّم الملف أو اضغطه.')
    ).toBeInTheDocument();
    // The over-limit file was rejected client-side — nothing hit the network.
    expect(xhrOpen).not.toHaveBeenCalled();
    expect(xhrSend).not.toHaveBeenCalled();
  });
});

describe('DriveView — dispatch register (§4.6 / §4.3)', () => {
  test('renders the register RTL with LTR-isolated mono size + the dossier folder icon', async () => {
    const nodes: NodeDto[] = [
      {
        id: 5,
        parent_id: 1,
        kind: 'folder',
        name: 'مستندات',
        size_bytes: 0,
        mime_type: null,
        auto_delete_at: null,
        created_at: NOW,
        updated_at: NOW,
      },
      {
        id: 6,
        parent_id: 1,
        kind: 'file',
        name: 'تقرير.pdf',
        size_bytes: 2048,
        mime_type: 'application/pdf',
        auto_delete_at: null,
        created_at: NOW,
        updated_at: NOW,
      },
    ];
    stubFetch({ '/api/nodes': nodes, '/api/nodes/trash': [], '/api/auth/me': USER });

    renderDrive(['/']);

    // Scope to the register table — jsdom renders BOTH the desktop table and
    // the (hidden below md, but still mounted) mobile card list, which repeats
    // the same node name/icon, so unscoped queries would match twice.
    const register = await screen.findByRole('table');

    // The Arabic folder name flows in the ambient RTL context — NOT wrapped in
    // an LTR bidi isolate.
    const folderName = within(register).getByText('مستندات');
    expect(folderName.closest('bdi')).toBeNull();

    // Folders carry the subject-grounded dossier icon (§4.7).
    expect(within(register).getByTestId('icon-folder')).toBeInTheDocument();

    // The size is monospace ledger data, bidi-isolated LTR so it never
    // scrambles inside the Arabic row (§4.3 / §4.5). Scope to the register
    // table — the storage meter legitimately shows the same total elsewhere.
    const size = within(register).getByText('2 KB');
    expect(size.tagName).toBe('BDI');
    expect(size).toHaveAttribute('dir', 'ltr');
    expect(size.className).toMatch(/font-mono/);
  });

  test('the status column shows the GRANULAR share status + a quick copy-link for a shared node (§4.6 / §4.4)', async () => {
    const nodes: NodeDto[] = [
      {
        id: 6,
        parent_id: 1,
        kind: 'file',
        name: 'تقرير.pdf',
        size_bytes: 2048,
        mime_type: 'application/pdf',
        auto_delete_at: null,
        created_at: NOW,
        updated_at: NOW,
      },
    ];
    // A live, ACTIVE share for node 6 — the register column must still show the
    // brass "shared" seal (§4.6), never leak the granular 'active' status.
    const share = {
      id: 1,
      node_id: 6,
      token: 'Tok3nAbc',
      is_active: true,
      has_password: false,
      expires_at: null,
      allow_download: true,
      created_at: NOW,
      status: 'active',
      url: 'https://project4.system.mow.gov.sy/s/Tok3nAbc',
    };
    stubFetch({
      '/api/nodes': nodes,
      '/api/nodes/trash': [],
      '/api/shares': [share],
      '/api/auth/me': USER,
    });

    renderDrive(['/']);

    const register = await screen.findByRole('table');
    // The drive column now shows the GRANULAR share status at a glance (active
    // here) + a quick copy-link, so the owner sees real state without opening
    // the modal — not the generic "shared" seal.
    expect(within(register).getByText(i18n.t('status.active'))).toBeInTheDocument();
    expect(within(register).queryByText(i18n.t('status.shared'))).toBeNull();
    expect(
      within(register).getByRole('button', { name: i18n.t('share.copy') })
    ).toBeInTheDocument();
  });

  test('the mobile card list renders the same node alongside the desktop table (§M2a two-layout pattern)', async () => {
    const nodes: NodeDto[] = [
      {
        id: 6,
        parent_id: 1,
        kind: 'file',
        name: 'تقرير.pdf',
        size_bytes: 2048,
        mime_type: 'application/pdf',
        auto_delete_at: null,
        created_at: NOW,
        updated_at: NOW,
      },
    ];
    stubFetch({ '/api/nodes': nodes, '/api/nodes/trash': [], '/api/auth/me': USER });

    renderDrive(['/']);

    // jsdom has no viewport, so both layouts mount; the `md:hidden` card list
    // is present in the DOM with a stable per-node testid and shows the same
    // name as the (CSS-hidden) desktop row.
    const card = await screen.findByTestId('drive-card-6');
    expect(within(card).getByText('تقرير.pdf')).toBeInTheDocument();
  });

  test('an empty root shows the authored empty-state copy verbatim (§4.9)', async () => {
    stubFetch({ '/api/nodes': [], '/api/nodes/trash': [], '/api/auth/me': USER });

    renderDrive(['/']);

    expect(
      await screen.findByText('لا ملفات بعد. ارفع أول ملف أو أنشئ مجلدًا.')
    ).toBeInTheDocument();
  });

  test('New Folder is usable on a brand-new empty root — POSTs with a null parent, no generic-failure short-circuit (§4.9)', async () => {
    // A brand-new account: the root listing is empty, so the client has NO
    // child to learn the concrete root node id from. Folder creation must still
    // POST (the server resolves the synthetic root from a null parent).
    const created: NodeDto = {
      id: 7,
      parent_id: 1,
      kind: 'folder',
      name: 'مجلد جديد',
      size_bytes: 0,
      mime_type: null,
      auto_delete_at: null,
      created_at: NOW,
      updated_at: NOW,
    };
    let folderBody: unknown;
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url).split('?')[0];
      const method = init?.method ?? 'GET';
      if (path === '/api/nodes/folder' && method === 'POST') {
        folderBody = init?.body ? JSON.parse(String(init.body)) : undefined;
        return jsonResponse(201, created);
      }
      if (path === '/api/nodes') return jsonResponse(200, []); // empty root — zero children
      if (path === '/api/nodes/trash') return jsonResponse(200, []);
      if (path === '/api/auth/me') return jsonResponse(200, USER);
      return jsonResponse(404, { error: 'not_found' });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderDrive(['/']);
    // The verbatim empty-root copy is shown — it offers folder creation.
    await screen.findByText('لا ملفات بعد. ارفع أول ملف أو أنشئ مجلدًا.');

    fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.newFolder') }));
    const nameInput = await screen.findByLabelText(i18n.t('dashboard.folder.nameLabel'));
    fireEvent.change(nameInput, { target: { value: 'مجلد جديد' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.folder.create') }));
    });

    // The create endpoint WAS called (previously it short-circuited to a
    // generic failure without ever POSTing), with a null parent so the server
    // resolves the root for the empty account.
    const call = fetchMock.mock.calls.find(
      ([u, init]) =>
        String(u).split('?')[0] === '/api/nodes/folder' &&
        ((init as RequestInit | undefined)?.method ?? 'GET') === 'POST'
    );
    expect(call).toBeDefined();
    expect(folderBody).toMatchObject({ parent_id: null, name: 'مجلد جديد' });
    // No generic-failure message surfaced.
    expect(screen.queryByText(i18n.t('dashboard.folder.error'))).toBeNull();
  });

  test('"move to root" is offered from a deep-linked subfolder because the root id comes from user.rootNodeId (known even at an empty root, no child to derive it from)', async () => {
    // A single file living in subfolder 9, reached by DEEP LINK (?parent=9):
    // the root listing (parent=null) is never fetched here, so there is no
    // root child from which to derive the synthetic root id. Before this fix,
    // rootIdRef stayed null and "move to root" had no destination. Now the
    // authoritative root id comes from the auth-context user.rootNodeId — the
    // same value that lets a brand-new EMPTY root create folders / move-to-root.
    const file: NodeDto = {
      id: 42,
      parent_id: 9,
      kind: 'file',
      name: 'تقرير.pdf',
      size_bytes: 2048,
      mime_type: 'application/pdf',
      auto_delete_at: null,
      created_at: NOW,
      updated_at: NOW,
    };
    // The user carries rootNodeId = 3 (distinct from the subfolder id 9).
    stubFetch({
      '/api/nodes': [file],
      '/api/nodes/trash': [],
      '/api/shares': [],
      '/api/auth/me': { ...USER, rootNodeId: 3 },
    });

    renderDrive(['/?parent=9']);

    // Gate on the auth user being loaded (its username renders in the shell),
    // so the rootNodeId is in the auth context before we open the Move modal.
    await screen.findByText('sara');

    // Scope to the register table — the mobile card list (mounted alongside
    // the table in jsdom, hidden only via CSS) repeats the same node name and
    // a same-labeled Move action, so unscoped queries would match twice.
    const register = await screen.findByRole('table');
    await within(register).findByText('تقرير.pdf');

    fireEvent.click(within(register).getByRole('button', { name: i18n.t('dashboard.action.move') }));

    // The Move modal offers "root" (ملفاتي) as a destination — its id (3) came
    // from user.rootNodeId, since the root listing was never fetched here.
    const rootOption = (await screen.findByRole('option', {
      name: i18n.t('dashboard.breadcrumb.root'),
    })) as HTMLOptionElement;
    expect(rootOption).toBeInTheDocument();
    expect(rootOption.value).toBe('3');
    // The "no destinations" fallback must NOT be shown.
    expect(screen.queryByText(i18n.t('dashboard.move.noTargets'))).toBeNull();
  });

  test('a 409 on folder create surfaces a name-conflict message (§3.2 / §7)', async () => {
    // A name clash needs an existing sibling, so the root is non-empty — which
    // is also how the client learns the concrete root node id (from a child's
    // parent_id) to POST against.
    const existing: NodeDto[] = [
      {
        id: 5,
        parent_id: 1,
        kind: 'folder',
        name: 'مستندات',
        size_bytes: 0,
        mime_type: null,
        auto_delete_at: null,
        created_at: NOW,
        updated_at: NOW,
      },
    ];
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url).split('?')[0];
      const method = init?.method ?? 'GET';
      if (path === '/api/nodes/folder' && method === 'POST') {
        return jsonResponse(409, { code: 'name_conflict' });
      }
      if (path === '/api/nodes') return jsonResponse(200, existing);
      if (path === '/api/nodes/trash') return jsonResponse(200, []);
      if (path === '/api/auth/me') return jsonResponse(200, USER);
      return jsonResponse(404, { error: 'not_found' });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderDrive(['/']);
    // Wait for the listing so the client has learned the root node id.
    await screen.findAllByText('مستندات');

    // Open the "new folder" modal, type a name, submit.
    fireEvent.click(await screen.findByRole('button', { name: i18n.t('dashboard.newFolder') }));
    const nameInput = await screen.findByLabelText(i18n.t('dashboard.folder.nameLabel'));
    fireEvent.change(nameInput, { target: { value: 'مستندات' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.folder.create') }));
    });

    expect(await screen.findByText(i18n.t('dashboard.folder.conflict'))).toBeInTheDocument();
  });
});
