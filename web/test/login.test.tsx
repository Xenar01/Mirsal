import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import i18n from '../src/i18n';
import { AuthProvider } from '../src/features/auth/auth-context';
import LoginPage from '../src/features/auth/LoginPage';

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Mocks fetch: 200+{user} for the login POST, 401 for the mount /me probe. */
function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).endsWith('/auth/login')) {
      return jsonResponse(200, {
        user: { id: 1, username: 'admin', role: 'admin', mustChangePassword: false },
      });
    }
    return jsonResponse(401);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function renderLogin(fetchMock: ReturnType<typeof vi.fn>) {
  render(
    <I18nextProvider i18n={i18n}>
      <AuthProvider>
        <MemoryRouter initialEntries={['/login']}>
          <LoginPage />
        </MemoryRouter>
      </AuthProvider>
    </I18nextProvider>,
  );
  // Flush the AuthProvider's mount `/api/auth/me` probe, then forget it so the
  // assertions below only see login-triggered fetches.
  await act(async () => {});
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(String(fetchMock.mock.calls[0][0])).toBe('/api/auth/me');
  fetchMock.mockClear();
}

beforeEach(() => {
  document.cookie = 'mirsal_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LoginPage — client-side validation', () => {
  test('submitting with empty fields shows an inline error and does NOT call the network', async () => {
    const fetchMock = stubFetch();
    await renderLogin(fetchMock);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: i18n.t('login.submit') }));
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(i18n.t('login.validation.required'));
  });

  test('a valid submit POSTs /api/auth/login with {username,password}', async () => {
    const fetchMock = stubFetch();
    await renderLogin(fetchMock);

    fireEvent.change(screen.getByLabelText(i18n.t('login.username')), {
      target: { value: 'admin' },
    });
    fireEvent.change(screen.getByLabelText(i18n.t('login.password')), {
      target: { value: 'secret-pw-12' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: i18n.t('login.submit') }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/auth/login');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ username: 'admin', password: 'secret-pw-12' });
  });

  test('a 403 account_deactivated response shows the deactivated message', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith('/auth/login')) {
        return jsonResponse(403, { error: 'account_deactivated' });
      }
      return jsonResponse(401);
    });
    vi.stubGlobal('fetch', fetchMock);
    await renderLogin(fetchMock);

    fireEvent.change(screen.getByLabelText(i18n.t('login.username')), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText(i18n.t('login.password')), { target: { value: 'y' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: i18n.t('login.submit') }));
    });

    expect(screen.getByRole('alert')).toHaveTextContent(i18n.t('login.error.deactivated'));
  });
});
