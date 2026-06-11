import { spawn, ChildProcess } from 'child_process';
import { config } from './config';
import { ProgressData, MetadataInfo } from './types';
import logger from './logger';
import { armWatchdog } from './utils/processWatchdog';
import fs from 'fs';

export interface YTDLPOptions {
  args: string[];
  onProgress?: (data: ProgressData) => void;
  onStderr?: (data: string) => void;
  onPathDiscovered?: (path: string) => void;
  onMetadata?: (data: MetadataInfo) => void;
  captureStdout?: boolean;
  /** Cookies file for this call (per-site). Falls back to the global cookiesPath. */
  cookiesPath?: string;
}

function isAbsolutePath(line: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(line) || (line.startsWith('/') && line.length > 2);
}

export class YTDLPProcessManager {
  private static activeProcesses: Map<string, ChildProcess> = new Map();

  static spawn(id: string, options: YTDLPOptions): Promise<{ code: number; stdout: string }> {
    return new Promise((resolve, reject) => {
      const baseArgs = [
        '--newline',
        '--progress',
        '--no-playlist',
        '--restrict-filenames',
        '--retries', '10',
        '--fragment-retries', '10',
        '--concurrent-fragments', '4',
        '--sleep-interval', '2',
        '--max-sleep-interval', '5',
        '--continue',
      ];

      const cookiesPath = options.cookiesPath || config.cookiesPath;
      if (cookiesPath && fs.existsSync(cookiesPath)) {
        baseArgs.push('--cookies', cookiesPath);
      }

      baseArgs.push('--ffmpeg-location', config.ffmpegPath);

      const finalArgs = [...baseArgs, ...options.args];

      logger.info({ id, args: finalArgs }, 'Spawning yt-dlp');

      const env = { ...process.env };
      if (config.nodePath) {
        env.PATH = env.PATH ? `${config.nodePath};${env.PATH}` : config.nodePath;
      }

      const child = spawn(config.ytdlpPath, finalArgs, { env });
      this.activeProcesses.set(id, child);

      // Kill a yt-dlp (and its child ffmpeg) that goes silent for too long — a
      // genuine hang, since a healthy run streams progress lines continuously.
      const wd = armWatchdog(child, { stallMs: config.ytdlpStallMs, label: `yt-dlp:${id}` });

      let stdoutAccumulator = '';
      let lineBuffer = '';

      const processLine = (rawLine: string) => {
        const line = rawLine.trim();
        if (!line) return;

        if (options.captureStdout) {
          stdoutAccumulator += rawLine + '\n';
          return;
        }

        // --print output: lines that don't start with yt-dlp prefixes
        if (!line.startsWith('[') && !line.startsWith('WARNING:') && !line.startsWith('ERROR:')) {
          if (line.includes('\t') && options.onMetadata) {
            const [title, uploader, thumbnail] = line.split('\t');
            options.onMetadata({
              title: title?.trim() || '',
              uploader: uploader?.trim() || '',
              thumbnail: thumbnail?.trim() || '',
            });
          } else if (isAbsolutePath(line) && options.onPathDiscovered) {
            options.onPathDiscovered(line);
          }
          return;
        }

        // Progress line: [download] 45.2% of 150.00MiB at 5.20MiB/s ETA 00:00:20
        const progressMatch = line.match(
          /\[download\]\s+([\d.]+)%\s+of\s+~?([\d.]+\s*\S+)\s+at\s+(\S+)\s+ETA\s+(\S+)/
        );
        if (progressMatch && options.onProgress) {
          options.onProgress({
            progress: parseFloat(progressMatch[1]),
            size: progressMatch[2],
            speed: progressMatch[3],
            eta: progressMatch[4],
          });
          return;
        }

        // Destination path from [download] Destination: ...
        const destMatch =
          line.match(/\[download\] Destination: (.+)/) ||
          line.match(/\[download\] (.+) has already been downloaded/);
        if (destMatch && options.onPathDiscovered) {
          options.onPathDiscovered(destMatch[1].trim());
          return;
        }

        // Merge path from [Merger]
        const mergeMatch =
          line.match(/\[Merger\] Merging formats into "([^"]+)"/) ||
          line.match(/\[Merger\] Merging formats into (.+)/);
        if (mergeMatch && options.onPathDiscovered) {
          options.onPathDiscovered(mergeMatch[1].trim().replace(/^"|"$/g, ''));
        }
      };

      child.stdout.on('data', (chunk: Buffer) => {
        wd.kick();
        lineBuffer += chunk.toString();
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';
        for (const rawLine of lines) {
          processLine(rawLine);
        }
      });

      child.stderr.on('data', (data: Buffer) => {
        wd.kick();
        if (options.onStderr) options.onStderr(data.toString());
      });

      child.on('close', (code) => {
        wd.disarm();
        if (lineBuffer.trim()) processLine(lineBuffer);
        lineBuffer = '';
        this.activeProcesses.delete(id);

        if (wd.timedOut()) {
          reject(new Error(`yt-dlp timed out (no output for ${config.ytdlpStallMs}ms)`));
        } else if (code === 0 || code === null) {
          resolve({ code: code || 0, stdout: stdoutAccumulator });
        } else {
          reject(new Error(`yt-dlp exited with code ${code}`));
        }
      });

      child.on('error', (err) => {
        wd.disarm();
        this.activeProcesses.delete(id);
        reject(err);
      });
    });
  }

  static cancel(id: string): boolean {
    const child = this.activeProcesses.get(id);
    if (child) {
      child.kill('SIGTERM');
      this.activeProcesses.delete(id);
      return true;
    }
    return false;
  }

  static cancelAll(): void {
    for (const child of this.activeProcesses.values()) {
      child.kill('SIGTERM');
    }
    this.activeProcesses.clear();
  }

  static classifyError(stderr: string): string {
    if (stderr.includes('Sign in to confirm') || stderr.includes('Private video') || stderr.includes('members only')) return 'AUTH_REQUIRED';
    if (stderr.includes('Incomplete cookies') || stderr.includes('cookies file')) return 'COOKIE_INVALID';
    if (stderr.includes('ffmpeg not found') || stderr.includes('ffprobe not found')) return 'FFMPEG_MISSING';
    if (stderr.includes('429') || stderr.includes('Rate-limited') || stderr.includes('Too Many Requests')) return 'RATE_LIMITED';
    if (stderr.includes('Geo-restrict') || stderr.includes('not available in your country') || stderr.includes('geo')) return 'GEO_BLOCKED';
    if (stderr.includes('Timed out') || stderr.includes('timed out') || stderr.includes('Connection timeout')) return 'NETWORK_TIMEOUT';
    if (stderr.includes('ConnectionResetError') || stderr.includes('Connection aborted') || stderr.includes('10054') || stderr.includes('RemoteDisconnected') || stderr.includes('Connection reset') || stderr.includes('Connection was reset') || stderr.includes('Recv failure') || stderr.includes('Send failure') || /curl: \((35|52|56)\)/.test(stderr)) return 'CONNECTION_RESET';
    if (stderr.includes('Cloudflare') || stderr.includes('403: Forbidden') || stderr.includes('HTTP Error 403') || stderr.includes('cf-browser-verification') || stderr.includes('Just a moment') || stderr.includes('Enable JavaScript and cookies')) return 'CLOUDFLARE_BLOCKED';
    if (stderr.includes('Requested format is not available') || stderr.includes('format is not available')) return 'FORMAT_UNAVAILABLE';
    if (stderr.includes('Video unavailable') || stderr.includes('This video is unavailable') || stderr.includes('has been removed')) return 'VIDEO_UNAVAILABLE';
    if (stderr.includes('Unsupported URL') || stderr.includes('Unable to extract') || stderr.includes('No video formats found')) {
      if (stderr.includes('Falling back on generic information extractor')) return 'DYNAMIC_CONTENT_UNSUPPORTED';
      return 'UNSUPPORTED_URL';
    }
    if (stderr.includes('ERROR:')) return 'DOWNLOAD_FAILED';
    return 'UNKNOWN_ERROR';
  }
}
