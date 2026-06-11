/**
 * errorCatalog.ts
 *
 * A structured taxonomy over the string error codes the providers / yt-dlp
 * classifier emit. The codes themselves stay as-is (they flow through retries and
 * the task record); this just groups them into categories so metrics can roll up
 * "why downloads fail" at a glance (e.g. mostly `blocked` vs `auth` vs `system`).
 */

export type ErrorCategory =
  | 'auth' | 'blocked' | 'network' | 'unavailable'
  | 'drm' | 'unsupported' | 'system' | 'unknown';

const ERROR_CATEGORY: Record<string, ErrorCategory> = {
  AUTH_REQUIRED: 'auth',
  COOKIE_INVALID: 'auth',

  RATE_LIMITED: 'blocked',
  CLOUDFLARE_BLOCKED: 'blocked',
  GEO_BLOCKED: 'blocked',

  NETWORK_TIMEOUT: 'network',
  CONNECTION_RESET: 'network',

  VIDEO_UNAVAILABLE: 'unavailable',
  FORMAT_UNAVAILABLE: 'unavailable',

  DRM_PROTECTED: 'drm',

  UNSUPPORTED_URL: 'unsupported',
  DYNAMIC_CONTENT_UNSUPPORTED: 'unsupported',

  FFMPEG_MISSING: 'system',
  DISK_FULL: 'system',

  DOWNLOAD_FAILED: 'unknown',
  UNKNOWN_ERROR: 'unknown',
  MAX_RETRIES_EXCEEDED: 'unknown',
  SEGMENTED_STREAM_UNRESOLVED: 'unknown',
  MSE_STREAM_UNRESOLVED: 'unknown',
};

/** Map an error code to its category (unknown for anything unrecognised). Pure. */
export function categorizeError(code: string): ErrorCategory {
  return ERROR_CATEGORY[code] || 'unknown';
}
