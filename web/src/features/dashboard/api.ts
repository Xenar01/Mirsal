/**
 * Thin, typed wrappers over the `/api/nodes/*` endpoints (spec §7). Reads/JSON
 * writes go through the shared `lib/api` client (relative `/api`,
 * `credentials:'include'`, CSRF header, typed `ApiError`). The one exception is
 * multipart **upload**, which uses `XMLHttpRequest` directly so the UI can show
 * per-file upload progress (`fetch` exposes no upload-progress events) — it
 * still rides the same `mirsal_session` cookie and echoes the `mirsal_csrf`
 * cookie, and posts same-origin `/api`, so it stays inside the strict CSP.
 */
import { apiGet, apiPost, apiPatch, apiDelete, ApiError, readCsrfToken } from '../../lib/api';
import type { NodeDto } from './types';

/** Root listing when `parentId` is null; a folder's children otherwise. */
export function listNodes(parentId: number | null): Promise<NodeDto[]> {
  return apiGet<NodeDto[]>(parentId === null ? '/nodes' : `/nodes?parent=${parentId}`);
}

export function listTrash(): Promise<NodeDto[]> {
  return apiGet<NodeDto[]>('/nodes/trash');
}

/**
 * Creates a folder under `parentId`. `null` means the root: the server
 * resolves the synthetic root itself (like the listing/upload endpoints), so a
 * brand-new empty account — which can't yet know its concrete root node id —
 * can still create its first folder.
 */
export function createFolder(parentId: number | null, name: string): Promise<NodeDto> {
  return apiPost<NodeDto>('/nodes/folder', { parent_id: parentId, name });
}

export function renameNode(id: number, name: string): Promise<NodeDto> {
  return apiPatch<NodeDto>(`/nodes/${id}`, { name });
}

export function moveNode(id: number, parentId: number): Promise<NodeDto> {
  return apiPatch<NodeDto>(`/nodes/${id}`, { parent_id: parentId });
}

export function trashNode(id: number): Promise<NodeDto> {
  return apiPost<NodeDto>(`/nodes/${id}/trash`);
}

export function restoreNode(id: number): Promise<NodeDto> {
  return apiPost<NodeDto>(`/nodes/${id}/restore`);
}

export function deleteNode(id: number): Promise<void> {
  return apiDelete<void>(`/nodes/${id}`);
}

/**
 * Schedules (or clears) a node's auto-delete deadline (spec §3.4). `epoch-ms`
 * UTC must be a future instant when set (the server validates); `null` clears
 * the schedule. When the deadline passes the scheduler trashes the subtree and
 * its shares go 410, then the blob is purged after a 7-day grace.
 */
export function setAutoDelete(id: number, autoDeleteAt: number | null): Promise<NodeDto> {
  return apiPatch<NodeDto>(`/nodes/${id}/auto-delete`, { auto_delete_at: autoDeleteAt });
}

/** Same-origin URL for a file download — triggered via a plain anchor (RFC-6266 on the server). */
export function downloadUrl(id: number): string {
  return `/api/nodes/${id}/download`;
}

/**
 * Machine-readable error code for a failed node call. The api client's
 * `ApiError.code` only mirrors a `{error:"..."}` body; several node endpoints
 * instead answer `{code:"..."}` (folder 409 `name_conflict`, upload 413
 * `quota_exceeded` / `file_too_large`), so fall back to `body.code`.
 */
export function nodeErrorCode(err: unknown): string | undefined {
  if (!(err instanceof ApiError)) return undefined;
  if (err.code) return err.code;
  const body = err.body as { code?: unknown } | undefined;
  return body && typeof body.code === 'string' ? body.code : undefined;
}

export interface UploadOptions {
  file: File;
  parentId: number | null;
  onProgress?: (fraction: number) => void;
}

/**
 * Uploads one file via `XMLHttpRequest`, reporting progress as a 0–1 fraction.
 * `parent_id` rides the query string (not a multipart field) to sidestep
 * busboy field-ordering entirely. Resolves with the created `NodeDto`; rejects
 * with an `ApiError` whose `code` carries the server's `{code}` (so the caller
 * can map 413 `quota_exceeded` / `file_too_large`).
 */
export function uploadFile({ file, parentId, onProgress }: UploadOptions): Promise<NodeDto> {
  return new Promise<NodeDto>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const query = parentId === null ? '' : `?parent_id=${parentId}`;
    xhr.open('POST', `/api/nodes/upload${query}`);
    xhr.withCredentials = true;

    const csrf = readCsrfToken();
    if (csrf) xhr.setRequestHeader('x-csrf-token', csrf);

    if (xhr.upload) {
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
      });
    }

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as NodeDto);
        } catch {
          reject(new ApiError({ status: xhr.status, message: 'invalid_json_response' }));
        }
        return;
      }
      let body: unknown;
      let code: string | undefined;
      try {
        body = JSON.parse(xhr.responseText);
        const asObj = body as { code?: unknown };
        if (typeof asObj.code === 'string') code = asObj.code;
      } catch {
        /* non-JSON error body — leave code unset */
      }
      reject(new ApiError({ status: xhr.status, code, body }));
    });

    xhr.addEventListener('error', () => reject(new ApiError({ status: 0, message: 'network_error' })));

    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  });
}
