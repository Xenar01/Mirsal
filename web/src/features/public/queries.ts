/**
 * TanStack Query hooks for the public share page. The metadata query never
 * throws for an expected outcome (it returns a discriminated
 * {@link PublicMetaResult}), so 401/404/410 are cached "successful" states the
 * page branches on — only a genuine network failure becomes `isError`. After a
 * password unlock the page calls the metadata query's `refetch()` (the unlock
 * cookie now lets the same endpoint return live metadata).
 */
import { useQuery } from '@tanstack/react-query';
import { fetchPublicList, fetchPublicMeta } from './api';

export const publicMetaKey = (token: string) => ['public', token, 'meta'] as const;
export const publicListKey = (token: string, path: number | null) =>
  ['public', token, 'list', path ?? 'root'] as const;

export function usePublicMeta(token: string) {
  return useQuery({
    queryKey: publicMetaKey(token),
    queryFn: () => fetchPublicMeta(token),
    enabled: token.length > 0,
  });
}

export function usePublicList(token: string, path: number | null) {
  return useQuery({
    queryKey: publicListKey(token, path),
    queryFn: () => fetchPublicList(token, path),
  });
}
