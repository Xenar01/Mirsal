import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { openDb } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { ensureAdmin } from './seed.js';
import { buildApp } from './app.js';
import { startScheduler, stopScheduler } from './scheduler/runner.js';
import { systemClock } from './clock.js';

/** The subset of Fastify's app that shutdown needs — narrowed for testability. */
export interface Closeable {
  close(): Promise<unknown>;
}

/** The subset of better-sqlite3's Database that shutdown needs — narrowed for testability. */
export interface DbCloseable {
  close(): unknown;
}

/**
 * Builds an idempotent shutdown handler: stops the cleanup scheduler, closes
 * the app, closes the db, then exits. Every step is individually wrapped in
 * try/catch so a throw or a rejected `app.close()` can never skip a later
 * cleanup step or leave the returned promise rejected — an un-guarded
 * rejection here would otherwise surface as an unhandled promise rejection
 * (the caller only ever does `void shutdown()`) and could crash the process
 * before `db.close()`/`exit()` ran, defeating the graceful-shutdown
 * contract. Exported so this failure-isolation behavior is unit-testable
 * without a real bound port or real OS signals.
 */
export function createShutdown(
  app: Closeable,
  db: DbCloseable,
  exit: (code: number) => void = (code) => process.exit(code)
): () => Promise<void> {
  let shuttingDown = false;

  return async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    try {
      stopScheduler();
    } catch (err) {
      console.error('shutdown: stopScheduler failed', err);
    }

    try {
      await app.close();
    } catch (err) {
      console.error('shutdown: app.close failed', err);
    }

    try {
      db.close();
    } catch (err) {
      console.error('shutdown: db.close failed', err);
    }

    exit(0);
  };
}

/**
 * The real server entrypoint: load config, open + migrate the DB, seed the
 * first-boot admin, build the app, start the cleanup scheduler, and start
 * listening. Host nginx reverse-proxies port `8084`; the bind address is
 * `config.HOST` (default loopback for a direct run, `0.0.0.0` inside the
 * container where the compose publish `127.0.0.1:8084:8084` confines exposure).
 */
async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const db = openDb(config.DB_PATH);
  migrate(db);
  await ensureAdmin(db, config, systemClock);

  const app = await buildApp({ db, config, now: systemClock });
  startScheduler(db, systemClock);

  const shutdown = createShutdown(app, db);

  process.on('SIGTERM', () => {
    void shutdown();
  });
  process.on('SIGINT', () => {
    void shutdown();
  });

  await app.listen({ host: config.HOST, port: 8084 });
}

// Guard: only run (and bind a real port) when this module is the actual
// process entrypoint, never as a side effect of another module (or a test)
// importing it.
const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
