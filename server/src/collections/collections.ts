import type Database from 'better-sqlite3';
import { randomToken } from '../util/ids.js';
import { hashPassword } from '../auth/passwords.js';
import { ensureUserRoots } from '../nodes/tree.js';
import { nextSuffixedName } from '../nodes/collisions.js';

/** Prefix for the auto-created Drive folder that holds a collection's responses. */
export const COLLECTION_FOLDER_PREFIX = 'طلب تجميع: ';

/** Mirrors a row of the `collections` table verbatim. */
export interface Collection {
  id: number;
  owner_id: number;
  token: string;
  title: string;
  template_node_id: number | null;
  folder_node_id: number;
  password_hash: string | null;
  is_active: number;
  deadline_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface CreateCollectionOptions {
  title: string;
  /** Raw list; normalized (trim/drop-empty/dedupe) internally. Must yield ≥1. */
  departments: string[];
  /** Owner-owned live file node id, or null/undefined for no template. */
  templateNodeId?: number | null;
  /** Non-empty string => hashed; null/undefined/'' => no password. */
  password?: string | null;
  /** epoch-ms deadline; null/undefined => no deadline. */
  deadlineAt?: number | null;
}

/**
 * Pure status: `is_active = 0` → 'closed' (checked first); else a past
 * `deadline_at` → 'expired'; else 'open'. Mirrors shares' `ownerStatus`.
 */
export function collectionStatus(
  c: Pick<Collection, 'is_active' | 'deadline_at'>,
  now: number
): 'open' | 'closed' | 'expired' {
  if (!c.is_active) return 'closed';
  if (c.deadline_at != null && c.deadline_at < now) return 'expired';
  return 'open';
}

/** Trim, drop empties, dedupe (case-sensitive), preserve first-seen order. */
export function normalizeDepartments(input: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const name = raw.trim();
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Creates a collection owned by `ownerId`: an auto-named response folder under
 * the owner's root, a URL-safe token, and one `collection_departments` row per
 * normalized name. Throws `Error('invalid_title')`, `Error('no_departments')`,
 * or `Error('bad_template')` (template must be an owner-owned, live, `file`
 * node). Password (if a non-empty string) is hashed BEFORE the transaction
 * (better-sqlite3 transactions are synchronous). The folder name is suffixed
 * via `nextSuffixedName` inside the txn so duplicate titles never collide.
 */
export async function createCollection(
  db: Database.Database,
  ownerId: number,
  options: CreateCollectionOptions,
  now: number
): Promise<Collection> {
  const title = options.title.trim();
  if (title.length === 0) throw new Error('invalid_title');

  const departments = normalizeDepartments(options.departments);
  if (departments.length === 0) throw new Error('no_departments');

  const templateNodeId = options.templateNodeId ?? null;
  if (templateNodeId !== null) {
    const t = db
      .prepare('SELECT owner_id, kind, trashed_at FROM nodes WHERE id = @id')
      .get({ id: templateNodeId }) as
      | { owner_id: number; kind: string; trashed_at: number | null }
      | undefined;
    if (!t || t.owner_id !== ownerId || t.kind !== 'file' || t.trashed_at !== null) {
      throw new Error('bad_template');
    }
  }

  const { rootId } = ensureUserRoots(db, ownerId, now);
  const passwordHash =
    options.password && options.password.length > 0 ? await hashPassword(options.password) : null;
  const token = randomToken(32);
  const deadlineAt = options.deadlineAt ?? null;

  const run = db.transaction((): Collection => {
    const folderName = nextSuffixedName(db, rootId, `${COLLECTION_FOLDER_PREFIX}${title}`);
    const folderInfo = db
      .prepare(
        `INSERT INTO nodes(owner_id, parent_id, kind, name, size_bytes, created_at, updated_at)
         VALUES (@ownerId, @rootId, 'folder', @folderName, 0, @now, @now)`
      )
      .run({ ownerId, rootId, folderName, now });
    const folderNodeId = Number(folderInfo.lastInsertRowid);

    const cInfo = db
      .prepare(
        `INSERT INTO collections(owner_id, token, title, template_node_id, folder_node_id, password_hash, is_active, deadline_at, created_at, updated_at)
         VALUES (@ownerId, @token, @title, @templateNodeId, @folderNodeId, @passwordHash, 1, @deadlineAt, @now, @now)`
      )
      .run({ ownerId, token, title, templateNodeId, folderNodeId, passwordHash, deadlineAt, now });
    const collectionId = Number(cInfo.lastInsertRowid);

    const insertDept = db.prepare(
      `INSERT INTO collection_departments(collection_id, name, position, created_at)
       VALUES (@collectionId, @name, @position, @now)`
    );
    departments.forEach((name, i) => insertDept.run({ collectionId, name, position: i, now }));

    return db.prepare('SELECT * FROM collections WHERE id = @id').get({ id: collectionId }) as Collection;
  });

  return run();
}

/** Owner-scoped fetch of one collection row, or undefined. */
export function getCollection(
  db: Database.Database,
  ownerId: number,
  collectionId: number
): Collection | undefined {
  return db
    .prepare('SELECT * FROM collections WHERE id = @id AND owner_id = @ownerId')
    .get({ id: collectionId, ownerId }) as Collection | undefined;
}
