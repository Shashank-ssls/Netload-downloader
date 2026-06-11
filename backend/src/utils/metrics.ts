/**
 * metrics.ts
 *
 * Per-provider download outcome counters, so you can SEE which provider/site class
 * is regressing (and why) before a user reports it — pairs with the corpus report
 * card on the roadmap. In-memory + process-lifetime (cheap, observable via
 * /api/health); not meant to be durable analytics.
 */

import { categorizeError, type ErrorCategory } from './errorCatalog';

export interface ProviderStats {
  attempts: number;
  successes: number;
  failures: number;
  byError: Record<string, number>;
}

export interface ProviderSnapshot extends ProviderStats {
  successRate: number;                         // 0..1, rounded to 3dp
  byCategory: Partial<Record<ErrorCategory, number>>;
}

export class Metrics {
  private static byProvider = new Map<string, ProviderStats>();

  private static get(provider: string): ProviderStats {
    let s = this.byProvider.get(provider);
    if (!s) { s = { attempts: 0, successes: 0, failures: 0, byError: {} }; this.byProvider.set(provider, s); }
    return s;
  }

  static recordSuccess(provider: string): void {
    const s = this.get(provider);
    s.attempts++; s.successes++;
  }

  static recordFailure(provider: string, errorCode: string): void {
    const s = this.get(provider);
    s.attempts++; s.failures++;
    const code = errorCode || 'UNKNOWN_ERROR';
    s.byError[code] = (s.byError[code] || 0) + 1;
  }

  /** Per-provider rollup with success rate + failure-category breakdown. */
  static snapshot(): Record<string, ProviderSnapshot> {
    const out: Record<string, ProviderSnapshot> = {};
    for (const [provider, s] of this.byProvider) {
      const byCategory: Partial<Record<ErrorCategory, number>> = {};
      for (const [code, n] of Object.entries(s.byError)) {
        const cat = categorizeError(code);
        byCategory[cat] = (byCategory[cat] || 0) + n;
      }
      out[provider] = {
        ...s,
        successRate: s.attempts ? Math.round((s.successes / s.attempts) * 1000) / 1000 : 0,
        byCategory,
      };
    }
    return out;
  }

  /** Test helper. */
  static reset(): void {
    this.byProvider.clear();
  }
}
