/**
 * onboard.ts
 *
 * Pure inference for the `netload onboard <url>` workflow (A2): given the diagnose
 * report + the analyze result for a NEW site, decide whether it already works,
 * and if not, scaffold a declarative site rule (A1) and a corpus regression
 * fixture (A3). This is the capstone that ties A1+A3 together — onboarding becomes
 * one command instead of hand-writing a rule row and a fixture.
 *
 * Kept pure (no I/O, no network) so the suggestion logic is unit-tested; the CLI
 * does the fetching + optional file writes around it.
 */

import type { SiteRule } from '../providers/siteRules';
import type { Expectation } from './classify';

export interface DiagLike {
  mediaRequests?: { mediaKind?: string }[];
  page?: {
    playerGlobals?: string[];
    appendBufferCount?: number;
    videos?: { usesBlob?: boolean }[];
    iframeChain?: string[];
  };
  hints?: string[];
}

export interface AnalyzeLike {
  title?: string;
  duration?: number;
  extractor?: string;
  requiresAuth?: boolean;
  isLikelyPreview?: boolean;
}

export interface CorpusFixture {
  name: string;
  url: string;
  category: string;
  expect: string | Expectation;
}

export interface OnboardSuggestion {
  host: string;
  alreadyWorks: boolean;
  rule?: SiteRule;        // omitted when the site already resolves
  fixture: CorpusFixture;
  notes: string[];
}

export function hostOfUrl(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return ''; }
}

/** The corpus expectation that best matches the analyze outcome. */
export function suggestFixtureExpect(analyze: AnalyzeLike): string | Expectation {
  if (analyze.requiresAuth) return 'auth';
  if (analyze.isLikelyPreview) return 'preview';
  if (analyze.title && (analyze.duration ?? 0) > 0) {
    return { outcome: 'ok', minDurationSec: Math.max(30, Math.floor((analyze.duration ?? 0) * 0.8)) };
  }
  return 'resolve';
}

/**
 * Combine diagnose + analyze into an onboarding suggestion. If the site already
 * resolves cleanly, no rule is proposed (just a guarding fixture); otherwise a
 * sensible rule skeleton is scaffolded and the notes explain what was observed.
 */
export function suggestOnboarding(url: string, name: string | undefined, diag: DiagLike, analyze: AnalyzeLike): OnboardSuggestion {
  const host = hostOfUrl(url);
  const kinds = new Set((diag.mediaRequests || []).map((m) => m.mediaKind).filter(Boolean) as string[]);
  const globals = diag.page?.playerGlobals || [];
  const appendBuffer = diag.page?.appendBufferCount || 0;
  const blobVideo = (diag.page?.videos || []).some((v) => v.usesBlob);
  const analyzeOk = !!(analyze.title && (analyze.duration ?? 0) > 0) && !analyze.requiresAuth && !analyze.isLikelyPreview;

  const fixture: CorpusFixture = { name: name || host, url, category: 'onboard', expect: suggestFixtureExpect(analyze) };
  const notes: string[] = [];

  if (analyzeOk) {
    notes.push(`Already resolves via the "${analyze.extractor || 'generic'}" path (~${Math.round(analyze.duration ?? 0)}s) — no site rule needed. Add the corpus fixture to guard it.`);
    return { host, alreadyWorks: true, fixture, notes };
  }

  const rule: SiteRule = {
    name: host,
    match: [host],
    impersonate: 'chrome',
    referer: 'self',
    format: 'bestvideo+bestaudio/best',
    extractorArgs: ['generic:impersonate'],
  };
  if (kinds.has('hls') || kinds.has('ts')) rule.hlsNative = true;

  if (analyze.requiresAuth) {
    notes.push('Gated/login-required — add a cookies.txt for the host, or open it once in the stealth browser so the A4 session profile persists the login.');
  }
  if (kinds.size) {
    notes.push(`Media seen on the network: ${[...kinds].join(', ')} — the rule + generic extractor should resolve it; adjust impersonate/referer if it 403s.`);
  }
  if (appendBuffer > 0 || (blobVideo && kinds.size === 0)) {
    notes.push('MSE/appendBuffer delivery — handled by the MSE capture path; if it still fails it is likely EME/DRM (undownloadable).');
  }
  if (kinds.has('dash')) {
    notes.push('DASH (.mpd) seen — handled by the DASH downloader.');
  }
  if (globals.length) {
    notes.push(`Player globals present: ${globals.join(', ')}.`);
  }
  if (kinds.size === 0 && appendBuffer === 0 && !blobVideo) {
    notes.push('No media detected at all — may need cookies/login, a different interaction, or an embed we did not follow.');
  }
  for (const h of diag.hints || []) notes.push(`hint: ${h}`);

  return { host, alreadyWorks: false, rule, fixture, notes };
}
