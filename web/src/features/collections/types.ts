/**
 * Client-side mirrors of the server's Collections DTOs (see
 * server/src/routes/collections.ts). status is derived server-side vs the
 * clock; url is the full public /c/<token> link. has_password/has_template are
 * booleans (the server never sends the hash or the template's blob).
 */
export interface CollectionSummaryDto {
  id: number;
  token: string;
  title: string;
  is_active: boolean;
  has_password: boolean;
  has_template: boolean;
  deadline_at: number | null;
  created_at: number;
  status: 'open' | 'closed' | 'expired';
  department_count: number;
  responded_count: number;
  url: string;
}

export interface RosterDeptDto {
  id: number;
  name: string;
  responded: boolean;
  file_count: number;
  submitted_at: number | null;
  note: string | null;
  /** The department's response subfolder in the owner's Drive; null until it responds. */
  folder_node_id: number | null;
}

export interface CollectionDetailDto {
  id: number;
  token: string;
  title: string;
  is_active: boolean;
  has_password: boolean;
  has_template: boolean;
  deadline_at: number | null;
  created_at: number;
  status: 'open' | 'closed' | 'expired';
  department_count: number;
  responded_count: number;
  departments: RosterDeptDto[];
  template: { node_id: number; name: string } | null;
  /** The collection's own Drive folder (root of the whole-collection ZIP export). */
  folder_node_id: number;
  url: string;
}
