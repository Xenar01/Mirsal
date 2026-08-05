/**
 * Client-side last-admin / self guards (spec §3.1). These are UX only — they
 * disable controls and explain why — while the server remains the source of
 * truth (it still answers 409 `last_admin` / `self`, which the panel surfaces
 * gracefully).
 */
import type { AdminUserDto } from './types';

/** Number of users that are currently an active admin — the protected quantity. */
export function activeAdminCount(users: AdminUserDto[]): number {
  return users.filter((u) => u.role === 'admin' && u.is_active === 1).length;
}

/**
 * The id of the ONLY active admin, or null when there are zero or ≥2. When a
 * row's id equals this, deactivating / demoting / deleting it would drop the
 * active-admin count below 1 — the invariant the server also enforces.
 */
export function onlyActiveAdminId(users: AdminUserDto[]): number | null {
  const admins = users.filter((u) => u.role === 'admin' && u.is_active === 1);
  return admins.length === 1 ? admins[0].id : null;
}

export interface GuardState {
  /** True when a lowering action (deactivate/demote/delete) must be blocked. */
  blocked: boolean;
  /** i18n key for the reason, or null when not blocked. */
  reasonKey: 'admin.guard.lastAdmin' | 'admin.guard.self' | null;
}

/**
 * Whether a lowering action on `row` (deactivate, demote, or delete) is blocked
 * for `currentUserId`, and why. Last-admin takes precedence over self (mirrors
 * the server's ordering: dropping the last active admin is necessarily a self
 * action, but reports as `last_admin`).
 */
export function loweringGuard(row: AdminUserDto, users: AdminUserDto[], currentUserId: number | undefined): GuardState {
  if (onlyActiveAdminId(users) === row.id) {
    return { blocked: true, reasonKey: 'admin.guard.lastAdmin' };
  }
  if (row.id === currentUserId) {
    return { blocked: true, reasonKey: 'admin.guard.self' };
  }
  return { blocked: false, reasonKey: null };
}
