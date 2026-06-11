import { execFileSync, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import logger from '../logger';

const execFileAsync = promisify(execFile);

// Where the last-known-good binary is stashed before each self-update, for rollback.
const lkgPath = (binaryPath = config.ytdlpPath): string => `${binaryPath}.lkg`;

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

// ─── UPDATE SAFETY NET (backup → smoke → rollback) ────────────────────────────

/** A yt-dlp version string looks like `2024.08.06` (optionally `.N`). Pure. */
export function isHealthyVersion(version: string): boolean {
  return /^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/.test((version || '').trim());
}

/** Copy the current binary aside as the last-known-good, for rollback. */
export function backupBinary(binaryPath = config.ytdlpPath, dest = lkgPath(binaryPath)): boolean {
  try {
    if (!fs.existsSync(binaryPath)) return false;
    fs.copyFileSync(binaryPath, dest);
    return true;
  } catch (err: any) {
    logger.warn({ err: err.message }, 'yt-dlp backup failed');
    return false;
  }
}

/** Restore the last-known-good binary over the current one. */
export function restoreBinary(binaryPath = config.ytdlpPath, src = lkgPath(binaryPath)): boolean {
  try {
    if (!fs.existsSync(src)) return false;
    fs.copyFileSync(src, binaryPath);
    cached = null; // force re-probe of the restored version
    return true;
  } catch (err: any) {
    logger.error({ err: err.message }, 'yt-dlp rollback (restore) failed');
    return false;
  }
}

/**
 * Verify a yt-dlp binary actually works after an update: it must report a sane
 * version AND load its extractor modules (network-free — catches a broken build).
 * If `config.ytdlpSmokeUrl` is set, also do a metadata-only extraction against it.
 */
export async function smokeTestYtdlp(): Promise<{ ok: boolean; detail: string }> {
  try {
    const { stdout } = await execFileAsync(config.ytdlpPath, ['--version'], { encoding: 'utf8', timeout: 15000 });
    if (!isHealthyVersion(stdout)) return { ok: false, detail: `bad --version output: ${stdout.trim().slice(0, 40)}` };
  } catch (err: any) {
    return { ok: false, detail: `--version failed: ${err.message}` };
  }

  try {
    await execFileAsync(config.ytdlpPath, ['--ignore-config', '--list-extractors'], {
      encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err: any) {
    return { ok: false, detail: `--list-extractors failed (broken build?): ${err.message}` };
  }

  if (config.ytdlpSmokeUrl) {
    try {
      await execFileAsync(config.ytdlpPath, ['--simulate', '--skip-download', '--no-warnings', '-J', config.ytdlpSmokeUrl], {
        encoding: 'utf8', timeout: 45000, maxBuffer: 32 * 1024 * 1024,
      });
    } catch (err: any) {
      return { ok: false, detail: `smoke-URL extraction failed: ${err.message}` };
    }
  }

  return { ok: true, detail: 'ok' };
}

/**
 * Self-update with a safety net: back up the current (known-good) binary, update,
 * smoke-test the result, and ROLL BACK to the backup if the smoke fails — so a bad
 * nightly/master build can't silently break all reach. Used by the auto-updater
 * and the manual endpoint.
 */
export async function safeUpdateYtdlp(channel?: string): Promise<{ ok: boolean; output: string; version: string; rolledBack?: boolean }> {
  const dest = lkgPath();
  const backedUp = backupBinary(config.ytdlpPath, dest);

  const result = await updateYtdlpAsync(channel);
  if (!result.ok) {
    // Update itself failed (pip-managed / no network) — binary untouched.
    return result;
  }

  const smoke = await smokeTestYtdlp();
  if (smoke.ok) {
    logger.info({ version: result.version }, 'yt-dlp post-update smoke passed');
    return result;
  }

  logger.error({ detail: smoke.detail, version: result.version }, 'yt-dlp post-update smoke FAILED — rolling back');
  if (backedUp && restoreBinary(config.ytdlpPath, dest)) {
    const restored = getBinaryVersions().ytdlp;
    logger.warn({ restored }, 'yt-dlp rolled back to last known good');
    return { ok: false, output: `post-update smoke failed (${smoke.detail}); rolled back to ${restored}`, version: restored, rolledBack: true };
  }

  logger.error('yt-dlp smoke failed and no backup to roll back to — binary may be broken');
  return { ok: false, output: `post-update smoke failed (${smoke.detail}); no rollback available`, version: result.version, rolledBack: false };
}
