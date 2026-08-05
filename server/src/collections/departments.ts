import type Database from 'better-sqlite3';

export interface Department {
  id: number;
  collection_id: number;
  name: string;
  position: number;
  created_at: number;
}

/** Thrown by addDepartment when the (collection_id, name) pair already exists. */
export class DuplicateDepartmentError extends Error {
  constructor() {
    super('duplicate department');
    this.name = 'DuplicateDepartmentError';
  }
}

function isUniqueConstraintError(e: unknown): boolean {
  return (
    e instanceof Error &&
    ((e as NodeJS.ErrnoException).code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/i.test(e.message))
  );
}

/** Departments of `collectionId`, ordered by position then id. */
export function listDepartments(db: Database.Database, collectionId: number): Department[] {
  return db
    .prepare('SELECT * FROM collection_departments WHERE collection_id = @collectionId ORDER BY position ASC, id ASC')
    .all({ collectionId }) as Department[];
}

/**
 * Adds a department to `collectionId` (owner-scoped). Throws `Error('not_found')`
 * if the collection isn't owned by `ownerId`, `Error('invalid_name')` if the
 * trimmed name is empty, or `DuplicateDepartmentError` on a name clash.
 */
export function addDepartment(
  db: Database.Database,
  ownerId: number,
  collectionId: number,
  name: string,
  now: number,
): Department {
  const owned = db
    .prepare('SELECT id FROM collections WHERE id = @collectionId AND owner_id = @ownerId')
    .get({ collectionId, ownerId });
  if (!owned) throw new Error('not_found');

  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error('invalid_name');

  const pos = (
    db
      .prepare(
        'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM collection_departments WHERE collection_id = @collectionId',
      )
      .get({ collectionId }) as { p: number }
  ).p;

  try {
    const info = db
      .prepare(
        `INSERT INTO collection_departments(collection_id, name, position, created_at)
         VALUES (@collectionId, @name, @position, @now)`,
      )
      .run({ collectionId, name: trimmed, position: pos, now });
    return db
      .prepare('SELECT * FROM collection_departments WHERE id = @id')
      .get({ id: Number(info.lastInsertRowid) }) as Department;
  } catch (e) {
    if (isUniqueConstraintError(e)) throw new DuplicateDepartmentError();
    throw e;
  }
}

export type RemoveDepartmentResult = 'removed' | 'not_found' | 'has_response';

/**
 * Removes `departmentId` from `collectionId` (owner-scoped). Returns
 * 'not_found' if the department/collection isn't the owner's, 'has_response'
 * if the department already has a submitted response (never orphan files), or
 * 'removed' on success.
 */
export function removeDepartment(
  db: Database.Database,
  ownerId: number,
  collectionId: number,
  departmentId: number,
): RemoveDepartmentResult {
  const dept = db
    .prepare(
      `SELECT d.id FROM collection_departments d
       JOIN collections c ON c.id = d.collection_id
       WHERE d.id = @departmentId AND d.collection_id = @collectionId AND c.owner_id = @ownerId`,
    )
    .get({ departmentId, collectionId, ownerId });
  if (!dept) return 'not_found';

  const resp = db
    .prepare('SELECT 1 FROM collection_responses WHERE department_id = @departmentId LIMIT 1')
    .get({ departmentId });
  if (resp) return 'has_response';

  db.prepare('DELETE FROM collection_departments WHERE id = @departmentId').run({ departmentId });
  return 'removed';
}

export interface RosterEntry {
  id: number;
  name: string;
  position: number;
  responded: boolean;
  file_count: number;
  submitted_at: number | null;
  note: string | null;
  folder_node_id: number | null;
}

/**
 * Every department of `collectionId`, left-joined to its response. A responded
 * department carries its live file count (direct `file` children of its
 * response subfolder), submitted time, note, and folder id; a missing one
 * reports responded=false / file_count=0 / nulls. Ordered by position.
 */
export function getRoster(db: Database.Database, collectionId: number): RosterEntry[] {
  const rows = db
    .prepare(
      `SELECT d.id AS id, d.name AS name, d.position AS position,
              r.folder_node_id AS folder_node_id, r.submitted_at AS submitted_at, r.note AS note,
              (SELECT COUNT(*) FROM nodes n
                 WHERE n.parent_id = r.folder_node_id AND n.kind = 'file' AND n.trashed_at IS NULL) AS file_count
       FROM collection_departments d
       LEFT JOIN collection_responses r ON r.department_id = d.id AND r.collection_id = d.collection_id
       WHERE d.collection_id = @collectionId
       ORDER BY d.position ASC, d.id ASC`,
    )
    .all({ collectionId }) as Array<{
    id: number;
    name: string;
    position: number;
    folder_node_id: number | null;
    submitted_at: number | null;
    note: string | null;
    file_count: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    position: r.position,
    responded: r.folder_node_id !== null,
    file_count: r.folder_node_id !== null ? r.file_count : 0,
    submitted_at: r.submitted_at,
    note: r.note,
    folder_node_id: r.folder_node_id,
  }));
}
