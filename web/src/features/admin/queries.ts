/**
 * TanStack Query data layer for the admin panel (spec §3.1). Query keys match
 * the J4 brief exactly: `['admin','users']`, `['admin','shares']`, and
 * `['admin','audit', page]`. Every mutation invalidates the affected listing so
 * the tables refresh together. A 401 bubbles out of the api client for the auth
 * layer to handle — never swallowed here.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as adminApi from './api';
import type { CreateUserVars, PatchUserVars } from './api';

export const usersKey = ['admin', 'users'] as const;
export const sharesKey = ['admin', 'shares'] as const;
export const auditKey = (page: number) => ['admin', 'audit', page] as const;

export function useAdminUsers() {
  return useQuery({ queryKey: usersKey, queryFn: adminApi.listUsers });
}

export function useCreateUser() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: CreateUserVars) => adminApi.createUser(vars),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: usersKey });
    },
  });
}

export function usePatchUser() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: PatchUserVars) => adminApi.patchUser(vars),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: usersKey });
    },
  });
}

export function useResetPassword() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => adminApi.resetPassword(id),
    onSuccess: () => {
      // A reset flips must_change_password server-side; refresh the row.
      void client.invalidateQueries({ queryKey: usersKey });
    },
  });
}

export function useDeleteUser() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => adminApi.deleteUser(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: usersKey });
    },
  });
}

export function useAdminShares() {
  return useQuery({ queryKey: sharesKey, queryFn: adminApi.listShares });
}

export function useRevokeShare() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => adminApi.revokeShare(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: sharesKey });
    },
  });
}

export function useAudit(page: number) {
  return useQuery({
    queryKey: auditKey(page),
    queryFn: () => adminApi.listAudit(page),
    // Keep the previous page visible while the next loads (no flash to empty).
    placeholderData: (prev) => prev,
  });
}
