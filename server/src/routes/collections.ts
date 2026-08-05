import type { FastifyInstance, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { Clock } from '../clock.js';
import type { Guards } from '../auth/guards.js';
import type { Config } from '../config.js';
import type { BlobStore } from '../storage/blobs.js';
import { writeAudit } from '../audit.js';
import {
  createCollection, getCollection, listCollections, setCollectionState, deleteCollection,
  collectionStatus, normalizeDepartments,
  type Collection, type CollectionSummaryRow, type SetCollectionStatePatch,
} from '../collections/collections.js';
import {
  addDepartment, removeDepartment, getRoster, DuplicateDepartmentError,
} from '../collections/departments.js';

export interface CollectionsRouteDeps {
  db: Database.Database;
  now: Clock;
  guards: Guards;
  config: Config;
  blobStore: BlobStore;
}

interface CollectionSummaryDto {
  id: number; token: string; title: string;
  is_active: boolean; has_password: boolean; has_template: boolean;
  deadline_at: number | null; created_at: number;
  status: 'open' | 'closed' | 'expired';
  department_count: number; responded_count: number;
  url: string;
}
interface RosterDeptDto {
  id: number; name: string; responded: boolean; file_count: number;
  submitted_at: number | null; note: string | null; folder_node_id: number | null;
}
interface CollectionDetailDto {
  id: number; token: string; title: string;
  is_active: boolean; has_password: boolean; has_template: boolean;
  deadline_at: number | null; created_at: number;
  status: 'open' | 'closed' | 'expired';
  department_count: number; responded_count: number;
  departments: RosterDeptDto[];
  template: { node_id: number; name: string } | null;
  folder_node_id: number;
  url: string;
}

function toSummaryDto(row: CollectionSummaryRow, base: string, nowMs: number): CollectionSummaryDto {
  return {
    id: row.id, token: row.token, title: row.title,
    is_active: !!row.is_active, has_password: row.password_hash !== null, has_template: row.template_node_id !== null,
    deadline_at: row.deadline_at, created_at: row.created_at,
    status: collectionStatus(row, nowMs),
    department_count: row.department_count, responded_count: row.responded_count,
    url: `${base}/c/${row.token}`,
  };
}

function buildDetailDto(db: Database.Database, c: Collection, base: string, nowMs: number): CollectionDetailDto {
  const roster = getRoster(db, c.id);
  const departments: RosterDeptDto[] = roster.map((r) => ({
    id: r.id, name: r.name, responded: r.responded, file_count: r.file_count,
    submitted_at: r.submitted_at, note: r.note, folder_node_id: r.folder_node_id,
  }));
  let template: { node_id: number; name: string } | null = null;
  if (c.template_node_id !== null) {
    const t = db
      .prepare('SELECT name FROM nodes WHERE id = @id AND owner_id = @ownerId')
      .get({ id: c.template_node_id, ownerId: c.owner_id }) as { name: string } | undefined;
    if (t) template = { node_id: c.template_node_id, name: t.name };
  }
  return {
    id: c.id, token: c.token, title: c.title,
    is_active: !!c.is_active, has_password: c.password_hash !== null, has_template: c.template_node_id !== null,
    deadline_at: c.deadline_at, created_at: c.created_at,
    status: collectionStatus(c, nowMs),
    department_count: departments.length,
    responded_count: departments.filter((d) => d.responded).length,
    departments, template,
    folder_node_id: c.folder_node_id,
    url: `${base}/c/${c.token}`,
  };
}

function parseIdParam(req: FastifyRequest, key = 'id'): number | null {
  const raw = (req.params as Record<string, string | undefined>)[key];
  const id = Number(raw);
  return Number.isInteger(id) ? id : null;
}

const createSchema = z.object({
  title: z.string().min(1).max(200),
  template_node_id: z.number().int().nullable().optional(),
  departments: z.array(z.string().max(200)).min(1).max(500),
  password: z.string().min(1).nullable().optional(),
  deadline_at: z.number().int().nullable().optional(),
});

const addDeptSchema = z.object({ name: z.string().min(1).max(200) });

const patchSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    // Tri-state: absent = unchanged, null = clear, non-empty string = set.
    password: z.string().min(1).nullable().optional(),
    // Tri-state: absent = unchanged, null = no deadline, number = deadline.
    deadline_at: z.number().int().nullable().optional(),
    is_active: z.boolean().optional(),
  })
  .refine(
    (v) => v.title !== undefined || v.password !== undefined || v.deadline_at !== undefined || v.is_active !== undefined,
    { message: 'at least one field is required' }
  );

/** Owner-scoped collection management. requireAuth (+ CSRF on mutating verbs). */
export default async function collectionsRoutes(app: FastifyInstance, deps: CollectionsRouteDeps): Promise<void> {
  const { db, now, guards, config, blobStore } = deps;
  const base = config.PUBLIC_BASE_URL;

  app.get('/api/collections', { preHandler: guards.requireAuth }, async (req, reply) => {
    const uid = req.user!.id;
    const nowMs = now();
    reply.code(200).send(listCollections(db, uid).map((r) => toSummaryDto(r, base, nowMs)));
  });

  app.post('/api/collections', { preHandler: guards.requireAuth }, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400).send({ error: 'invalid_body' }); return; }
    const uid = req.user!.id;
    if (normalizeDepartments(parsed.data.departments).length === 0) {
      reply.code(400).send({ code: 'no_departments' });
      return;
    }
    try {
      const c = await createCollection(db, uid, {
        title: parsed.data.title,
        departments: parsed.data.departments,
        templateNodeId: parsed.data.template_node_id ?? null,
        password: parsed.data.password ?? null,
        deadlineAt: parsed.data.deadline_at ?? null,
      }, now());
      writeAudit(db, {
        actorId: uid, action: 'collection_created', target: c.token,
        detail: JSON.stringify({ collection_id: c.id, departments: normalizeDepartments(parsed.data.departments).length }),
      }, now);
      reply.code(201).send(buildDetailDto(db, c, base, now()));
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      if (msg === 'bad_template') { reply.code(400).send({ code: 'bad_template' }); return; }
      if (msg === 'no_departments' || msg === 'invalid_title') { reply.code(400).send({ error: 'invalid_body' }); return; }
      throw e;
    }
  });

  app.get('/api/collections/:id', { preHandler: guards.requireAuth }, async (req, reply) => {
    const id = parseIdParam(req);
    if (id === null) { reply.code(404).send({ error: 'not_found' }); return; }
    const uid = req.user!.id;
    const c = getCollection(db, uid, id);
    if (!c) { reply.code(404).send({ error: 'not_found' }); return; }
    reply.code(200).send(buildDetailDto(db, c, base, now()));
  });

  app.patch('/api/collections/:id', { preHandler: guards.requireAuth }, async (req, reply) => {
    const id = parseIdParam(req);
    if (id === null) { reply.code(404).send({ error: 'not_found' }); return; }
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400).send({ error: 'invalid_body' }); return; }
    if (parsed.data.title !== undefined && parsed.data.title.trim() === '') {
      reply.code(400).send({ error: 'invalid_body' });
      return;
    }
    const uid = req.user!.id;

    const patch: SetCollectionStatePatch = {};
    if (parsed.data.title !== undefined) patch.title = parsed.data.title;
    if (parsed.data.is_active !== undefined) patch.isActive = parsed.data.is_active;
    if (parsed.data.password !== undefined) patch.password = parsed.data.password;
    if (parsed.data.deadline_at !== undefined) patch.deadlineAt = parsed.data.deadline_at;

    const updated = await setCollectionState(db, uid, id, patch, now());
    if (!updated) { reply.code(404).send({ error: 'not_found' }); return; }
    reply.code(200).send(buildDetailDto(db, updated, base, now()));
  });

  app.delete('/api/collections/:id', { preHandler: guards.requireAuth }, async (req, reply) => {
    const id = parseIdParam(req);
    if (id === null) { reply.code(404).send({ error: 'not_found' }); return; }
    const uid = req.user!.id;
    const c = getCollection(db, uid, id);
    if (!c) { reply.code(404).send({ error: 'not_found' }); return; }

    const { storagePaths } = deleteCollection(db, uid, id);
    for (const p of storagePaths) blobStore.deleteBlob(p);
    writeAudit(db, { actorId: uid, action: 'collection_deleted', target: c.token, detail: JSON.stringify({ collection_id: id }) }, now);
    reply.code(200).send({ ok: true });
  });

  app.post('/api/collections/:id/departments', { preHandler: guards.requireAuth }, async (req, reply) => {
    const id = parseIdParam(req);
    if (id === null) { reply.code(404).send({ error: 'not_found' }); return; }
    const parsed = addDeptSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400).send({ error: 'invalid_body' }); return; }
    const uid = req.user!.id;
    try {
      const dept = addDepartment(db, uid, id, parsed.data.name, now());
      reply.code(201).send({ id: dept.id, name: dept.name, position: dept.position });
    } catch (e) {
      if (e instanceof DuplicateDepartmentError) { reply.code(409).send({ code: 'duplicate' }); return; }
      const msg = e instanceof Error ? e.message : '';
      if (msg === 'not_found') { reply.code(404).send({ error: 'not_found' }); return; }
      if (msg === 'invalid_name') { reply.code(400).send({ error: 'invalid_body' }); return; }
      throw e;
    }
  });

  app.delete('/api/collections/:id/departments/:deptId', { preHandler: guards.requireAuth }, async (req, reply) => {
    const id = parseIdParam(req, 'id');
    const deptId = parseIdParam(req, 'deptId');
    if (id === null || deptId === null) { reply.code(404).send({ error: 'not_found' }); return; }
    const uid = req.user!.id;
    const result = removeDepartment(db, uid, id, deptId);
    if (result === 'not_found') { reply.code(404).send({ error: 'not_found' }); return; }
    if (result === 'has_response') { reply.code(409).send({ code: 'has_response' }); return; }
    reply.code(200).send({ ok: true });
  });
}
