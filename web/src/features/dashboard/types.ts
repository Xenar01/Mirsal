/**
 * Client-side mirror of the server's `NodeDto` (see
 * `server/src/routes/nodes.ts`). Every `/api/nodes/*` endpoint returns this
 * shape. Timestamps are epoch-ms; folder `size_bytes` is a server-side rollup
 * of its subtree.
 */
export interface NodeDto {
  id: number;
  parent_id: number | null;
  kind: 'root' | 'trash' | 'folder' | 'file';
  name: string;
  size_bytes: number;
  mime_type: string | null;
  auto_delete_at: number | null;
  created_at: number;
  updated_at: number;
}

/** A breadcrumb step carried in router history state as the user drills down. */
export interface Crumb {
  id: number;
  name: string;
}
