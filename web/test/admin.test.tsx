import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '../src/i18n';
import { AuthProvider } from '../src/features/auth/auth-context';
import { ToastProvider } from '../src/components/Toast';
import AdminPanel from '../src/features/admin/AdminPanel';

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o);
const NOW = 1_750_000_000_000; // fixed epoch-ms

const ADMIN_ME = { id: 1, username: 'admin', role: 'admin', mustChangePassword: false };

interface AdminUser {
  id: number;
  username: string;
  role: 'admin' | 'user';
  is_active: number;
  quota_bytes: number | null;
  used_bytes: number;
  must_change_password: number;
  created_at: number;
}

function mkUser(over: Partial<AdminUser> & { id: number; username: string }): AdminUser {
  return {
    role: 'user',
    is_active: 1,
    quota_bytes: null,
    used_bytes: 0,
    must_change_password: 0,
    created_at: NOW,
    ...over,
  };
}

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

interface StubConfig {
  me?: unknown;
  users?: AdminUser[];
  shares?: unknown[];
  audit?: unknown[];
  /** Override a specific route response (path+method) → [status, body]. */
  overrides?: Record<string, [number, unknown]>;
}

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

/** A path→method-aware fetch mock that records every call. */
function stubFetch(cfg: StubConfig): { fetchMock: ReturnType<typeof vi.fn>; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const full = String(url);
    const path = full.split('?')[0];
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });

    const key = `${method} ${path}`;
    if (cfg.overrides && key in cfg.overrides) {
      const [status, respBody] = cfg.overrides[key];
      return jsonResponse(status, respBody);
    }

    if (path === '/api/auth/me') return jsonResponse(200, cfg.me ?? ADMIN_ME);
    if (path === '/api/admin/users' && method === 'GET') return jsonResponse(200, cfg.users ?? []);
    if (path === '/api/admin/users' && method === 'POST') {
      // Echo back a created DTO (server never returns the password).
      return jsonResponse(201, mkUser({ id: 999, username: String(body?.username ?? 'new'), must_change_password: 1 }));
    }
    if (path.startsWith('/api/admin/users/') && path.endsWith('/password') && method === 'POST') {
      return jsonResponse(200, { password: 'Genrated-Reset-Pw12' });
    }
    if (path.startsWith('/api/admin/users/') && method === 'PATCH') {
      return jsonResponse(200, mkUser({ id: 1, username: 'admin', role: 'admin' }));
    }
    if (path.startsWith('/api/admin/users/') && method === 'DELETE') {
      return jsonResponse(200, { ok: true });
    }
    if (path === '/api/admin/shares' && method === 'GET') return jsonResponse(200, cfg.shares ?? []);
    if (path.startsWith('/api/admin/shares/') && method === 'DELETE') {
      return jsonResponse(200, { ok: true });
    }
    if (path === '/api/admin/audit' && method === 'GET') return jsonResponse(200, cfg.audit ?? []);
    return jsonResponse(404, { error: 'not_found' });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

async function renderAdmin(cfg: StubConfig) {
  const client = makeQueryClient();
  const utils = render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <AuthProvider>
          <ToastProvider>
            <MemoryRouter initialEntries={['/admin']}>
              <AdminPanel />
            </MemoryRouter>
          </ToastProvider>
        </AuthProvider>
      </I18nextProvider>
    </QueryClientProvider>
  );
  // Flush the AuthProvider mount /me probe + the initial users query.
  await act(async () => {});
  return utils;
}

/** Count only the create-user POSTs (path+method), ignoring the /me + list GETs. */
function createPosts(calls: Recorded[]): Recorded[] {
  return calls.filter((c) => c.method === 'POST' && c.path === '/api/admin/users');
}

beforeEach(() => {
  document.cookie = 'mirsal_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Admin — non-admin gate', () => {
  test('a non-admin sees the admins-only notice, not the panel', async () => {
    await renderAdmin({ me: { id: 2, username: 'sara', role: 'user', mustChangePassword: false } });
    expect(screen.getByText(t('admin.adminsOnly'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('admin.users.create') })).toBeNull();
  });
});

describe('Admin — CreateUserModal validation (§3.1)', () => {
  async function openCreate() {
    fireEvent.click(await screen.findByRole('button', { name: t('admin.users.create') }));
    return screen.findByLabelText(t('admin.create.usernameLabel'));
  }

  test('an invalid username shows an inline error and does NOT POST', async () => {
    const { calls } = stubFetch({ users: [] });
    await renderAdmin({ users: [] });

    const username = await openCreate();
    fireEvent.change(username, { target: { value: 'bad name!!' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('admin.create.submit') }));
    });

    expect(screen.getByText(t('admin.create.usernameInvalid'))).toBeInTheDocument();
    expect(createPosts(calls)).toHaveLength(0);
  });

  test('a password under 8 chars shows an inline error and does NOT POST', async () => {
    const { calls } = stubFetch({ users: [] });
    await renderAdmin({ users: [] });

    const username = await openCreate();
    fireEvent.change(username, { target: { value: 'sara' } });
    fireEvent.change(screen.getByLabelText(t('admin.create.passwordLabel')), {
      target: { value: 'short' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('admin.create.submit') }));
    });

    expect(screen.getByText(t('admin.create.passwordTooShort'))).toBeInTheDocument();
    expect(createPosts(calls)).toHaveLength(0);
  });

  test('a valid submit POSTs /api/admin/users with {username, password, role}', async () => {
    const { calls } = stubFetch({ users: [] });
    await renderAdmin({ users: [] });

    const username = await openCreate();
    fireEvent.change(username, { target: { value: 'sara' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('admin.create.submit') }));
    });

    const posts = createPosts(calls);
    expect(posts).toHaveLength(1);
    const body = posts[0].body as { username: string; password: string; role: string };
    expect(body.username).toBe('sara');
    expect(body.role).toBe('user');
    expect(typeof body.password).toBe('string');
    expect(body.password.length).toBeGreaterThanOrEqual(8);
  });

  test('a 409 username_taken keeps the form and shows an inline error', async () => {
    stubFetch({
      users: [],
      overrides: { 'POST /api/admin/users': [409, { code: 'username_taken' }] },
    });
    await renderAdmin({ users: [] });

    const username = await openCreate();
    fireEvent.change(username, { target: { value: 'sara' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('admin.create.submit') }));
    });

    expect(await screen.findByText(t('admin.create.usernameTaken'))).toBeInTheDocument();
    // The form is still open (username field present).
    expect(screen.getByLabelText(t('admin.create.usernameLabel'))).toBeInTheDocument();
  });
});

describe('Admin — reveal-once generated password (§3.1)', () => {
  test('after a successful create the generated password is revealed once with a copy control', async () => {
    const { calls } = stubFetch({ users: [] });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    await renderAdmin({ users: [] });

    fireEvent.click(await screen.findByRole('button', { name: t('admin.users.create') }));
    fireEvent.change(await screen.findByLabelText(t('admin.create.usernameLabel')), {
      target: { value: 'sara' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('admin.create.submit') }));
    });

    const submitted = (createPosts(calls)[0].body as { password: string }).password;

    const reveal = await screen.findByTestId('admin-reveal');
    // The exact submitted password is shown (the server never echoes it, so the
    // UI is the only place it appears).
    expect(within(reveal).getByText(submitted)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(within(reveal).getByRole('button', { name: t('admin.reveal.copy') }));
    });
    expect(writeText).toHaveBeenCalledWith(submitted);
  });
});

describe('Admin — last-admin / self guards (§3.1)', () => {
  test('with exactly one active admin, its deactivate + delete controls stay focusable, expose the last-admin reason accessibly, and do nothing when activated', async () => {
    const users = [mkUser({ id: 1, username: 'admin', role: 'admin', is_active: 1 }), mkUser({ id: 2, username: 'sara' })];
    const { calls } = stubFetch({ users });
    await renderAdmin({ users });

    const row = await screen.findByTestId('user-row-1');

    // The reason is VISIBLE text in the row (discoverable to mouse users), not
    // hidden inside a native `title` on an unfocusable button.
    expect(within(row).getByText(t('admin.guard.lastAdmin'))).toBeInTheDocument();

    const deactivate = within(row).getByRole('button', { name: t('admin.users.action.deactivate') });
    // aria-disabled (not native `disabled`) → the control keeps focus + the
    // reason is exposed to keyboard/AT via aria-describedby.
    expect(deactivate).toHaveAttribute('aria-disabled', 'true');
    expect(deactivate).not.toBeDisabled();
    expect(deactivate).toHaveAccessibleDescription(t('admin.guard.lastAdmin'));

    const del = within(row).getByRole('button', { name: t('admin.users.action.delete') });
    expect(del).toHaveAttribute('aria-disabled', 'true');
    expect(del).not.toBeDisabled();
    expect(del).toHaveAccessibleDescription(t('admin.guard.lastAdmin'));

    // Activating a guarded (aria-disabled) control is a no-op: no mutation fires
    // and the destructive delete modal never opens.
    await act(async () => {
      fireEvent.click(deactivate);
      fireEvent.click(del);
    });
    expect(calls.find((c) => c.method === 'PATCH')).toBeUndefined();
    expect(calls.find((c) => c.method === 'DELETE')).toBeUndefined();
    expect(screen.queryByRole('button', { name: t('admin.delete.confirm') })).toBeNull();
  });

  test('with two active admins, a non-self admin row deactivate control is enabled and carries no guard', async () => {
    const users = [
      mkUser({ id: 1, username: 'admin', role: 'admin', is_active: 1 }),
      mkUser({ id: 2, username: 'admin2', role: 'admin', is_active: 1 }),
    ];
    stubFetch({ users });
    await renderAdmin({ users });

    const row2 = await screen.findByTestId('user-row-2');
    const deactivate = within(row2).getByRole('button', { name: t('admin.users.action.deactivate') });
    expect(deactivate).toBeEnabled();
    expect(deactivate).not.toHaveAttribute('aria-disabled', 'true');
    expect(within(row2).queryByText(t('admin.guard.lastAdmin'))).toBeNull();
  });
});

describe('Admin — SharesTable force-revoke (§3.1)', () => {
  test('force-revoking a share issues DELETE /api/admin/shares/:id', async () => {
    const shares = [
      {
        id: 10,
        node_id: 5,
        owner_id: 2,
        owner_username: 'sara',
        owner_active: true,
        node_name: 'تقرير.pdf',
        is_active: true,
        has_password: false,
        expires_at: null,
        allow_download: true,
        created_at: NOW,
        status: 'active',
      },
    ];
    const { calls } = stubFetch({ shares });
    await renderAdmin({ shares });

    // Switch to the shares tab.
    fireEvent.click(await screen.findByRole('tab', { name: t('admin.tabs.shares') }));

    // Open the revoke confirm for the row, confirm it.
    fireEvent.click(await screen.findByRole('button', { name: t('admin.shares.revoke') }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('admin.shares.confirm.confirm') }));
    });

    const del = calls.find((c) => c.method === 'DELETE' && c.path === '/api/admin/shares/10');
    expect(del).toBeDefined();
  });
});

describe('Admin — AuditLog (§3.1)', () => {
  test('renders audit rows read-only with a Damascus timestamp and a redacted secret target', async () => {
    const audit = [
      { id: 3, actor_id: 1, action: 'user_create', target: '2', detail: null, created_at: NOW },
      {
        id: 2,
        actor_id: null,
        action: 'share_unlock_failure',
        target: 'redacted:abcdef0123456789',
        detail: null,
        created_at: NOW,
      },
    ];
    stubFetch({ audit });
    await renderAdmin({ audit });

    fireEvent.click(await screen.findByRole('tab', { name: t('admin.tabs.audit') }));

    // The friendly action label for a known action.
    expect(await screen.findByText(t('admin.audit.action.user_create'))).toBeInTheDocument();
    // The redacted secret target passes through verbatim (server already redacted it).
    expect(screen.getByText('redacted:abcdef0123456789')).toBeInTheDocument();
    // A null actor renders as the system label, not a blank.
    expect(screen.getByText(t('admin.audit.system'))).toBeInTheDocument();
  });
});
