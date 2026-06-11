/**
 * browserProfiles.ts
 *
 * Persistent per-site stealth-browser sessions (onboarding roadmap A4). Builds on
 * the cookie harvester: instead of only writing a per-site cookies.txt for yt-dlp,
 * we save the FULL Playwright storageState (cookies + localStorage) for a host, and
 * load it back when opening a context for that host — so a gated/members site (or a
 * site behind a one-time Cloudflare clearance) stays signed-in across runs without
 * re-solving the challenge or re-logging-in every time.
 *
 * Cookies are scoped to the site's own registrable domain (reusing the harvester's
 * filter) so we never persist third-party/tracker state. localStorage origins are
 * already origin-scoped, so they're kept as-is.
 *
 * The path + filter logic is pure, so it's unit-tested directly.
 */

import fs from 'fs';
import path from 'path';
import { config } from '../config';
import logger from '../logger';
import { filterCookiesForHost, registrableDomain } from './cookieHarvester';
import type { BrowserContext } from 'playwright-core';

/** Playwright storageState shape (the bits we touch). */
export interface StorageState {
  cookies: any[];
  origins: any[];
}

/** www-stripped host key for a URL (matches the cookie/profile naming). */
export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return ''; }
}

/** Keep only the site's own cookies in a storageState; origins (localStorage)
 *  are origin-scoped already so they're preserved. Pure — unit-tested. */
export function filterStorageState(state: StorageState, host: string): StorageState {
  return {
    cookies: filterCookiesForHost((state.cookies || []) as any, host) as any[],
    origins: Array.isArray(state.origins) ? state.origins : [],
  };
}

/** True when a saved storageState has anything worth persisting. Pure. */
export function isMeaningfulState(state: StorageState): boolean {
  return (state.cookies?.length || 0) > 0 || (state.origins?.length || 0) > 0;
}

export class BrowserProfiles {
  static pathFor(url: string): string | null {
    const host = hostOf(url);
    return host ? path.join(config.profilesDir, `${host}.json`) : null;
  }

  /** All saved per-host session profiles (host, cookie/origin counts, savedAt). */
  static list(dir = config.profilesDir): { host: string; cookies: number; origins: number; savedAt: number }[] {
    try {
      return fs.readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          const file = path.join(dir, f);
          let cookies = 0; let origins = 0;
          try {
            const s = JSON.parse(fs.readFileSync(file, 'utf8')) as StorageState;
            cookies = s.cookies?.length || 0;
            origins = s.origins?.length || 0;
          } catch { /* unreadable profile */ }
          return { host: f.replace(/\.json$/, ''), cookies, origins, savedAt: fs.statSync(file).mtimeMs };
        })
        .sort((a, b) => b.savedAt - a.savedAt);
    } catch {
      return []; // no profiles dir yet
    }
  }

  /** Delete a host's saved session profile. Returns true if a file was removed. */
  static remove(host: string, dir = config.profilesDir): boolean {
    const safe = (host || '').replace(/^www\./, '').toLowerCase().replace(/[^a-z0-9.-]/g, '');
    if (!safe) return false;
    const file = path.join(dir, `${safe}.json`);
    try {
      if (!fs.existsSync(file)) return false;
      fs.unlinkSync(file);
      logger.info({ host: safe }, 'Removed saved session profile');
      return true;
    } catch (err: any) {
      logger.warn({ err: err.message, host: safe }, 'Could not remove session profile');
      return false;
    }
  }

  /** A storageState file path for `browser.newContext({ storageState })`, or
   *  undefined if there's no saved profile for this host. */
  static storageStateOption(url: string): string | undefined {
    const file = this.pathFor(url);
    return file && fs.existsSync(file) ? file : undefined;
  }

  /**
   * Save `context`'s session for `url`'s host (cookies scoped to the site +
   * localStorage). Overwrites any prior profile to keep the session fresh. Returns
   * true if a file was written. Best-effort: never throws into the caller.
   */
  static async save(context: BrowserContext, url: string): Promise<boolean> {
    try {
      const raw = (await context.storageState()) as StorageState;
      return this.saveState(url, raw);
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Saving browser profile failed (continuing)');
      return false;
    }
  }

  /**
   * Save an already-materialised storageState for `url`'s host (cookies scoped to
   * the site). Used when the session was obtained outside Playwright (e.g. a
   * FlareSolverr clearance), so there's no live context to read from. Returns true
   * if a meaningful profile was written. Best-effort: never throws into the caller.
   */
  static saveState(url: string, raw: StorageState): boolean {
    try {
      const file = this.pathFor(url);
      if (!file) return false;
      const host = hostOf(url);
      const scoped = filterStorageState(raw, host);
      if (!isMeaningfulState(scoped)) return false;

      fs.mkdirSync(config.profilesDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(scoped), 'utf8');
      logger.info(
        { host: registrableDomain(host), cookies: scoped.cookies.length, origins: scoped.origins.length },
        'Saved stealth-browser session profile',
      );
      return true;
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Saving browser profile failed (continuing)');
      return false;
    }
  }
}
