/**
 * browserManager.ts
 * Singleton stealth Chromium manager.
 * RULES:
 *  - Lazy launch on first use only
 *  - One shared browser, isolated contexts per request
 *  - ALWAYS close contexts after use — memory leak prevention
 *  - PLAYWRIGHT_BROWSERS_PATH must be set before import
 */

import path from 'path';
import logger from '../logger';
import { config } from '../config';
import { Semaphore } from './semaphore';

// CRITICAL: Resolve and force-set browser path before any playwright import
const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH
  ? path.resolve(process.env.PLAYWRIGHT_BROWSERS_PATH)
  : path.join(__dirname, '..', '..', 'playwright-browsers');

process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;

import { chromium as playwrightChromium } from 'playwright-core';
// @ts-ignore — playwright-extra / stealth plugin ship no bundled type declarations
import { chromium as stealthChromium } from 'playwright-extra';
// @ts-ignore — playwright-extra / stealth plugin ship no bundled type declarations
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

stealthChromium.use(StealthPlugin());

import type { Browser, BrowserContext } from 'playwright-core';
import type { CapturedStream } from '../types';

export { CapturedStream };

export class BrowserManager {
  private static browser: Browser | null = null;
  private static launchPromise: Promise<Browser> | null = null;
  // Caps simultaneous contexts so a queue of downloads can't launch enough
  // heavy rendered pages to exhaust memory. Permit is acquired in newContext()
  // and released when the context closes.
  private static readonly contextLimiter = new Semaphore(config.maxBrowserContexts);

  static async getBrowser(): Promise<Browser> {
    if (this.launchPromise) return this.launchPromise;
    if (this.browser?.isConnected()) return this.browser;

    this.launchPromise = this.launch();
    try {
      this.browser = await this.launchPromise;
      return this.browser;
    } finally {
      this.launchPromise = null;
    }
  }

  private static async launch(): Promise<Browser> {
    logger.info({ browsersPath }, 'Launching stealth Chromium...');
    const browser = await stealthChromium.launch({
      headless: true,
      executablePath: playwrightChromium.executablePath(),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-features=IsolateOrigins,site-per-process',
        '--window-size=1920,1080',
        '--lang=en-US,en',
      ],
    });

    browser.on('disconnected', () => {
      logger.warn('Stealth browser disconnected — will relaunch on next use');
      this.browser = null;
    });

    logger.info('Stealth Chromium launched successfully');
    return browser;
  }

  /**
   * Returns a fresh isolated browser context (like a private window), once a
   * concurrency permit is free. ALWAYS call context.close() when done — the permit
   * is released automatically on the context's 'close' event, so a queued caller
   * can proceed. If the limit is reached, this awaits until a context closes.
   */
  static async newContext(): Promise<BrowserContext> {
    await this.contextLimiter.acquire();
    if (this.contextLimiter.waiting > 0) {
      logger.info(this.stats(), 'Browser context limit reached — callers queued');
    }

    let context: BrowserContext;
    try {
      const browser = await this.getBrowser();
      context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        locale: 'en-US',
        timezoneId: 'America/New_York',
        colorScheme: 'light',
        extraHTTPHeaders: {
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Sec-CH-UA': '"Chromium";v="124", "Google Chrome";v="124", "Not=A?Brand";v="99"',
          'Sec-CH-UA-Mobile': '?0',
          'Sec-CH-UA-Platform': '"Windows"',
        },
      });
    } catch (err) {
      this.contextLimiter.release(); // never leak a permit if creation fails
      throw err;
    }

    // Release exactly once, whether the caller closes it or the browser does.
    let released = false;
    context.once('close', () => {
      if (released) return;
      released = true;
      this.contextLimiter.release();
    });
    return context;
  }

  /** Concurrency snapshot for observability (surfaced in /api/health). */
  static stats(): { contextsInUse: number; contextsMax: number; contextsWaiting: number } {
    return {
      contextsInUse: this.contextLimiter.inUse,
      contextsMax: this.contextLimiter.capacity,
      contextsWaiting: this.contextLimiter.waiting,
    };
  }

  static async shutdown(): Promise<void> {
    if (this.browser) {
      logger.info('Shutting down stealth browser...');
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}
