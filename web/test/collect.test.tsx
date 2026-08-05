import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '../src/i18n';
import CollectPage from '../src/features/collect/CollectPage';

const TOKEN = 'tok-c1';

function jsonResponse(status: number, body?: unknown, headers?: Record<string, string>): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
  });
}

const openMetaBody = {
  isOpen: true,
  needsPassword: false,
  title: 'مسح الاحتياجات',
  hasTemplate: false,
  templateName: null as string | null,
  departments: [
    { id: 1, name: 'المالية' },
    { id: 2, name: 'الموارد' },
  ],
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[`/c/${TOKEN}`]}>
          <Routes>
            <Route path="/c/:token" element={<CollectPage />} />
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

describe('CollectPage — public collect-intake page', () => {
  test('open: renders title, department select, file input; AR default then EN toggle flips dir + copy', async () => {
    setNavigatorLanguage('ar-SY');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, openMetaBody)));

    const { container } = renderPage();

    // AR default: title, department select (placeholder + both options), file input.
    expect(await screen.findByText('مسح الاحتياجات')).toBeInTheDocument();
    expect(document.documentElement.getAttribute('dir')).toBe('rtl');
    const deptSelectAr = screen.getByLabelText('القسم') as HTMLSelectElement;
    expect(within(deptSelectAr).getByText('اختر قسمك')).toBeInTheDocument();
    expect(within(deptSelectAr).getByText('المالية')).toBeInTheDocument();
    expect(within(deptSelectAr).getByText('الموارد')).toBeInTheDocument();
    expect(container.querySelector('input[type="file"][multiple]')).not.toBeNull();

    // Toggle to English -> document flips to LTR and EN copy renders.
    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    expect(await screen.findByLabelText('Department')).toBeInTheDocument();
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
    expect(document.documentElement.getAttribute('lang')).toBe('en');
    const deptSelectEn = screen.getByLabelText('Department') as HTMLSelectElement;
    expect(within(deptSelectEn).getByText('Choose your department')).toBeInTheDocument();

    // Toggle back to Arabic -> RTL restored.
    fireEvent.click(screen.getByRole('button', { name: 'العربية' }));
    expect(await screen.findByLabelText('القسم')).toBeInTheDocument();
    expect(document.documentElement.getAttribute('dir')).toBe('rtl');
  });

  test('closed meta → neutral closed copy (AR + EN)', async () => {
    setNavigatorLanguage('ar-SY');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { isOpen: false })));

    renderPage();
    await screen.findByText('هذا الطلب مغلق حاليًا.');
    const arText = stripIsolates(screen.getByRole('status').textContent ?? '');
    expect(arText).toBe('هذا الطلب مغلق حاليًا.');

    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    await screen.findByText('This request is currently closed.');
    const enText = stripIsolates(screen.getByRole('status').textContent ?? '');
    expect(enText).toBe('This request is currently closed.');
  });

  test('notFound (404) → not-found copy', async () => {
    setNavigatorLanguage('en-US');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(404, { error: 'not_found' })));

    renderPage();
    await screen.findByText("This link doesn't exist.");
    const text = stripIsolates(screen.getByRole('status').textContent ?? '');
    expect(text).toBe("This link doesn't exist.");
  });

  test('password state → gate; unlock success re-fetches and shows the form', async () => {
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
        return jsonResponse(401, { error: 'invalid_password' }, { 'x-ratelimit-remaining': '2' });
      }
      if (unlocked) {
        return jsonResponse(200, openMetaBody);
      }
      return jsonResponse(200, { isOpen: true, needsPassword: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    // Pre-unlock: only the gate + branding; no title/department leaks.
    expect(await screen.findByText('This request is password-protected.')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.queryByText('مسح الاحتياجات')).not.toBeInTheDocument();

    // Wrong password -> attempts-remaining copy from the header.
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByText('Incorrect password. 2 attempts left.')).toBeInTheDocument();

    // Correct password -> unlock 200 -> metadata re-fetch reveals the form.
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'right' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByText('مسح الاحتياجات')).toBeInTheDocument();
    expect(screen.getByLabelText('Department')).toBeInTheDocument();

    // The FIRST meta fetch omitted credentials — the mechanism that forces the re-prompt.
    const firstMeta = fetchMock.mock.calls.find((c) => !String(c[0]).includes('/unlock'))!;
    expect((firstMeta[1] as RequestInit).credentials).toBe('omit');
  });

  test('submitting files issues a multipart POST and shows the confirmation', async () => {
    setNavigatorLanguage('ar-SY');
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes('/submit')) return jsonResponse(200, { ok: true });
      return jsonResponse(200, openMetaBody);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderPage();
    await screen.findByText('مسح الاحتياجات');

    fireEvent.change(screen.getByLabelText('القسم'), { target: { value: '2' } });
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['hello'], 'report.pdf', { type: 'application/pdf' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    fireEvent.click(screen.getByRole('button', { name: 'إرسال الرد' }));

    expect(await screen.findByText('تم استلام ردّك. شكرًا لك.')).toBeInTheDocument();

    const submitCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/submit'))!;
    expect(submitCall).toBeTruthy();
    const [url, init] = submitCall as [RequestInfo | URL, RequestInit];
    expect(String(url)).toBe(`/api/collect/${TOKEN}/submit`);
    expect(init.method).toBe('POST');
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('departmentId')).toBe('2');
    expect(form.getAll('files')).toEqual([file]);

    // "Send another" resets back to a fresh, empty form.
    fireEvent.click(screen.getByRole('button', { name: 'إرسال رد آخر' }));
    expect(await screen.findByLabelText('القسم')).toHaveValue('');
  });

  test('client guards: >10 files and a >100MB file are rejected before any request', async () => {
    setNavigatorLanguage('en-US');
    const fetchMock = vi.fn(async () => jsonResponse(200, openMetaBody));
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderPage();
    await screen.findByText('مسح الاحتياجات');
    const callsAfterLoad = fetchMock.mock.calls.length;

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

    // >10 files -> rejected, no request fired.
    const many = Array.from({ length: 11 }, (_, i) => new File(['x'], `f${i}.txt`));
    fireEvent.change(fileInput, { target: { files: many } });
    expect(await screen.findByText('At most 10 files.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.length).toBe(callsAfterLoad);

    // A single file over 100MB -> rejected, no request fired.
    const bigFile = new File(['x'], 'huge.zip', { type: 'application/zip' });
    Object.defineProperty(bigFile, 'size', { value: 200 * 1024 * 1024 });
    fireEvent.change(fileInput, { target: { files: [bigFile] } });
    expect(await screen.findByText('100 MB max per file: huge.zip.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.length).toBe(callsAfterLoad);
  });

  test('submit with the department left at the placeholder → collect.departmentRequired renders and no POST fires', async () => {
    setNavigatorLanguage('ar-SY');
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes('/submit')) return jsonResponse(200, { ok: true });
      return jsonResponse(200, openMetaBody);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderPage();
    await screen.findByText('مسح الاحتياجات');

    // A valid file is attached, but the department select is left at its
    // empty placeholder — the JS guard (not native constraint validation)
    // must be what stops the submit.
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['hello'], 'report.pdf', { type: 'application/pdf' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    const callsBeforeSubmit = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'إرسال الرد' }));

    expect(await screen.findByText('اختر القسم.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.length).toBe(callsBeforeSubmit);
  });

  test('submit with zero files chosen → collect.filesRequired renders and no POST fires', async () => {
    setNavigatorLanguage('ar-SY');
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes('/submit')) return jsonResponse(200, { ok: true });
      return jsonResponse(200, openMetaBody);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('مسح الاحتياجات');

    fireEvent.change(screen.getByLabelText('القسم'), { target: { value: '1' } });

    const callsBeforeSubmit = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'إرسال الرد' }));

    expect(await screen.findByText('أرفق ملفًا واحدًا على الأقل.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.length).toBe(callsBeforeSubmit);
  });
});
