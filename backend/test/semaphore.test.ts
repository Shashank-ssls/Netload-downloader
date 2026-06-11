import { describe, it, expect } from 'vitest';
import { Semaphore } from '../src/utils/semaphore';

describe('Semaphore', () => {
  it('rejects an invalid capacity', () => {
    expect(() => new Semaphore(0)).toThrow();
  });

  it('grants up to `max` permits immediately, then queues', async () => {
    const s = new Semaphore(2);
    await s.acquire();
    await s.acquire();
    expect(s.inUse).toBe(2);
    expect(s.available).toBe(0);

    let third = false;
    const p = s.acquire().then(() => { third = true; });
    await Promise.resolve();
    expect(third).toBe(false);   // blocked — no permit free
    expect(s.waiting).toBe(1);

    s.release();                 // hand the permit to the waiter
    await p;
    expect(third).toBe(true);
    expect(s.waiting).toBe(0);
    expect(s.inUse).toBe(2);     // still 2 in use (the waiter took the freed one)
  });

  it('releases permits FIFO', async () => {
    const s = new Semaphore(1);
    await s.acquire();
    const order: number[] = [];
    const a = s.acquire().then(() => order.push(1));
    const b = s.acquire().then(() => order.push(2));
    const c = s.acquire().then(() => order.push(3));

    s.release(); await a;
    s.release(); await b;
    s.release(); await c;
    expect(order).toEqual([1, 2, 3]);
  });

  it('does not exceed `max` available when over-released', () => {
    const s = new Semaphore(2);
    s.release();                 // spurious release
    s.release();
    expect(s.available).toBe(2); // capped at max — no phantom permits
  });

  it('run() always releases, even when the task throws', async () => {
    const s = new Semaphore(1);
    await expect(s.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(s.available).toBe(1); // permit returned despite the throw
    const out = await s.run(async () => 42);
    expect(out).toBe(42);
  });

  it('serialises work through run() under contention', async () => {
    const s = new Semaphore(1);
    let active = 0;
    let maxActive = 0;
    const task = async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    };
    await Promise.all([s.run(task), s.run(task), s.run(task)]);
    expect(maxActive).toBe(1);   // never more than one at a time
  });
});
