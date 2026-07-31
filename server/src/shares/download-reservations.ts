/**
 * Per-process in-flight download reservations, keyed by share id. Bounds
 * concurrency so completed+in-flight never exceeds a share's limit. Purely
 * in-memory and ephemeral (empty each boot — a crash can never strand one).
 * All methods are synchronous, so a caller can read the DB's completed count
 * and tryReserve in one await-free block (atomic under Node's single thread).
 */
export interface Reservations {
  /** Reserve one slot iff completed + current in-flight < limit. Returns success. */
  tryReserve(shareId: number, completed: number, limit: number): boolean;
  release(shareId: number): void;
  inFlight(shareId: number): number;
}

export function createReservations(): Reservations {
  const map = new Map<number, number>();
  return {
    tryReserve(shareId, completed, limit) {
      const inflight = map.get(shareId) ?? 0;
      if (completed + inflight >= limit) return false;
      map.set(shareId, inflight + 1);
      return true;
    },
    release(shareId) {
      const n = (map.get(shareId) ?? 0) - 1;
      if (n <= 0) map.delete(shareId);
      else map.set(shareId, n);
    },
    inFlight(shareId) {
      return map.get(shareId) ?? 0;
    },
  };
}
