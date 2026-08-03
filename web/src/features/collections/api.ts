/**
 * Typed wrappers over the owner Collections endpoints (spec §7.1). Every call
 * rides the shared lib/api client (same-origin /api, credentials:'include',
 * CSRF header on mutating verbs, typed ApiError). Bodies use the server's
 * snake_case keys; PATCH is tri-state — send ONLY the keys the caller changes
 * (null = clear, omit = unchanged), never password:'' (the server rejects it).
 */
import { apiGet, apiPost, apiPatch, apiDelete } from '../../lib/api';
import type { CollectionSummaryDto, CollectionDetailDto } from './types';

export function listCollections(): Promise<CollectionSummaryDto[]> {
  return apiGet<CollectionSummaryDto[]>('/collections');
}
export function getCollection(id: number): Promise<CollectionDetailDto> {
  return apiGet<CollectionDetailDto>(`/collections/${id}`);
}

export interface CreateCollectionVars {
  title: string;
  departments: string[];
  templateNodeId?: number | null;
  password?: string | null;
  deadlineAt?: number | null;
}
export function createCollection(vars: CreateCollectionVars): Promise<CollectionDetailDto> {
  const body: Record<string, unknown> = { title: vars.title, departments: vars.departments };
  if (vars.templateNodeId != null) body.template_node_id = vars.templateNodeId;
  if (vars.password) body.password = vars.password;
  if (vars.deadlineAt != null) body.deadline_at = vars.deadlineAt;
  return apiPost<CollectionDetailDto>('/collections', body);
}

export interface PatchCollectionVars {
  id: number;
  title?: string;
  password?: string | null;
  deadlineAt?: number | null;
  isActive?: boolean;
}
export function patchCollection(vars: PatchCollectionVars): Promise<CollectionDetailDto> {
  const body: Record<string, unknown> = {};
  if (vars.title !== undefined) body.title = vars.title;
  if (vars.password !== undefined) body.password = vars.password;
  if (vars.deadlineAt !== undefined) body.deadline_at = vars.deadlineAt;
  if (vars.isActive !== undefined) body.is_active = vars.isActive;
  return apiPatch<CollectionDetailDto>(`/collections/${vars.id}`, body);
}

export function deleteCollection(id: number): Promise<{ ok: true }> {
  return apiDelete<{ ok: true }>(`/collections/${id}`);
}
export function addDepartment(id: number, name: string): Promise<{ id: number; name: string; position: number }> {
  return apiPost(`/collections/${id}/departments`, { name });
}
export function removeDepartment(id: number, deptId: number): Promise<{ ok: true }> {
  return apiDelete<{ ok: true }>(`/collections/${id}/departments/${deptId}`);
}
