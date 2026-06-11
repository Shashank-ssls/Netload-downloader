/**
 * captcha.ts
 *
 * A pluggable captcha-solver hook (onboarding roadmap A6). The stealth browser
 * already auto-passes most Cloudflare JS challenges; this adds a structured way to
 * handle the interactive widgets that block whole classes of sites — Cloudflare
 * Turnstile, hCaptcha, reCAPTCHA — for AUTHORIZED use.
 *
 * We don't bundle a solver. Instead, if `config.captchaSolverCmd` is set, we detect
 * the challenge + its sitekey, invoke that command (`<cmd> <type> <sitekey> <url>`),
 * and inject the returned token into the page's response field. With no command
 * configured this is a no-op and the existing stealth flow is unaffected.
 *
 * Detection + the token-field mapping are pure and unit-tested.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { config } from '../config';
import logger from '../logger';
import type { Page } from 'playwright-core';

const execFileAsync = promisify(execFile);

export type ChallengeType = 'cloudflare' | 'turnstile' | 'hcaptcha' | 'recaptcha';

/** Identify the challenge from page HTML + frame URLs. Pure — unit-tested. */
export function detectChallengeType(html: string, frameUrls: string[] = []): ChallengeType | null {
  const h = html || '';
  const frames = frameUrls.join(' ');
  if (/h-captcha|hcaptcha\.com/i.test(h) || /hcaptcha\.com/i.test(frames)) return 'hcaptcha';
  if (/g-recaptcha|recaptcha\/api|google\.com\/recaptcha/i.test(h) || /recaptcha/i.test(frames)) return 'recaptcha';
  if (/cf-turnstile|challenges\.cloudflare\.com\/turnstile|turnstile\/v0/i.test(h) || /turnstile/i.test(frames)) return 'turnstile';
  if (/Just a moment|cf-browser-verification|Checking your browser|Enable JavaScript and cookies/i.test(h)) return 'cloudflare';
  return null;
}

/** The hidden response field a solved token is written into (null for the plain
 *  Cloudflare JS challenge, which has no token field). Pure — unit-tested. */
export function tokenFieldFor(type: ChallengeType): string | null {
  switch (type) {
    case 'turnstile': return 'cf-turnstile-response';
    case 'hcaptcha': return 'h-captcha-response';
    case 'recaptcha': return 'g-recaptcha-response';
    case 'cloudflare': return null;
  }
}

export class CaptchaSolver {
  /** Is an external solver configured? */
  static get enabled(): boolean {
    return !!config.captchaSolverCmd;
  }

  /**
   * Try to solve an interactive captcha via the configured external hook. Returns
   * true only if a token was obtained AND injected. A no-op (false) when no solver
   * is configured, the challenge has no token field (plain CF JS), or the sitekey
   * can't be found — leaving the existing stealth flow to handle it.
   */
  static async trySolve(page: Page): Promise<boolean> {
    if (!this.enabled) return false;

    const html = await page.content().catch(() => '');
    const frameUrls = page.frames().map((f) => f.url());
    const type = detectChallengeType(html, frameUrls);
    if (!type) return false;

    const field = tokenFieldFor(type);
    if (!field) return false; // plain CF JS challenge — nothing to inject

    const sitekey = await this.findSitekey(page).catch(() => null);
    if (!sitekey) {
      logger.warn({ type }, 'Captcha detected but no sitekey found — skipping solver hook');
      return false;
    }

    const token = await this.runSolver(type, sitekey, page.url());
    if (!token) return false;

    const injected = await this.injectToken(page, field, token).catch(() => false);
    logger.info({ type, injected }, 'Captcha solver hook produced a token');
    return injected;
  }

  /** Read the widget's data-sitekey from the page (any of the known widgets). */
  private static async findSitekey(page: Page): Promise<string | null> {
    return page.evaluate(() => {
      const el = document.querySelector(
        '.cf-turnstile[data-sitekey], .h-captcha[data-sitekey], .g-recaptcha[data-sitekey], [data-sitekey]',
      );
      return el?.getAttribute('data-sitekey') || null;
    });
  }

  /** Invoke the external solver command; expect the token on stdout. */
  private static async runSolver(type: ChallengeType, sitekey: string, url: string): Promise<string | null> {
    const cmd = config.captchaSolverCmd;
    const [bin, ...preArgs] = cmd.split(' ').filter(Boolean);
    try {
      const { stdout } = await execFileAsync(bin, [...preArgs, type, sitekey, url], {
        timeout: config.captchaSolverTimeoutMs,
        maxBuffer: 1024 * 1024,
      });
      const token = stdout.trim();
      return token || null;
    } catch (err: any) {
      logger.warn({ err: err.message, type }, 'Captcha solver command failed');
      return null;
    }
  }

  /** Write the token into the widget's hidden field and fire input/change. */
  private static async injectToken(page: Page, field: string, token: string): Promise<boolean> {
    return page.evaluate(({ field, token }) => {
      const el = document.querySelector(`textarea[name="${field}"], input[name="${field}"]`) as
        | HTMLTextAreaElement | HTMLInputElement | null;
      if (!el) return false;
      el.value = token;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, { field, token });
  }
}
