/**
 * flaresolverr.ts
 *
 * Last-resort Cloudflare recovery via FlareSolverr (authorized use). Some sites —
 * yoyomovies-class — sit behind a Cloudflare Turnstile / managed challenge that
 * refuses to clear for ANY Playwright-driven Chromium (headed or headless): the
 * stealth browser only ever captures the challenge cookie (`cf_chl_rc_ni`), never
 * `cf_clearance`. It's automation-fingerprint detection, not UA, so our own browser
 * can't win. FlareSolverr runs a separate, undetected browser as a local service and
 * does clear these.
 *
 * Flow: POST <endpoint> {cmd:'request.get', url, maxTimeout} → on success the
 * response carries `solution.cookies` (incl. `cf_clearance`) + `solution.userAgent`.
 * We map those into:
 *   1. the immediate yt-dlp retry — a scoped `Cookie` header + the matched UA
 *      (cf_clearance is UA-bound, so the UA must travel with it), and
 *   2. persistence — a per-site `cookies/<host>.txt` (Netscape, for future yt-dlp
 *      runs) + the A4 stealth-browser session profile (so the next browser-fallback
 *      reuses the clearance instead of re-hitting the wall).
 *
 * No-op unless `config.flaresolverrUrl` is set. The response→cookies/header mapping
 * is pure and unit-tested.
 */

import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { config } from '../config';
import logger from '../logger';
import {
  filterCookiesForHost,
  toNetscapeCookies,
  type PlaywrightCookie,
} from '../utils/cookieHarvester';
import { BrowserProfiles, hostOf, type StorageState } from '../utils/browserProfiles';

/** A cookie as returned by FlareSolverr's `solution.cookies` (Playwright shape). */
export interface FlareCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number; // unix seconds, or -1 for a session cookie
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

/** The FlareSolverr `solution` we care about. */
export interface FlareSolution {
  cookies: FlareCookie[];
  userAgent: string;
}

/** The request body FlareSolverr expects. Pure — unit-tested. */
export function buildRequestPayload(url: string, maxTimeoutMs: number): Record<string, unknown> {
  return { cmd: 'request.get', url, maxTimeout: maxTimeoutMs };
}

/** Normalise FlareSolverr's `<base>` to its `/v1` command endpoint (idempotent). */
export function endpointFor(base: string): string {
  const trimmed = (base || '').replace(/\/+$/, '');
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/** FlareSolverr cookies → Playwright cookie shape (the two are already compatible;
 *  this just fills defaults so the harvester/profile helpers can consume them). */
export function toPlaywrightCookies(cookies: FlareCookie[]): PlaywrightCookie[] {
  return (cookies || [])
    .filter((c) => c && c.name)
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain || '',
      path: c.path || '/',
      expires: typeof c.expires === 'number' ? c.expires : -1,
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
    }));
}

/** Find the `cf_clearance` value in a cookie list (the token that proves we cleared
 *  the challenge), or null. Pure — unit-tested. */
export function findCfClearance(cookies: FlareCookie[]): string | null {
  const hit = (cookies || []).find((c) => c && c.name === 'cf_clearance' && c.value);
  return hit ? hit.value : null;
}

/** A `Cookie:` request-header value built from the site's own cookies (scoped to
 *  host). Turnstile sites often set more than `cf_clearance`, so we send them all.
 *  Pure — unit-tested. */
export function cookieHeaderFor(cookies: FlareCookie[], host: string): string {
  const scoped = filterCookiesForHost(toPlaywrightCookies(cookies), host);
  return scoped.map((c) => `${c.name}=${c.value}`).join('; ');
}

/** FlareSolverr cookies → a Netscape `cookies.txt` body scoped to `host`. Pure. */
export function flareCookiesToNetscape(cookies: FlareCookie[], host: string): string {
  const scoped = filterCookiesForHost(toPlaywrightCookies(cookies), host);
  return toNetscapeCookies(scoped);
}

/** Normalise FlareSolverr's sameSite to a value Playwright's storageState accepts. */
function normSameSite(v: string | undefined): 'Strict' | 'Lax' | 'None' {
  switch ((v || '').toLowerCase()) {
    case 'strict': return 'Strict';
    case 'none':
    case 'no_restriction': return 'None';
    default: return 'Lax';
  }
}

/** FlareSolverr cookies → a Playwright storageState scoped to `host` (no localStorage
 *  origins — FlareSolverr doesn't expose them). Pure — unit-tested. */
export function flareCookiesToStorageState(cookies: FlareCookie[], host: string): StorageState {
  const scoped = filterCookiesForHost(toPlaywrightCookies(cookies), host);
  const raw = cookies || [];
  return {
    cookies: scoped.map((c) => {
      const orig = raw.find((r) => r.name === c.name);
      return {
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: normSameSite(orig?.sameSite),
      };
    }),
    origins: [],
  };
}

export class FlareSolverr {
  /** Is a FlareSolverr endpoint configured? */
  static get enabled(): boolean {
    return !!config.flaresolverrUrl;
  }

  /** Drive FlareSolverr to fetch `url` and return its solution (cookies + UA), or
   *  null if it's not configured / didn't succeed. */
  static async solve(url: string): Promise<FlareSolution | null> {
    if (!this.enabled) return null;
    const endpoint = endpointFor(config.flaresolverrUrl);
    try {
      logger.info({ url, endpoint }, 'Requesting Cloudflare clearance via FlareSolverr...');
      const { data } = await axios.post(
        endpoint,
        buildRequestPayload(url, config.flaresolverrTimeoutMs),
        // FlareSolverr can take a while to drive its browser; give it the configured
        // budget plus headroom for its own startup/teardown.
        { timeout: config.flaresolverrTimeoutMs + 30000, headers: { 'Content-Type': 'application/json' } },
      );

      if (!data || data.status !== 'ok' || !data.solution) {
        logger.warn({ url, status: data?.status, message: data?.message }, 'FlareSolverr did not return a solution');
        return null;
      }
      const solution = data.solution as { cookies?: FlareCookie[]; userAgent?: string };
      const cookies = Array.isArray(solution.cookies) ? solution.cookies : [];
      const userAgent = solution.userAgent || '';
      logger.info({ url, cookies: cookies.length, hasClearance: !!findCfClearance(cookies) }, 'FlareSolverr returned a solution');
      return { cookies, userAgent };
    } catch (err: any) {
      logger.warn({ url, endpoint, err: err.message }, 'FlareSolverr request failed');
      return null;
    }
  }

  /**
   * Clear `url` via FlareSolverr and wire the result into the current retry:
   * inject a scoped `Cookie` header into `headers` (mutates it) and return the
   * matched User-Agent. Also persists the session for future runs — a per-site
   * `cookies/<host>.txt` (unless a manual export already exists) and the A4 stealth
   * profile. Returns null when FlareSolverr is unconfigured, fails, or produced no
   * `cf_clearance`. Mirrors `CloudflareRecoveryManager.harvestAndInject`.
   */
  static async harvestAndInject(url: string, headers: Record<string, string>): Promise<string | null> {
    const solution = await this.solve(url);
    if (!solution) return null;

    const clearance = findCfClearance(solution.cookies);
    if (!clearance) {
      logger.warn({ url }, 'FlareSolverr cleared the page but no cf_clearance cookie was present');
      return null;
    }

    const host = hostOf(url);
    const cookieHeader = cookieHeaderFor(solution.cookies, host);
    if (cookieHeader) headers['Cookie'] = cookieHeader;

    // Persist for future yt-dlp runs (don't clobber a manual/earlier export).
    try {
      const file = path.join(config.cookiesDir, `${host}.txt`);
      if (!fs.existsSync(file)) {
        fs.mkdirSync(config.cookiesDir, { recursive: true });
        fs.writeFileSync(file, flareCookiesToNetscape(solution.cookies, host), 'utf8');
        logger.info({ host, file }, 'Wrote FlareSolverr cookies to per-site cookies.txt');
      }
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Persisting FlareSolverr cookies.txt failed (continuing)');
    }

    // Seed the A4 stealth-browser profile so the next browser fallback reuses it.
    BrowserProfiles.saveState(url, flareCookiesToStorageState(solution.cookies, host));

    logger.info({ url, clearance: clearance.substring(0, 20) + '...' }, 'FlareSolverr clearance injected');
    return solution.userAgent || null;
  }
}
