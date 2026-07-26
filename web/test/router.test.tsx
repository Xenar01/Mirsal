import { describe, test, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import i18n from '../src/i18n';
import { AuthProvider } from '../src/features/auth/auth-context';
import AppRoutes from '../src/app/router';

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderApp(initialEntries: string[]) {
  render(
    <I18nextProvider i18n={i18n}>
      <AuthProvider>
        <MemoryRouter initialEntries={initialEntries}>
          <AppRoutes />
        </MemoryRouter>
      </AuthProvider>
    </I18nextProvider>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RequireAuth route guard', () => {
  test('an unauthenticated visit to a protected route (/) redirects to /login', async () => {
    // /api/auth/me → 401 (no session)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(401))
    );

    renderApp(['/']);

    expect(await screen.findByRole('heading', { name: i18n.t('login.title') })).toBeInTheDocument();
  });

  test('a user with mustChangePassword is redirected from / to /change-password', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(200, { id: 1, username: 'admin', role: 'admin', mustChangePassword: true })
      )
    );

    renderApp(['/']);

    expect(
      await screen.findByRole('heading', { name: i18n.t('changePassword.title') })
    ).toBeInTheDocument();
  });

  test('an authenticated user without mustChangePassword sees the dashboard at /', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(200, { id: 1, username: 'admin', role: 'admin', mustChangePassword: false })
      )
    );

    renderApp(['/']);

    expect(
      await screen.findByRole('heading', { name: i18n.t('dashboard.title') })
    ).toBeInTheDocument();
  });
});
