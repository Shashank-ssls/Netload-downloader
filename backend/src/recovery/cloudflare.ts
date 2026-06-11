/**
 * cloudflare.ts
 * Real Cloudflare clearance harvesting.
 *
 * Flow:
 *  1. Open isolated stealth Chromium context
 *  2. Warm-up: visit domain root to prime CF cookies
 *  3. Navigate to blocked URL, detect JS challenge page
 *  4. Wait for cf_clearance cookie to appear (challenge auto-solves in stealth browser)
 *  5. Return cookie + matched User-Agent for yt-dlp injection
 */

import logger from '../logger';
import { BrowserManager } from '../utils/browserManager';
import { BrowserHelpers } from '../utils/browserHelpers';
import { BrowserProfiles } from '../utils/browserProfiles';
import { FlareSolverr } from './flaresolverr';

export interface CloudflareTokens {
  cfClearance: string;
  userAgent: string;
}

export class CloudflareRecoveryManager {
  static readonly MAX_RETRIES = 3;
  static readonly BASE_COOLDOWN_MS = 2000;
  static readonly CF_TIMEOUT_MS = 60000;

  static async harvestClearance(url: string): Promise<CloudflareTokens | null> {
    let context = null;
    let page = null;

    try {
      logger.info({ url }, 'Starting CF clearance harvest...');
      context = await BrowserManager.newContext({ url }); // reuse a prior session if any
      page = await context.newPage();

      // Warm-up: hit the domain root to establish a base CF session
      const origin = new URL(url).origin;
      try {
        await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(2000);
        logger.info({ origin }, 'Domain warm-up complete');
      } catch { /* non-fatal */ }

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.CF_TIMEOUT_MS });

      // Detect and solve CF challenge
      await BrowserHelpers.solveCFChallenge(page);

      // Poll for cf_clearance cookie (up to CF_TIMEOUT_MS)
      const startTime = Date.now();
      let cfClearance: string | null = null;
      while (Date.now() - startTime < this.CF_TIMEOUT_MS) {
        const cookies = await context.cookies().catch(() => []);
        const cfCookie = cookies.find(c => c.name === 'cf_clearance');
        if (cfCookie) { cfClearance = cfCookie.value; break; }
        await page.waitForTimeout(1500);
      }

      if (!cfClearance) {
        logger.warn({ url }, 'cf_clearance did not appear within timeout');
        return null;
      }

      const userAgent = await page.evaluate(() => navigator.userAgent);
      // Persist the cleared session so the next run reuses it instead of re-solving.
      await BrowserProfiles.save(context, url).catch(() => {});
      logger.info({ url, cookie: cfClearance.substring(0, 20) + '...' }, 'CF clearance harvested');
      return { cfClearance, userAgent };

    } catch (err: any) {
      logger.error({ url, err: err.message }, 'CF clearance harvest failed');
      return null;
    } finally {
      await page?.close().catch(() => {});
      await context?.close().catch(() => {});
    }
  }

  /**
   * Harvest a CF clearance for `url` and inject the cookie into `headers`
   * (mutates it). Returns the matched User-Agent on success, or null. Shared by
   * the analyze and download recovery loops, which previously duplicated this
   * exact block.
   */
  static async harvestAndInject(url: string, headers: Record<string, string>): Promise<string | null> {
    const tokens = await this.harvestClearance(url);
    if (tokens) {
      headers['Cookie'] = `cf_clearance=${tokens.cfClearance}`;
      return tokens.userAgent;
    }
    // Stealth Chromium couldn't clear it (e.g. a Turnstile managed challenge that
    // fingerprint-blocks Playwright). Fall back to FlareSolverr's undetected browser
    // if one is configured — it injects its own scoped Cookie header + matched UA.
    if (FlareSolverr.enabled) {
      logger.info({ url }, 'Stealth CF harvest failed — falling back to FlareSolverr');
      return FlareSolverr.harvestAndInject(url, headers);
    }
    return null;
  }

  static buildCFArgs(tokens: CloudflareTokens): string[] {
    return [
      '--add-header', `Cookie:cf_clearance=${tokens.cfClearance}`,
      '--user-agent', tokens.userAgent,
    ];
  }

  static getRecoveryArgs(attempt: number): string[] {
    return [
      '--extractor-args', 'generic:impersonate',
      '--sleep-interval', String(attempt * 2),
      '--max-sleep-interval', String(attempt * 4),
    ];
  }

  // Distinct browser fingerprints to rotate through when a site keeps blocking
  // us. yt-dlp/curl_cffi reliably support these --impersonate targets.
  static readonly IMPERSONATE_ROTATION = ['chrome', 'safari', 'edge'];

  /**
   * Pick the `--impersonate` target for an attempt. The provider's default is used
   * on the first try; on subsequent tries (persistent 403/blocks) we rotate through
   * distinct browser fingerprints, since a CDN may fingerprint-block one client.
   * Pure, so it's unit-tested directly.
   */
  static cycleImpersonateTarget(attempt: number, providerDefault: string | null): string | null {
    if (attempt <= 1) return providerDefault;
    return this.IMPERSONATE_ROTATION[(attempt - 2) % this.IMPERSONATE_ROTATION.length];
  }

  /**
   * Force yt-dlp's generic extractor (with impersonation) — a cheap retry for a
   * non-generic provider whose dedicated extractor went stale, tried BEFORE
   * spinning up the headless browser. The captured player headers still apply.
   */
  static genericExtractorArgs(): string[] {
    return ['--force-generic-extractor', '--extractor-args', 'generic:impersonate'];
  }

  static async waitCooldown(attempt: number): Promise<void> {
    const delay = this.BASE_COOLDOWN_MS * Math.pow(2, attempt - 1);
    const jitter = Math.floor(Math.random() * 1000);
    logger.info({ attempt, delayMs: delay + jitter }, 'Cloudflare cooldown active');
    return new Promise(resolve => setTimeout(resolve, delay + jitter));
  }

  static isRecoverable(errorType: string): boolean {
    return [
      'CLOUDFLARE_BLOCKED', 'RATE_LIMITED', 'NETWORK_TIMEOUT',
      'CONNECTION_RESET', 'FORMAT_UNAVAILABLE', 'UNKNOWN_ERROR',
      'UNSUPPORTED_URL', 'DOWNLOAD_FAILED', 'DYNAMIC_CONTENT_UNSUPPORTED'
    ].includes(errorType);
  }
}
