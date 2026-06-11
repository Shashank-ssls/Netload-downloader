/**
 * Pure outcome-classification for the reach corpus (`netload corpus`). Kept
 * separate from the CLI's I/O so the pass/fail semantics are unit-testable.
 */

export type Outcome = string; // 'ok' | 'preview' | 'auth' | 'resolved' | `error:CODE`

export interface AnalyzeLike {
  isLikelyPreview?: boolean;
  requiresAuth?: boolean;
  title?: string;
  duration?: number;
}

/** Classify a successful /api/analyze result into a coarse reach outcome. */
export function classifyOutcome(result: AnalyzeLike): Outcome {
  if (result.isLikelyPreview) return 'preview';
  if (result.requiresAuth) return 'auth';
  if (result.title && (result.duration ?? 0) > 0) return 'ok';
  return 'resolved'; // got something (e.g. formats) but no duration
}

/**
 * Does the actual outcome satisfy the entry's expectation?
 *  - omitted / 'resolve' → any non-error outcome passes (lenient default)
 *  - 'error'             → any error passes
 *  - anything else       → exact match ('ok' | 'preview' | 'auth' | 'resolved' | 'error:CODE')
 */
export function matchesExpect(expect: string | undefined, actual: Outcome): boolean {
  const exp = expect || 'resolve';
  if (exp === 'resolve') return !actual.startsWith('error');
  if (exp === 'error') return actual.startsWith('error');
  return exp === actual;
}

// ─── Richer fixtures + report card (A3) ───────────────────────────────────────

/** Object form of an entry's expectation (string form still supported). */
export interface Expectation {
  outcome?: string;        // ok | preview | auth | resolved | resolve | error | error:CODE
  minDurationSec?: number; // analyze-reported duration floor
  extractor?: string;      // yt-dlp extractor that should have handled it (case-insensitive)
}

/**
 * Evaluate an entry against the FULL analyze result (not just the coarse outcome),
 * supporting a duration floor and an expected extractor on top of the outcome.
 * Returns the pass/fail plus a human reason for the report card. Pure.
 */
export function evaluateExpectation(
  expect: string | Expectation | undefined,
  result: AnalyzeLike & { extractor?: string },
): { ok: boolean; actual: Outcome; reason: string } {
  const actual = classifyOutcome(result);

  if (expect === undefined || typeof expect === 'string') {
    const ok = matchesExpect(expect, actual);
    return { ok, actual, reason: ok ? '' : `expected ${expect || 'resolve'}, got ${actual}` };
  }

  if (expect.outcome) {
    if (!matchesExpect(expect.outcome, actual)) return { ok: false, actual, reason: `expected ${expect.outcome}, got ${actual}` };
  } else if (actual.startsWith('error')) {
    return { ok: false, actual, reason: `got ${actual}` };
  }
  if (expect.minDurationSec !== undefined && (result.duration ?? 0) < expect.minDurationSec) {
    return { ok: false, actual, reason: `duration ${result.duration ?? 0}s < ${expect.minDurationSec}s` };
  }
  if (expect.extractor && (result.extractor || '').toLowerCase() !== expect.extractor.toLowerCase()) {
    return { ok: false, actual, reason: `extractor ${result.extractor || 'none'} != ${expect.extractor}` };
  }
  return { ok: true, actual, reason: '' };
}

/** Pass/total per category for the report card. Pure. */
export function summarizeByCategory(rows: { category?: string; ok: boolean }[]): Record<string, { pass: number; total: number }> {
  const out: Record<string, { pass: number; total: number }> = {};
  for (const r of rows) {
    const cat = r.category || 'uncategorized';
    const s = out[cat] || { pass: 0, total: 0 };
    s.total++;
    if (r.ok) s.pass++;
    out[cat] = s;
  }
  return out;
}

/**
 * Compare this run's per-URL pass map against the previous run's: a regression is
 * a URL that passed before and fails now; a recovery is the reverse. Pure — this
 * is what turns the corpus into a guard rather than a one-shot probe.
 */
export function diffRuns(
  prev: Record<string, boolean>,
  curr: Record<string, boolean>,
): { regressions: string[]; recoveries: string[] } {
  const regressions: string[] = [];
  const recoveries: string[] = [];
  for (const [url, ok] of Object.entries(curr)) {
    if (prev[url] === true && ok === false) regressions.push(url);
    if (prev[url] === false && ok === true) recoveries.push(url);
  }
  return { regressions, recoveries };
}
