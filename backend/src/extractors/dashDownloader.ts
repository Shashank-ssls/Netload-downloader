/**
 * dashDownloader.ts
 *
 * Roadmap #3 — DASH (.mpd) was detected (scored, duration-probed) but never
 * actually downloaded, so newer sites that deliver via MPEG-DASH fell through.
 *
 * DASH is the #2 manifest format after HLS. ffmpeg's dash demuxer fetches the
 * manifest and reassembles SegmentTemplate/Timeline/SegmentBase natively, so —
 * exactly like R1 routes HLS through ffmpeg — we point ffmpeg straight at the
 * captured `.mpd` URL with the player's headers/UA and `-c copy`.
 *
 * A5 (DASH parity with the HLS path): a DASH manifest can carry several audio
 * AdaptationSets (alternate languages/dubs) and text AdaptationSets (subtitles).
 * ffmpeg's default stream selection only takes the single best video + best audio,
 * so alternate audio and subtitles were dropped. We now ffprobe the manifest, then:
 *   - mux the best video + the best representation of EACH distinct audio language,
 *   - write each subtitle track to a `<output>.<lang>.srt` sidecar (best-effort).
 * If ffprobe yields nothing usable we fall back to ffmpeg's default selection.
 *
 * yt-dlp's own DASH handling is patchier for opaque/unlisted sites, so for a
 * captured manifest we prefer this dedicated path. DRM-protected manifests
 * (Widevine/PlayReady ContentProtection) are surfaced as DRM_PROTECTED rather than
 * producing an undecryptable file — reusing the same detector as the HLS path.
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import axios from 'axios';
import logger from '../logger';
import { config } from '../config';
import { FileValidator } from '../utils/validators';
import { SegmentStitcher, type StitchResult } from './segmentStitcher';
import { armWatchdog } from '../utils/processWatchdog';
import type { ProgressData } from '../types';

const MANIFEST_FETCH_TIMEOUT_MS = 15_000;
const MANIFEST_MAX_BYTES = 16 * 1024 * 1024;
// Output shorter than this fraction of the manifest-reported duration = partial.
const COMPLETE_COVERAGE_RATIO = 0.9;
const PROBE_TIMEOUT_MS = 20_000;
const MAX_SUBTITLE_TRACKS = 6;

/** One stream from `ffprobe -show_streams` (the fields we plan maps from). */
export interface DashStream {
  index: number;
  type: 'video' | 'audio' | 'subtitle' | 'other';
  lang: string;   // ISO code or 'und'
  bitrate: number;
  pixels: number; // width*height (video only), else 0
}

/** The stream-selection plan for a DASH manifest. */
export interface DashMapPlan {
  videoIndex: number | null;
  audioTracks: { index: number; lang: string }[];   // one per distinct language
  subtitleTracks: { index: number; lang: string }[]; // ffmpeg-exposed sub streams (wvtt/stpp)
}

/** A subtitle track parsed straight from the MPD XML (lang + absolute file URL). */
export interface DashSubtitleTrack {
  lang: string;
  uri: string;
}

/** A subtitle source for sidecar extraction: a stream in the manifest (`mapIndex`)
 *  OR a standalone subtitle file (`uri`). */
interface SubSource {
  lang: string;
  mapIndex?: number;
  uri?: string;
}

/**
 * Parse subtitle AdaptationSets out of the MPD XML and resolve each track's file
 * URL. ffmpeg's dash demuxer ignores `application/ttml+xml` / `text/vtt` text
 * AdaptationSets (they don't appear as streams), so we read them ourselves: most
 * are a single sidecar file referenced by a `<BaseURL>` (e.g. `English_track.xml`),
 * resolved against any MPD/Period-level BaseURL and the manifest URL. Pure — unit-tested.
 */
export function parseDashSubtitleTracks(mpdXml: string, manifestUrl: string): DashSubtitleTrack[] {
  const out: DashSubtitleTrack[] = [];
  if (!mpdXml) return out;

  // A top-level BaseURL is a child of MPD/Period — i.e. before the first AdaptationSet.
  const preamble = mpdXml.split(/<AdaptationSet/i)[0] || '';
  const topBase = (preamble.match(/<BaseURL>([^<]+)<\/BaseURL>/i)?.[1] || '').trim();
  const resolve = (rel: string): string => {
    try {
      const mid = topBase ? new URL(topBase, manifestUrl).toString() : manifestUrl;
      return new URL(rel.trim(), mid).toString();
    } catch { return ''; }
  };

  const blocks = mpdXml.match(/<AdaptationSet\b[^>]*>[\s\S]*?<\/AdaptationSet>/gi) || [];
  for (const block of blocks) {
    const head = block.match(/<AdaptationSet\b[^>]*>/i)?.[0] || '';
    const isText =
      /mimeType\s*=\s*"[^"]*(ttml|vtt|text)/i.test(head) ||
      /contentType\s*=\s*"text"/i.test(head) ||
      /codecs\s*=\s*"[^"]*(stpp|wvtt)/i.test(block) ||
      /value\s*=\s*"(subtitle|caption)"/i.test(block);
    if (!isText) continue;

    const lang = (head.match(/\blang\s*=\s*"([^"]+)"/i)?.[1] || 'und').toLowerCase();
    // Single-file track: a <BaseURL> inside the AdaptationSet/Representation.
    const repBase = block.match(/<BaseURL>([^<]+)<\/BaseURL>/i)?.[1];
    if (repBase) {
      const uri = resolve(repBase);
      if (uri) out.push({ lang, uri });
    }
  }
  return out;
}

/** Parse `ffprobe -show_streams -of json` into a flat stream list. Pure — unit-tested. */
export function parseProbeStreams(json: string): DashStream[] {
  let parsed: any;
  try { parsed = JSON.parse(json); } catch { return []; }
  const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
  return streams.map((s: any): DashStream => {
    const ct = s?.codec_type;
    const type: DashStream['type'] =
      ct === 'video' ? 'video' : ct === 'audio' ? 'audio' : ct === 'subtitle' ? 'subtitle' : 'other';
    const lang = (s?.tags?.language || s?.tags?.LANGUAGE || 'und').toString().toLowerCase();
    const bitrate = parseInt(s?.bit_rate ?? s?.tags?.['variant_bitrate'] ?? '0', 10) || 0;
    const w = parseInt(s?.width ?? '0', 10) || 0;
    const h = parseInt(s?.height ?? '0', 10) || 0;
    return { index: parseInt(s?.index ?? '0', 10) || 0, type, lang, bitrate, pixels: w * h };
  });
}

/**
 * Choose which streams to mux: the single best video (most pixels, then bitrate),
 * the best representation of each distinct audio language, and every subtitle
 * track. DASH exposes each Representation as its own stream, so grouping audio by
 * language and keeping the best per language avoids muxing five bitrate variants of
 * the same dub. Pure — unit-tested.
 */
export function planDashMaps(streams: DashStream[]): DashMapPlan {
  const videos = streams.filter((s) => s.type === 'video');
  const audios = streams.filter((s) => s.type === 'audio');
  const subs = streams.filter((s) => s.type === 'subtitle');

  let videoIndex: number | null = null;
  if (videos.length) {
    videoIndex = videos.reduce((best, s) =>
      s.pixels > best.pixels || (s.pixels === best.pixels && s.bitrate > best.bitrate) ? s : best,
    ).index;
  }

  // Best representation per distinct audio language (insertion order preserved).
  const bestByLang = new Map<string, DashStream>();
  for (const a of audios) {
    const cur = bestByLang.get(a.lang);
    if (!cur || a.bitrate > cur.bitrate) bestByLang.set(a.lang, a);
  }
  const audioTracks = [...bestByLang.values()].map((a) => ({ index: a.index, lang: a.lang }));

  const subtitleTracks = subs.slice(0, MAX_SUBTITLE_TRACKS).map((s) => ({ index: s.index, lang: s.lang }));

  return { videoIndex, audioTracks, subtitleTracks };
}

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

    // A5: ffprobe the manifest so we can keep alternate audio languages + subtitles.
    const plan = await this.probeManifest(manifestUrl, headers, userAgent);

    const args = ['-y', '-headers', headerLines, '-user_agent', userAgent,
      '-protocol_whitelist', 'file,http,https,tcp,tls,crypto', '-i', manifestUrl];

    // Explicit maps when the probe found a video + ≥1 audio language; otherwise let
    // ffmpeg's default selection take the best A/V (the original behaviour).
    const useMaps = plan && plan.videoIndex !== null && plan.audioTracks.length > 0;
    if (useMaps) {
      args.push('-map', `0:${plan!.videoIndex}`);
      for (const a of plan!.audioTracks) args.push('-map', `0:${a.index}`);
      logger.info(
        { videoIndex: plan!.videoIndex, audioLangs: plan!.audioTracks.map((a) => a.lang) },
        'DASH: muxing best video + all audio languages',
      );
    }
    // -c copy: remux only, no re-encode. (No -map ⇒ ffmpeg default best A/V.)
    args.push('-c', 'copy', outPath);

    logger.info({ manifestUrl, outPath, durationSec: Math.round(durationSec) }, 'Downloading DASH via ffmpeg');
    await SegmentStitcher.runFfmpeg(ffmpeg, args, durationSec, onProgress);
    onProgress({ progress: 100, size: '—', speed: '—', eta: '0s' });

    // A5: subtitle sidecars (best-effort — never fail the download over subs). Two
    // sources: ffmpeg-exposed subtitle streams (segmented wvtt/stpp in the manifest)
    // and text AdaptationSets parsed from the MPD XML (ttml/vtt files ffmpeg ignores).
    const subSources: SubSource[] = [
      ...(plan?.subtitleTracks || []).map((t) => ({ lang: t.lang, mapIndex: t.index })),
      ...parseDashSubtitleTracks(manifestText, manifestUrl).map((t) => ({ lang: t.lang, uri: t.uri })),
    ];
    if (subSources.length) {
      await this.fetchSubtitleSidecars(manifestUrl, headerLines, userAgent, subSources, outPath)
        .catch((e) => logger.warn({ err: e.message }, 'DASH subtitle sidecar fetch failed'));
    }

    const outDur = FileValidator.probeDurationSec(outPath) ?? 0;
    const partial = durationSec > 0 && outDur > 0 && outDur < durationSec * COMPLETE_COVERAGE_RATIO;
    if (partial) {
      logger.warn({ outPath, outDur, reported: durationSec }, 'DASH output shorter than reported duration — partial');
    }
    logger.info({ outPath }, 'DASH download complete');
    return { path: outPath, partial };
  }

  /** ffprobe the manifest → a stream-selection plan, or null if probing fails. */
  private static async probeManifest(
    manifestUrl: string,
    headers: Record<string, string>,
    userAgent: string,
  ): Promise<DashMapPlan | null> {
    const ffprobe = path.join(config.ffmpegPath, 'ffprobe.exe');
    const headerLines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n';
    const args = [
      '-headers', headerLines, '-user_agent', userAgent,
      '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
      '-show_streams', '-of', 'json', '-i', manifestUrl,
    ];
    try {
      const json = await this.runProbe(ffprobe, args);
      const streams = parseProbeStreams(json);
      if (!streams.length) return null;
      return planDashMaps(streams);
    } catch (err: any) {
      logger.warn({ manifestUrl, err: err.message }, 'DASH ffprobe failed — using ffmpeg default stream selection');
      return null;
    }
  }

  private static runProbe(ffprobe: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(ffprobe, args);
      const wd = armWatchdog(child, { stallMs: PROBE_TIMEOUT_MS, label: 'ffprobe-dash' });
      let out = '';
      let errTail = '';
      child.stdout.on('data', (d) => { wd.kick(); out += d.toString(); });
      child.stderr.on('data', (d) => { wd.kick(); errTail = (errTail + d.toString()).slice(-1000); });
      child.on('error', (err) => { wd.disarm(); reject(err); });
      child.on('close', (code) => {
        wd.disarm();
        if (wd.timedOut()) reject(new Error('ffprobe stalled'));
        else if (code === 0) resolve(out);
        else reject(new Error(errTail.slice(-200) || `ffprobe exit ${code}`));
      });
    });
  }

  /**
   * Write each subtitle track to a `<output>.<lang>.<ext>` sidecar. De-duped by
   * language, best-effort (a failed track is skipped, not fatal):
   *  - a standalone text file (`uri`) is downloaded RAW in its native format
   *    (.vtt/.ttml/.xml/.srt) — ffmpeg has no TTML→SRT decoder, so converting would
   *    drop the most common DASH subtitle format;
   *  - an in-manifest subtitle stream (`mapIndex`, segmented wvtt/stpp) is extracted
   *    to `.srt` via ffmpeg, which handles WebVTT fine.
   */
  private static async fetchSubtitleSidecars(
    manifestUrl: string,
    headerLines: string,
    userAgent: string,
    tracks: SubSource[],
    outPath: string,
  ): Promise<void> {
    const ffmpeg = path.join(config.ffmpegPath, 'ffmpeg.exe');
    const baseNoExt = outPath.replace(/\.[^./\\]+$/, '');
    const seen = new Set<string>();
    for (const t of tracks.slice(0, MAX_SUBTITLE_TRACKS)) {
      const lang = ((t.lang || 'und').replace(/[^a-z0-9_-]/gi, '').slice(0, 8)) || 'und';
      if (seen.has(lang)) continue;
      seen.add(lang);
      try {
        if (t.uri) {
          const ext = (t.uri.match(/\.(vtt|srt|ttml|xml|ass|ssa)(?:\?|$)/i)?.[1] || 'vtt').toLowerCase();
          const subOut = `${baseNoExt}.${lang}.${ext}`;
          const r = await axios.get(t.uri, {
            headers: { 'User-Agent': userAgent }, timeout: MANIFEST_FETCH_TIMEOUT_MS,
            responseType: 'text', maxContentLength: MANIFEST_MAX_BYTES, transformResponse: (d) => d,
          });
          const body = typeof r.data === 'string' ? r.data : String(r.data);
          if (!body.trim()) throw new Error('empty subtitle body');
          fs.writeFileSync(subOut, body, 'utf8');
          logger.info({ subOut, lang }, 'DASH subtitle sidecar written (raw)');
        } else {
          const subOut = `${baseNoExt}.${lang}.srt`;
          const args = [
            '-y', '-headers', headerLines, '-user_agent', userAgent,
            '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
            '-i', manifestUrl, '-map', `0:${t.mapIndex}`, subOut,
          ];
          await this.runSubtitleFfmpeg(ffmpeg, args);
          logger.info({ subOut, lang }, 'DASH subtitle sidecar written (ffmpeg)');
        }
      } catch (e: any) {
        logger.warn({ lang, err: e.message }, 'DASH subtitle track failed (skipping)');
      }
    }
  }

  private static runSubtitleFfmpeg(ffmpeg: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, args);
      const wd = armWatchdog(child, { stallMs: config.ffmpegStallMs, label: 'ffmpeg-dash-subs' });
      let tail = '';
      child.stderr.on('data', (d) => { wd.kick(); tail = (tail + d.toString()).slice(-2000); });
      child.on('error', (err) => { wd.disarm(); reject(err); });
      child.on('close', (code) => {
        wd.disarm();
        if (wd.timedOut()) reject(new Error('subtitle ffmpeg stalled'));
        else if (code === 0) resolve();
        else reject(new Error(tail.slice(-200)));
      });
    });
  }
}
