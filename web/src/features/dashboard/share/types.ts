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
  status: 'active' | 'stopped' | 'expired';
  url: string;
}
