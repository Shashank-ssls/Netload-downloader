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
