import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '../src/i18n';
import SealedDispatch from '../src/features/public/SealedDispatch';
import { formatExpiry } from '../src/features/public/format';

const TOKEN = 'tok-123';

function jsonResponse(
  status: number,
  body?: unknown,
  headers?: Record<string, string>
): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
  });
}

const liveFile = {
  token: TOKEN,
  kind: 'file' as const,
  name: 'report.pdf',
  size_bytes: 2048,
  isFolder: false,
  allow_download: true,
  download_limit: null as number | null,
  download_count: 0,
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[`/s/${TOKEN}`]}>
          <Routes>
            <Route path="/s/:token" element={<SealedDispatch />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>
  );
}

function setNavigatorLanguage(lang: string): void {
  Object.defineProperty(window.navigator, 'language', { value: lang, configurable: true });
}

/** Strips the invisible bidi isolate characters (U+2066…U+2069) so a copy assertion sees the visible text. */
const ISOLATE_CHARS = new RegExp('[' + String.fromCharCode(0x2066, 0x2067, 0x2068, 0x2069) + ']', 'g');
function stripIsolates(text: string): string {
  return text.replace(ISOLATE_CHARS, '');
}

beforeEach(() => {
  setNavigatorLanguage('ar-SY');
  document.documentElement.dir = 'rtl';
  document.documentElement.lang = 'ar';
});

afterEach(() => {
  vi.unstubAllGlobals();
  void i18n.changeLanguage('ar');
  document.documentElement.dir = 'rtl';
  document.documentElement.lang = 'ar';
});

describe('SealedDispatch — public share page', () => {
  test('EN toggle flips the document to LTR and renders EN copy; toggling back restores RTL', async () => {
    // Browser prefers Arabic -> seeds AR/RTL.
    setNavigatorLanguage('ar-SY');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, liveFile))
    );

    renderPage();

    // Arabic first: the §4.9 AR framing renders and the document is RTL.
    expect(await screen.findByText('وصلك ملف عبر مِرسال')).toBeInTheDocument();
    expect(document.documentElement.getAttribute('dir')).toBe('rtl');

    // Toggle to English -> document flips to LTR and EN §4.9 copy renders.
    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    expect(await screen.findByText('A file was sent to you via Mirsal')).toBeInTheDocument();
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
    expect(document.documentElement.getAttribute('lang')).toBe('en');

    // Toggle back to Arabic -> RTL restored.
    fireEvent.click(screen.getByRole('button', { name: 'العربية' }));
    expect(await screen.findByText('وصلك ملف عبر مِرسال')).toBeInTheDocument();
    expect(document.documentElement.getAttribute('dir')).toBe('rtl');
  });

  test('410 stopped and 410 expired render their DISTINCT §4.9 copy', async () => {
    setNavigatorLanguage('en-US');

    // --- stopped ---
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(410, { error: 'gone', reason: 'stopped', expires_at: null }))
    );
    const stopped = renderPage();
    await screen.findByText('The sender turned this link off.');
    const stoppedText = stripIsolates(screen.getByRole('status').textContent ?? '');
    expect(stoppedText).toBe('The sender turned this link off.');
    stopped.unmount();
    vi.unstubAllGlobals();

    // --- expired (with a real Damascus date) ---
    const expiresAt = Date.UTC(2026, 0, 5, 12, 0, 0);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(410, { error: 'gone', reason: 'expired', expires_at: expiresAt }))
    );
    renderPage();
    await screen.findByRole('status');
    const expiredText = stripIsolates(screen.getByRole('status').textContent ?? '');
    const expectedDate = formatExpiry(expiresAt, 'en'); // "January 5, 2026"
    expect(expiredText).toBe(`This link expired on ${expectedDate}.`);

    // The two end-states must not collapse to the same message.
    expect(expiredText).not.toBe(stoppedText);
  });

  test('on a live file, Download is the visually PRIMARY action (brass fill + brass-ink)', async () => {
    setNavigatorLanguage('en-US');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, liveFile))
    );

    const { container } = renderPage();
    await screen.findByText('A file was sent to you via Mirsal');

    // Download is now a POST-form submit button (a passive GET can't burn a capped
    // share) — but it still wears the exact §4.1 primary recipe.
    const download = container.querySelector('button[data-variant="primary"]') as HTMLButtonElement | null;
    expect(download).not.toBeNull();
    expect(download).toHaveAttribute('type', 'submit');
    // The submit posts to the counted download endpoint; the unlock cookie rides along.
    const form = download!.closest('form');
    expect(form).toHaveAttribute('method', 'post');
    expect(form).toHaveAttribute('action', `/api/public/${TOKEN}/download`);
    // §4.1 contrast contract: brass FILL + --brass-ink label (never white-on-brass / brass-as-text).
    expect(download!.className).toContain('bg-brass');
    expect(download!.className).toContain('text-brass-ink');
    expect(download!.textContent).toContain('Download');
    // No bare GET download anchor remains on a file share.
    expect(container.querySelector('a[data-variant="primary"]')).toBeNull();
  });

  test('password gate: pre-unlock reveals no name/size; a wrong password shows attempts-remaining from the header, then a correct one unlocks and re-fetches', async () => {
    setNavigatorLanguage('en-US');

    let unlocked = false;
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/unlock')) {
        const body = JSON.parse((init?.body as string) ?? '{}') as { password?: string };
        if (body.password === 'right') {
          unlocked = true;
          return jsonResponse(200, { ok: true });
        }
        return jsonResponse(401, { error: 'invalid_password' }, { 'x-ratelimit-remaining': '3' });
      }
      // metadata endpoint: locked until the unlock cookie exists (simulated by `unlocked`)
      if (unlocked) {
        return jsonResponse(200, { ...liveFile, name: 'secret.txt' });
      }
      return jsonResponse(401, { needsPassword: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    // Pre-unlock: only the password gate + branding; NO file metadata leaks.
    expect(await screen.findByText('This file is password-protected.')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.queryByText('A file was sent to you via Mirsal')).not.toBeInTheDocument();
    expect(screen.queryByText('secret.txt')).not.toBeInTheDocument();

    // Wrong password -> §4.9 attempts-remaining copy from the x-ratelimit-remaining header.
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByText('Incorrect password. 3 attempts left.')).toBeInTheDocument();

    // Correct password -> unlock 200 -> metadata re-fetch now reveals the live file.
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'right' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByText('A file was sent to you via Mirsal')).toBeInTheDocument();
    expect(screen.getByText('secret.txt')).toBeInTheDocument();
  });

  test('a limited file shows a live "N of M remaining" counter; an unlimited one shows none', async () => {
    setNavigatorLanguage('en-US');

    // limit 1, 0 used → 1 remaining.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { ...liveFile, download_limit: 1, download_count: 0 }))
    );
    const a = renderPage();
    expect(await screen.findByText('1 of 1 downloads remaining')).toBeInTheDocument();
    a.unmount();
    vi.unstubAllGlobals();

    // limit 3, 1 used → 2 remaining.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { ...liveFile, download_limit: 3, download_count: 1 }))
    );
    const b = renderPage();
    expect(await screen.findByText('2 of 3 downloads remaining')).toBeInTheDocument();
    b.unmount();
    vi.unstubAllGlobals();

    // unlimited → no counter at all.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { ...liveFile, download_limit: null, download_count: 0 }))
    );
    renderPage();
    await screen.findByText('A file was sent to you via Mirsal');
    expect(screen.queryByText(/downloads remaining/)).not.toBeInTheDocument();
  });

  test('a folder share shows the name + Download-all-as-ZIP and NO file listing (#10)', async () => {
    setNavigatorLanguage('en-US');
    const liveFolder = {
      token: TOKEN,
      kind: 'folder' as const,
      name: 'Reports',
      size_bytes: 4096,
      isFolder: true,
      allow_download: true,
      download_limit: null as number | null,
      download_count: 0,
    };
    const fetchMock = vi.fn(async () => jsonResponse(200, liveFolder));
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderPage();
    await screen.findByText('A folder was sent to you via Mirsal');

    // The folder name is shown and ZIP is the only content action.
    expect(screen.getByText('Reports')).toBeInTheDocument();
    expect(container.querySelector(`a[href="/api/public/${TOKEN}/zip"]`)).not.toBeNull();

    // No /list request is ever made — contents stay hidden.
    const listCalled = fetchMock.mock.calls.some((c) => String(c[0]).includes('/list'));
    expect(listCalled).toBe(false);
  });

  test('the download control POSTs to the counted /download endpoint (passive GETs cannot burn the cap)', async () => {
    setNavigatorLanguage('en-US');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { ...liveFile, download_limit: 1 }))
    );

    const { container } = renderPage();
    await screen.findByText('A file was sent to you via Mirsal');

    // The control is a POST <form> pointed at the counted download endpoint —
    // a bare GET (unfurler / scanner / prefetch) must not be able to trigger it.
    const form = container.querySelector('form') as HTMLFormElement | null;
    expect(form).not.toBeNull();
    expect(form!.getAttribute('method')).toBe('post');
    expect(form!.getAttribute('action')).toBe(`/api/public/${TOKEN}/download`);
    // The submit lives inside that form; no GET download anchor remains.
    const submit = form!.querySelector('button[type="submit"]') as HTMLButtonElement | null;
    expect(submit).not.toBeNull();
    expect(submit!.textContent).toContain('Download');
    expect(container.querySelector('a[data-variant="primary"]')).toBeNull();
  });
});
