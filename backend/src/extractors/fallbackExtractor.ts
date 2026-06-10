/**
 * fallbackExtractor.ts
 *
 * TIER 1 — Fast (axios + cheerio, ~2-5s):
 *   Fetches raw HTML, scans for m3u8/mp4 URLs, base64 blobs,
 *   video tags, and known iframe embed players.
 *   Also recursively follows iframe chains (movie sites nest 2-3 iframes deep).
 *   Fails on Cloudflare-protected or pure JS-rendered players.
 *
 * TIER 2 — Deep (Playwright network interception, ~5-20s):
 *   Launches stealth Chromium, fully renders the page (runs all JS),
 *   clicks the play button (required by Video.js, JWPlayer, Plyr),
 *   and intercepts the exact network request the player makes to the CDN.
 *   Captures: stream URL + Referer + Origin + auth headers.
 *   This is how hanime.tv, hanime2.org, miruro.tv, and most anime
 *   streaming sites serve their HLS playlists.
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import logger from '../logger';
import { HeaderBuilder } from '../utils/headers';
import { BrowserManager } from '../utils/browserManager';
import { BrowserHelpers } from '../utils/browserHelpers';
import type { CapturedStream, StreamMagnitude } from '../types';
import type { Page } from 'playwright-core';

// "Real content" floors. A stream below BOTH is treated as a preview/placeholder
// and demoted (and flagged as a likely preview if it's still the best we have).
export const DURATION_FLOOR_SEC = 90;
export const BYTES_FLOOR = 10 * 1024 * 1024; // ~10 MB
const PROBE_TIMEOUT_MS = 6000;

const STREAM_URL_PATTERNS = [
  /\.m3u8(\?|$)/i,
  /\.mp4(\?|$)/i,
  /\/hls\//i,
  /\/dash\//i,
  /master\.m3u8/i,
  /index\.m3u8/i,
  /playlist\.m3u8/i,
  /\/stream\//i,
  /sprintcdn/i,
  /ultracloud/i,
  /cdnfile/i,
  /delivery\.cdn/i,
  /akamaized\.net\/.*\.(m3u8|mp4)/i,
  /cloudfront\.net\/.*\.(m3u8|mp4)/i,
];

const MEDIA_RESOURCE_TYPES = ['xhr', 'fetch', 'media', 'other'];

const PLAY_BUTTON_SELECTORS = [
  '.vjs-big-play-button',
  '.jw-display-icon-container',
  '.plyr__control--overlaid',
  '[data-plyr="play"]',
  '.play-button',
  '#play-btn',
  '.btn-play',
  '.player-play-overlay',
  '.play-overlay',
  '[class*="play-btn"]',
  '[class*="playBtn"]',
  'button[aria-label*="play" i]',
  '[aria-label*="Play" i]',
  '.icon-play',
  '.fa-play',
  'video',
];

// Hostname patterns for known embed providers
const KNOWN_EMBEDDER_HOSTNAMES = [
  'dood.watch', 'doodstream.com', 'filemoon.sx', 'vidplay.online', 'mixdrop.co',
  'mp4upload.com', 'streamwish.to', 'voe.sx', 'rabbitstream.net', 'megacloud.tv',
  'upstream.to', 'streamtape.com', 'gofile.io', 'sendvid.com', 'streamsb.net',
  'sbplay.org', 'sbfull.com', 'rapid-cloud.co', 'vidcloud9.com', 'vidmoly.to',
  'uqload.com', 'supervideo.tv', 'fembed.com', 'vidhide.com', 'streamlare.com',
  'bysesayeveum.com',
];

function hostnameMatchesEmbedder(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return KNOWN_EMBEDDER_HOSTNAMES.some(e => hostname === e || hostname.endsWith('.' + e));
  } catch {
    return false;
  }
}

export class FallbackExtractor {

  static async extractMediaUrl(url: string, providerType: string): Promise<CapturedStream | null> {
    const ranked = await this.extractRankedCandidates(url, providerType);
    return ranked[0] || null;
  }

  /**
   * Returns all discovered candidate streams, ranked best-first by magnitude
   * (duration for manifests, byte size for progressive files). The downloader
   * can walk this list, falling back to the next candidate if a download turns
   * out to be too small. Tier 1 (fast HTML) is tried first; if it yields
   * nothing, Tier 2 (browser network interception) takes over.
   */
  static async extractRankedCandidates(url: string, providerType: string): Promise<CapturedStream[]> {
    const tier1Ranked = await this.selectBestCandidate(
      await this.extractTier1(url, providerType, 0, new Set([url]))
    );
    // Good content from Tier 1 → done (fast path). If Tier 1 found only previews
    // (or nothing), escalate to Tier 2 browser interception.
    if (tier1Ranked.length > 0 && !tier1Ranked[0].isLikelyPreview) return tier1Ranked;

    logger.info({ url }, 'Tier 1 yielded no full content — escalating to Tier 2 (network interception)');
    const tier2Ranked = await this.selectBestCandidate(await this.extractTier2(url));

    if (tier2Ranked.length > 0 && !tier2Ranked[0].isLikelyPreview) return tier2Ranked;

    // Both tiers only produced previews/placeholders — return the best we have
    // (Tier 2 first, since it actually rendered the player), still flagged.
    return tier2Ranked.length > 0 ? tier2Ranked : tier1Ranked;
  }

  // ─── Candidate ranking by magnitude (site-agnostic) ─────────────────────────

  /**
   * Probe each candidate's size/duration and return them ranked best-first.
   * Magnitude (duration for manifests, bytes for progressive files) is the
   * primary signal — it generalises across sites where ad/placeholder URLs are
   * named differently. scoreStream() keyword rules are only a tiebreaker / a
   * fallback when a probe can't determine size. The top result is flagged
   * `isLikelyPreview` when even the best candidate measures below both floors.
   */
  static async selectBestCandidate(candidates: CapturedStream[]): Promise<CapturedStream[]> {
    if (candidates.length === 0) return [];

    const uniq = new Map<string, CapturedStream>();
    for (const c of candidates) if (!uniq.has(c.url)) uniq.set(c.url, c);
    const list = [...uniq.values()];

    await Promise.allSettled(list.map(async (c) => { c.magnitude = await this.probeMagnitude(c); }));

    list.sort((a, b) => this.candidateRank(b) - this.candidateRank(a));

    const top = list[0];
    top.isLikelyPreview = this.isMeasured(top.magnitude) && !this.isAboveFloor(top.magnitude);

    logger.info(
      { chosen: top.url, magnitude: top.magnitude, isLikelyPreview: top.isLikelyPreview, candidateCount: list.length },
      'Selected best candidate by size/duration'
    );
    return list;
  }

  private static isAboveFloor(m?: StreamMagnitude): boolean {
    if (!m) return false;
    if (m.durationSec !== undefined && m.durationSec >= DURATION_FLOOR_SEC) return true;
    if (m.bytes !== undefined && m.bytes >= BYTES_FLOOR) return true;
    return false;
  }

  private static isMeasured(m?: StreamMagnitude): boolean {
    return !!m && (m.durationSec !== undefined || m.bytes !== undefined);
  }

  /**
   * Sortable rank. Higher is better. Tiers (high→low):
   *   real-duration manifest > big progressive file > unmeasured (e.g. embed
   *   page) > tiny preview/placeholder > known ad host.
   * Keyword score breaks ties within a tier.
   */
  private static candidateRank(c: CapturedStream): number {
    const ks = this.scoreStream(c.url);
    if (ks <= -100) return -1_000_000 + ks;             // known ad host → always last

    const m = c.magnitude;
    if (m?.durationSec !== undefined) {
      return m.durationSec >= DURATION_FLOOR_SEC
        ? 1_000_000 + m.durationSec
        : m.durationSec + ks;                            // tiny manifest = preview
    }
    if (m?.bytes !== undefined) {
      const mb = m.bytes / (1024 * 1024);
      return m.bytes >= BYTES_FLOOR
        ? 900_000 + mb
        : mb + ks;                                       // tiny file = preview/placeholder
    }
    return 500_000 + ks;                                 // size unknown (embed page, blocked probe)
  }

  // ─── Magnitude probing (cheap, pre-download) ────────────────────────────────

  private static async probeMagnitude(stream: CapturedStream): Promise<StreamMagnitude> {
    const url = stream.url;
    const headers = { ...stream.headers, 'User-Agent': stream.userAgent };
    const isHls = /\.m3u8(\?|$)/i.test(url) || /\/hls\//i.test(url);
    const isDash = /\.mpd(\?|$)/i.test(url);

    try {
      if (isHls) return { durationSec: await this.probeHlsDuration(url, headers), isManifest: true };
      if (isDash) return { durationSec: await this.probeDashDuration(url, headers), isManifest: true };
      return { bytes: await this.probeBytes(url, headers), isManifest: false };
    } catch (err: any) {
      logger.debug({ url, err: err?.message }, 'probeMagnitude failed');
      return { isManifest: isHls || isDash };
    }
  }

  /** Sum #EXTINF durations; for a master playlist, follow the top-bandwidth variant first. */
  private static async probeHlsDuration(url: string, headers: Record<string, string>): Promise<number | undefined> {
    const resp = await axios.get(url, { headers, timeout: PROBE_TIMEOUT_MS, validateStatus: () => true, responseType: 'text' });
    if (resp.status >= 400 || typeof resp.data !== 'string') return undefined;
    let text = resp.data as string;

    if (/#EXT-X-STREAM-INF/i.test(text)) {
      const variant = this.pickBestVariant(text, url);
      if (variant) {
        const r2 = await axios.get(variant, { headers, timeout: PROBE_TIMEOUT_MS, validateStatus: () => true, responseType: 'text' });
        if (r2.status < 400 && typeof r2.data === 'string') text = r2.data; else return undefined;
      }
    }

    let total = 0; let found = false;
    for (const m of text.matchAll(/#EXTINF:\s*([\d.]+)/gi)) { total += parseFloat(m[1]) || 0; found = true; }
    return found ? total : undefined;
  }

  private static pickBestVariant(masterText: string, masterUrl: string): string | undefined {
    const lines = masterText.split('\n').map(l => l.trim());
    let best = { bw: -1, uri: '' };
    for (let i = 0; i < lines.length; i++) {
      if (/^#EXT-X-STREAM-INF/i.test(lines[i])) {
        const bwm = lines[i].match(/BANDWIDTH=(\d+)/i);
        const bw = bwm ? parseInt(bwm[1], 10) : 0;
        let j = i + 1;
        while (j < lines.length && (lines[j] === '' || lines[j].startsWith('#'))) j++;
        const uri = lines[j];
        if (uri && bw > best.bw) best = { bw, uri };
      }
    }
    return best.uri ? this.resolveUrl(best.uri, masterUrl) : undefined;
  }

  private static async probeDashDuration(url: string, headers: Record<string, string>): Promise<number | undefined> {
    const resp = await axios.get(url, { headers, timeout: PROBE_TIMEOUT_MS, validateStatus: () => true, responseType: 'text' });
    if (resp.status >= 400 || typeof resp.data !== 'string') return undefined;
    const m = (resp.data as string).match(/mediaPresentationDuration="([^"]+)"/i);
    return m ? this.parseIso8601Duration(m[1]) : undefined;
  }

  private static parseIso8601Duration(s: string): number | undefined {
    const m = s.match(/P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/i);
    if (!m) return undefined;
    const [, d, h, min, sec] = m;
    return (parseInt(d || '0', 10) * 86400) + (parseInt(h || '0', 10) * 3600) +
           (parseInt(min || '0', 10) * 60) + (parseFloat(sec || '0'));
  }

  /** Total byte size via HEAD Content-Length, falling back to a ranged GET. */
  private static async probeBytes(url: string, headers: Record<string, string>): Promise<number | undefined> {
    try {
      const head = await axios.head(url, { headers, timeout: PROBE_TIMEOUT_MS, validateStatus: () => true });
      if (head.status < 400) {
        const cl = parseInt(String(head.headers['content-length'] || ''), 10);
        if (cl > 0) return cl;
      }
    } catch { /* HEAD unsupported — fall through */ }

    try {
      const r = await axios.get(url, {
        headers: { ...headers, Range: 'bytes=0-0' },
        timeout: PROBE_TIMEOUT_MS, validateStatus: () => true, responseType: 'arraybuffer',
      });
      const cr = String(r.headers['content-range'] || '').match(/\/(\d+)\s*$/);
      if (cr) return parseInt(cr[1], 10);
      if (!r.headers['content-range']) {
        const cl = parseInt(String(r.headers['content-length'] || ''), 10);
        if (cl > 0) return cl;
      }
    } catch { /* give up — size unknown */ }
    return undefined;
  }

  // ─── TIER 1: Lightweight HTML scraping ──────────────────────────────────────

  private static async extractTier1(
    url: string,
    providerType: string,
    depth: number,
    visited: Set<string>,
  ): Promise<CapturedStream[]> {
    if (depth > 3) return [];

    try {
      const headers = HeaderBuilder.getHeadersForProvider(providerType, url);
      const baseUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

      logger.info({ url, depth }, 'Tier 1: Fetching HTML for scan...');
      const response = await axios.get(url, {
        headers: { ...headers, 'User-Agent': baseUA },
        timeout: 10000,
        validateStatus: () => true,
      });

      if (response.status === 403 || response.status === 503 || response.status === 429) {
        logger.warn({ status: response.status }, 'Tier 1: Blocked by Cloudflare/rate-limit');
        return [];
      }

      const html = response.data as string;
      if (typeof html !== 'string' || html.length < 100) return [];

      const $ = cheerio.load(html);
      const out: CapturedStream[] = [];

      // Collect every direct stream candidate in the page (no selection here —
      // ranking by size/duration happens once over the full pool).
      const directUrls = new Set<string>();
      const addUrl = (raw: string | undefined) => {
        if (!raw) return;
        const u = raw.replace(/\\\//g, '/');
        if (u.startsWith('http')) directUrls.add(u);
      };

      for (const m of html.matchAll(/["'`](https?:\/\/[^"'`]+\.m3u8[^"'`]*?)["'`]/gi)) addUrl(m[1]);
      for (const m of html.matchAll(/(https?:\/\/[^\s"'<>]+?\.mp4[^\s"'<>]*)/gi)) addUrl(m[1]);

      const base64Chunks = html.match(/[a-zA-Z0-9+/]{80,}={0,2}/g) || [];
      for (const chunk of base64Chunks) {
        try {
          const decoded = Buffer.from(chunk, 'base64').toString('utf-8');
          if (decoded.includes('.m3u8') || decoded.includes('.mp4')) {
            addUrl(decoded.match(/(https?:\/\/[^\s"']+)/)?.[1]);
          }
        } catch { /* not valid base64 */ }
      }

      const videoSrc = $('video source').attr('src') || $('video').attr('src');
      if (videoSrc) addUrl(this.resolveUrl(videoSrc, url));

      for (const u of directUrls) out.push(this.buildStream(u, url, baseUA));
      if (directUrls.size > 0) {
        logger.info({ count: directUrls.size, depth }, 'Tier 1: Collected direct stream candidates');
      }

      // Iframe chain following — known embedders + recurse into unknown ones
      const iframes = $('iframe');
      for (let i = 0; i < iframes.length; i++) {
        const src = $(iframes[i]).attr('src') || $(iframes[i]).attr('data-src');
        if (!src) continue;
        const resolved = this.resolveUrl(src, url);
        if (!resolved.startsWith('http') || visited.has(resolved)) continue;

        if (hostnameMatchesEmbedder(resolved)) {
          logger.info({ iframeUrl: resolved }, 'Tier 1: Found known embed iframe');
          out.push(this.buildStream(resolved, url, baseUA));
          continue;
        }

        const hostname = (() => { try { return new URL(resolved).hostname; } catch { return ''; } })();
        if (hostname && !['google.com', 'facebook.com', 'twitter.com', 'doubleclick.net'].some(d => hostname.includes(d))) {
          logger.info({ iframeUrl: resolved, depth }, 'Tier 1: Recursing into iframe');
          visited.add(resolved);
          out.push(...await this.extractTier1(resolved, 'generic', depth + 1, visited));
        }
      }

      return out;

    } catch (err: any) {
      logger.warn({ err: err.message, url }, 'Tier 1 extraction error');
      return [];
    }
  }

  // ─── TIER 2: Headless browser + network interception ────────────────────────

  static async extractTier2(url: string): Promise<CapturedStream[]> {
    let context = null;
    let page: Page | null = null;

    try {
      logger.info({ url }, 'Tier 2: Starting network interception...');
      context = await BrowserManager.newContext();
      page = await context.newPage();

      // Collect every stream candidate the player requests, then pick the best.
      // The key reliability problem: the real HLS manifest often only loads
      // *after* a preview/ad clip or a second interaction, so settling quickly
      // on the first (weak) mp4 misses it. We therefore PRIORITISE WAITING FOR A
      // MANIFEST: a strong .m3u8/.mpd settles fast, but weak-only candidates are
      // held much longer to give the manifest a chance to appear.
      const MANIFEST_SCORE = 70;      // .mpd / .m3u8 and above
      const MANIFEST_SETTLE_MS = 1500; // once we have a manifest, grab it
      const WEAK_GRACE_MS = 15000;     // how long to wait for a manifest when only mp4s seen
      const HARD_CAP_MS = 35000;       // absolute ceiling

      const capturePromise = new Promise<CapturedStream[]>((resolve) => {
        const candidates: CapturedStream[] = [];
        let done = false;
        let settleTimer: NodeJS.Timeout | null = null;
        let bestScore = -Infinity;

        const finish = () => {
          if (done) return;
          done = true;
          if (settleTimer) clearTimeout(settleTimer);
          clearTimeout(hardCap);
          logger.info({ candidateCount: candidates.length }, 'Tier 2: Capture window closed');
          resolve(candidates);
        };

        const hardCap = setTimeout(finish, HARD_CAP_MS);

        page!.on('request', (request) => {
          if (done) return;

          const reqUrl = request.url();
          const resourceType = request.resourceType();
          const reqHeaders = request.headers();

          if (!MEDIA_RESOURCE_TYPES.includes(resourceType) &&
              !STREAM_URL_PATTERNS.some(p => p.test(reqUrl))) {
            return;
          }

          if (reqUrl.includes('.ts?') || reqUrl.endsWith('.ts')) return;
          if (!STREAM_URL_PATTERNS.some(pattern => pattern.test(reqUrl))) return;
          if (candidates.some(c => c.url === reqUrl)) return; // dedupe

          const captured: CapturedStream = {
            url: reqUrl,
            referer: reqHeaders['referer'] || url,
            userAgent: reqHeaders['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            headers: {
              'Referer': reqHeaders['referer'] || url,
              'Origin': reqHeaders['origin'] || (() => { try { return new URL(url).origin; } catch { return url; } })(),
            },
          };

          ['authorization', 'x-auth-token', 'x-access-token', 'x-requested-with', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-dest'].forEach(h => {
            if (reqHeaders[h]) captured.headers[h] = reqHeaders[h];
          });

          const score = this.scoreStream(reqUrl);
          candidates.push(captured);
          bestScore = Math.max(bestScore, score);
          logger.info({ reqUrl, type: resourceType, score }, 'Tier 2: Stream candidate captured');

          // Manifest in hand → settle fast. Otherwise keep waiting (up to the
          // weak grace, bounded by the hard cap) for a manifest to show up.
          if (settleTimer) clearTimeout(settleTimer);
          const wait = bestScore >= MANIFEST_SCORE ? MANIFEST_SETTLE_MS : WEAK_GRACE_MS;
          settleTimer = setTimeout(finish, wait);
        });
      });

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

      await BrowserHelpers.solveCFChallenge(page);

      // Drive playback persistently while the capture window is open. The real
      // manifest only loads once genuine playback starts, which can need a
      // second click (to dismiss an overlay/ad) or a programmatic play().
      const stop = { value: false };
      const driver = this.drivePlayback(page, stop).catch(() => {});

      const captured = await capturePromise;
      stop.value = true;
      await driver;
      if (captured.length > 0) return captured;

      const domVideoUrl = await page.evaluate(() => {
        const v = document.querySelector('video');
        if (v?.src || v?.currentSrc) return v.src || v.currentSrc;
        const s = document.querySelector('video source') as HTMLSourceElement;
        if (s?.src) return s.src;
        return null;
      }).catch(() => null);

      if (domVideoUrl && domVideoUrl.startsWith('http')) {
        logger.info({ url: domVideoUrl }, 'Tier 2: Found video src in post-JS DOM');
        return [this.buildStream(
          domVideoUrl, url,
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        )];
      }

      logger.warn({ url }, 'Tier 2: No stream found after full page load + play click');
      return [];

    } catch (err: any) {
      logger.error({ url, err: err.message }, 'Tier 2 deep extraction failed');
      return [];
    } finally {
      await page?.close().catch(() => {});
      await context?.close().catch(() => {});
    }
  }

  /**
   * Repeatedly nudge the player into real playback until `stop.value` is set
   * (capture resolved) or the deadline passes. Each round, across every frame,
   * it clicks known play-button selectors and forces a muted `video.play()` —
   * muting satisfies autoplay policies, and retrying handles players that need
   * a second interaction (overlay/ad dismissal) before loading the real stream.
   */
  private static async drivePlayback(page: Page, stop: { value: boolean }): Promise<void> {
    const deadline = Date.now() + 30000;
    let round = 0;

    while (!stop.value && Date.now() < deadline) {
      round++;
      for (const frame of page.frames()) {
        if (stop.value) break;

        for (const selector of PLAY_BUTTON_SELECTORS) {
          try {
            const el = await frame.$(selector);
            if (el) {
              await el.scrollIntoViewIfNeeded().catch(() => {});
              await el.click({ timeout: 1500 }).catch(() => {});
              if (round === 1) logger.info({ selector, frameUrl: frame.url() }, 'Tier 2: Clicked play button in frame');
            }
          } catch { /* selector/frame not actionable */ }
        }

        // Programmatic play as a backstop (muted to bypass autoplay blocking).
        try {
          await frame.evaluate(() => {
            const v = document.querySelector('video');
            if (v) { (v as HTMLVideoElement).muted = true; (v as HTMLVideoElement).play?.().catch(() => {}); }
          });
        } catch { /* cross-origin frame — ignore */ }
      }

      await page.waitForTimeout(2500).catch(() => {});
    }
  }

  private static buildStream(url: string, pageUrl: string, ua: string): CapturedStream {
    let origin = pageUrl;
    try { origin = new URL(pageUrl).origin; } catch {}
    return {
      url,
      referer: pageUrl,
      userAgent: ua,
      headers: { 'Referer': pageUrl, 'Origin': origin },
    };
  }

  /**
   * Rank a captured stream URL so the real episode wins over preview/banner
   * clips. HLS/DASH manifests describe the full quality ladder and are how
   * player sites serve real content, so they outrank a standalone progressive
   * mp4 (which is frequently a short marquee/teaser loop). Known junk keywords
   * are penalised heavily.
   */
  private static scoreStream(url: string): number {
    const u = url.toLowerCase();
    let score = 0;

    if (/master\.m3u8/.test(u)) score += 100;
    else if (/(index|playlist)\.m3u8/.test(u)) score += 90;
    else if (/\.m3u8(\?|$)/.test(u)) score += 80;
    else if (/\.mpd(\?|$)/.test(u)) score += 70;
    else if (/\.mp4(\?|$)/.test(u)) score += 40;

    // Known ad-network hosts/paths — an ad creative must never beat real content.
    if (/(adtng|doubleclick|googlesyndication|googleadservices|adnxs|amazon-adsystem|adsrvr|moatads|adservice|spotxchange|freewheel|adswizz|\/ads?\/|\/creatives?\/|advert)/.test(u)) {
      score -= 200;
    }

    // Placeholder / preview / teaser clips
    if (/(preview|trailer|teaser|sample|banner|marquee|promo|sprite|thumb|intro|outro|bumper|black[_-]?screen|blankmp4|\bblank\b|placeholder)/.test(u)) {
      score -= 90;
    }

    return score;
  }

  private static resolveUrl(extracted: string, base: string): string {
    if (extracted.startsWith('http')) return extracted;
    if (extracted.startsWith('//')) return 'https:' + extracted;
    try { return new URL(extracted, base).href; } catch { return extracted; }
  }
}
