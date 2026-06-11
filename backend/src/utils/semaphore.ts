/**
 * semaphore.ts
 *
 * A minimal async counting semaphore. Used to cap how many stealth-Chromium
 * contexts can exist at once (browserManager): every media-extraction path —
 * Tier 2 capture, segment stitch, MSE capture, DASH pre-check, diagnose, CF
 * harvest — opens a context, and an unbounded queue of downloads could otherwise
 * launch enough heavy rendered pages to exhaust memory.
 *
 * Fair (FIFO): a released permit is handed directly to the longest-waiting
 * acquirer, so no caller can be starved.
 */
export class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {
    if (max < 1) throw new Error('Semaphore max must be >= 1');
    this.permits = max;
  }

  /** Resolves immediately if a permit is free, otherwise queues until one frees. */
  acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  /** Return a permit — handed directly to the next waiter if any are queued. */
  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next(); // permit passes straight to the waiter; count stays the same
    } else if (this.permits < this.max) {
      this.permits++;
    }
  }

  /** Acquire, run `fn`, and always release — even if `fn` throws. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  get available(): number { return this.permits; }
  get waiting(): number { return this.waiters.length; }
  get inUse(): number { return this.max - this.permits; }
  get capacity(): number { return this.max; }
}
