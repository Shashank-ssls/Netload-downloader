/**
 * diagnostics.ts
 *
 * A `diagnose` / inspect mode: when a NEW site fails to download, open it
 * headless and dump *everything* useful to a single report instead of grepping
 * logs. It reuses the Tier-2 browser plumbing but, rather than filtering for the
 * one stream we want, records:
 *   - every request/response (URL, resource type, status, Content-Type, first
 *     bytes, and our content-based media classification)
 *   - the post-render <video> elements (incl. whether their src is a blob:)
 *   - which player globals exist (jwplayer / videojs / Hls / dashjs / Plyr)
 *   - MSE / Blob activity (SourceBuffer.appendBuffer calls + mime types) — the
 *     tell-tale of "video plays but nothing downloads"
 *   - the full iframe chain
 * and then turns those facts into plain-language hints about why a download
 * would (or wouldn't) work, pointing at the relevant reach gap.
 *
 * The summarising + hint logic is pure and unit-tested; only the capture itself
 * needs a browser.
 */

import logger from '../logger';
import { BrowserManager } from '../utils/browserManager';
import { BrowserHelpers } from '../utils/browserHelpers';
import { classifyContentType, classifyBytes, type MediaKind } from './mediaSignature';
import type { Page, Response as PlaywrightResponse } from 'playwright-core';

const DIAG_RESOURCE_TYPES = ['xhr', 'fetch', 'media', 'other', 'document'];
const SNIFF_MAX_BYTES = 2 * 1024 * 1024;
const MAX_REQUESTS = 500;
const CAPTURE_MS = 30_000;

const PLAY_BUTTON_SELECTORS = [
  '.vjs-big-play-button', '.jw-display-icon-container', '.plyr__control--overlaid',
  '[data-plyr="play"]', '.play-button', '#play-btn', '.btn-play',
  '.player-play-overlay', '.play-overlay', '[class*="play-btn"]', '[class*="playBtn"]',
  'button[aria-label*="play" i]', '[aria-label*="Play" i]', '.icon-play', '.fa-play', 'video',
];

export interface DiagRequest {
  url: string;
  method: string;
  resourceType: string;
  status?: number;
  contentType?: string;
  contentLength?: number;
  firstBytesHex?: string;
  mediaKind?: MediaKind;
}

export interface DiagPageState {
  videos: { src: string; currentSrc: string; duration: number; usesBlob: boolean }[];
  playerGlobals: string[];
  mediaSourceUsed: boolean;
  appendBufferCount: number;
  sourceBufferMimes: string[];
  blobUrlCount: number;
  iframeChain: string[];
}

export interface DiagnosticReport {
  url: string;
  finalUrl: string;
  durationMs: number;
  totalRequests: number;
  byResourceType: Record<string, number>;
  mediaRequests: DiagRequest[];
  requests: DiagRequest[];
  page: DiagPageState;
  hints: string[];
}

// ─── PURE SUMMARY / HINT LOGIC (unit-tested, no browser) ──────────────────────

export function tallyResourceTypes(requests: DiagRequest[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of requests) out[r.resourceType] = (out[r.resourceType] || 0) + 1;
  return out;
}

export function mediaRequestsOf(requests: DiagRequest[]): DiagRequest[] {
  return requests.filter((r) => !!r.mediaKind);
}

/**
 * Turn the captured facts into plain-language guidance, each line pointing at the
 * relevant reach mechanism (or gap). Pure: depends only on the report fields.
 */
export function deriveHints(r: Omit<DiagnosticReport, 'hints'>): string[] {
  const hints: string[] = [];
  const media = r.mediaRequests;
  const kinds = new Set(media.map((m) => m.mediaKind));
  const blobVideo = r.page.videos.some((v) => v.usesBlob);

  if (kinds.has('hls')) {
    hints.push('HLS manifest seen on the network — downloadable via the HLS engine. If the URL is opaque it is now caught by content-based capture.');
  }
  if (kinds.has('dash')) {
    hints.push('DASH (.mpd) manifest seen — detected but DASH reassembly is not yet implemented (roadmap #3); a download will currently fall through.');
  }
  if (kinds.has('mp4') && !kinds.has('hls')) {
    hints.push('Progressive media response(s) seen — should download directly.');
  }
  if (kinds.has('ts') && !kinds.has('hls')) {
    hints.push('MPEG-TS segments seen without a manifest — segment-run stitching should apply.');
  }

  if (r.page.appendBufferCount > 0) {
    const detail = r.page.sourceBufferMimes.length ? ` (mimes: ${r.page.sourceBufferMimes.join(', ')})` : '';
    if (media.length === 0) {
      hints.push(`MSE/appendBuffer in use${detail} but no media URLs on the network — the player decrypts/feeds segments in JS straight to the <video>. Needs SourceBuffer interception (roadmap #2).`);
    } else {
      hints.push(`MSE/appendBuffer in use${detail}; media was also seen on the network.`);
    }
  } else if (blobVideo && media.length === 0) {
    hints.push('The <video> src is a blob: with no media on the network — content is delivered via MSE/Blob; needs in-page interception (roadmap #2).');
  }

  if (media.length === 0 && r.page.appendBufferCount === 0 && !blobVideo) {
    hints.push('No media detected at all — the site may require login/cookies, a different interaction, or render the player behind an embed we did not follow.');
  }
  if (r.page.playerGlobals.length) {
    hints.push(`Player globals present: ${r.page.playerGlobals.join(', ')}.`);
  }
  if (r.page.iframeChain.length) {
    hints.push(`Followed ${r.page.iframeChain.length} iframe(s): ${r.page.iframeChain.slice(0, 5).join(' -> ')}${r.page.iframeChain.length > 5 ? ' …' : ''}.`);
  }
  return hints;
}

export function toHex(buf: Uint8Array, n = 16): string {
  const end = Math.min(buf.length, n);
  let s = '';
  for (let i = 0; i < end; i++) s += buf[i].toString(16).padStart(2, '0');
  return s;
}

// ─── CAPTURE (browser) ────────────────────────────────────────────────────────

export class Diagnostics {
  static async run(url: string): Promise<DiagnosticReport> {
    const started = Date.now();
    let context = null;
    let page: Page | null = null;
    const requests: DiagRequest[] = [];
    const seen = new Set<string>();

    try {
      logger.info({ url }, 'Diagnose: opening page for full inspection');
      context = await BrowserManager.newContext();
      page = await context.newPage();

      // In-page probe: record MSE/Blob activity that never touches the network.
      await page.addInitScript(() => {
        const d: any = ((window as any).__diag = { append: 0, mimes: [] as string[], blobs: 0, mse: false });
        try {
          const proto = (window as any).SourceBuffer && (window as any).SourceBuffer.prototype;
          if (proto && proto.appendBuffer) {
            const orig = proto.appendBuffer;
            proto.appendBuffer = function (this: any, ...args: any[]) {
              try { d.append++; if (this && this.__mime && d.mimes.indexOf(this.__mime) === -1) d.mimes.push(this.__mime); } catch { /* ignore */ }
              return orig.apply(this, args);
            };
          }
          const MS = (window as any).MediaSource;
          if (MS && MS.prototype && MS.prototype.addSourceBuffer) {
            d.mse = true;
            const add = MS.prototype.addSourceBuffer;
            MS.prototype.addSourceBuffer = function (this: any, mime: string, ...rest: any[]) {
              const sb = add.apply(this, [mime, ...rest]);
              try { sb.__mime = mime; if (d.mimes.indexOf(mime) === -1) d.mimes.push(mime); } catch { /* ignore */ }
              return sb;
            };
          }
          const origCreate = URL.createObjectURL;
          URL.createObjectURL = function (this: any, ...args: any[]) { try { d.blobs++; } catch { /* ignore */ } return origCreate.apply(this, args as any); };
        } catch { /* probe best-effort */ }
      });

      page.on('response', (response) => { void this.recordResponse(response, requests, seen); });

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch((e) => {
        logger.warn({ url, err: e.message }, 'Diagnose: navigation issue (continuing)');
      });
      await BrowserHelpers.solveCFChallenge(page);
      await this.drivePlayback(page);

      const finalUrl = page.url();
      const pageState = await this.collectPageState(page);

      const base = {
        url,
        finalUrl,
        durationMs: Date.now() - started,
        totalRequests: requests.length,
        byResourceType: tallyResourceTypes(requests),
        mediaRequests: mediaRequestsOf(requests),
        requests: requests.slice(0, MAX_REQUESTS),
        page: pageState,
      };
      const report: DiagnosticReport = { ...base, hints: deriveHints(base) };
      logger.info({ url, totalRequests: report.totalRequests, media: report.mediaRequests.length }, 'Diagnose: report ready');
      return report;
    } finally {
      await page?.close().catch(() => {});
      await context?.close().catch(() => {});
    }
  }

  private static async recordResponse(
    response: PlaywrightResponse,
    requests: DiagRequest[],
    seen: Set<string>,
  ): Promise<void> {
    try {
      if (requests.length >= MAX_REQUESTS) return;
      const reqUrl = response.url();
      const request = response.request();
      const resourceType = request.resourceType();
      if (!DIAG_RESOURCE_TYPES.includes(resourceType)) return;
      if (seen.has(reqUrl)) return;
      seen.add(reqUrl);

      const headers = response.headers();
      const contentType = headers['content-type'];
      const len = parseInt(headers['content-length'] || '', 10);
      const rec: DiagRequest = {
        url: reqUrl,
        method: request.method(),
        resourceType,
        status: response.status(),
        contentType,
        contentLength: Number.isFinite(len) ? len : undefined,
      };

      let kind = classifyContentType(contentType);
      // Sniff first bytes for media/ambiguous responses that are cheap to read.
      const sniffable = resourceType !== 'document' &&
        (!Number.isFinite(len) || (len > 0 && len <= SNIFF_MAX_BYTES));
      if (sniffable && (!kind || kind === 'media' || resourceType === 'media' || resourceType === 'other')) {
        const body = await response.body().catch(() => null);
        if (body) {
          rec.firstBytesHex = toHex(body);
          const sniffed = classifyBytes(body.subarray(0, 512));
          if (sniffed) kind = sniffed;
        }
      }
      if (kind) rec.mediaKind = kind;
      requests.push(rec);
    } catch { /* response gone */ }
  }

  private static async collectPageState(page: Page): Promise<DiagPageState> {
    // Child frames only — exclude the top/main frame (it's the page, not an iframe).
    const main = page.mainFrame();
    const iframeChain = page.frames()
      .filter((f) => f !== main)
      .map((f) => f.url())
      .filter((u) => u && u !== 'about:blank');

    const inPage = await page.evaluate(() => {
      const vids = Array.from(document.querySelectorAll('video')).map((v) => ({
        src: v.getAttribute('src') || '',
        currentSrc: (v as HTMLVideoElement).currentSrc || '',
        duration: isFinite((v as HTMLVideoElement).duration) ? (v as HTMLVideoElement).duration : 0,
        usesBlob: ((v as HTMLVideoElement).currentSrc || v.getAttribute('src') || '').startsWith('blob:'),
      }));
      const w = window as any;
      const globals = ['jwplayer', 'videojs', 'Hls', 'dashjs', 'Plyr', 'shaka', 'flowplayer', 'clappr']
        .filter((g) => typeof w[g] !== 'undefined');
      const d = w.__diag || {};
      return {
        videos: vids,
        playerGlobals: globals,
        mediaSourceUsed: !!d.mse || typeof w.MediaSource !== 'undefined',
        appendBufferCount: d.append || 0,
        sourceBufferMimes: d.mimes || [],
        blobUrlCount: d.blobs || 0,
      };
    }).catch(() => ({
      videos: [], playerGlobals: [], mediaSourceUsed: false,
      appendBufferCount: 0, sourceBufferMimes: [], blobUrlCount: 0,
    }));

    return { ...inPage, iframeChain };
  }

  /** Drive playback briefly across every frame so the player actually loads media. */
  private static async drivePlayback(page: Page): Promise<void> {
    const deadline = Date.now() + CAPTURE_MS;
    while (Date.now() < deadline) {
      for (const frame of page.frames()) {
        for (const sel of PLAY_BUTTON_SELECTORS) {
          try { const el = await frame.$(sel); if (el) await el.click({ timeout: 1000 }).catch(() => {}); } catch { /* not actionable */ }
        }
        try {
          await frame.evaluate(() => {
            const v = document.querySelector('video');
            if (v) { (v as HTMLVideoElement).muted = true; (v as HTMLVideoElement).play?.().catch(() => {}); }
          });
        } catch { /* cross-origin */ }
      }
      await page.waitForTimeout(2500).catch(() => {});
    }
  }
}
