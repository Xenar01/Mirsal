/**
 * TanStack Query hook for the public collect-intake page. The metadata query
 * never throws for an expected outcome (it returns a discriminated
 * {@link CollectMetaResult}), so 404/closed/password are cached "successful"
 * states the page branches on — only a genuine network failure becomes
 * `isError`. After a password unlock the page calls the metadata query's
 * `refetch()` (the unlock cookie now lets the same endpoint return live
 * metadata). Mirrors `features/public/queries.ts`.
 */
import { useQuery } from '@tanstack/react-query';
import { fetchCollectMeta } from './api';

export const collectMetaKey = (token: string, reveal: boolean) =>
  ['collect', token, 'meta', reveal ? 'reveal' : 'gate'] as const;

export function useCollectMeta(token: string, reveal: boolean) {
  return useQuery({
    queryKey: collectMetaKey(token, reveal),
    queryFn: () => fetchCollectMeta(token, { reveal }),
    enabled: token.length > 0,
  });
}
