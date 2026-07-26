/**
 * TanStack Query data layer for shares (§3.3). The owner's share list is cached
 * under `['shares']` (keyed exactly as the J3 brief requires); every mutation
 * invalidates it so the ShareModal, the Shared register, and the DriveView
 * status column all refresh together. A 401 bubbles out of the api client for
 * the auth layer to handle — never swallowed here.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as shareApi from './api';
import type { CreateShareVars, PatchShareVars } from './api';

export const sharesKey = ['shares'] as const;

export function useShares() {
  return useQuery({ queryKey: sharesKey, queryFn: shareApi.listShares });
}

export function useCreateShare() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: CreateShareVars) => shareApi.createShare(vars),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: sharesKey });
    },
  });
}

export function usePatchShare() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: PatchShareVars) => shareApi.patchShare(vars),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: sharesKey });
    },
  });
}

export function useRevokeShare() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => shareApi.revokeShare(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: sharesKey });
    },
  });
}
