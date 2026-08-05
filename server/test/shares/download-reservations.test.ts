import { describe, it, expect } from 'vitest';
import { createReservations } from '../../src/shares/download-reservations.js';

describe('download reservations', () => {
  it('reserves up to (limit - completed) then rejects', () => {
    const r = createReservations();
    expect(r.tryReserve(1, 0, 1)).toBe(true); // completed 0, limit 1 → ok, inflight 1
    expect(r.tryReserve(1, 0, 1)).toBe(false); // 0 + inflight 1 >= 1 → reject
    expect(r.inFlight(1)).toBe(1);
  });
  it('release frees a slot and deletes the key at zero', () => {
    const r = createReservations();
    r.tryReserve(2, 0, 2);
    r.tryReserve(2, 0, 2);
    r.release(2);
    expect(r.inFlight(2)).toBe(1);
    r.release(2);
    expect(r.inFlight(2)).toBe(0);
  });
  it('release never goes negative', () => {
    const r = createReservations();
    r.release(9);
    expect(r.inFlight(9)).toBe(0);
  });
});
