/**
 * Behavior-inferred recovery hints for UNLISTED (generic) sites — the ones with
 * no hardcoded provider entry. Rather than maintain a hostname list for every CDN
 * that wants a Referer, we infer it from the failure: on a forbidden/blocked
 * error with no Referer yet set, suggest a self-referer (the site's own origin)
 * for the next attempt. This is intentionally only used for `GenericProvider` so
 * it can never override a listed provider's deliberate header tactics.
 */

// Error codes where a missing Referer is a plausible cause (a 403 maps to
// CLOUDFLARE_BLOCKED in classifyError, so it's covered here too).
const FORBIDDEN_SIGNALS = ['CLOUDFLARE_BLOCKED', 'DOWNLOAD_FAILED', 'UNKNOWN_ERROR'];

/**
 * Headers to add for the next retry, or null if nothing should change. Returns
 * null once a Referer is already set (one-shot escalation, no repeats).
 */
export function inferRecoveryHeaders(
  errorType: string,
  url: string,
  hasReferer: boolean,
): Record<string, string> | null {
  if (hasReferer || !FORBIDDEN_SIGNALS.includes(errorType)) return null;
  try {
    const origin = new URL(url).origin;
    return { Referer: `${origin}/`, Origin: origin };
  } catch {
    return null;
  }
}
