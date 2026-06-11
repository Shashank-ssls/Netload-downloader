/**
 * interactiveLogin.ts
 *
 * One-time interactive login / manual challenge solve, capturing the result as a
 * persistent per-site session profile (the A4 capstone). For sites that the
 * stealth browser can't pass automatically — a real login (hanime, members-only)
 * or a stubborn Cloudflare/Turnstile interstitial (yoyomovies) — we open a VISIBLE
 * browser, the user signs in / clicks through ONCE, and we save the resulting
 * cookies + localStorage. Every later headless run for that host reuses the
 * profile (BrowserManager.newContext({ url })), so the download just works.
 *
 * We snapshot the session periodically (so an abrupt window close still captures
 * the latest state) and finish when the user closes the window or the deadline
 * passes — whichever comes first.
 */

import { config } from '../config';
import logger from '../logger';
import { BrowserManager } from '../utils/browserManager';
import { BrowserProfiles, hostOf } from '../utils/browserProfiles';

const SNAPSHOT_INTERVAL_MS = 3000;

export interface LoginResult {
  host: string;
  saved: boolean;
  reason: 'window-closed' | 'timeout' | 'error';
  cookies: number;
  durationMs: number;
}

/** Shape the final result from the captured profile + how the session ended.
 *  `saved` reflects whether a profile was actually persisted (cookies OR
 *  localStorage — some sites keep auth only in localStorage). Pure — unit-tested. */
export function summarizeLogin(
  host: string,
  saved: boolean,
  cookieCount: number,
  endedByClose: boolean,
  startedAt: number,
  now: number,
): LoginResult {
  return {
    host,
    saved,
    reason: endedByClose ? 'window-closed' : 'timeout',
    cookies: cookieCount,
    durationMs: now - startedAt,
  };
}

export class InteractiveLogin {
  static async run(url: string, opts: { timeoutMs?: number } = {}): Promise<LoginResult> {
    const startedAt = Date.now();
    const host = hostOf(url);
    const timeoutMs = opts.timeoutMs ?? config.interactiveLoginTimeoutMs;

    let browser; let context; let page;
    try {
      ({ browser, context, page } = await BrowserManager.launchHeadedContext(url));
    } catch (err: any) {
      logger.error({ url, err: err.message }, 'Could not launch headed browser (no display?)');
      return { host, saved: false, reason: 'error', cookies: 0, durationMs: Date.now() - startedAt };
    }

    let closed = false;
    const onClose = () => { closed = true; };
    context.on('close', onClose);
    page.on('close', onClose);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      logger.info({ url }, 'Interactive login: sign in / clear the challenge, then close the window');

      const deadline = startedAt + timeoutMs;
      let lastCookies = 0;
      let savedAny = false;
      while (!closed && Date.now() < deadline) {
        // Periodic snapshot — the latest good session survives an abrupt close.
        const state = await context.storageState().catch(() => null);
        if (state) {
          const wrote = await BrowserProfiles.save(context, url).catch(() => false);
          savedAny = savedAny || wrote;
          lastCookies = state.cookies?.filter((c) => {
            const cd = (c.domain || '').replace(/^\./, '');
            return cd === host || cd.endsWith(host) || host.endsWith(cd);
          }).length || lastCookies;
        }
        await new Promise((r) => setTimeout(r, SNAPSHOT_INTERVAL_MS));
      }

      // Final snapshot if the window is still open at the deadline.
      if (!closed) savedAny = (await BrowserProfiles.save(context, url).catch(() => false)) || savedAny;

      const result = summarizeLogin(host, savedAny, lastCookies, closed, startedAt, Date.now());
      logger.info(result, 'Interactive login finished');
      return result;
    } finally {
      await browser.close().catch(() => {});
    }
  }
}
