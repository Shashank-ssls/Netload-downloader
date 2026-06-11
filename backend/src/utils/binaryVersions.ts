import { execFileSync, execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { config } from '../config';
import logger from '../logger';

const execFileAsync = promisify(execFile);

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

/**
 * Build the yt-dlp self-update args for a release channel. `stable` (or unset)
 * uses the plain `-U`; `nightly`/`master` (or any explicit channel) target it via
 * `--update-to`, which also lets a pinned build move forward onto that channel.
 */
export function updateArgs(channel?: string): string[] {
  return channel && channel !== 'stable' ? ['--update-to', channel] : ['-U'];
}

/** Run yt-dlp's built-in self-update and refresh the cached version (blocking). */
export function updateYtdlp(channel?: string): { ok: boolean; output: string; version: string } {
  try {
    const output = execFileSync(config.ytdlpPath, updateArgs(channel), { encoding: 'utf8', timeout: 120000 }).trim();
    cached = null; // force re-probe
    const version = getBinaryVersions().ytdlp;
    logger.info({ version, channel: channel || 'stable' }, 'yt-dlp self-update complete');
    return { ok: true, output, version };
  } catch (err: any) {
    logger.error({ err: err.message }, 'yt-dlp self-update failed');
    return { ok: false, output: err.message || 'update failed', version: getBinaryVersions().ytdlp };
  }
}

/** Non-blocking variant of {@link updateYtdlp} for the background auto-updater. */
export async function updateYtdlpAsync(channel?: string): Promise<{ ok: boolean; output: string; version: string }> {
  try {
    const { stdout } = await execFileAsync(config.ytdlpPath, updateArgs(channel), { encoding: 'utf8', timeout: 120000 });
    cached = null; // force re-probe
    const version = getBinaryVersions().ytdlp;
    logger.info({ version, channel: channel || 'stable' }, 'yt-dlp self-update complete');
    return { ok: true, output: stdout.trim(), version };
  } catch (err: any) {
    logger.error({ err: err.message }, 'yt-dlp self-update failed');
    return { ok: false, output: err.message || 'update failed', version: getBinaryVersions().ytdlp };
  }
}
