import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { config } from '../config';

/** What ffprobe tells us about a file's streams + container. */
export interface MediaProbe {
  durationSec?: number;
  videoStreams: number;
  audioStreams: number;
  codecs: string[];
}

/**
 * Parse `ffprobe -of json -show_entries stream=codec_type,codec_name:format=duration`
 * output into a MediaProbe. Returns undefined for unparseable output (a broken/
 * truncated container ffprobe can't read). Pure, so it's unit-tested directly.
 */
export function parseFfprobeJson(json: string): MediaProbe | undefined {
  let data: any;
  try { data = JSON.parse(json); } catch { return undefined; }
  if (!data || typeof data !== 'object') return undefined;

  const streams = Array.isArray(data.streams) ? data.streams : [];
  let videoStreams = 0;
  let audioStreams = 0;
  const codecs: string[] = [];
  for (const s of streams) {
    if (s?.codec_type === 'video') videoStreams++;
    else if (s?.codec_type === 'audio') audioStreams++;
    if (s?.codec_name) codecs.push(String(s.codec_name));
  }

  const d = parseFloat(data.format?.duration);
  return { durationSec: Number.isFinite(d) ? d : undefined, videoStreams, audioStreams, codecs };
}

/**
 * Decide whether a probed file is structurally a usable media file: ffprobe could
 * read it, it has at least one A/V stream (a valid container, not a 0-byte/HTML/
 * broken-mux artifact), a video stream when one is required, and clears the
 * duration floor when given. Pure — unit-tested with synthetic probes.
 */
export function evaluateIntegrity(
  probe: MediaProbe | undefined,
  opts: { requireVideo?: boolean; minDurationSec?: number } = {},
): { ok: boolean; reason: string } {
  if (!probe) return { ok: false, reason: 'unreadable (ffprobe failed)' };
  if (probe.videoStreams === 0 && probe.audioStreams === 0) {
    return { ok: false, reason: 'no audio or video streams' };
  }
  if (opts.requireVideo && probe.videoStreams === 0) {
    return { ok: false, reason: 'no video stream' };
  }
  if (opts.minDurationSec && (probe.durationSec === undefined || probe.durationSec < opts.minDurationSec)) {
    return { ok: false, reason: `duration ${probe.durationSec ?? 'unknown'}s < ${opts.minDurationSec}s` };
  }
  return { ok: true, reason: 'ok' };
}

export class FileValidator {
  static validate(filePath: string): boolean {
    if (!filePath || !fs.existsSync(filePath)) {
      return false;
    }

    const stats = fs.statSync(filePath);
    if (stats.size === 0) {
      return false;
    }

    const validExtensions = ['.mp4', '.m4a', '.webm', '.mkv', '.mp3', '.ts'];
    const ext = path.extname(filePath).toLowerCase();
    
    // Sometimes yt-dlp saves without extension if format is weird, 
    // but usually we want to enforce it. Let's be slightly lenient if size > 1MB.
    if (!validExtensions.includes(ext) && stats.size < 1024 * 1024) {
      return false;
    }

    return true;
  }

  /** Media duration in seconds via ffprobe, or undefined if it can't be read. */
  static probeDurationSec(filePath: string): number | undefined {
    if (!filePath || !fs.existsSync(filePath)) return undefined;
    const ffprobe = path.join(config.ffmpegPath, 'ffprobe.exe');
    try {
      const out = execFileSync(ffprobe, [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        filePath,
      ], { encoding: 'utf8', timeout: 15000 }).trim();
      const dur = parseFloat(out);
      return Number.isFinite(dur) ? dur : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Full ffprobe stream/container inspection (stream types + codecs + duration),
   * or undefined if ffprobe can't read the file at all (a broken container).
   */
  static probeMedia(filePath: string): MediaProbe | undefined {
    if (!filePath || !fs.existsSync(filePath)) return undefined;
    const ffprobe = path.join(config.ffmpegPath, 'ffprobe.exe');
    try {
      const out = execFileSync(ffprobe, [
        '-v', 'error',
        '-of', 'json',
        '-show_entries', 'stream=codec_type,codec_name:format=duration',
        filePath,
      ], { encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
      return parseFfprobeJson(out);
    } catch {
      return undefined;
    }
  }

  /**
   * Integrity check (returns the reason for logging): the file is a readable
   * container with the streams a real download should have. Catches subtly broken
   * muxes — e.g. an MSE concat or DASH/segment remux that yields a file with a
   * plausible size/duration but no decodable video track.
   */
  static checkPlayable(
    filePath: string,
    opts: { requireVideo?: boolean; minDurationSec?: number } = {},
  ): { ok: boolean; reason: string } {
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, reason: 'missing file' };
    if (fs.statSync(filePath).size === 0) return { ok: false, reason: 'empty file' };
    return evaluateIntegrity(this.probeMedia(filePath), opts);
  }

  /** Boolean convenience wrapper over {@link checkPlayable}. */
  static isPlayable(filePath: string, opts: { requireVideo?: boolean; minDurationSec?: number } = {}): boolean {
    return this.checkPlayable(filePath, opts).ok;
  }

  /**
   * A downloaded file is "sane" if it clears the size floor and (when duration
   * is readable) the duration floor. Used to reject preview/placeholder/ad
   * downloads so the caller can try the next candidate.
   */
  static isContentSane(
    filePath: string,
    opts: { minBytes: number; minDurationSec: number },
  ): boolean {
    if (!filePath || !fs.existsSync(filePath)) return false;
    const bytes = fs.statSync(filePath).size;
    if (bytes >= opts.minBytes) return true; // big enough on size alone

    const dur = this.probeDurationSec(filePath);
    if (dur !== undefined && dur >= opts.minDurationSec) return true;

    // Small AND (short or unreadable duration) → not real content.
    return false;
  }

  /** Free space on the filesystem holding `dir`, in MB, or -1 if it can't be read. */
  static getFreeSpaceMB(dir: string): number {
    try {
      const s = fs.statfsSync(dir);
      return Math.floor((s.bavail * s.bsize) / (1024 * 1024));
    } catch {
      return -1;
    }
  }

  static cleanupTemp(dir: string, maxAgeHours: number = 24) {
    if (!fs.existsSync(dir)) return;
    const now = Date.now();
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      const stats = fs.statSync(filePath);
      if (now - stats.mtimeMs > maxAgeHours * 60 * 60 * 1000) {
        if (filePath.endsWith('.part') || filePath.endsWith('.ytdl')) {
          try { fs.unlinkSync(filePath); } catch (e) {}
        }
      }
    }
  }
}

export class CookieValidator {
  static isValid(cookiePath: string): boolean {
    if (!fs.existsSync(cookiePath)) return false;
    const stats = fs.statSync(cookiePath);
    if (stats.size === 0) return false;
    
    const content = fs.readFileSync(cookiePath, 'utf8');
    // Basic Netscape format check
    if (!content.includes('# Netscape HTTP Cookie File')) {
      return false;
    }
    return true;
  }
}
