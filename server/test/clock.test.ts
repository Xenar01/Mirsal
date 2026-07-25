import { expect, test } from 'vitest';
import { systemClock } from '../src/clock.js';

test('clock returns ms number', () => {
  const t = systemClock();
  expect(typeof t).toBe('number');
  expect(t).toBeGreaterThan(1_700_000_000_000);
});
