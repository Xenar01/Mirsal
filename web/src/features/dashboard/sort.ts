import type { NodeDto } from './types';

export type SortKey = 'name' | 'size' | 'date';
export type SortDir = 'asc' | 'desc';
export interface SortState {
  key: SortKey;
  dir: SortDir;
}

// Arabic, numeric-aware, case/diacritic-insensitive collation for names.
const collator = new Intl.Collator('ar', { numeric: true, sensitivity: 'base' });

/**
 * Sorts a node listing for display (§3.2 / spec §Phase 3.2). Folders always
 * come before files; within each group, rows are ordered by the chosen key
 * and direction, with a stable name tiebreak. Pure — returns a NEW array and
 * never mutates its input.
 */
export function sortNodes(nodes: NodeDto[], sort: SortState): NodeDto[] {
  const dir = sort.dir === 'asc' ? 1 : -1;
  const within = (a: NodeDto, b: NodeDto): number => {
    let base: number;
    if (sort.key === 'size') base = a.size_bytes - b.size_bytes;
    else if (sort.key === 'date') base = a.updated_at - b.updated_at;
    else base = collator.compare(a.name, b.name);
    if (base === 0) base = collator.compare(a.name, b.name); // stable tiebreak
    return base * dir;
  };
  const folders = nodes.filter((n) => n.kind === 'folder').sort(within);
  const files = nodes.filter((n) => n.kind !== 'folder').sort(within);
  return [...folders, ...files];
}
