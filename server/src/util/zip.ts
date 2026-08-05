import type Database from 'better-sqlite3';
import { ZipArchive } from 'archiver';
import { listChildren, type Node } from '../nodes/tree.js';
import type { BlobStore } from '../storage/blobs.js';

/**
 * zlib level for the `/zip` archiver. Level 9 (max compression) spends
 * substantially more CPU than the marginal size reduction is worth on an
 * unauthenticated, un-rate-limited-by-size endpoint — across a subtree near
 * `MAX_ZIP_ENTRIES` files that cost is an easy CPU-exhaustion DoS. zlib's own
 * default trade-off (6) keeps the archive genuinely compressed at a fraction
 * of the CPU cost.
 */
export const ZIP_COMPRESSION_LEVEL = 6;

/** Hard cap on files included in a `/zip` (loop/DoS-safety on a public endpoint). */
export const MAX_ZIP_ENTRIES = 10_000;
/**
 * Hard cap on total nodes (files AND folders) visited while walking the
 * subtree for `/zip`. `MAX_ZIP_ENTRIES` alone only bounds the files
 * *collected* — a folder-heavy, file-sparse shared subtree (many nested
 * empty/near-empty folders) would still make the walk itself (and its
 * `listChildren` calls) unbounded, since the file cap is never reached. This
 * cap bounds the walk regardless of how many of the visited nodes are files.
 */
export const MAX_ZIP_WALK_NODES = 20_000;

/** Sanitizes a shared node's name into a `<name>.zip` download filename (CR/LF and separators stripped). */
export function zipFileName(rawName: string): string {
  // eslint-disable-next-line no-control-regex
  const base = rawName.replace(/[\r\n\x00-\x1F\x7F/\\]/g, '_').trim();
  return `${base.length > 0 ? base : 'download'}.zip`;
}

/**
 * Collects every live file under `root` as `{storagePath, name}` where
 * `name` is the path relative to the shared node (the shared folder itself
 * is not a prefix; its children sit at the zip root). Iterative + bounded
 * on BOTH axes to stay loop/DoS-safe on this unauthenticated route:
 *  - `MAX_ZIP_ENTRIES` caps the files collected.
 *  - `MAX_ZIP_WALK_NODES` caps the total nodes (files+folders) visited,
 *    which in turn caps the number of `listChildren` (DB) calls — this is
 *    the one that protects a folder-heavy, file-sparse subtree, where the
 *    file cap above would never trip.
 * Uses `listChildren`, which already excludes trashed rows.
 */
export function collectSubtreeFiles(
  database: Database.Database,
  ownerId: number,
  root: Node
): Array<{ storagePath: string; name: string }> {
  const out: Array<{ storagePath: string; name: string }> = [];

  if (root.kind === 'file') {
    if (root.storage_path) out.push({ storagePath: root.storage_path, name: root.name });
    return out;
  }

  let visited = 0;
  const stack: Array<{ folderId: number; prefix: string }> = [{ folderId: root.id, prefix: '' }];
  while (stack.length > 0 && out.length < MAX_ZIP_ENTRIES && visited < MAX_ZIP_WALK_NODES) {
    const { folderId, prefix } = stack.pop()!;
    for (const child of listChildren(database, ownerId, folderId)) {
      visited++;
      if (child.kind === 'file') {
        if (child.storage_path) {
          out.push({ storagePath: child.storage_path, name: prefix + child.name });
        }
      } else if (child.kind === 'folder') {
        stack.push({ folderId: child.id, prefix: `${prefix}${child.name}/` });
      }
      if (out.length >= MAX_ZIP_ENTRIES || visited >= MAX_ZIP_WALK_NODES) break;
    }
  }

  return out;
}

/** Streams each collected file's blob into `archive` under its resolved `name`. */
export function appendFilesToArchive(
  archive: ZipArchive,
  files: Array<{ storagePath: string; name: string }>,
  blobStore: BlobStore
): void {
  for (const f of files) {
    archive.append(blobStore.readBlob(f.storagePath), { name: f.name });
  }
}
