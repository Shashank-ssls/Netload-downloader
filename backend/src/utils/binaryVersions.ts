import { execFileSync } from 'child_process';
import path from 'path';
import { config } from '../config';
import logger from '../logger';

export interface BinaryVersions {
  ytdlp: string;
  ffmpeg: string;
}

let cached: BinaryVersions | null = null;

/** yt-dlp + ffmpeg versions, probed once and cached (cleared after a self-update). */
export function getBinaryVersions(): BinaryVersions {
  if (cached) return cached;
  cached = { ytdlp: probeYtdlp(), ffmpeg: probeFfmpeg() };
  return cached;
}

function probeYtdlp(): string {
  try {
    return execFileSync(config.ytdlpPath, ['--version'], { encoding: 'utf8', timeout: 5000 })
      .trim()
      .split('\n')[0];
  } catch {
    return 'unknown';
  }
}

function probeFfmpeg(): string {
  try {
    const out = execFileSync(path.join(config.ffmpegPath, 'ffmpeg.exe'), ['-version'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    const m = out.match(/ffmpeg version (\S+)/);
    return m ? m[1] : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Run yt-dlp's built-in self-update (`-U`) and refresh the cached version. */
export function updateYtdlp(): { ok: boolean; output: string; version: string } {
  try {
    const output = execFileSync(config.ytdlpPath, ['-U'], { encoding: 'utf8', timeout: 120000 }).trim();
    cached = null; // force re-probe
    const version = getBinaryVersions().ytdlp;
    logger.info({ version }, 'yt-dlp self-update complete');
    return { ok: true, output, version };
  } catch (err: any) {
    logger.error({ err: err.message }, 'yt-dlp self-update failed');
    return { ok: false, output: err.message || 'update failed', version: getBinaryVersions().ytdlp };
  }
}
