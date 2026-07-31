/**
 * Thin, typed wrappers over `/api/admin/*` (spec §7). Every call rides the
 * shared `lib/api` client (same-origin `/api`, `credentials:'include'`, CSRF
 * header, typed `ApiError`). METADATA ONLY — there is deliberately no
 * download/content wrapper here (spec §3.1).
 */
import { apiGet, apiPost, apiPatch, apiDelete, ApiError } from '../../lib/api';
import type { AdminUserDto, AdminShareDto, AuditRowDto } from './types';

/**
 * Same username policy the server enforces (`server/src/routes/admin.ts`):
 * ASCII letters/digits and `. _ -`, 1–64 chars. Validated client-side so an
 * obviously-bad handle never round-trips; the server remains the source of
 * truth.
 */
export const USERNAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** Minimum password length enforced in the UI (matches the user-facing policy). */
export const MIN_PASSWORD_LEN = 8;

/** Default page size for the audit log (server default + max 500). */
export const AUDIT_PAGE_SIZE = 100;

// --- Users -----------------------------------------------------------------

export function listUsers(): Promise<AdminUserDto[]> {
  return apiGet<AdminUserDto[]>('/admin/users');
}

export interface CreateUserVars {
  username: string;
  password: string;
  role: 'admin' | 'user';
  /** Omitted/null => unlimited quota. */
  quotaBytes?: number | null;
  /** Free-text label; omit for none. */
  displayName?: string | null;
}

export function createUser(vars: CreateUserVars): Promise<AdminUserDto> {
  const body: Record<string, unknown> = {
    username: vars.username,
    password: vars.password,
    role: vars.role,
  };
  if (vars.quotaBytes !== undefined && vars.quotaBytes !== null) {
    body.quota_bytes = vars.quotaBytes;
  }
  if (vars.displayName !== undefined) {
    body.display_name = vars.displayName;
  }
  return apiPost<AdminUserDto>('/admin/users', body);
}

export interface PatchUserVars {
  id: number;
  isActive?: boolean;
  role?: 'admin' | 'user';
  /** number sets a quota; null = unlimited; omit = unchanged. */
  quotaBytes?: number | null;
  /** string sets a label; null clears it; omit = unchanged. */
  displayName?: string | null;
}

export function patchUser(vars: PatchUserVars): Promise<AdminUserDto> {
  const body: Record<string, unknown> = {};
  if (vars.isActive !== undefined) body.is_active = vars.isActive;
  if (vars.role !== undefined) body.role = vars.role;
  if (vars.quotaBytes !== undefined) body.quota_bytes = vars.quotaBytes;
  if (vars.displayName !== undefined) body.display_name = vars.displayName;
  return apiPatch<AdminUserDto>(`/admin/users/${vars.id}`, body);
}

/**
 * Resets a user's password to a NEW server-generated one, returned once. Sends
 * an empty body so the server generates + returns `{ password }` (spec §3.1);
 * the reveal-once panel is the only place that value is shown.
 */
export function resetPassword(id: number): Promise<{ password: string }> {
  return apiPost<{ password: string }>(`/admin/users/${id}/password`, {});
}

export function deleteUser(id: number): Promise<{ ok: true }> {
  return apiDelete<{ ok: true }>(`/admin/users/${id}`);
}

// --- Shares ----------------------------------------------------------------

export function listShares(): Promise<AdminShareDto[]> {
  return apiGet<AdminShareDto[]>('/admin/shares');
}

export function revokeShare(id: number): Promise<{ ok: true }> {
  return apiDelete<{ ok: true }>(`/admin/shares/${id}`);
}

// --- Audit -----------------------------------------------------------------

export function listAudit(page: number): Promise<AuditRowDto[]> {
  const offset = page * AUDIT_PAGE_SIZE;
  return apiGet<AuditRowDto[]>(`/admin/audit?limit=${AUDIT_PAGE_SIZE}&offset=${offset}`);
}

/**
 * Machine-readable error code for a failed admin call. The api client's
 * `ApiError.code` mirrors a `{error:"..."}` body; the admin guards instead
 * answer `{code:"..."}` (409 `username_taken` / `last_admin` / `self`), so fall
 * back to `body.code`.
 */
export function adminErrorCode(err: unknown): string | undefined {
  if (!(err instanceof ApiError)) return undefined;
  if (err.code) return err.code;
  const body = err.body as { code?: unknown } | undefined;
  return body && typeof body.code === 'string' ? body.code : undefined;
}
