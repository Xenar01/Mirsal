import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { openDb } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { ensureAdmin } from './seed.js';
import { buildApp } from './app.js';
import { startScheduler, stopScheduler } from './scheduler/runner.js';
import { systemClock } from './clock.js';

/**
 * The real server entrypoint: load config, open + migrate the DB, seed the
 * first-boot admin, build the app, start the cleanup scheduler, and start
 * listening. Host nginx reverse-proxies `127.0.0.1:8084` (global
 * constraints) — that host/port pair is fixed, not configurable.
 */
async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const db = openDb(config.DB_PATH);
  migrate(db);
  await ensureAdmin(db, config, systemClock);

  const app = await buildApp({ db, config, now: systemClock });
  startScheduler(db, systemClock);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopScheduler();
    await app.close();
    db.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    void shutdown();
  });
  process.on('SIGINT', () => {
    void shutdown();
  });

  await app.listen({ host: '127.0.0.1', port: 8084 });
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
