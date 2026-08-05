/**
 * TanStack Query layer for owner Collections. The list is cached under
 * ['collections']; each detail under ['collections', id]. Every mutation
 * invalidates the list and (where relevant) the affected detail so the list
 * counts and the roster refresh together. A 401 bubbles to the auth layer.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from './api';
import type { CreateCollectionVars, PatchCollectionVars } from './api';

export const collectionsKey = ['collections'] as const;
export const collectionKey = (id: number) => ['collections', id] as const;

export function useCollections() {
  return useQuery({ queryKey: collectionsKey, queryFn: api.listCollections });
}
export function useCollection(id: number) {
  return useQuery({ queryKey: collectionKey(id), queryFn: () => api.getCollection(id), enabled: Number.isInteger(id) });
}

function useInvalidate() {
  const client = useQueryClient();
  return (id?: number) => {
    void client.invalidateQueries({ queryKey: collectionsKey });
    if (id !== undefined) void client.invalidateQueries({ queryKey: collectionKey(id) });
  };
}

export function useCreateCollection() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: CreateCollectionVars) => api.createCollection(v),
    onSuccess: () => invalidate(),
  });
}
export function usePatchCollection() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: PatchCollectionVars) => api.patchCollection(v),
    onSuccess: (d) => invalidate(d.id),
  });
}
export function useDeleteCollection() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (id: number) => api.deleteCollection(id), onSuccess: () => invalidate() });
}
export function useAddDepartment() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { id: number; name: string }) => api.addDepartment(v.id, v.name),
    onSuccess: (_r, v) => invalidate(v.id),
  });
}
export function useRemoveDepartment() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { id: number; deptId: number }) => api.removeDepartment(v.id, v.deptId),
    onSuccess: (_r, v) => invalidate(v.id),
  });
}
