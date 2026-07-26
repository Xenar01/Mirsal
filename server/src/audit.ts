import type Database from 'better-sqlite3';
import type { Clock } from './clock.js';

/** One `audit_log` row to be written. `actorId` may be null (system actions). */
export interface AuditEntry {
  actorId: number | null;
  action: string;
  target?: string | null;
  detail?: string | null;
}

/**
 * Inserts one row into `audit_log`. Never pass secrets/tokens/passwords in
 * `detail` — callers are responsible for redacting sensitive values before
 * calling this.
 */
export function writeAudit(db: Database.Database, entry: AuditEntry, now: Clock): void {
  db.prepare(
    `INSERT INTO audit_log(actor_id, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(entry.actorId, entry.action, entry.target ?? null, entry.detail ?? null, now());
}
