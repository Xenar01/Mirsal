import { expect, test } from 'vitest';
import { Semaphore } from '../../src/util/semaphore.js';

test('bounds concurrent execution to max and runs every queued task to completion', async () => {
  const s = new Semaphore(2);
  let active = 0;
  let peak = 0;
  let completed = 0;

  const tasks = Array.from({ length: 10 }, () =>
    s.run(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      completed++;
    }),
  );

  await Promise.all(tasks);

  expect(peak).toBeLessThanOrEqual(2);
  expect(completed).toBe(10);
});

test('releases the permit when a task rejects, so queued tasks still run (try/finally)', async () => {
  const s = new Semaphore(1);

  await expect(
    s.run(async () => {
      throw new Error('boom');
    }),
  ).rejects.toThrow('boom');

  await expect(s.run(async () => 42)).resolves.toBe(42);
});

test('rejects construction with a non-positive max', () => {
  expect(() => new Semaphore(0)).toThrow();
  expect(() => new Semaphore(-1)).toThrow();
});
