/**
 * remedy.ts
 *
 * Turn a settled task into the exact one-line action a user should take — so a
 * gated preview or a Cloudflare block tells you to run `netload login <host>`
 * instead of leaving you to guess. Pure (no I/O), so it's unit-tested and reusable
 * by the CLI display layer. (The stored note/error CODES are left untouched — they
 * key the metrics rollup — this only derives a human remedy for display.)
 */

export interface SettledTask {
  status?: string;
  note?: string;
  error?: string;
  url?: string;
}

function hostOf(url?: string): string {
  try { return new URL(url || '').hostname.replace(/^www\./, ''); }
  catch { return 'the site'; }
}

/** A short remedy string for a settled task, or null when no action helps. */
export function suggestRemedy(task: SettledTask): string | null {
  const host = hostOf(task.url);

  if (task.note === 'LIKELY_PREVIEW_ADD_COOKIES') {
    return `Gated preview — run: netload login ${host}   (or add cookies/${host}.txt) for the full video`;
  }
  if (task.error === 'CLOUDFLARE_BLOCKED') {
    return `Cloudflare blocked — run: netload login ${host}   to clear it once (then it's reused), or set FLARESOLVERR_URL to clear Turnstile automatically`;
  }
  if (task.error === 'DRM_PROTECTED') {
    return 'DRM-protected — cannot be downloaded';
  }
  if (task.error === 'AUTH_REQUIRED' || task.error === 'COOKIE_INVALID') {
    return `Login required — run: netload login ${host}   (or add cookies/${host}.txt)`;
  }
  return null;
}
