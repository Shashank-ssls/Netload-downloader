/**
 * siteRules.ts
 *
 * Declarative, data-driven site rules (onboarding roadmap A1). Adding support for
 * a NEW site that just needs the usual knobs (referer, impersonation target,
 * format, headers, HLS hints) is now a DATA row in `config/siteRules.json` — no
 * code, no rebuild. The hand-written BaseProvider classes stay only for genuinely
 * code-heavy sites; the detector checks rules in between those and the generic
 * fallback. The file is hot-reloaded (mtime), so edits apply without a restart.
 *
 * The matching + arg-building logic is pure, so it's unit-tested directly.
 */

import fs from 'fs';
import path from 'path';
import logger from '../logger';

export interface SiteRule {
  /** Hostname/URL substrings; a rule matches if ANY is contained in the URL. */
  match: string[];
  name?: string;                       // label for logs/metrics (default rule:<first match>)
  impersonate?: string | null;         // --impersonate target (chrome | safari | edge | …)
  format?: string;                     // yt-dlp -f format strategy
  extractorArgs?: string[];            // each becomes `--extractor-args <value>`
  hlsNative?: boolean;                 // adds --hls-prefer-native --hls-use-mpegts
  socketTimeout?: number;              // --socket-timeout N
  referer?: string;                    // explicit Referer, or 'self' for the URL's origin
  headers?: Record<string, string>;    // each becomes `--add-header K:V`
}

const RULES_PATH = path.join(__dirname, '../../config/siteRules.json');
const EXAMPLE_PATH = path.join(__dirname, '../../config/siteRules.example.json');

/** A rule matches when any of its `match` substrings is contained in the URL. */
export function ruleMatches(rule: SiteRule, url: string): boolean {
  return Array.isArray(rule.match) && rule.match.some((m) => !!m && url.includes(m));
}

/** First matching rule, or null. */
export function matchRule(rules: SiteRule[], url: string): SiteRule | null {
  for (const r of rules) if (ruleMatches(r, url)) return r;
  return null;
}

/** Build the yt-dlp args a rule contributes (the data-driven equivalent of a
 *  provider's getSpecificArgs). Pure. */
export function buildRuleArgs(rule: SiteRule, url: string): string[] {
  const args: string[] = [];
  for (const a of rule.extractorArgs || []) args.push('--extractor-args', a);
  if (rule.hlsNative) args.push('--hls-prefer-native', '--hls-use-mpegts');
  if (rule.socketTimeout) args.push('--socket-timeout', String(rule.socketTimeout));
  if (rule.referer) {
    let ref = rule.referer;
    if (ref === 'self') { try { ref = new URL(url).origin; } catch { ref = url; } }
    args.push('--referer', ref);
  }
  for (const [k, v] of Object.entries(rule.headers || {})) args.push('--add-header', `${k}:${v}`);
  return args;
}

/** Keep only well-formed rule objects (a `_note`/comment entry is dropped). */
export function sanitizeRules(parsed: unknown): SiteRule[] {
  const list = Array.isArray(parsed) ? parsed : ((parsed as any)?.rules ?? []);
  if (!Array.isArray(list)) return [];
  return (list as SiteRule[]).filter((r) => r && Array.isArray(r.match) && r.match.length > 0);
}

export class SiteRules {
  private static rules: SiteRule[] = [];
  private static mtimeMs = -1;
  private static loadedFrom = '';

  private static activePath(): string {
    return fs.existsSync(RULES_PATH) ? RULES_PATH : EXAMPLE_PATH;
  }

  /** Current rules, reloaded transparently whenever the file changes (mtime). */
  static getRules(): SiteRule[] {
    const file = this.activePath();
    let mtime = -1;
    try { mtime = fs.statSync(file).mtimeMs; } catch { return this.rules; }
    if (file === this.loadedFrom && mtime === this.mtimeMs) return this.rules;

    try {
      this.rules = sanitizeRules(JSON.parse(fs.readFileSync(file, 'utf8')));
      this.mtimeMs = mtime;
      this.loadedFrom = file;
      logger.info({ file: path.basename(file), count: this.rules.length }, 'Loaded site rules');
    } catch (err: any) {
      logger.warn({ err: err.message, file }, 'Failed to load site rules — keeping previous set');
    }
    return this.rules;
  }

  static match(url: string): SiteRule | null {
    return matchRule(this.getRules(), url);
  }
}
