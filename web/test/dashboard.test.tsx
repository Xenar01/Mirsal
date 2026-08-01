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
import TrashView from '../src/features/dashboard/TrashView';
import UploadDrop from '../src/features/dashboard/UploadDrop';
import type { NodeDto } from '../src/features/dashboard/types';
import { sortNodes, type SortState } from '../src/features/dashboard/sort';

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

function renderTrash(initialEntries: string[]) {
  const client = makeQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <AuthProvider>
          <ToastProvider>
            <MemoryRouter initialEntries={initialEntries}>
              <TrashView />
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

  test('clicking the Size column header reorders the rows (folders stay first) (#7)', async () => {
    const listing: NodeDto[] = [
      { id: 1, parent_id: 9, kind: 'file', name: 'big.bin', size_bytes: 900, mime_type: null, auto_delete_at: null, created_at: 0, updated_at: 100 },
      { id: 2, parent_id: 9, kind: 'file', name: 'small.txt', size_bytes: 10, mime_type: null, auto_delete_at: null, created_at: 0, updated_at: 200 },
      { id: 3, parent_id: 9, kind: 'folder', name: 'Docs', size_bytes: 0, mime_type: null, auto_delete_at: null, created_at: 0, updated_at: 300 },
    ];
    stubFetch({ '/api/nodes': listing, '/api/shares': [] });
    renderDrive(['/']);

    // Scope to the register table — the mobile card list (mounted alongside
    // the table in jsdom, hidden only via CSS) repeats the same node names,
    // so an unscoped query would match twice.
    const table = await screen.findByRole('table');
    await within(table).findByText('big.bin');
    const sizeHeaderBtn = within(table).getByRole('button', { name: /الحجم/ });
    await act(async () => {
      fireEvent.click(sizeHeaderBtn); // size asc
    });

    const nameCells = within(table).getAllByText(/big\.bin|small\.txt|Docs/).map((el) => el.textContent);
    // Folder first, then files ascending by size: Docs, small.txt, big.bin
    expect(nameCells).toEqual(['Docs', 'small.txt', 'big.bin']);
  });

  test('selecting rows shows a bulk bar; confirming bulk-trashes each selected id (#8)', async () => {
    const listing: NodeDto[] = [
      { id: 1, parent_id: 9, kind: 'file', name: 'a.txt', size_bytes: 5, mime_type: null, auto_delete_at: null, created_at: 0, updated_at: 100 },
      { id: 2, parent_id: 9, kind: 'file', name: 'b.txt', size_bytes: 6, mime_type: null, auto_delete_at: null, created_at: 0, updated_at: 200 },
    ];
    const trashed: number[] = [];
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url).split('?')[0];
      const method = (init?.method ?? 'GET').toUpperCase();
      if (path === '/api/nodes' && method === 'GET') return jsonResponse(200, listing);
      if (path === '/api/shares') return jsonResponse(200, []);
      const m = path.match(/^\/api\/nodes\/(\d+)\/trash$/);
      if (m && method === 'POST') { trashed.push(Number(m[1])); return jsonResponse(200, {}); }
      return jsonResponse(200, {});
    });
    vi.stubGlobal('fetch', fetchMock);

    renderDrive(['/']);
    // Scope the initial wait to the table — jsdom mounts both the desktop
    // table and the (CSS-hidden) mobile card list, which repeats the same
    // node name, so an unscoped `findByText` would match twice.
    await screen.findByRole('table');

    // Select both rows via their per-row checkboxes.
    const cbs = screen.getAllByRole('checkbox', { name: 'تحديد الصف' });
    await act(async () => {
      fireEvent.click(cbs[0]);
      fireEvent.click(cbs[1]);
    });

    // Bulk bar appears with the count; confirm.
    const bulkBtn = await screen.findByRole('button', { name: /نقل إلى المهملات \(2\)/ });
    await act(async () => {
      fireEvent.click(bulkBtn);
    });
    // Scope to the confirm dialog — its submit button shares the same label
    // ("نقل") as each row's per-node "move" action button, so an unscoped
    // query would match those too.
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'نقل' });
    await act(async () => {
      fireEvent.click(confirm);
    });

    expect(trashed.sort()).toEqual([1, 2]);
  });

  test('the select-all checkbox toggles every row in the current folder (#8)', async () => {
    const listing: NodeDto[] = [
      { id: 1, parent_id: 9, kind: 'file', name: 'a.txt', size_bytes: 5, mime_type: null, auto_delete_at: null, created_at: 0, updated_at: 100 },
      { id: 2, parent_id: 9, kind: 'folder', name: 'Docs', size_bytes: 0, mime_type: null, auto_delete_at: null, created_at: 0, updated_at: 200 },
    ];
    stubFetch({ '/api/nodes': listing, '/api/shares': [] });
    renderDrive(['/']);
    await screen.findByRole('table');

    const selectAll = screen.getByRole('checkbox', { name: 'تحديد الكل' });
    await act(async () => {
      fireEvent.click(selectAll);
    });
    // Bulk bar reflects both rows selected.
    await screen.findByRole('button', { name: /نقل إلى المهملات \(2\)/ });
  });
});

describe('sortNodes — folders first, then by key/direction (#7)', () => {
  const mk = (id: number, kind: 'folder' | 'file', name: string, size: number, updated: number): NodeDto => ({
    id, parent_id: 1, kind, name, size_bytes: size, mime_type: null, auto_delete_at: null, created_at: 0, updated_at: updated,
  });
  const nodes: NodeDto[] = [
    mk(1, 'file', 'banana', 30, 100),
    mk(2, 'folder', 'Zebra', 0, 300),
    mk(3, 'file', 'apple', 10, 200),
    mk(4, 'folder', 'alpha', 0, 50),
  ];

  const names = (s: SortState) => sortNodes(nodes, s).map((n) => n.name);

  test('name asc: folders (by name) before files (by name)', () => {
    expect(names({ key: 'name', dir: 'asc' })).toEqual(['alpha', 'Zebra', 'apple', 'banana']);
  });
  test('name desc reverses within each group but keeps folders first', () => {
    expect(names({ key: 'name', dir: 'desc' })).toEqual(['Zebra', 'alpha', 'banana', 'apple']);
  });
  test('size asc sorts files by size_bytes (folders still first)', () => {
    expect(names({ key: 'size', dir: 'asc' }).slice(2)).toEqual(['apple', 'banana']); // 10 < 30
  });
  test('date desc sorts by updated_at newest-first within group', () => {
    expect(names({ key: 'date', dir: 'desc' }).slice(2)).toEqual(['apple', 'banana']); // 200 > 100
  });
  test('returns a new array (does not mutate input order)', () => {
    const before = nodes.map((n) => n.id);
    sortNodes(nodes, { key: 'size', dir: 'desc' });
    expect(nodes.map((n) => n.id)).toEqual(before);
  });
});

describe('TrashView — mobile card list (§M2b two-layout pattern)', () => {
  test('the mobile card list renders the same trashed node alongside the desktop table', async () => {
    const trashed: NodeDto[] = [
      {
        id: 9,
        parent_id: null,
        kind: 'file',
        name: 'مسودة.docx',
        size_bytes: 1024,
        mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        auto_delete_at: null,
        created_at: NOW,
        updated_at: NOW,
      },
    ];
    stubFetch({ '/api/nodes/trash': trashed, '/api/auth/me': USER });

    renderTrash(['/trash']);

    // jsdom has no viewport, so both layouts mount; the `md:hidden` card list
    // is present in the DOM with a stable per-node testid and shows the same
    // name as the (CSS-hidden) desktop row.
    const card = await screen.findByTestId('trash-card-9');
    expect(within(card).getByText('مسودة.docx')).toBeInTheDocument();
  });
});

describe('TrashView — empty whole trash (#6)', () => {
  test('shows an empty-trash button only when the trash is non-empty, and calls the endpoint on confirm', async () => {
    const trashed: NodeDto[] = [
      { id: 10, parent_id: 2, kind: 'file', name: 'old.txt', size_bytes: 5, mime_type: 'text/plain', auto_delete_at: null, created_at: NOW, updated_at: NOW },
    ];
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url).split('?')[0];
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push(`${method} ${path}`);
      if (path === '/api/nodes/trash' && method === 'GET') return jsonResponse(200, trashed);
      if (path === '/api/nodes/trash/empty' && method === 'POST') return jsonResponse(200, { freedBytes: 5 });
      return jsonResponse(200, {});
    });
    vi.stubGlobal('fetch', fetchMock);

    renderTrash(['/trash']);
    const emptyBtn = await screen.findByRole('button', { name: 'إفراغ سلة المهملات' });

    fireEvent.click(emptyBtn);
    // Destructive confirm modal → the confirm button carries the "إفراغ" label.
    const confirm = await screen.findByRole('button', { name: 'إفراغ' });
    await act(async () => {
      fireEvent.click(confirm);
    });

    expect(calls).toContain('POST /api/nodes/trash/empty');
  });

  test('hides the empty-trash button when the trash is empty', async () => {
    stubFetch({ '/api/nodes/trash': [] });
    renderTrash(['/trash']);
    // The empty-state copy renders…
    await screen.findByText('المهملات فارغة.');
    // …and no empty-trash button is present.
    expect(screen.queryByRole('button', { name: 'إفراغ سلة المهملات' })).toBeNull();
  });
});

describe('DashboardShell — primary app nav (§M4)', () => {
  test('renders the shared app-nav as links to My Files / Shared / Trash (below md a scrollable pill strip)', async () => {
    stubFetch({ '/api/nodes': [], '/api/nodes/trash': [], '/api/auth/me': USER });
    renderDrive(['/']);

    const nav = await screen.findByRole('navigation', { name: i18n.t('dashboard.nav.label') });
    expect(within(nav).getByRole('link', { name: i18n.t('dashboard.nav.myFiles') })).toHaveAttribute('href', '/');
    expect(within(nav).getByRole('link', { name: i18n.t('dashboard.nav.shared') })).toHaveAttribute('href', '/shared');
    expect(within(nav).getByRole('link', { name: i18n.t('dashboard.nav.trash') })).toHaveAttribute('href', '/trash');
    // A non-admin never sees the Admin pill.
    expect(within(nav).queryByRole('link', { name: i18n.t('dashboard.nav.admin') })).toBeNull();
  });
});
