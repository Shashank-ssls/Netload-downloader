/**
 * cookieHarvester.ts
 *
 * Smaller reach item: reuse the stealth browser's cookies. When Tier 2 renders a
 * site (and solves any Cloudflare/login challenge), the browser context holds the
 * session cookies the CDN expects. Persisting them as a per-site `cookies.txt`
 * lets subsequent yt-dlp calls authenticate without the user hand-exporting
 * cookies — it pairs with the per-site CookieResolver (utils/cookieResolver.ts).
 *
 * We never clobber an existing cookie file (a manual/earlier export wins), so this
 * only fills the gap for sites the user hasn't already provided cookies for.
 */

import fs from 'fs';
import path from 'path';
import { config } from '../config';
import logger from '../logger';
import type { BrowserContext } from 'playwright-core';

export interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;   // unix seconds, or -1 for a session cookie
  httpOnly: boolean;
  secure: boolean;
}

/**
 * Convert Playwright cookies to the Netscape `cookies.txt` format yt-dlp reads.
 * Columns: domain, includeSubdomains, path, secure, expiry, name, value (tabs).
 * Pure, so it's unit-tested directly.
 */
export function toNetscapeCookies(cookies: PlaywrightCookie[]): string {
  const lines = ['# Netscape HTTP Cookie File', '# Auto-harvested by netload-downloader', ''];
  for (const c of cookies) {
    if (!c.name) continue;
    const includeSub = c.domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const expires = c.expires && c.expires > 0 ? Math.floor(c.expires) : 0;
    lines.push([
      c.domain,
      includeSub,
      c.path || '/',
      c.secure ? 'TRUE' : 'FALSE',
      String(expires),
      c.name,
      c.value,
    ].join('\t'));
  }
  return lines.join('\n') + '\n';
}

export class CookieHarvester {
  /**
   * Persist `context`'s cookies to the per-site cookies file for `pageUrl`'s host
   * (Netscape format), unless a cookie file already exists for that host. Returns
   * true if a file was written. Best-effort: never throws into the caller.
   */
  static async harvest(context: BrowserContext, pageUrl: string): Promise<boolean> {
    try {
      const host = new URL(pageUrl).hostname.replace(/^www\./, '');
      const file = path.join(config.cookiesDir, `${host}.txt`);
      if (fs.existsSync(file)) return false; // don't clobber a manual/earlier export

      const cookies = (await context.cookies()) as PlaywrightCookie[];
      if (!cookies || cookies.length === 0) return false;

      fs.mkdirSync(config.cookiesDir, { recursive: true });
      fs.writeFileSync(file, toNetscapeCookies(cookies), 'utf8');
      logger.info({ host, count: cookies.length, file }, 'Harvested stealth-browser cookies for site');
      return true;
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Cookie harvest failed (continuing)');
      return false;
    }
  }
}
