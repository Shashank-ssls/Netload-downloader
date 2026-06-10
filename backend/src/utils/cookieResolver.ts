import path from 'path';
import { config } from '../config';
import { CookieValidator } from './validators';

/**
 * Resolves which cookies.txt to use for a given URL.
 *
 * Per-site cookies live in `config.cookiesDir` as `<host>.txt` — e.g.
 * `cookies/hanime.tv.txt`. We try the exact host, then progressively broader
 * parent domains (`www.hanime.tv` → `hanime.tv`), and finally fall back to the
 * global `config.cookiesPath`. Only valid (Netscape-format, non-empty) files
 * are considered.
 */
export class CookieResolver {
  static resolve(url: string): string | null {
    let host: string;
    try {
      host = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return this.globalFallback();
    }

    // Try `<host>.txt`, then each parent domain (a.b.c → b.c).
    const labels = host.split('.');
    for (let i = 0; i < labels.length - 1; i++) {
      const candidateHost = labels.slice(i).join('.');
      const file = path.join(config.cookiesDir, `${candidateHost}.txt`);
      if (CookieValidator.isValid(file)) return file;
    }

    return this.globalFallback();
  }

  private static globalFallback(): string | null {
    return CookieValidator.isValid(config.cookiesPath) ? config.cookiesPath : null;
  }
}
