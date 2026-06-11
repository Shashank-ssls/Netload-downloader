/**
 * mseCapture.ts
 *
 * Roadmap #2 — the "video plays but nothing downloads" case.
 *
 * A growing class of players never expose a media URL on the network at all.
 * They decrypt/assemble the media in JavaScript and feed the raw bytes straight
 * to the <video> via `SourceBuffer.prototype.appendBuffer()`. The <video> carries
 * a `blob:` src and there is nothing useful to intercept on the wire — so neither
 * the candidate walk (no URL) nor the segment stitcher (no sibling segment URLs)
 * can see it.
 *
 * This module handles that delivery pattern generically (no per-site rules):
 *   1. HOOK — before any page script runs, wrap `MediaSource.addSourceBuffer`
 *      (to tag each SourceBuffer with an id + mime) and `SourceBuffer.appendBuffer`
 *      (to copy every appended ArrayBuffer and ship it to Node, in order). We also
 *      detect EME (`requestMediaKeySystemAccess` / `setMediaKeys`) so a Widevine/
 *      PlayReady stream — whose appended bytes are still encrypted — is surfaced as
 *      DRM_PROTECTED rather than written out as garbage.
 *   2. CAPTURE — play the video through the whole timeline (reusing the segment
 *      stitcher's buffer-chase driver), accumulating each SourceBuffer's byte
 *      stream to a temp file. Concatenated fMP4 init + media fragments form a valid
 *      fragmented MP4 per track.
 *   3. MUX — hand the per-track files to ffmpeg (`-c copy`) to remux/interleave
 *      into a single output, then ffprobe against the player-reported duration.
 */

import fs from 'fs';
import path from 'path';
import logger from '../logger';
import { config } from '../config';
import { BrowserManager } from '../utils/browserManager';
import { BrowserHelpers } from '../utils/browserHelpers';
import { FileValidator } from '../utils/validators';
import { SegmentStitcher, type StitchResult } from './segmentStitcher';
import type { ProgressData } from '../types';
import type { Page } from 'playwright-core';

// Whole-episode capture is bounded — a runaway player can't hang a download.
const CAPTURE_CAP_MS = 12 * 60 * 1000;
// Give up if no new bytes are appended for this long despite nudging.
const STALL_MS = 30_000;
const CHASE_INTERVAL_MS = 1200;
const STUCK_TICKS_BEFORE_NUDGE = 10;
// Bail quickly if the site simply isn't an MSE site: no appends within this long.
const FIRST_APPEND_WAIT_MS = 25_000;
// After playback ends, give in-flight binding messages a moment to drain.
const FLUSH_WAIT_MS = 2_000;
// Floors below which we treat the capture as "not a real MSE stream" and bail.
const MIN_TOTAL_BYTES = 512 * 1024;
const MIN_APPENDS = 3;
// Hard ceiling so a misbehaving page can't fill the disk.
const MAX_TOTAL_BYTES = 6 * 1024 * 1024 * 1024;
// A real MSE stream has a handful of SourceBuffers (video/audio/maybe a couple);
// cap distinct track ids so a hostile page can't grow the map unboundedly.
const MAX_TRACKS = 16;
// Output shorter than this fraction of the player-reported duration = partial.
const COMPLETE_COVERAGE_RATIO = 0.9;

export type TrackKind = 'video' | 'audio' | 'muxed' | 'other';

/** One appended payload shipped from the page to Node via the exposed binding. */
interface SinkPayload {
  id: number;
  mime: string;
  seq: number;
  b64: string;
}

interface TrackState {
  id: number;
  mime: string;
  file: string;
  stream: fs.WriteStream;
  bytes: number;
  appends: number;
  nextSeq: number;     // expected seq, for out-of-order detection
  outOfOrder: boolean;
}

// ─── PURE HELPERS (unit-tested, no browser) ───────────────────────────────────

const VIDEO_CODEC_RE = /^(avc1|avc3|hev1|hvc1|vp0?8|vp0?9|av01|mp4v|dvh|dvav)/;
const AUDIO_CODEC_RE = /^(mp4a|opus|ac-3|ec-3|vorbis|flac|alac|dtsc|dtse)/;

/**
 * Classify a SourceBuffer mime (e.g. `video/mp4; codecs="avc1.4d401f, mp4a.40.2"`)
 * as a video-only, audio-only, muxed (both), or unknown track. MSE players nearly
 * always use separate audio + video SourceBuffers, but some mux both into one.
 */
export function classifyTrack(mime: string): TrackKind {
  const m = (mime || '').toLowerCase();
  const codecs = (m.match(/codecs\s*=\s*"?([^";]+)"?/) || [])[1] || '';
  const list = codecs.split(/,\s*/).map((c) => c.trim()).filter(Boolean);
  const hasVCodec = list.some((c) => VIDEO_CODEC_RE.test(c));
  const hasACodec = list.some((c) => AUDIO_CODEC_RE.test(c));

  if (hasVCodec && hasACodec) return 'muxed';
  if (m.startsWith('video/')) return hasACodec && !hasVCodec ? 'muxed' : 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (hasVCodec) return 'video';
  if (hasACodec) return 'audio';
  return 'other';
}

/**
 * Order the captured track files (video/muxed first, then audio, then other) and
 * build the ffmpeg args to remux them into a single file with `-c copy`. Each
 * input is explicitly mapped so ffmpeg interleaves all tracks (its default would
 * otherwise pick a single stream from a single input).
 */
export function buildMuxArgs(inputs: { path: string; kind: TrackKind }[], outPath: string): string[] {
  const rank = (k: TrackKind) => (k === 'video' || k === 'muxed' ? 0 : k === 'audio' ? 1 : 2);
  const ordered = [...inputs].sort((a, b) => rank(a.kind) - rank(b.kind));
  const args = ['-y'];
  for (const inp of ordered) args.push('-i', inp.path);
  for (let i = 0; i < ordered.length; i++) args.push('-map', String(i));
  args.push('-c', 'copy', outPath);
  return args;
}

// ─── CAPTURE (browser) ────────────────────────────────────────────────────────

export class MseCapturer {

  /**
   * Open `pageUrl`, intercept the MSE appendBuffer stream, and mux the captured
   * tracks into `outPath`. Returns the output path (+ whether it's partial), or
   * null if the page isn't an MSE site / produced too little to be real content.
   * Throws `Error('DRM_PROTECTED')` if the stream is EME-protected.
   */
  static async run(
    pageUrl: string,
    outPath: string,
    onProgress: (data: ProgressData) => void,
  ): Promise<StitchResult | null> {
    const tmpDir = path.join(config.tempPath, `mse_${path.basename(outPath, path.extname(outPath))}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    let context = null;
    let page: Page | null = null;
    const tracks = new Map<number, TrackState>();
    let totalBytes = 0;
    let totalAppends = 0;
    let capped = false;

    try {
      context = await BrowserManager.newContext({ url: pageUrl });
      page = await context.newPage();

      // Node-side sink: each appended fragment is written, in arrival order, to
      // its track's file. Binding callbacks for one page are delivered in call
      // order, so arrival order == append order (we still flag any seq gap).
      await page.exposeBinding('__mseSink', (_src, payload: SinkPayload) => {
        try {
          // Validate the page-controlled payload shape before trusting it.
          if (capped || !payload || typeof payload.b64 !== 'string') return;
          if (typeof payload.id !== 'number' || !Number.isInteger(payload.id) || payload.id < 0 || payload.id >= MAX_TRACKS) return;
          if (typeof payload.seq !== 'number' || !Number.isInteger(payload.seq) || payload.seq < 0) return;
          const buf = Buffer.from(payload.b64, 'base64');
          if (buf.length === 0) return;
          let t = tracks.get(payload.id);
          if (!t) {
            if (tracks.size >= MAX_TRACKS) return; // refuse to grow past the cap
            const file = path.join(tmpDir, `track_${payload.id}.mp4`);
            t = {
              id: payload.id, mime: payload.mime || '', file,
              stream: fs.createWriteStream(file), bytes: 0, appends: 0,
              nextSeq: 0, outOfOrder: false,
            };
            tracks.set(payload.id, t);
          }
          if (!t.mime && payload.mime) t.mime = payload.mime;
          if (payload.seq !== t.nextSeq) t.outOfOrder = true;
          t.nextSeq = payload.seq + 1;
          t.stream.write(buf);
          t.bytes += buf.length;
          t.appends++;
          totalBytes += buf.length;
          totalAppends++;
          if (totalBytes > MAX_TOTAL_BYTES && !capped) {
            capped = true;
            logger.warn({ totalBytes }, 'MSE capture hit byte ceiling — stopping');
          }
        } catch (err: any) {
          logger.warn({ err: err.message }, 'MSE sink write failed');
        }
      });

      // In-page hooks: tag SourceBuffers + capture every appendBuffer, and flag EME.
      await page.addInitScript(() => {
        const w = window as any;
        w.__mse = { eme: false, started: false };
        const toB64 = (bytes: Uint8Array): string => {
          let s = '';
          const CHUNK = 0x8000;
          for (let i = 0; i < bytes.length; i += CHUNK) {
            s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as any);
          }
          return btoa(s);
        };
        try {
          const MS = w.MediaSource;
          if (MS && MS.prototype && MS.prototype.addSourceBuffer) {
            let nextId = 0;
            const addOrig = MS.prototype.addSourceBuffer;
            MS.prototype.addSourceBuffer = function (this: any, mime: string, ...rest: any[]) {
              const sb = addOrig.apply(this, [mime, ...rest]);
              try { sb.__mseId = nextId++; sb.__mseMime = mime; sb.__mseSeq = 0; } catch { /* frozen */ }
              return sb;
            };
          }
          const SB = w.SourceBuffer;
          if (SB && SB.prototype && SB.prototype.appendBuffer) {
            const apOrig = SB.prototype.appendBuffer;
            SB.prototype.appendBuffer = function (this: any, data: any, ...rest: any[]) {
              try {
                let view: Uint8Array | null = null;
                if (data instanceof ArrayBuffer) view = new Uint8Array(data);
                else if (data && data.buffer) view = new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
                if (view && view.length) {
                  if (this.__mseId === undefined) { this.__mseId = 0; this.__mseSeq = 0; }
                  w.__mse.started = true;
                  // Copy synchronously (the player may reuse the buffer), ship async.
                  const copy = new Uint8Array(view);
                  const seq = this.__mseSeq++;
                  const id = this.__mseId;
                  const mime = this.__mseMime || '';
                  Promise.resolve().then(() => {
                    try { w.__mseSink({ id, mime, seq, b64: toB64(copy) }); } catch { /* binding gone */ }
                  });
                }
              } catch { /* never break playback */ }
              return apOrig.apply(this, [data, ...rest]);
            };
          }
          // EME detection — these streams stay encrypted in the appended bytes.
          if (w.navigator && navigator.requestMediaKeySystemAccess) {
            const emeOrig: any = navigator.requestMediaKeySystemAccess.bind(navigator);
            (navigator as any).requestMediaKeySystemAccess = function (this: any, ...a: any[]) {
              try { w.__mse.eme = true; } catch { /* ignore */ }
              return emeOrig(...a);
            };
          }
          const HME = w.HTMLMediaElement;
          if (HME && HME.prototype && HME.prototype.setMediaKeys) {
            const smkOrig = HME.prototype.setMediaKeys;
            HME.prototype.setMediaKeys = function (this: any, keys: any) {
              try { if (keys) w.__mse.eme = true; } catch { /* ignore */ }
              return smkOrig.apply(this, [keys]);
            };
          }
        } catch { /* hooks are best-effort */ }
      });

      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await BrowserHelpers.solveCFChallenge(page);
      await SegmentStitcher.clickPlay(page);

      // Drive playback through the timeline, accumulating appended bytes.
      const deadline = Date.now() + CAPTURE_CAP_MS;
      const firstAppendDeadline = Date.now() + FIRST_APPEND_WAIT_MS;
      let lastBytes = 0;
      let lastNewAt = Date.now();
      let stuckTicks = 0;
      let durationSec = 0;
      let coverageSec = 0;

      while (Date.now() < deadline && !capped) {
        const nudge = stuckTicks >= STUCK_TICKS_BEFORE_NUDGE;
        const state = await SegmentStitcher.driveAndProbe(page, nudge);
        if (state) {
          durationSec = Math.max(durationSec, state.duration);
          coverageSec = Math.max(coverageSec, state.currentTime);
        }

        if (totalBytes > lastBytes) {
          lastBytes = totalBytes; lastNewAt = Date.now(); stuckTicks = 0;
        } else {
          stuckTicks++;
        }

        // Quick bail: not an MSE site at all.
        if (totalAppends === 0 && Date.now() > firstAppendDeadline) {
          logger.info({ pageUrl }, 'MSE capture: no appendBuffer activity — not an MSE stream');
          break;
        }
        if (state?.ended) { logger.info('MSE capture: playback ended'); break; }
        if (durationSec > 0 && state && state.currentTime >= durationSec - 2) {
          logger.info({ coverageSec, durationSec }, 'MSE capture: reached end of timeline');
          break;
        }
        if (totalAppends > 0 && Date.now() - lastNewAt > STALL_MS) {
          logger.info({ totalBytes, coverageSec, durationSec }, 'MSE capture: stalled despite nudging — finishing');
          break;
        }
        if (totalAppends > 0) {
          const mb = (totalBytes / 1048576);
          onProgress({
            progress: durationSec > 0 ? Math.min(90, Math.round((coverageSec / durationSec) * 90)) : 0,
            size: `${mb.toFixed(1)}MiB`, speed: '—',
            eta: durationSec > 0 ? `${Math.max(0, Math.round(durationSec - coverageSec))}s` : '—',
          });
        }
        await page.waitForTimeout(CHASE_INTERVAL_MS).catch(() => {});
      }

      // Let any in-flight sink messages drain, then read the EME flag.
      await page.waitForTimeout(FLUSH_WAIT_MS).catch(() => {});
      const eme = await page.evaluate(() => !!(window as any).__mse?.eme).catch(() => false);

      await page?.close().catch(() => {});
      page = null;
      await context?.close().catch(() => {});
      context = null;

      // Close all track files before ffmpeg reads them.
      await Promise.all([...tracks.values()].map((t) => new Promise<void>((r) => t.stream.end(() => r()))));

      if (eme) {
        logger.error({ pageUrl }, 'MSE stream is EME/DRM-protected — appended bytes stay encrypted');
        throw new Error('DRM_PROTECTED');
      }

      if (totalAppends < MIN_APPENDS || totalBytes < MIN_TOTAL_BYTES) {
        logger.info({ pageUrl, totalAppends, totalBytes }, 'MSE capture too small — not a real stream');
        return null;
      }

      const inputs = [...tracks.values()]
        .filter((t) => t.bytes > 0)
        .map((t) => {
          if (t.outOfOrder) logger.warn({ id: t.id }, 'MSE track had out-of-order appends — output may be corrupt');
          return { path: t.file, kind: classifyTrack(t.mime), mime: t.mime, bytes: t.bytes };
        });
      logger.info(
        { pageUrl, tracks: inputs.map((i) => ({ kind: i.kind, mb: (i.bytes / 1048576).toFixed(1) })), durationSec: Math.round(durationSec) },
        'MSE capture complete — muxing tracks',
      );

      const ffmpeg = path.join(config.ffmpegPath, 'ffmpeg.exe');
      const args = buildMuxArgs(inputs, outPath);
      await SegmentStitcher.runFfmpeg(ffmpeg, args, durationSec, onProgress);
      onProgress({ progress: 100, size: `${(totalBytes / 1048576).toFixed(1)}MiB`, speed: '—', eta: '0s' });

      const outDur = FileValidator.probeDurationSec(outPath) ?? 0;
      const partial = durationSec > 0 && outDur > 0 && outDur < durationSec * COMPLETE_COVERAGE_RATIO;
      if (partial) {
        logger.warn({ outPath, outDur, reported: durationSec }, 'MSE output shorter than reported duration — partial capture');
      }
      return { path: outPath, partial };

    } catch (err: any) {
      if (err?.message === 'DRM_PROTECTED') throw err;
      logger.error({ pageUrl, err: err.message }, 'MSE capture failed');
      return null;
    } finally {
      await page?.close().catch(() => {});
      await context?.close().catch(() => {});
      // Ensure streams are closed even on the error path before cleanup.
      for (const t of tracks.values()) { try { t.stream.destroy(); } catch { /* already closed */ } }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}
