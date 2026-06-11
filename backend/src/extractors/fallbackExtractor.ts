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
import { CookieHarvester, registrableDomain } from '../utils/cookieHarvester';
import { BrowserProfiles } from '../utils/browserProfiles';
import { PageMeta, extractImageUrlFromText, pickImageUrl } from '../utils/pageMeta';
import type { CapturedStream, StreamMagnitude } from '../types';
import type { Page, Response as PlaywrightResponse } from 'playwright-core';
import { classifyContentType, classifyBytes, type MediaKind } from './mediaSignature';

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

// Auth/identity headers worth replaying to the CDN so segment + key fetches pass.
const FORWARDED_HEADERS = [
  'authorization', 'x-auth-token', 'x-access-token', 'x-requested-with',
  'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-dest',
];
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── Content-based capture (catches opaque media URLs the patterns above miss) ──
// Resource types we'll content-sniff. A streaming `<video>` fetch is usually
// `media`; obfuscated players pull manifests/segments via `xhr`/`fetch`.
const CONTENT_SNIFF_RESOURCE_TYPES = ['xhr', 'fetch', 'media', 'other'];
// Only read a response body to byte-sniff when it's cheap: small or unsized
// (manifests are tiny; a mislabelled segment is a few hundred KB). Never buffer a
// large progressive video just to peek at its header.
const BYTE_SNIFF_MAX_BYTES = 2 * 1024 * 1024;
// Hard ceiling on captured candidates, so a pure segment site (no manifest, many
// sibling chunks) can't grow the list without bound. A handful of siblings is
// already enough for segment-run detection downstream.
const MAX_TIER2_CANDIDATES = 60;

/** Coarse score for a content-classified stream so manifests settle/rank fast. */
function kindScore(kind: MediaKind): number {
  switch (kind) {
    case 'hls': return 80;
    case 'dash': return 70;
    case 'mp4': return 40;
    default: return 0; // ts segment / generic — let magnitude probing rank it
  }
}

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

// Well-known in-page player libraries. A frame exposing any of these globals is a
// video player regardless of its domain — the structural counterpart to the
// hostname allowlist above (roadmap #6).
export const PLAYER_GLOBALS = [
  'jwplayer', 'videojs', 'Hls', 'dashjs', 'Plyr', 'shaka', 'flowplayer', 'clappr',
];

export interface FramePlayerFacts {
  hasVideo: boolean;
  playerGlobals: string[];
}

/**
 * Decide — by STRUCTURE, not domain — whether a frame is a video-player frame:
 * it contains a `<video>` element or exposes a known player library global.
 * (Network "stream traffic" is the third signal, but Tier 2 already captures that
 * page-wide, so a frame emitting a real stream is handled by the network path.)
 * Pure, so it's unit-tested directly.
 */
export function looksLikePlayerFrame(f: FramePlayerFacts): boolean {
  return f.hasVideo || f.playerGlobals.length > 0;
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

  // `static` (not private) so the ranking logic can be unit-tested directly.
  static isAboveFloor(m?: StreamMagnitude): boolean {
    if (!m) return false;
    if (m.durationSec !== undefined && m.durationSec >= DURATION_FLOOR_SEC) return true;
    if (m.bytes !== undefined && m.bytes >= BYTES_FLOOR) return true;
    return false;
  }

  static isMeasured(m?: StreamMagnitude): boolean {
    return !!m && (m.durationSec !== undefined || m.bytes !== undefined);
  }

  /**
   * Sortable rank. Higher is better. Tiers (high→low):
   *   real-duration manifest > big progressive file > unmeasured (e.g. embed
   *   page) > tiny preview/placeholder > known ad host.
   * Keyword score breaks ties within a tier.
   */
  static candidateRank(c: CapturedStream): number {
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
    // Honour a content-classified kind first — an opaque-token manifest carries
    // no `.m3u8`/`.mpd` in its URL but must still be probed as a manifest.
    const isHls = stream.mediaKind === 'hls' || /\.m3u8(\?|$)/i.test(url) || /\/hls\//i.test(url);
    const isDash = stream.mediaKind === 'dash' || /\.mpd(\?|$)/i.test(url);

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

  // `static` (not private) so the segment stitcher can reuse it to follow a
  // master playlist intercepted in-page (roadmap smaller-items: master follow).
  static pickBestVariant(masterText: string, masterUrl: string): string | undefined {
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

  static parseIso8601Duration(s: string): number | undefined {
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
      context = await BrowserManager.newContext({ url });
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

        // Shared sink for both the URL-pattern (request) path and the
        // content-sniff (response) path. Dedupes, bounds the list, and drives the
        // settle timer: a manifest in hand settles fast, otherwise we keep waiting
        // (up to the weak grace, bounded by the hard cap) for one to appear.
        const addCandidate = (captured: CapturedStream, score: number): void => {
          if (done) return;
          if (candidates.length >= MAX_TIER2_CANDIDATES) return;
          if (candidates.some(c => c.url === captured.url)) return; // dedupe
          candidates.push(captured);
          bestScore = Math.max(bestScore, score);
          if (settleTimer) clearTimeout(settleTimer);
          const wait = bestScore >= MANIFEST_SCORE ? MANIFEST_SETTLE_MS : WEAK_GRACE_MS;
          settleTimer = setTimeout(finish, wait);
        };

        // FAST PATH — capture by URL pattern (cheap, no body read). Covers the
        // overwhelming majority of sites whose media URLs carry a tell-tale
        // extension/path/CDN name.
        page!.on('request', (request) => {
          if (done) return;
          const reqUrl = request.url();
          const resourceType = request.resourceType();

          if (!MEDIA_RESOURCE_TYPES.includes(resourceType)) return;
          if (reqUrl.includes('.ts?') || reqUrl.endsWith('.ts')) return;
          if (!STREAM_URL_PATTERNS.some(pattern => pattern.test(reqUrl))) return;

          const captured = this.capturedFromHeaders(reqUrl, request.headers(), url);
          logger.info({ reqUrl, type: resourceType, score: this.scoreStream(reqUrl) }, 'Tier 2: Stream candidate captured (url-pattern)');
          addCandidate(captured, this.scoreStream(reqUrl));
        });

        // CONTENT PATH — for opaque URLs the patterns miss, classify by what the
        // response actually IS (Content-Type / first bytes). This is what lets the
        // extractor reach sites whose media lives behind unknown CDNs/tokens.
        page!.on('response', (response) => {
          if (done) return;
          void this.captureByContent(response, url, addCandidate);
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

      // Read title + thumbnail from the RENDERED DOM — an SPA (e.g. hanime.tv)
      // injects og:image/og:title via JS, so a later static PageMeta.fetch sees
      // nothing. Remember what the browser sees so the downloader can name the
      // fallback output and set the thumbnail. Best-effort.
      await this.rememberPageMeta(page, url).catch(() => {});

      // Reuse the stealth browser's session cookies (CF clearance / login) for
      // later yt-dlp calls — only if this host has no cookie file yet.
      await CookieHarvester.harvest(context, url).catch(() => {});
      // Persist the full session (cookies + localStorage) so this site stays
      // signed-in / cleared on the next run (A4).
      await BrowserProfiles.save(context, url).catch(() => {});

      // Structural player-frame detection (#6): an unknown embedder we followed
      // may expose a <video> or a known player global without a network stream we
      // could capture (a yt-dlp-supported host, a child-frame <video>, or blob/MSE
      // delivery). Inspect every child frame by structure — domain-independent —
      // and add such frames as candidates so the downstream extractors get a shot.
      const playerFrames = await this.collectPlayerFrameCandidates(page, url).catch(() => []);
      const merged = this.mergeCandidates(captured, playerFrames);
      if (merged.length > 0) return merged;

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

  /**
   * Inspect every child frame structurally (roadmap #6) and return a candidate for
   * each one that looks like a player — by a `<video>` element or a known player
   * global, not by hostname. A frame's own `<video>` http src is captured directly
   * (better than the embed URL); otherwise the frame's document URL is added so
   * yt-dlp's extractors (incl. the generic one) can try the unknown embedder.
   * Cross-origin child frames are fine: Playwright evaluates per-frame.
   */
  private static async collectPlayerFrameCandidates(page: Page, pageUrl: string): Promise<CapturedStream[]> {
    const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    const out: CapturedStream[] = [];
    const main = page.mainFrame();

    for (const frame of page.frames()) {
      if (frame === main) continue;
      const frameUrl = frame.url();
      if (!frameUrl.startsWith('http')) continue;

      let facts: { hasVideo: boolean; videoSrc: string; playerGlobals: string[] } | null = null;
      try {
        facts = await frame.evaluate((globals) => {
          const v = document.querySelector('video') as HTMLVideoElement | null;
          const w = window as unknown as Record<string, unknown>;
          return {
            hasVideo: !!v,
            videoSrc: v ? (v.currentSrc || v.getAttribute('src') || '') : '',
            playerGlobals: globals.filter((g) => typeof w[g] !== 'undefined'),
          };
        }, PLAYER_GLOBALS);
      } catch { continue; /* detached / not yet navigated */ }

      if (!facts || !looksLikePlayerFrame(facts)) continue;

      if (facts.videoSrc && facts.videoSrc.startsWith('http')) {
        logger.info({ frameUrl, videoSrc: facts.videoSrc }, 'Tier 2: Structural player frame — captured <video> src');
        out.push(this.buildStream(facts.videoSrc, pageUrl, DEFAULT_UA));
      } else {
        logger.info({ frameUrl, globals: facts.playerGlobals, hasVideo: facts.hasVideo }, 'Tier 2: Structural player frame — adding frame URL candidate');
        out.push(this.buildStream(frameUrl, pageUrl, DEFAULT_UA));
      }
    }
    return out;
  }

  /**
   * Read title + thumbnail from the rendered page and remember them for the
   * downloader's fallback-output naming. The title comes from the main frame
   * (og:title / twitter:title / <title>). The thumbnail is often NOT on the main
   * page (an SPA like hanime.tv puts the poster in a player iframe), so we also scan
   * child frames — but ONLY same-site ones, to avoid grabbing an ad-iframe poster.
   * For a trusted same-site frame we accept og:image / a <video poster>, and as a
   * last resort a poster URL embedded in the frame's own URL.
   */
  private static async rememberPageMeta(page: Page, url: string): Promise<void> {
    let pageReg = '';
    try { pageReg = registrableDomain(new URL(url).hostname); } catch { /* leave empty */ }

    const readFrame = (frame: import('playwright-core').Frame) =>
      frame.evaluate(() => {
        const m = (sel: string) => document.querySelector(sel)?.getAttribute('content') || '';
        const title = m('meta[property="og:title"]') || m('meta[name="twitter:title"]') || document.title || '';
        const poster = (document.querySelector('video[poster]') as HTMLVideoElement | null)?.poster || '';
        const thumb = m('meta[property="og:image"]') || m('meta[name="twitter:image"]') || poster || '';
        return { title: title.trim(), thumbnail: thumb.trim() };
      }).catch(() => ({ title: '', thumbnail: '' }));

    let title = '';
    let thumbnail = '';
    for (const frame of page.frames()) {
      const fUrl = frame.url();
      let sameSite = false;
      try { sameSite = !!fUrl && !!pageReg && registrableDomain(new URL(fUrl).hostname) === pageReg; } catch { /* opaque */ }

      const info = await readFrame(frame);
      if (!title && info.title) title = info.title;            // main frame is first → its title wins
      if (!thumbnail && sameSite) {
        // og:image may be a direct image, OR a wrapper URL embedding the image
        // (e.g. hanime's omni-player .../index.html?poster_url=<img>) → normalise it;
        // failing that, a poster embedded in the player-frame URL itself.
        thumbnail = pickImageUrl(info.thumbnail) || extractImageUrlFromText(fUrl);
      }
      if (title && thumbnail) break;
    }
    PageMeta.remember(url, { title: title || undefined, thumbnail: thumbnail || undefined });
  }

  /** Concatenate two candidate lists, dropping any whose URL is already present. */
  static mergeCandidates(primary: CapturedStream[], extra: CapturedStream[]): CapturedStream[] {
    const seen = new Set(primary.map((c) => c.url));
    const out = [...primary];
    for (const c of extra) {
      if (seen.has(c.url)) continue;
      seen.add(c.url);
      out.push(c);
    }
    return out;
  }

  /**
   * Build a CapturedStream from a request's headers, replaying the player's
   * Referer/Origin/auth so the CDN authorizes the follow-up fetch. `mediaKind`
   * is set when the stream was identified by content (not URL), so downstream
   * magnitude probing treats an opaque-token manifest as a manifest.
   */
  private static capturedFromHeaders(
    reqUrl: string,
    reqHeaders: Record<string, string>,
    pageUrl: string,
    mediaKind?: MediaKind,
  ): CapturedStream {
    let origin = reqHeaders['origin'];
    if (!origin) { try { origin = new URL(pageUrl).origin; } catch { origin = pageUrl; } }
    const captured: CapturedStream = {
      url: reqUrl,
      referer: reqHeaders['referer'] || pageUrl,
      userAgent: reqHeaders['user-agent'] || DEFAULT_UA,
      headers: { 'Referer': reqHeaders['referer'] || pageUrl, 'Origin': origin },
    };
    FORWARDED_HEADERS.forEach(h => { if (reqHeaders[h]) captured.headers[h] = reqHeaders[h]; });
    if (mediaKind) captured.mediaKind = mediaKind;
    return captured;
  }

  /**
   * Content-based capture: classify a response as media by Content-Type and, when
   * that's ambiguous/lying, by sniffing the first bytes. URLs already caught by
   * the URL-pattern fast path are skipped (the request handler owns those). Body
   * sniffing is gated to small/unsized responses so we never buffer a big video.
   */
  private static async captureByContent(
    response: PlaywrightResponse,
    pageUrl: string,
    addCandidate: (c: CapturedStream, score: number) => void,
  ): Promise<void> {
    try {
      const reqUrl = response.url();
      const request = response.request();
      const resourceType = request.resourceType();
      if (!CONTENT_SNIFF_RESOURCE_TYPES.includes(resourceType)) return;
      if (reqUrl.includes('.ts?') || reqUrl.endsWith('.ts')) return;        // obvious segment
      if (STREAM_URL_PATTERNS.some(p => p.test(reqUrl))) return;            // url-pattern path owns it

      const headers = response.headers();
      const ctKind = classifyContentType(headers['content-type']);
      let kind: MediaKind | null = ctKind && ctKind !== 'media' ? ctKind : null;

      // A specific video/manifest content-type already decided. Otherwise (no
      // type, or generic octet-stream) try to corroborate by first bytes when
      // that's cheap to read — a real manifest/segment has a clear signature.
      if (!kind) {
        const len = parseInt(headers['content-length'] || '', 10);
        const cheap = !Number.isFinite(len) || (len > 0 && len <= BYTE_SNIFF_MAX_BYTES);
        if (cheap) {
          const body = await response.body().catch(() => null);
          kind = body ? classifyBytes(body.subarray(0, 512)) : null;
        }
        // A *large* octet-stream we couldn't sniff is most likely a progressive
        // media download — keep it as generic media. A small unrecognised one is
        // probably not media (font/wasm/json blob), so drop it.
        if (!kind && ctKind === 'media' && !cheap) kind = 'media';
      }
      if (!kind) return;

      const captured = this.capturedFromHeaders(reqUrl, request.headers(), pageUrl, kind);
      const score = Math.max(this.scoreStream(reqUrl), kindScore(kind));
      logger.info({ reqUrl, type: resourceType, contentType: headers['content-type'], kind, score }, 'Tier 2: Stream candidate captured (content-sniff)');
      addCandidate(captured, score);
    } catch { /* response body gone / context closed */ }
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
  static scoreStream(url: string): number {
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
