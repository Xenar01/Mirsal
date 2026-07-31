import { describe, test, expect, vi, afterEach } from 'vitest';
import { render, screen, act, waitFor, renderHook } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
} from '@tanstack/react-query';
import type { ReactNode } from 'react';
import i18n from '../src/i18n';
import { AuthProvider } from '../src/features/auth/auth-context';
import StorageMeter from '../src/features/dashboard/StorageMeter';
import { useDeleteNode } from '../src/features/dashboard/queries';

// The trash portion of the meter is irrelevant to this behaviour — stub the
// dashboard queries so the only network the meter itself drives is GET /me.
vi.mock('../src/features/dashboard/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/features/dashboard/queries')>();
  return { ...actual, useTrash: () => ({ data: [] }), sumSizes: () => 0 };
});

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ME = (usedBytes: number) => ({
  id: 1,
  username: 'u',
  role: 'user',
  mustChangePassword: false,
  rootNodeId: 2,
  quotaBytes: 1000,
  usedBytes,
});

/**
 * A QueryClient configured EXACTLY like production (`web/src/main.tsx`):
 * refetch-on-focus OFF globally. The meter's own query must opt back in, so a
 * test built on this client proves the per-query override — not a relaxed test
 * default — is what makes the tab-focus refresh work.
 */
function prodLikeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  // Hand focus tracking back to the default (event-based) manager.
  focusManager.setFocused(undefined);
});

describe('StorageMeter — refreshes when the browser tab regains focus', () => {
  test('re-pulls /auth/me on window focus and shows the new used total', async () => {
    let used = 250;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) => {
        if (String(url).split('?')[0].endsWith('/auth/me')) return jsonResponse(200, ME(used));
        throw new Error(`unexpected fetch: ${String(url)}`);
      })
    );

    const client = prodLikeClient();
    render(
      <QueryClientProvider client={client}>
        <AuthProvider>
          <I18nextProvider i18n={i18n}>
            <StorageMeter />
          </I18nextProvider>
        </AuthProvider>
      </QueryClientProvider>
    );

    // Initial load: 250 / 1000 = 25%.
    await waitFor(() =>
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25')
    );

    // A file is uploaded from another tab → the server's used_bytes grows.
    // Switching back to this tab must refresh the meter (the reported bug: it
    // stayed frozen until a full browser reload).
    used = 500;
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });

    await waitFor(() =>
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50')
    );
  });
});

describe('dashboard mutations — keep the storage meter coherent', () => {
  test('deleting a node invalidates the /me query so the meter re-reads used_bytes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { freedBytes: 10 })));

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useDeleteNode(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(5);
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['auth', 'me'] });
  });
});
