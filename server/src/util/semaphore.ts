/**
 * Bounds the number of concurrently in-flight async operations to `max`.
 * Callers beyond the limit queue FIFO and are granted a permit as one frees up.
 * A permit is always released — on both resolve and reject — via try/finally.
 */
export class Semaphore {
  private readonly max: number;
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error('Semaphore max must be a positive integer');
    }
    this.max = max;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }
}
