import { config } from '../config';

/**
 * Blocks analyze/download targets that resolve to private, loopback, or
 * link-local addresses (a basic SSRF guard — this tool fetches arbitrary URLs).
 * Literal-IP and obvious local hostnames are rejected; DNS-rebinding is out of
 * scope. Set ALLOW_PRIVATE_URLS=true to bypass for local testing.
 */
export class SsrfGuard {
  private static LOCAL_HOST_PATTERNS = [/^localhost$/i, /\.local$/i, /\.internal$/i, /\.localhost$/i];

  static isBlockedHost(hostname: string): boolean {
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
    if (!h) return true;
    if (this.LOCAL_HOST_PATTERNS.some((p) => p.test(h))) return true;

    // IPv6 loopback / unique-local (fc00::/7) / link-local (fe80::/10)
    if (h === '::1') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
    if (/^fe80:/.test(h)) return true;

    // IPv4 literal
    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
      const [a, b] = [Number(m[1]), Number(m[2])];
      if (a === 0 || a === 10 || a === 127) return true; // this-net, private, loopback
      if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
      if (a === 172 && b >= 16 && b <= 31) return true; // private
      if (a === 192 && b === 168) return true; // private
      if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    }
    return false;
  }

  /** Throws BLOCKED_PRIVATE_URL for a disallowed host (no-op when allowPrivateUrls). */
  static assertSafe(url: string): void {
    if (config.allowPrivateUrls) return;
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      throw new Error('INVALID_URL');
    }
    if (this.isBlockedHost(hostname)) throw new Error('BLOCKED_PRIVATE_URL');
  }
}
