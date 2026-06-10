import { Page } from 'playwright-core';
import logger from '../logger';

export class BrowserHelpers {
  /**
   * Attempts to solve an interactive Cloudflare challenge (Turnstile/Checkbox)
   * by simulating human-like mouse interaction with challenge iframes.
   */
  static async solveCFChallenge(page: Page): Promise<boolean> {
    const pageContent = await page.content().catch(() => '');
    const isCFChallenge = 
      pageContent.includes('Just a moment') || 
      pageContent.includes('Checking your browser') ||
      pageContent.includes('cf-browser-verification') ||
      pageContent.includes('Enable JavaScript and cookies to continue');

    if (!isCFChallenge) return false;

    logger.info('Cloudflare challenge detected — attempting auto-resolution...');

    try {
      // Give the challenge time to fully render
      await page.waitForTimeout(4000);

      const iframes = await page.$$('iframe');
      let clicked = false;

      for (const iframe of iframes) {
        const box = await iframe.boundingBox();
        if (box && box.width > 0 && box.height > 0) {
          // Move mouse smoothly to the center
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
          await page.waitForTimeout(300);
          
          // Physical mouse down/up to trigger the checkbox
          await page.mouse.down();
          await page.waitForTimeout(100);
          await page.mouse.up();
          
          logger.info('Clicked CF challenge iframe center');
          clicked = true;
          break; // Usually only one challenge per page
        }
      }

      // Fallback to standard buttons if no iframes found
      if (!clicked) {
        const btn = await page.$('input[type="button"], input[type="submit"], button');
        if (btn) {
          await btn.click();
          logger.info('Clicked CF challenge fallback button');
          clicked = true;
        }
      }

      if (clicked) {
        // Wait for redirect after solving
        await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {
          logger.debug('CF navigation timeout — might have already redirected');
        });
        return true;
      }
    } catch (err: any) {
      logger.error({ err: err.message }, 'Failed to solve CF challenge');
    }

    return false;
  }
}
