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

    // The Arabic folder name flows in the ambient RTL context — NOT wrapped in
    // an LTR bidi isolate.
    const folderName = await screen.findByText('مستندات');
    expect(folderName.closest('bdi')).toBeNull();

    // Folders carry the subject-grounded dossier icon (§4.7).
    expect(screen.getByTestId('icon-folder')).toBeInTheDocument();

    // The size is monospace ledger data, bidi-isolated LTR so it never
    // scrambles inside the Arabic row (§4.3 / §4.5). Scope to the register
    // table — the storage meter legitimately shows the same total elsewhere.
    const register = screen.getByRole('table');
    const size = within(register).getByText('2 KB');
    expect(size.tagName).toBe('BDI');
    expect(size).toHaveAttribute('dir', 'ltr');
    expect(size.className).toMatch(/font-mono/);
  });

  test('an empty root shows the authored empty-state copy verbatim (§4.9)', async () => {
    stubFetch({ '/api/nodes': [], '/api/nodes/trash': [], '/api/auth/me': USER });

    renderDrive(['/']);

    expect(
      await screen.findByText('لا ملفات بعد. ارفع أول ملف أو أنشئ مجلدًا.')
    ).toBeInTheDocument();
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
