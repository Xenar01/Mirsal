/**
 * Live TanStack query for the session user's server-maintained figures
 * (`quotaBytes`/`usedBytes`), used by the dashboard storage meter.
 *
 * The auth CONTEXT (`auth-context.tsx`) still owns identity + routing — it
 * fetches `/api/auth/me` once at bootstrap and on login. This query exists so
 * the meter can refresh those figures WITHOUT a full page reload, which the
 * context alone never does:
 *  - `refetchOnWindowFocus: true` overrides the app-wide default (OFF in
 *    `web/src/main.tsx`), so switching back to the browser tab re-pulls
 *    `used_bytes` — the reported bug was that it stayed frozen until a manual
 *    reload;
 *  - dashboard mutations + uploads invalidate {@link meKey}, so a delete/upload
 *    moves the meter immediately.
 *
 * It is seeded from the context user (already fetched at bootstrap) as
 * `initialData` so the meter paints the right numbers on first render, and is
 * only `enabled` once a user exists (no pointless `/me` probe while logged out).
 */
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../lib/api';
import { useAuth, type PublicUser } from './auth-context';

/**
 * Invalidation PREFIX for the session-user query. Mutations invalidate this
 * (prefix match), refreshing whichever id-scoped entry is live.
 */
export const meKey = ['auth', 'me'] as const;

export function useMe() {
  const { user } = useAuth();
  return useQuery({
    // Scoped by user id so a same-session account switch never surfaces the
    // previous user's cached quota/used (the entry keys differ); mutations
    // still hit it via the `meKey` prefix.
    queryKey: [...meKey, user?.id],
    queryFn: () => apiGet<PublicUser>('/auth/me'),
    enabled: user !== null,
    initialData: user ?? undefined,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });
}
