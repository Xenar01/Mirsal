import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '../src/i18n';
import { ToastProvider } from '../src/components/Toast';
import CreateCollectionModal from '../src/features/collections/CreateCollectionModal';
import type { CollectionDetailDto } from '../src/features/collections/types';

/*
 * CreateCollectionModal — create flow (Collections Phase 3 / Task 4).
 *
 * Mirrors test/share.test.tsx's provider stack (QueryClient + I18next +
 * ToastProvider, no router/auth needed — the modal itself doesn't route or
 * read the auth context) and its path+method aware fetch stub. The
 * template-upload test additionally stubs `XMLHttpRequest` because
 * `uploadFile` (reused from ../dashboard/api) posts multipart via XHR, not
 * `fetch`, so it can report upload progress (fetch has no such event).
 */

const NOW = 1_750_000_000_000; // fixed epoch-ms

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A path+method aware fetch stub; records every call for body assertions. */
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

function mkDetail(over: Partial<CollectionDetailDto> = {}): CollectionDetailDto {
  return {
    id: 7,
    token: 'tok7',
    title: 'مسح',
    is_active: true,
    has_password: false,
    has_template: false,
    deadline_at: null,
    created_at: NOW,
    status: 'open',
    department_count: 2,
    responded_count: 0,
    departments: [],
    template: null,
    url: 'https://project4.system.mow.gov.sy/c/tok7',
    ...over,
  };
}

/** A minimal fake XHR that fires a 201 `load` with a JSON body after `send()`. */
class MockXHR {
  static instances: MockXHR[] = [];
  open = vi.fn();
  setRequestHeader = vi.fn();
  withCredentials = false;
  status = 0;
  responseText = '';
  upload = { addEventListener: vi.fn() };
  private listeners: Record<string, Array<() => void>> = {};

  constructor() {
    MockXHR.instances.push(this);
  }

  addEventListener(type: string, cb: () => void) {
    (this.listeners[type] ??= []).push(cb);
  }

  send = vi.fn(() => {
    this.status = 201;
    this.responseText = JSON.stringify({
      id: 42,
      parent_id: null,
      kind: 'file',
      name: 'template.pdf',
      size_bytes: 10,
      mime_type: 'application/pdf',
      auto_delete_at: null,
      created_at: NOW,
      updated_at: NOW,
    });
    queueMicrotask(() => {
      this.listeners['load']?.forEach((cb) => cb());
    });
  });
}

function renderModal(onClose = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <ToastProvider>
          <CreateCollectionModal onClose={onClose} />
        </ToastProvider>
      </I18nextProvider>
    </QueryClientProvider>
  );
  return onClose;
}

function fillTitleAndDepartments(title: string, departments: string) {
  fireEvent.change(screen.getByLabelText(i18n.t('collections.create.titleLabel')), {
    target: { value: title },
  });
  fireEvent.change(screen.getByLabelText(i18n.t('collections.create.departmentsLabel')), {
    target: { value: departments },
  });
}

function submitButton() {
  return screen.getByRole('button', { name: i18n.t('collections.create.submit') });
}

function postCall(fetchMock: ReturnType<typeof vi.fn>): [unknown, RequestInit | undefined] | undefined {
  return fetchMock.mock.calls.find(
    ([url, init]: [RequestInfo | URL, RequestInit?]) =>
      String(url) === '/api/collections' && (init?.method ?? 'GET').toUpperCase() === 'POST'
  ) as [unknown, RequestInit | undefined] | undefined;
}

beforeEach(() => {
  document.cookie = 'mirsal_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
  MockXHR.instances = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CreateCollectionModal — create flow (Collections Phase 3)', () => {
  test('requires a title and at least one department before POSTing', async () => {
    const fetchMock = stubFetch({});
    renderModal();

    fireEvent.click(submitButton());
    expect(
      await screen.findByText(i18n.t('collections.create.titleRequired'))
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(i18n.t('collections.create.titleLabel')), {
      target: { value: 'مسح' },
    });
    fireEvent.click(submitButton());
    expect(
      await screen.findByText(i18n.t('collections.create.departmentsRequired'))
    ).toBeInTheDocument();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('splits the departments textarea into a trimmed, de-duplicated array and POSTs', async () => {
    const fetchMock = stubFetch({ 'POST /api/collections': mkDetail() });
    renderModal();

    fillTitleAndDepartments('مسح', 'المالية\n المالية \n\nالموارد');

    // The live count reflects the trimmed/deduped list before submit.
    expect(
      screen.getByText(i18n.t('collections.create.departmentsCount', { count: 2 }))
    ).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(submitButton());
    });

    const call = postCall(fetchMock);
    expect(call).toBeTruthy();
    const body = JSON.parse((call?.[1]?.body as string) ?? '{}');
    expect(body.departments).toEqual(['المالية', 'الموارد']);
    expect(body.title).toBe('مسح');
  });

  test('when a template file is picked it is uploaded first, then its node id is sent as template_node_id', async () => {
    vi.stubGlobal('XMLHttpRequest', MockXHR as unknown as typeof XMLHttpRequest);
    const fetchMock = stubFetch({ 'POST /api/collections': mkDetail() });
    renderModal();

    fillTitleAndDepartments('مسح', 'المالية');

    const fileInput = screen.getByTestId('collection-template-input') as HTMLInputElement;
    const file = new File(['x'], 'template.pdf', { type: 'application/pdf' });
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [file] } });
    });

    await act(async () => {
      fireEvent.click(submitButton());
    });

    // The template uploaded via XHR before the create POST fired.
    expect(MockXHR.instances).toHaveLength(1);
    expect(MockXHR.instances[0].send).toHaveBeenCalled();

    const call = postCall(fetchMock);
    expect(call).toBeTruthy();
    const body = JSON.parse((call?.[1]?.body as string) ?? '{}');
    expect(body.template_node_id).toBe(42);
  });

  test('shows the copyable /c link on success', async () => {
    stubFetch({
      'POST /api/collections': mkDetail({ url: 'https://project4.system.mow.gov.sy/c/tok7' }),
    });
    renderModal();

    fillTitleAndDepartments('مسح', 'المالية');
    await act(async () => {
      fireEvent.click(submitButton());
    });

    expect(
      await screen.findByText('https://project4.system.mow.gov.sy/c/tok7')
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: i18n.t('collections.copyLink') })
    ).toBeInTheDocument();
  });
});
