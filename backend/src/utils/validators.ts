import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { config } from '../config';

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
