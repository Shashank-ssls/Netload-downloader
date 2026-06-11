/**
 * segmentStitcher.ts
 *
 * Some sites never expose an HLS/DASH manifest on the network. Instead the
 * player decrypts a playlist in-page and fetches the individual media segments
 * (often short MPEG-TS chunks) through a proxy that hides them behind opaque
 * tokens and lies about the Content-Type (e.g. `image/jpeg`). There is no single
 * URL that yields the full episode — only a stream of sibling segment URLs.
 *
 * This module handles that delivery pattern generically (no per-site rules):
 *   1. DETECT — a run of sibling segment URLs (same origin + directory) among
 *      the captured candidates.
 *   2. CAPTURE — re-open the player in a headless browser and "chase the buffer"
 *      through the entire timeline, recording every segment URL in playback
 *      order. We ride the buffered frontier and, when the player stalls, nudge
 *      just past it (never far enough to skip a segment) to force the next fetch.
 *   3. STITCH — preferred: hand the intercepted playlist (URIs rewritten absolute)
 *      to ffmpeg's HLS engine, which downloads + decrypts (AES-128) + remuxes with
 *      the player's headers. Fallback: hand-rolled segment download + concat. Then
 *      ffprobe the result against the player-reported duration to flag a partial.
 */

import fs from 'fs';
import http from 'http';
import path from 'path';
import { spawn } from 'child_process';
import axios from 'axios';
import logger from '../logger';
import { config } from '../config';
import { BrowserManager } from '../utils/browserManager';
import { BrowserHelpers } from '../utils/browserHelpers';
import { FileValidator } from '../utils/validators';
import { FallbackExtractor } from './fallbackExtractor';
import type { ProgressData, CapturedStream } from '../types';
import type { Page } from 'playwright-core';

// Minimum segments a *full capture* must yield to count as real content.
const SEGMENT_RUN_MIN = 4;
// DETECTION thresholds — how readily we ATTEMPT the authoritative playlist
// intercept from the (often tiny) Tier-2 capture. The intercept re-opens the
// browser and is authoritative, so a thin initial signal is enough: a few
// same-dir siblings of any size, OR even one chunk-sized sibling.
const SEGMENT_RUN_STRONG = 3;
const SEGMENT_RUN_SMALL = 1;
// A same-dir non-manifest candidate measured below this is "chunk-sized" — a
// strong segment signal (a full progressive file would be larger).
const SEGMENT_CHUNK_MAX_BYTES = 10 * 1024 * 1024;
// Whole-episode capture is bounded — a runaway player can't hang a download.
const CAPTURE_CAP_MS = 12 * 60 * 1000;
// Give up the capture if no new segment appears for this long despite nudging.
const STALL_MS = 30_000;
const CHASE_INTERVAL_MS = 1200;
// Nudge the playhead this far PAST the buffered frontier when stalled. Kept well
// under a typical segment length so we trigger the *next* segment, never skip one.
const NUDGE_SEC = 1.0;
// Only kick the playhead after a GENUINE stall (~12s of no new segments). Nudging
// during normal rebuffering would re-introduce the seek-induced fragment aborts we
// switched to linear playback to avoid.
const STUCK_TICKS_BEFORE_NUDGE = 10;

// How long to wait for the player to decrypt + emit its playlist after play().
const PLAYLIST_WAIT_MS = 30_000;

// Download concurrency defaults to config.segmentConcurrency (gentle by default —
// high concurrency on a long episode trips anti-abuse throttling and connections
// start hanging). On a throttle failure the stitch retries once at half this.
const SEGMENT_FETCH_TIMEOUT_MS = 25_000;
const SEGMENT_FETCH_RETRIES = 5;
// A few unrecoverable segments out of hundreds = a brief glitch, not a failure.
// Abort the whole stitch only if more than this fraction can't be fetched.
const MAX_MISSING_RATIO = 0.03;
// Output shorter than this fraction of the player-reported duration = partial.
const COMPLETE_COVERAGE_RATIO = 0.9;

const PLAY_BUTTON_SELECTORS = [
  '.vjs-big-play-button', '.jw-display-icon-container', '.plyr__control--overlaid',
  '[data-plyr="play"]', '.play-button', '#play-btn', '.btn-play',
  '.player-play-overlay', '.play-overlay', '[class*="play-btn"]', '[class*="playBtn"]',
  'button[aria-label*="play" i]', '[aria-label*="Play" i]', '.icon-play', '.fa-play', 'video',
];

interface SegmentCapture {
  segments: string[];
  headers: Record<string, string>;
  userAgent: string;
  durationSec: number;   // player-reported total (0 if unknown)
  coverageSec: number;   // furthest playhead position reached
  // The intercepted media playlist with all URIs rewritten absolute (when the
  // playlist-intercept path was used). Lets ffmpeg do the download/decrypt.
  playlistText?: string;
}

export interface StitchResult {
  path: string;
  partial: boolean;      // output noticeably shorter than the reported duration
}

export class SegmentStitcher {

  /**
   * Decide whether to attempt the authoritative playlist intercept, returning the
   * segment directory prefix to capture (or null). We group same-directory
   * non-manifest candidates and trigger when a group has either several siblings
   * (any size) or even one *chunk-sized* sibling — because the intercept itself is
   * authoritative, a thin signal from a rate-limited Tier-2 capture is enough.
   * A lone *large* candidate (a normal progressive file) does NOT trigger, so
   * native/progressive sites aren't mis-routed into stitching.
   */
  static looksLikeSegmentRun(candidates: CapturedStream[]): string | null {
    const groups = new Map<string, { count: number; small: number }>();
    for (const c of candidates) {
      if (c.magnitude?.isManifest) continue;          // a real manifest isn't a segment run
      const key = this.dirPrefix(c.url);
      if (!key) continue;
      const g = groups.get(key) || { count: 0, small: 0 };
      g.count++;
      const bytes = c.magnitude?.bytes;
      if (bytes !== undefined && bytes < SEGMENT_CHUNK_MAX_BYTES) g.small++;
      groups.set(key, g);
    }

    let best: { prefix: string; count: number; small: number } | null = null;
    for (const [prefix, g] of groups) {
      const triggers = g.count >= SEGMENT_RUN_STRONG || g.small >= SEGMENT_RUN_SMALL;
      if (triggers && (!best || g.count > best.count)) best = { prefix, ...g };
    }

    if (best) {
      logger.info({ prefix: best.prefix, count: best.count, small: best.small }, 'Detected segmented-stream run');
      return best.prefix;
    }
    return null;
  }

  /** origin + path up to (and including) the last '/', e.g. https://h/stream/.
   *  `static` (not private) so it can be unit-tested directly. */
  static dirPrefix(url: string): string | null {
    try {
      const u = new URL(url);
      const dir = u.pathname.slice(0, u.pathname.lastIndexOf('/') + 1);
      return dir ? u.origin + dir : null;
    } catch {
      return null;
    }
  }

  /**
   * Full flow: capture every segment for `pageUrl` under `prefix`, then download
   * and stitch them into `outPath`. Returns the output path (and whether it's a
   * partial capture), or null if capture produced too few segments to be real.
   */
  static async run(
    pageUrl: string,
    prefix: string,
    outPath: string,
    onProgress: (data: ProgressData) => void,
  ): Promise<StitchResult | null> {
    // PRIMARY: intercept the decrypted m3u8 playlist in-page (gives the full
    // ordered segment list at once — no fragile playback-driving). FALLBACK:
    // chase the buffer through playback if no playlist could be intercepted.
    let cap = await this.captureViaPlaylist(pageUrl, prefix);
    if (!cap || cap.segments.length < SEGMENT_RUN_MIN) {
      logger.info({ pageUrl, viaPlaylist: cap?.segments.length || 0 }, 'No usable playlist intercepted — falling back to playback capture');
      cap = await this.captureSegments(pageUrl, prefix);
    }
    if (!cap || cap.segments.length < SEGMENT_RUN_MIN) {
      logger.warn({ pageUrl, captured: cap?.segments.length || 0 }, 'Segment capture too small — aborting stitch');
      return null;
    }
    logger.info(
      { pageUrl, segments: cap.segments.length, durationSec: cap.durationSec, coverageSec: cap.coverageSec },
      'Captured full segment list — downloading + stitching',
    );

    // Bail early on DRM — these segments can't be decrypted; downloading them
    // would just produce garbage. Surface a clear, terminal error instead.
    if (cap.playlistText && this.detectDrm(cap.playlistText)) {
      logger.error({ pageUrl }, 'Intercepted manifest is DRM-protected — cannot download');
      throw new Error('DRM_PROTECTED');
    }

    // Use ffmpeg's HLS engine only when the playlist actually NEEDS it — AES-128
    // decryption or fMP4 init segments, which the manual TS concat can't handle.
    // For plain MPEG-TS the manual path is faster (concurrent) and already proven,
    // so prefer it. (On ffmpeg failure we still fall back to manual, though that
    // won't recover an encrypted stream — logged accordingly.)
    let stitched = false;
    if (cap.playlistText && this.needsFfmpeg(cap.playlistText)) {
      try {
        await this.stitchViaFfmpeg(cap, outPath, onProgress);
        stitched = true;
      } catch (err: any) {
        logger.warn({ err: err.message }, 'ffmpeg playlist stitch failed — falling back to manual (may be invalid if encrypted)');
      }
    }
    if (!stitched) {
      await this.stitchManualWithRetry(cap, outPath, onProgress);
    }

    // Verify completeness against what the player said the duration was.
    const outDur = FileValidator.probeDurationSec(outPath) ?? 0;
    const partial = cap.durationSec > 0 && outDur > 0 && outDur < cap.durationSec * COMPLETE_COVERAGE_RATIO;
    if (partial) {
      logger.warn({ outPath, outDur, reported: cap.durationSec }, 'Stitched output is shorter than reported duration — partial capture');
    }
    return { path: outPath, partial };
  }

  // ─── PRIMARY CAPTURE: intercept the decrypted m3u8 playlist in-page ──────────

  /**
   * Obfuscated players decrypt the playlist in JS and hand it to the video layer
   * — almost always as a Blob (`URL.createObjectURL(new Blob([m3u8]))`) or via a
   * fetch/XHR whose body is the plaintext playlist. We inject a hook BEFORE any
   * page script runs that taps Blob construction + fetch + XHR and stashes any
   * body containing `#EXTM3U`. Playing the video triggers decryption; we then read
   * the captured playlist and parse out the full, correctly-ordered segment list.
   */
  private static async captureViaPlaylist(pageUrl: string, prefix: string): Promise<SegmentCapture | null> {
    let context = null;
    let page: Page | null = null;

    try {
      context = await BrowserManager.newContext();
      page = await context.newPage();

      await page.addInitScript(() => {
        (window as any).__caps = [];
        const scan = (t: any) => {
          try { if (typeof t === 'string' && t.indexOf('#EXTM3U') !== -1) (window as any).__caps.push(t); } catch { /* ignore */ }
        };
        const decode = (p: any) => {
          try {
            if (typeof p === 'string') return p;
            if (p instanceof ArrayBuffer) return new TextDecoder().decode(p);
            if (ArrayBuffer.isView(p)) return new TextDecoder().decode(p as any);
          } catch { /* ignore */ }
          return '';
        };
        // Blob constructor — the most common carrier for a decrypted playlist.
        const OrigBlob = window.Blob;
        const BlobHook = function (parts: any, opts: any) {
          try { if (Array.isArray(parts)) for (const p of parts) scan(decode(p)); } catch { /* ignore */ }
          return new OrigBlob(parts, opts);
        } as any;
        BlobHook.prototype = OrigBlob.prototype;
        window.Blob = BlobHook;
        // fetch — playlists fetched as plaintext.
        const origFetch = window.fetch;
        window.fetch = function (this: any, ...args: any[]) {
          return origFetch.apply(this, args as any).then((resp: Response) => {
            try { resp.clone().text().then(scan).catch(() => {}); } catch { /* ignore */ }
            return resp;
          });
        } as any;
        // XHR — older players.
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, ...a: any[]) {
          this.addEventListener('load', function (this: XMLHttpRequest) {
            try { if (this.responseType === '' || this.responseType === 'text') scan(this.responseText); } catch { /* ignore */ }
          });
          return origSend.apply(this, a as any);
        };
      });

      // Capture real segment request headers/UA while we're here (for download).
      let headers: Record<string, string> = { 'Referer': pageUrl, 'Origin': (() => { try { return new URL(pageUrl).origin; } catch { return pageUrl; } })() };
      let userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
      let gotHeaders = false;
      page.on('request', (request) => {
        if (gotHeaders || !request.url().startsWith(prefix)) return;
        gotHeaders = true;
        const h = request.headers();
        userAgent = h['user-agent'] || userAgent;
        headers = { 'Referer': h['referer'] || pageUrl, 'Origin': h['origin'] || headers['Origin'] };
        ['authorization', 'x-auth-token', 'x-access-token'].forEach(k => { if (h[k]) headers[k] = h[k]; });
      });

      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await BrowserHelpers.solveCFChallenge(page);
      await this.clickPlay(page);

      // Poll for a captured playlist that yields enough segments.
      const deadline = Date.now() + PLAYLIST_WAIT_MS;
      let best: { segments: string[]; durationSec: number; text: string; base: string } | null = null;
      const fetchedVariants = new Set<string>();
      while (Date.now() < deadline) {
        const caps: string[] = await page.evaluate(() => (window as any).__caps || []).catch(() => []);
        for (const text of caps) {
          let parsed = this.parsePlaylist(text, prefix);
          let parsedText = text;
          let base = prefix;

          // Master playlist (variants only, no #EXTINF) — follow its highest-
          // bandwidth variant to the real media playlist. Relative variant URIs
          // resolve against the segment-dir prefix (the best base we have in-page).
          if (!parsed && /#EXT-X-STREAM-INF/i.test(text)) {
            const variantUrl = FallbackExtractor.pickBestVariant(text, prefix);
            if (variantUrl && !fetchedVariants.has(variantUrl)) {
              fetchedVariants.add(variantUrl);
              const mediaText = await this.fetchText(variantUrl, headers, userAgent);
              const mediaParsed = mediaText ? this.parsePlaylist(mediaText, variantUrl) : null;
              if (mediaParsed && mediaText) {
                parsed = mediaParsed; parsedText = mediaText; base = variantUrl;
                logger.info({ variantUrl, segments: mediaParsed.segments.length }, 'Followed master playlist to best variant');
              }
            }
          }

          if (parsed && (!best || parsed.segments.length > best.segments.length)) {
            best = { ...parsed, text: parsedText, base };
          }
        }
        if (best && best.segments.length >= SEGMENT_RUN_MIN) break;
        await page.waitForTimeout(1000).catch(() => {});
      }

      if (!best || best.segments.length < SEGMENT_RUN_MIN) return null;
      logger.info({ segments: best.segments.length, durationSec: Math.round(best.durationSec) }, 'Intercepted decrypted playlist');
      return {
        segments: best.segments,
        headers,
        userAgent,
        durationSec: best.durationSec,
        coverageSec: best.durationSec,
        playlistText: this.normalizePlaylist(best.text, best.base),
      };

    } catch (err: any) {
      logger.warn({ pageUrl, err: err.message }, 'Playlist interception failed');
      return null;
    } finally {
      await page?.close().catch(() => {});
      await context?.close().catch(() => {});
    }
  }

  /**
   * Parse an HLS media playlist into an ordered segment list + total duration.
   * Master playlists (variants only, no #EXTINF) are skipped here — we keep the
   * captured text with the most segments, which is the media playlist.
   */
  static parsePlaylist(text: string, baseHint: string): { segments: string[]; durationSec: number } | null {
    if (text.indexOf('#EXTINF') === -1) return null;     // not a media playlist
    const segments: string[] = [];
    let durationSec = 0;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#EXTINF')) {
        const m = line.match(/#EXTINF:\s*([\d.]+)/i);
        if (m) durationSec += parseFloat(m[1]) || 0;
      } else if (!line.startsWith('#')) {
        const resolved = this.resolveSegUrl(line, baseHint);
        if (resolved) segments.push(resolved);
      }
    }
    return segments.length ? { segments, durationSec } : null;
  }

  /** Fetch a text resource (e.g. a media playlist) replaying the player's headers. */
  private static async fetchText(url: string, headers: Record<string, string>, userAgent: string): Promise<string | null> {
    try {
      const r = await axios.get(url, {
        headers: { ...headers, 'User-Agent': userAgent },
        timeout: SEGMENT_FETCH_TIMEOUT_MS,
        responseType: 'text',
        validateStatus: () => true,
        transformResponse: (d) => d,
      });
      return r.status < 400 && typeof r.data === 'string' ? r.data : null;
    } catch {
      return null;
    }
  }

  static resolveSegUrl(uri: string, baseHint: string): string | null {
    if (uri.startsWith('http')) return uri;
    if (uri.startsWith('//')) return 'https:' + uri;
    try { return new URL(uri, baseHint).href; } catch { return null; }
  }

  /**
   * A playlist needs ffmpeg's HLS engine when it's AES-encrypted (`#EXT-X-KEY`
   * METHOD=AES-128/SAMPLE-AES) or uses fMP4 init segments (`#EXT-X-MAP`) — things
   * the manual TS concat can't do. Plain MPEG-TS goes the faster manual route.
   */
  static needsFfmpeg(playlist: string): boolean {
    return /#EXT-X-KEY:[^\r\n]*METHOD=(AES-128|SAMPLE-AES)/i.test(playlist) || /#EXT-X-MAP/i.test(playlist);
  }

  /**
   * Detect a DRM-protected manifest (Widevine / PlayReady / FairPlay) — HLS via
   * a DRM KEYFORMAT or an `skd://` key URI, DASH via a Widevine/PlayReady
   * ContentProtection scheme. These can't be downloaded; we surface a clear
   * DRM_PROTECTED error instead of producing garbage. (Plain AES-128 with an http
   * key URI is *clear-key*, not DRM — ffmpeg decrypts it, so it's NOT flagged.)
   */
  static detectDrm(manifest: string): boolean {
    if (/KEYFORMAT="(com\.apple\.streamingkeydelivery|com\.microsoft\.playready|com\.widevine|urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed)"/i.test(manifest)) return true;
    if (/#EXT-X-(SESSION-)?KEY:[^\r\n]*URI="skd:\/\//i.test(manifest)) return true;
    if (/schemeIdUri="urn:uuid:(edef8ba9-79d6-4ace-a3c8-27dcd51d21ed|9a04f079-9840-4286-ab92-e65be0885f95)"/i.test(manifest)) return true;
    return false;
  }

  /**
   * Rewrite every relative URI in a media playlist to absolute so ffmpeg can read
   * it from a local temp file: segment lines, plus the `URI="..."` attribute on
   * `#EXT-X-KEY` (AES key) and `#EXT-X-MAP` (fMP4 init segment). Everything else
   * (durations, byteranges, IVs) is preserved verbatim.
   */
  static normalizePlaylist(text: string, baseHint: string): string {
    return text
      .split(/\r?\n/)
      .map((raw) => {
        const line = raw.trim();
        if (!line) return raw;
        if (line.startsWith('#')) {
          if (/URI="/.test(line)) {
            return line.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${this.resolveSegUrl(uri, baseHint) || uri}"`);
          }
          return raw;
        }
        return this.resolveSegUrl(line, baseHint) || raw;
      })
      .join('\n');
  }

  // ─── FALLBACK CAPTURE: chase the buffer through the whole timeline ───────────

  private static async captureSegments(pageUrl: string, prefix: string): Promise<SegmentCapture | null> {
    let context = null;
    let page: Page | null = null;

    try {
      context = await BrowserManager.newContext();
      page = await context.newPage();

      const seen = new Set<string>();
      const segments: string[] = [];
      let headers: Record<string, string> = {};
      let userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

      page.on('request', (request) => {
        const u = request.url();
        if (!u.startsWith(prefix) || seen.has(u)) return;
        seen.add(u);
        segments.push(u);
        if (segments.length === 1) {
          const h = request.headers();
          userAgent = h['user-agent'] || userAgent;
          headers = {
            'Referer': h['referer'] || pageUrl,
            'Origin': h['origin'] || (() => { try { return new URL(pageUrl).origin; } catch { return pageUrl; } })(),
          };
          ['authorization', 'x-auth-token', 'x-access-token'].forEach(k => { if (h[k]) headers[k] = h[k]; });
        }
      });

      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await BrowserHelpers.solveCFChallenge(page);
      await this.clickPlay(page);

      const deadline = Date.now() + CAPTURE_CAP_MS;
      let lastCount = 0;
      let lastNewAt = Date.now();
      let stuckTicks = 0;
      let durationSec = 0;
      let coverageSec = 0;

      while (Date.now() < deadline) {
        // Once the player has stalled for a couple of ticks, kick just past the
        // buffered frontier to force the next segment to load.
        const nudge = stuckTicks >= STUCK_TICKS_BEFORE_NUDGE;
        const state = await this.driveAndProbe(page, nudge);

        if (state) {
          durationSec = Math.max(durationSec, state.duration);
          coverageSec = Math.max(coverageSec, state.currentTime);
        }

        if (segments.length > lastCount) {
          lastCount = segments.length; lastNewAt = Date.now(); stuckTicks = 0;
        } else {
          stuckTicks++;
        }

        if (state?.ended) { logger.info('Segment capture: playback ended'); break; }
        if (durationSec > 0 && state && state.currentTime >= durationSec - 2) {
          logger.info({ coverageSec, durationSec }, 'Segment capture: reached end of timeline');
          break;
        }
        if (Date.now() - lastNewAt > STALL_MS) {
          logger.info({ segments: segments.length, coverageSec, durationSec }, 'Segment capture: stalled despite nudging — finishing');
          break;
        }

        if (segments.length > 0 && segments.length % 25 === 0) {
          logger.info({ segments: segments.length, coverageSec: Math.round(state?.currentTime || 0), durationSec: Math.round(durationSec) }, 'Segment capture progress');
        }
        await page.waitForTimeout(CHASE_INTERVAL_MS).catch(() => {});
      }

      return { segments, headers, userAgent, durationSec, coverageSec };

    } catch (err: any) {
      logger.error({ pageUrl, err: err.message }, 'Segment capture failed');
      return null;
    } finally {
      await page?.close().catch(() => {});
      await context?.close().catch(() => {});
    }
  }

  /** One initial pass clicking known play buttons across every frame. */
  static async clickPlay(page: Page): Promise<void> {
    for (const frame of page.frames()) {
      for (const sel of PLAY_BUTTON_SELECTORS) {
        try {
          const el = await frame.$(sel);
          if (el) { await el.click({ timeout: 1500 }).catch(() => {}); }
        } catch { /* not actionable */ }
      }
    }
  }

  /**
   * In every frame: force muted playback at high rate, ride the buffered frontier
   * (seek up to it so the player keeps fetching ahead), and when `nudge` is set,
   * seek a hair PAST the frontier to kick a stalled player into loading the next
   * segment. Returns the state of the first <video> found.
   */
  static async driveAndProbe(
    page: Page,
    nudge: boolean,
  ): Promise<{ currentTime: number; duration: number; ended: boolean } | null> {
    for (const frame of page.frames()) {
      try {
        const state = await frame.evaluate(({ doNudge, nudgeSec }) => {
          const v = document.querySelector('video');
          if (!v) return null;
          v.muted = true;
          // Fast LINEAR playback: let the player fetch its forward buffer naturally
          // at high rate. We deliberately do NOT seek during normal play — forcing
          // currentTime makes HLS players abort fragment loads and eventually error
          // out, which was stalling capture partway through. Seeking is used ONLY as
          // a last-resort kick when genuinely stalled.
          try { v.playbackRate = 16; } catch { /* clamped by player */ }
          const p = v.play(); if (p && (p as any).catch) (p as any).catch(() => {});

          if (doNudge) {
            let bend = v.currentTime;
            if (v.buffered && v.buffered.length) { try { bend = v.buffered.end(v.buffered.length - 1); } catch { /* not ready */ } }
            // Stalled: nudge a hair past the frontier to trigger the next segment.
            try { v.currentTime = bend + nudgeSec; } catch { /* seek rejected */ }
          }

          return {
            currentTime: v.currentTime,
            duration: isFinite(v.duration) ? v.duration : 0,
            ended: v.ended,
          };
        }, { doNudge: nudge, nudgeSec: NUDGE_SEC });
        if (state) return state;
      } catch { /* cross-origin / detached frame */ }
    }
    return null;
  }

  // ─── FFMPEG PLAYLIST PATH (preferred): let ffmpeg fetch + decrypt the HLS ─────

  /**
   * Serve the (absolute-rewritten) intercepted media playlist from an ephemeral
   * 127.0.0.1 HTTP server and point ffmpeg at it. ffmpeg's hls demuxer then does
   * the segment download, AES-128 decryption, and byte-range/fMP4 handling — and
   * the captured headers (Referer/Origin/UA) propagate to the segment + key
   * requests so the CDN authorizes. (ffmpeg rejects `-headers`/`-user_agent` for a
   * *local file* input, hence the tiny http server rather than a temp `.m3u8`.)
   */
  private static async stitchViaFfmpeg(
    cap: SegmentCapture,
    outPath: string,
    onProgress: (data: ProgressData) => void,
  ): Promise<void> {
    const playlist = cap.playlistText || '';
    const isFmp4 = /#EXT-X-MAP/i.test(playlist);

    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end(playlist);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : 0;
    const playlistUrl = `http://127.0.0.1:${port}/playlist.m3u8`;

    try {
      const ffmpeg = path.join(config.ffmpegPath, 'ffmpeg.exe');
      const headerLines = Object.entries(cap.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n';

      const args = [
        '-y',
        '-headers', headerLines,
        '-user_agent', cap.userAgent,
        '-protocol_whitelist', 'http,https,tcp,tls,crypto',
        // Segment URLs are often opaque/extensionless tokens; disable ffmpeg's
        // strict extension policing so it will fetch them.
        '-extension_picky', '0',
        '-i', playlistUrl,
        '-c', 'copy',
      ];
      // ADTS→ASC only applies to MPEG-TS audio; fMP4 audio is already ASC-framed.
      if (!isFmp4) args.push('-bsf:a', 'aac_adtstoasc');
      args.push(outPath);

      logger.info({ outPath, isFmp4, port }, 'Stitching via ffmpeg HLS engine');
      await this.runFfmpeg(ffmpeg, args, cap.durationSec, onProgress);
      onProgress({ progress: 100, size: '—', speed: '—', eta: '0s' });
      logger.info({ outPath }, 'ffmpeg playlist stitch complete');
    } finally {
      server.close();
    }
  }

  /** Spawn ffmpeg, parsing `time=` from stderr into download progress (0–99%). */
  static runFfmpeg(
    ffmpeg: string,
    args: string[],
    durationSec: number,
    onProgress: (data: ProgressData) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, args);
      let tail = '';
      child.stderr.on('data', (d) => {
        tail = (tail + d.toString()).slice(-4000);
        const m = tail.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g);
        if (m && durationSec > 0) {
          const last = m[m.length - 1].match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
          if (last) {
            const sec = +last[1] * 3600 + +last[2] * 60 + parseFloat(last[3]);
            const pct = Math.min(99, Math.round((sec / durationSec) * 100));
            onProgress({ progress: pct, size: '—', speed: '—', eta: '—' });
          }
        }
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg HLS exited ${code}: ${tail.slice(-500)}`));
      });
    });
  }

  // ─── MANUAL STITCH (fallback): download every segment, then ffmpeg concat ────

  /** Manual segment download + concat, retrying once at half concurrency if the
   *  proxy throttles too many segments. */
  private static async stitchManualWithRetry(
    cap: SegmentCapture,
    outPath: string,
    onProgress: (data: ProgressData) => void,
  ): Promise<void> {
    try {
      await this.stitch(cap, outPath, onProgress, config.segmentConcurrency);
    } catch (err: any) {
      if (/Too many segments failed/.test(err?.message || '') && config.segmentConcurrency > 1) {
        const lower = Math.max(1, Math.floor(config.segmentConcurrency / 2));
        logger.warn({ lower, err: err.message }, 'Stitch hit segment throttling — retrying once at lower concurrency');
        await this.stitch(cap, outPath, onProgress, lower);
      } else {
        throw err;
      }
    }
  }

  private static async stitch(
    cap: SegmentCapture,
    outPath: string,
    onProgress: (data: ProgressData) => void,
    concurrency: number,
  ): Promise<void> {
    const tmpDir = path.join(config.tempPath, `seg_${path.basename(outPath, path.extname(outPath))}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      const total = cap.segments.length;
      const reqHeaders = { ...cap.headers, 'User-Agent': cap.userAgent };
      const files: (string | undefined)[] = new Array(total);
      const missing: number[] = [];
      let done = 0;
      let bytes = 0;
      const startedAt = Date.now();

      // Bounded-concurrency pool. File index == playback order regardless of
      // which download finishes first, so the concat stays correctly ordered.
      // A segment that won't come down even after retries is recorded as missing
      // (a brief glitch) rather than failing the whole download.
      let next = 0;
      const worker = async () => {
        while (true) {
          const i = next++;
          if (i >= total) return;
          const name = `seg_${String(i).padStart(5, '0')}.ts`;
          try {
            const buf = await this.fetchSegment(cap.segments[i], reqHeaders);
            fs.writeFileSync(path.join(tmpDir, name), buf);
            files[i] = name;
            bytes += buf.length;
          } catch (err: any) {
            missing.push(i);
            logger.warn({ index: i, err: err.message }, 'Segment unrecoverable — skipping');
          }
          done++;

          const elapsed = (Date.now() - startedAt) / 1000;
          const mbps = elapsed > 0 ? (bytes / 1048576) / elapsed : 0;
          onProgress({
            progress: Math.round((done / total) * 90 * 10) / 10,   // segments = 0–90%
            size: `${(bytes / 1048576).toFixed(1)}MiB`,
            speed: `${mbps.toFixed(2)}MiB/s`,
            eta: mbps > 0 ? `${Math.max(0, Math.round((total - done) * (bytes / done) / 1048576 / mbps))}s` : '—',
          });
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, total)) }, worker));

      if (missing.length > total * MAX_MISSING_RATIO) {
        throw new Error(`Too many segments failed: ${missing.length}/${total} (proxy throttling?)`);
      }
      if (missing.length > 0) {
        logger.warn({ missing: missing.length, total }, 'Stitching with a few missing segments (minor glitches expected)');
      }

      // ffmpeg concat demuxer over the ordered list (skipping any missing).
      const listPath = path.join(tmpDir, 'filelist.txt');
      const ordered = files.filter((f): f is string => !!f);
      fs.writeFileSync(listPath, ordered.map(f => `file '${f}'`).join('\n'), 'utf8');

      onProgress({ progress: 92, size: `${(bytes / 1048576).toFixed(1)}MiB`, speed: '—', eta: 'merging' });
      await this.ffmpegConcat(listPath, outPath, tmpDir);
      onProgress({ progress: 100, size: `${(bytes / 1048576).toFixed(1)}MiB`, speed: '—', eta: '0s' });

      logger.info({ outPath, segments: total, mb: (bytes / 1048576).toFixed(1) }, 'Segment stitch complete');

    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /** Fetch one segment with retries and a hard wall-clock cap (a trickling
   *  connection can outlive axios' own timeout, so we race an AbortController). */
  private static async fetchSegment(url: string, headers: Record<string, string>): Promise<Buffer> {
    let lastErr: any;
    for (let attempt = 1; attempt <= SEGMENT_FETCH_RETRIES; attempt++) {
      const controller = new AbortController();
      const hardKill = setTimeout(() => controller.abort(), SEGMENT_FETCH_TIMEOUT_MS);
      try {
        const r = await axios.get(url, {
          headers,
          responseType: 'arraybuffer',
          timeout: SEGMENT_FETCH_TIMEOUT_MS,
          signal: controller.signal,
        });
        return Buffer.from(r.data);
      } catch (err: any) {
        lastErr = err;
        await new Promise(res => setTimeout(res, 500 * attempt));
      } finally {
        clearTimeout(hardKill);
      }
    }
    throw new Error(`Segment fetch failed after ${SEGMENT_FETCH_RETRIES} tries: ${url} (${lastErr?.message})`);
  }

  private static ffmpegConcat(listPath: string, outPath: string, cwd: string): Promise<void> {
    const ffmpeg = path.join(config.ffmpegPath, 'ffmpeg.exe');
    // -c copy: no re-encode. aac_adtstoasc: required to mux ADTS/TS audio into mp4.
    const args = ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', outPath];

    return new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, args, { cwd });
      let stderr = '';
      child.stderr.on('data', d => { stderr += d.toString(); });
      child.on('error', reject);
      child.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg concat exited ${code}: ${stderr.slice(-500)}`));
      });
    });
  }
}
