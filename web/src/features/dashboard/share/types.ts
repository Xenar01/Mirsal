/**
 * Client-side mirror of the server's owner-facing share projection (see
 * `server/src/routes/shares.ts` — `ShareDto`). The server deliberately never
 * sends the password hash: password presence is exposed only as the boolean
 * `has_password`. `status` is derived server-side against the clock; `url` is
 * the full public `/s/<token>` link.
 */
export interface ShareDto {
  id: number;
  node_id: number;
  token: string;
  is_active: boolean;
  has_password: boolean;
  expires_at: number | null;
  allow_download: boolean;
  created_at: number;
  status: 'active' | 'stopped' | 'expired' | 'exhausted';
  /** null = unlimited; ≥1 = per-file download cap (spec §4 data model). */
  download_limit: number | null;
  /** Completed counted downloads; server reports 0 when unlimited. */
  download_count: number;
  /** Terminal action once the cap is reached. */
  on_exhaust: 'stop' | 'delete';
  url: string;
}
