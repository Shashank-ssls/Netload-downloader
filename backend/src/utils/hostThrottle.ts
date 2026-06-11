/**
 * hostThrottle.ts
 *
 * Per-host politeness: cap how many downloads target the SAME host at once, so a
 * burst of same-site tasks can't get the IP rate-limited or banned — which would
 * kill every site on that CDN, not just one. Built on the existing Semaphore, one
 * per host, created lazily.
 */

import { Semaphore } from './semaphore';
import { config } from '../config';

export class HostThrottle {
  private static perHost = new Map<string, Semaphore>();

  /** Registrable-ish host key for a URL (www-stripped hostname). */
  static hostOf(url: string): string {
    try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); }
    catch { return 'unknown'; }
  }

  private static sem(host: string): Semaphore {
    let s = this.perHost.get(host);
    if (!s) { s = new Semaphore(config.maxPerHostConcurrent); this.perHost.set(host, s); }
    return s;
  }

  /** Run `fn` while holding a permit for `host` (awaits if the host is saturated). */
  static run<T>(host: string, fn: () => Promise<T>): Promise<T> {
    return this.sem(host).run(fn);
  }

  /** Observability: hosts with work in flight or queued. */
  static stats(): Record<string, { inUse: number; waiting: number }> {
    const out: Record<string, { inUse: number; waiting: number }> = {};
    for (const [host, s] of this.perHost) {
      if (s.inUse > 0 || s.waiting > 0) out[host] = { inUse: s.inUse, waiting: s.waiting };
    }
    return out;
  }
}
