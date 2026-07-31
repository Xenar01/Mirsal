/**
 * Thin, typed wrappers over the `/api/shares/*` endpoints (spec §7 / §3.3).
 * Every call rides the shared `lib/api` client (same-origin `/api`,
 * `credentials:'include'`, CSRF header, typed `ApiError`).
 */
import { apiGet, apiPost, apiPatch, apiDelete } from '../../../lib/api';
import type { ShareDto } from './types';

/** The owner's shares, newest first. */
export function listShares(): Promise<ShareDto[]> {
  return apiGet<ShareDto[]>('/shares');
}

export interface CreateShareVars {
  nodeId: number;
  /** Absent/empty => no password. */
  password?: string;
  /** epoch-ms UTC; null/absent => never expires. */
  expiresAt?: number | null;
}

export function createShare(vars: CreateShareVars): Promise<ShareDto> {
  const body: Record<string, unknown> = { node_id: vars.nodeId };
  if (vars.password) body.password = vars.password;
  if (vars.expiresAt !== undefined) body.expires_at = vars.expiresAt;
  return apiPost<ShareDto>('/shares', body);
}

/**
 * Tri-state PATCH: send ONLY the keys the caller wants to change. Never sends
 * `password: ''` (the server rejects it — an empty "set" would hash to a
 * password the owner could never resubmit, permanently locking the share); use
 * `password: null` to clear instead.
 */
export interface PatchShareVars {
  id: number;
  isActive?: boolean;
  /** non-empty string sets a password; null clears it; omit = unchanged. */
  password?: string | null;
  /** number sets a new deadline; null = never-expires; omit = unchanged. */
  expiresAt?: number | null;
  /** int ≥ 1 sets the per-file cap; null clears it (unlimited); omit = unchanged. */
  downloadLimit?: number | null;
  /** terminal action when the cap is reached ('stop' | 'delete'); omit = unchanged. */
  onExhaust?: 'stop' | 'delete';
}

export function patchShare(vars: PatchShareVars): Promise<ShareDto> {
  const body: Record<string, unknown> = {};
  if (vars.isActive !== undefined) body.is_active = vars.isActive;
  if (vars.password !== undefined) body.password = vars.password;
  if (vars.expiresAt !== undefined) body.expires_at = vars.expiresAt;
  if (vars.downloadLimit !== undefined) body.download_limit = vars.downloadLimit;
  if (vars.onExhaust !== undefined) body.on_exhaust = vars.onExhaust;
  return apiPatch<ShareDto>(`/shares/${vars.id}`, body);
}

export function revokeShare(id: number): Promise<{ ok: true }> {
  return apiDelete<{ ok: true }>(`/shares/${id}`);
}
