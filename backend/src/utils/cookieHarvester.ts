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

/** Registrable-ish domain: the last two labels (e.g. a.b.example.com → example.com).
 *  A heuristic (no public-suffix list), good enough to scope cookies to the site. */
export function registrableDomain(host: string): string {
  const h = host.replace(/^\./, '').toLowerCase();
  const labels = h.split('.');
  return labels.length <= 2 ? h : labels.slice(-2).join('.');
}

/**
 * Keep only cookies belonging to the page's own site, dropping unrelated
 * third-party/ad/tracker cookies. Avoids writing a pile of someone else's session
 * cookies to disk (privacy) and keeps the per-site file lean. Pure — unit-tested.
 */
export function filterCookiesForHost(cookies: PlaywrightCookie[], host: string): PlaywrightCookie[] {
  const reg = registrableDomain(host);
  const h = host.replace(/^\./, '').toLowerCase();
  return cookies.filter((c) => {
    const cd = (c.domain || '').replace(/^\./, '').toLowerCase();
    if (!cd) return false;
    return cd === h || cd === reg || cd.endsWith('.' + reg);
  });
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

      const all = (await context.cookies()) as PlaywrightCookie[];
      // Scope to the site's own cookies — never persist third-party/tracker cookies.
      const cookies = filterCookiesForHost(all || [], host);
      if (cookies.length === 0) return false;

      fs.mkdirSync(config.cookiesDir, { recursive: true });
      fs.writeFileSync(file, toNetscapeCookies(cookies), 'utf8');
      logger.info({ host, count: cookies.length, dropped: (all?.length || 0) - cookies.length, file }, 'Harvested stealth-browser cookies for site');
      return true;
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Cookie harvest failed (continuing)');
      return false;
    }
  }
}
