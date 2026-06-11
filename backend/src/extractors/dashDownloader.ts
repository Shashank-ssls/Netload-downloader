/**
 * dashDownloader.ts
 *
 * Roadmap #3 — DASH (.mpd) was detected (scored, duration-probed) but never
 * actually downloaded, so newer sites that deliver via MPEG-DASH fell through.
 *
 * DASH is the #2 manifest format after HLS. ffmpeg's dash demuxer fetches the
 * manifest and reassembles SegmentTemplate/Timeline/SegmentBase natively, so —
 * exactly like R1 routes HLS through ffmpeg — we point ffmpeg straight at the
 * captured `.mpd` URL with the player's headers/UA and `-c copy`. ffmpeg's default
 * stream selection picks the best video + audio representation across the ladder.
 *
 * yt-dlp's own DASH handling is patchier for opaque/unlisted sites, so for a
 * captured manifest we prefer this dedicated path. DRM-protected manifests
 * (Widevine/PlayReady ContentProtection) are surfaced as DRM_PROTECTED rather than
 * producing an undecryptable file — reusing the same detector as the HLS path.
 */

import axios from 'axios';
import path from 'path';
import logger from '../logger';
import { config } from '../config';
import { FileValidator } from '../utils/validators';
import { SegmentStitcher, type StitchResult } from './segmentStitcher';
import type { ProgressData } from '../types';

const MANIFEST_FETCH_TIMEOUT_MS = 15_000;
const MANIFEST_MAX_BYTES = 16 * 1024 * 1024;
// Output shorter than this fraction of the manifest-reported duration = partial.
const COMPLETE_COVERAGE_RATIO = 0.9;

export class DashDownloader {

  /** A URL whose path is a DASH manifest. (Content-classified `dash` streams are
   *  routed by mediaKind in the caller; this catches the plain-URL case.) */
  static isDashUrl(url: string): boolean {
    return /\.mpd(\?|$)/i.test(url);
  }

  /**
   * Download a DASH manifest to `outPath` via ffmpeg. Throws `Error('DRM_PROTECTED')`
   * if the manifest carries a Widevine/PlayReady ContentProtection scheme.
   */
  static async run(
    manifestUrl: string,
    headers: Record<string, string>,
    userAgent: string,
    durationSec: number,
    outPath: string,
    onProgress: (data: ProgressData) => void,
  ): Promise<StitchResult> {
    // DRM pre-check: peek at the manifest XML before committing to a download.
    let manifestText = '';
    try {
      const r = await axios.get(manifestUrl, {
        headers: { ...headers, 'User-Agent': userAgent },
        timeout: MANIFEST_FETCH_TIMEOUT_MS,
        responseType: 'text',
        maxContentLength: MANIFEST_MAX_BYTES,
        transformResponse: (d) => d, // keep raw text, don't let axios parse XML
      });
      manifestText = typeof r.data === 'string' ? r.data : String(r.data);
    } catch (err: any) {
      logger.warn({ manifestUrl, err: err.message }, 'Could not pre-fetch DASH manifest for DRM check — proceeding');
    }
    if (manifestText && SegmentStitcher.detectDrm(manifestText)) {
      logger.error({ manifestUrl }, 'DASH manifest is DRM-protected — cannot download');
      throw new Error('DRM_PROTECTED');
    }

    const ffmpeg = path.join(config.ffmpegPath, 'ffmpeg.exe');
    const headerLines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n';
    const args = [
      '-y',
      '-headers', headerLines,
      '-user_agent', userAgent,
      '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
      '-i', manifestUrl,
      // No explicit -map: ffmpeg's default stream selection takes the best video +
      // best audio representation. -c copy: remux only, no re-encode.
      '-c', 'copy',
      outPath,
    ];

    logger.info({ manifestUrl, outPath, durationSec: Math.round(durationSec) }, 'Downloading DASH via ffmpeg');
    await SegmentStitcher.runFfmpeg(ffmpeg, args, durationSec, onProgress);
    onProgress({ progress: 100, size: '—', speed: '—', eta: '0s' });

    const outDur = FileValidator.probeDurationSec(outPath) ?? 0;
    const partial = durationSec > 0 && outDur > 0 && outDur < durationSec * COMPLETE_COVERAGE_RATIO;
    if (partial) {
      logger.warn({ outPath, outDur, reported: durationSec }, 'DASH output shorter than reported duration — partial');
    }
    logger.info({ outPath }, 'DASH download complete');
    return { path: outPath, partial };
  }
}
