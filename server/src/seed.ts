import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Clock } from './clock.js';
import type { Config } from './config.js';
import { createPasswordService } from './auth/passwords.js';
import { randomToken } from './util/ids.js';
import { ensureUserRoots } from './nodes/tree.js';

/**
 * Ensures exactly one admin user exists.
 *
 * If any `role='admin'` row already exists this is a no-op: it never creates
 * a second admin and never touches the credential file (first-boot seeding
 * only — the file is a one-time handoff, not resynced on every restart).
 *
 * Otherwise it creates the `admin` user with a random password
 * (`must_change_password=1`, forcing a change on first login), gives it
 * synthetic root/trash nodes via {@link ensureUserRoots}, and writes the
 * one-time credential to a root-only `0600` file living next to the
 * database (derived from `config.DB_PATH`, never under a web-served
 * directory). The password is written to that file only — it is never
 * logged.
 *
 * The INSERT, {@link ensureUserRoots}, and the credential-file write are all
 * run inside a single `db.transaction()`. `ensureUserRoots` opens its own
 * nested transaction, which better-sqlite3 implements as a SAVEPOINT, so it
 * composes cleanly with the outer one. The file write happens as the last
 * step *inside* that transaction: if it throws (permission error, full disk,
 * ...), the transaction wrapper rolls back the user row and roots, so the DB
 * is left exactly as it was before this call — a subsequent call still sees
 * "no admin" and retries cleanly, instead of leaving a permanently
 * unrecoverable, credential-less admin behind.
 */
export async function ensureAdmin(db: Database.Database, config: Config, now: Clock): Promise<void> {
  const existing = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as {
    n: number;
  };
  if (existing.n > 0) {
    return;
  }

  const password = randomToken(12);
  const passwordHash = await createPasswordService(config).hashPassword(password);
  const t = now();

  const credentialPath = path.join(path.dirname(config.DB_PATH), 'admin-credential.txt');
  const content = `username: admin\npassword: ${password}\n`;

  const seedAdmin = db.transaction((): void => {
    const info = db
      .prepare(
        `INSERT INTO users(username, password_hash, role, is_active, must_change_password, created_at, updated_at)
         VALUES ('admin', @passwordHash, 'admin', 1, 1, @t, @t)`,
      )
      .run({ passwordHash, t });

    const adminId = Number(info.lastInsertRowid);
    ensureUserRoots(db, adminId, t);

    fs.writeFileSync(credentialPath, content, { mode: 0o600 });
    // Belt-and-suspenders: writeFileSync's mode only applies when the file is
    // created, and is otherwise subject to the process umask — chmod it
    // explicitly so the credential is never left more permissive than 0600.
    fs.chmodSync(credentialPath, 0o600);
  });

  seedAdmin();

  // Log only that seeding happened and where the credential landed — never
  // the password itself.
  console.log(`admin seeded (credential written to ${credentialPath})`);
}
