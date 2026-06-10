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
      context = await BrowserManager.newContext();
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
    if (!tokens) return null;
    headers['Cookie'] = `cf_clearance=${tokens.cfClearance}`;
    return tokens.userAgent;
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
