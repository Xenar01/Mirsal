import { expect, test, vi } from 'vitest';
import { createShutdown, type Closeable, type DbCloseable } from '../src/index.js';

/**
 * Covers the review fix: every shutdown step is isolated, so a throw/reject
 * from an earlier step can never skip a later cleanup step or leave the
 * returned promise rejected (which would otherwise surface as an unhandled
 * promise rejection at the `void shutdown()` call sites in `main()`).
 */

test('createShutdown still closes the db and exits(0) even when app.close() rejects', async () => {
  const app: Closeable = { close: vi.fn().mockRejectedValue(new Error('app.close boom')) };
  const dbClose = vi.fn();
  const db: DbCloseable = { close: dbClose };
  const exit = vi.fn();
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  const shutdown = createShutdown(app, db, exit);

  await expect(shutdown()).resolves.toBeUndefined();

  expect(dbClose).toHaveBeenCalledTimes(1);
  expect(exit).toHaveBeenCalledExactlyOnceWith(0);

  errorSpy.mockRestore();
});

test('createShutdown still exits(0) even when db.close() throws', async () => {
  const app: Closeable = { close: vi.fn().mockResolvedValue(undefined) };
  const db: DbCloseable = {
    close: vi.fn().mockImplementation(() => {
      throw new Error('db.close boom');
    }),
  };
  const exit = vi.fn();
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  const shutdown = createShutdown(app, db, exit);

  await expect(shutdown()).resolves.toBeUndefined();

  expect(app.close).toHaveBeenCalledTimes(1);
  expect(exit).toHaveBeenCalledExactlyOnceWith(0);

  errorSpy.mockRestore();
});

test('createShutdown is idempotent: a second call does nothing', async () => {
  const app: Closeable = { close: vi.fn().mockResolvedValue(undefined) };
  const dbClose = vi.fn();
  const db: DbCloseable = { close: dbClose };
  const exit = vi.fn();

  const shutdown = createShutdown(app, db, exit);
  await shutdown();
  await shutdown();

  expect(app.close).toHaveBeenCalledTimes(1);
  expect(dbClose).toHaveBeenCalledTimes(1);
  expect(exit).toHaveBeenCalledTimes(1);
});
