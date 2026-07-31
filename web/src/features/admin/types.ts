/**
 * Client-side mirrors of the admin API projections (see
 * `server/src/routes/admin.ts`). The admin surface is METADATA ONLY (spec
 * §3.1/§7): no `password_hash`, no share `token`, no node `storage_path`, and
 * there is no content/download path anywhere in this feature.
 */

/**
 * A user row as the admin panel sees it. `is_active` / `must_change_password`
 * arrive as their raw 0/1 INTEGER from SQLite (the server sends them verbatim
 * so the panel casts them itself — see `truthy`).
 */
export interface AdminUserDto {
  id: number;
  username: string;
  role: 'admin' | 'user';
  is_active: 0 | 1;
  quota_bytes: number | null;
  used_bytes: number;
  must_change_password: 0 | 1;
  created_at: number;
  display_name: string | null;
}

/**
 * A share as the admin sees it. Deliberately has NO `token` — an admin has no
 * content path, so shares are identified (and force-revoked) by their row `id`
 * (spec §3.1). `status` is derived server-side against the clock.
 */
export interface AdminShareDto {
  id: number;
  node_id: number;
  owner_id: number;
  owner_username: string;
  owner_active: boolean;
  node_name: string | null;
  is_active: boolean;
  has_password: boolean;
  expires_at: number | null;
  allow_download: boolean;
  created_at: number;
  status: 'active' | 'stopped' | 'expired';
}

/** One paginated audit-log row. Secret-valued targets are redacted server-side. */
export interface AuditRowDto {
  id: number;
  actor_id: number | null;
  action: string;
  target: string | null;
  detail: string | null;
  created_at: number;
}

/** Coerces the server's raw 0/1 INTEGER flags to a boolean. */
export const truthy = (v: 0 | 1): boolean => v === 1;
