import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config({ path: path.join(__dirname, '../.env.local') });

export const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  env: process.env.NODE_ENV || 'development',
  databasePath: path.resolve(process.env.DATABASE_PATH || './database/downloader.db'),
  storagePath: path.resolve(process.env.STORAGE_PATH || 'F:/MediaDownloads'),
  tempPath: path.resolve(process.env.TEMP_PATH || './temp'),
  ffmpegPath: path.resolve(process.env.FFMPEG_PATH || './ffmpeg'),
  ytdlpPath: path.resolve(process.env.YTDLP_PATH || './yt-dlp/yt-dlp.exe'),
  cookiesPath: path.resolve(process.env.COOKIES_PATH || './cookies/cookies.txt'),
  // Per-site cookies live here as `<host>.txt` (falls back to cookiesPath).
  cookiesDir: path.resolve(process.env.COOKIES_DIR || './cookies'),
  nodePath: process.env.NODE_PATH || 'F:\\Apps\\NodeJS',

  // Download guards. maxFilesizeMB=0 means unlimited; minFreeSpaceMB is the
  // free-space floor on the storage drive before a download is allowed to start.
  maxFilesizeMB: parseInt(process.env.MAX_FILESIZE_MB || '0', 10),
  minFreeSpaceMB: parseInt(process.env.MIN_FREE_SPACE_MB || '500', 10),
  // Concurrency for segment-stitch downloads (gentle by default to avoid proxy throttling).
  segmentConcurrency: parseInt(process.env.SEGMENT_CONCURRENCY || '3', 10),

  // Security / limits. apiToken empty = auth disabled (localhost-only already).
  apiToken: process.env.API_TOKEN || '',
  rateLimitPerMin: parseInt(process.env.RATE_LIMIT_PER_MIN || '60', 10),
  maxRequestBodyKb: parseInt(process.env.MAX_REQUEST_BODY_KB || '256', 10),
  // Allow analyze/download of private/loopback hosts (off by default — SSRF guard).
  allowPrivateUrls: process.env.ALLOW_PRIVATE_URLS === 'true',
  logPath: path.resolve(process.env.LOG_PATH || './logs'),
};

// Ensure required directories exist
const dirs = [
  path.dirname(config.databasePath),
  config.storagePath,
  config.tempPath,
  path.dirname(config.cookiesPath),
];

dirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});
