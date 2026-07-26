/**
 * TanStack Query data layer for the dashboard (resolves the Phase-I carry
 * "TanStack Query provider deferred to J"). Listings are cached under
 * `['nodes', <parentId|'root'>]` and `['trash']`; every mutation invalidates
 * the whole `['nodes', …]` family plus `['trash']` so the register, the
 * breadcrumb view, and the storage meter all refresh together. A 401 bubbles
 * out of the api client as `ApiError.isUnauthorized` for the auth flow to
 * handle — it is never swallowed here.
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import * as nodesApi from './api';
import type { NodeDto } from './types';

export const nodesKey = (parentId: number | null) => ['nodes', parentId ?? 'root'] as const;
export const trashKey = ['trash'] as const;

/** Invalidate every node listing + the trash listing (also refreshes the meter). */
function invalidateNodes(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: ['nodes'] });
  void client.invalidateQueries({ queryKey: trashKey });
}

export function useNodes(parentId: number | null) {
  return useQuery({
    queryKey: nodesKey(parentId),
    queryFn: () => nodesApi.listNodes(parentId),
  });
}

export function useTrash() {
  return useQuery({ queryKey: trashKey, queryFn: nodesApi.listTrash });
}

export function useCreateFolder() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { parentId: number; name: string }) =>
      nodesApi.createFolder(vars.parentId, vars.name),
    onSuccess: () => invalidateNodes(client),
  });
}

export function useRenameNode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: number; name: string }) => nodesApi.renameNode(vars.id, vars.name),
    onSuccess: () => invalidateNodes(client),
  });
}

export function useMoveNode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: number; parentId: number }) => nodesApi.moveNode(vars.id, vars.parentId),
    onSuccess: () => invalidateNodes(client),
  });
}

export function useTrashNode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => nodesApi.trashNode(id),
    onSuccess: () => invalidateNodes(client),
  });
}

export function useRestoreNode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => nodesApi.restoreNode(id),
    onSuccess: () => invalidateNodes(client),
  });
}

export function useDeleteNode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => nodesApi.deleteNode(id),
    onSuccess: () => invalidateNodes(client),
  });
}

/** Sum `size_bytes` over a listing, tolerating an undefined/non-array cache. */
export function sumSizes(nodes: NodeDto[] | undefined): number {
  if (!Array.isArray(nodes)) return 0;
  return nodes.reduce((total, node) => total + (node.size_bytes || 0), 0);
}
