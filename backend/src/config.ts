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
  // Per-site stealth-browser sessions (Playwright storageState: cookies +
  // localStorage) live here as `<host>.json`, so a gated/logged-in site stays
  // signed in across runs without re-solving CF / re-logging-in each time.
  profilesDir: path.resolve(process.env.PROFILES_DIR || './profiles'),
  nodePath: process.env.NODE_PATH || 'F:\\Apps\\NodeJS',

  // Download guards. maxFilesizeMB=0 means unlimited; minFreeSpaceMB is the
  // free-space floor on the storage drive before a download is allowed to start.
  maxFilesizeMB: parseInt(process.env.MAX_FILESIZE_MB || '0', 10),
  minFreeSpaceMB: parseInt(process.env.MIN_FREE_SPACE_MB || '500', 10),
  // Concurrency for segment-stitch downloads (gentle by default to avoid proxy throttling).
  segmentConcurrency: parseInt(process.env.SEGMENT_CONCURRENCY || '3', 10),
  // Max simultaneous stealth-Chromium contexts. Every extraction path (Tier 2,
  // segment stitch, MSE, DASH pre-check, diagnose, CF harvest) opens one; this
  // caps total so a queue of downloads can't exhaust memory with rendered pages.
  maxBrowserContexts: Math.max(1, parseInt(process.env.MAX_BROWSER_CONTEXTS || '3', 10)),
  // Max simultaneous downloads targeting the SAME host — politeness so a burst of
  // same-site tasks can't get the IP rate-limited/banned (which kills every site
  // on that CDN, not just one).
  maxPerHostConcurrent: Math.max(1, parseInt(process.env.MAX_PER_HOST_CONCURRENT || '2', 10)),

  // Watchdog stall ceilings: a spawned ffmpeg/yt-dlp is killed (process tree) if it
  // emits NO output for this long — catches true hangs (dead sockets) without
  // killing a legitimately long download, which keeps emitting progress.
  ffmpegStallMs: Math.max(10, parseInt(process.env.FFMPEG_STALL_SEC || '120', 10)) * 1000,
  ytdlpStallMs: Math.max(10, parseInt(process.env.YTDLP_STALL_SEC || '180', 10)) * 1000,

  // yt-dlp freshness. yt-dlp ships new/fixed extractors almost daily, so a stale
  // binary silently loses reach — we self-update on startup (throttled) + weekly.
  // YTDLP_AUTO_UPDATE=false disables it. YTDLP_CHANNEL = stable | nightly | master
  // (nightly/master carry the very latest extractor fixes, at some stability cost).
  ytdlpAutoUpdate: process.env.YTDLP_AUTO_UPDATE !== 'false',
  ytdlpChannel: process.env.YTDLP_CHANNEL || 'stable',
  ytdlpUpdateIntervalMs:
    Math.max(1, parseInt(process.env.YTDLP_UPDATE_INTERVAL_DAYS || '7', 10)) * 24 * 60 * 60 * 1000,
  // Optional URL for a post-update functional smoke (metadata-only `-J`). Empty =
  // skip; the version + extractor-load checks always run regardless.
  ytdlpSmokeUrl: process.env.YTDLP_SMOKE_URL || '',

  // Security / limits. apiToken empty = auth disabled (localhost-only already).
  apiToken: process.env.API_TOKEN || '',
  rateLimitPerMin: parseInt(process.env.RATE_LIMIT_PER_MIN || '60', 10),
  maxRequestBodyKb: parseInt(process.env.MAX_REQUEST_BODY_KB || '256', 10),
  // Allow analyze/download of private/loopback hosts (off by default — SSRF guard).
  allowPrivateUrls: process.env.ALLOW_PRIVATE_URLS === 'true',

  // Optional external captcha solver hook (authorized use). A command invoked as
  // `<cmd> <type> <sitekey> <pageUrl>` that prints a solution token on stdout for
  // Turnstile/hCaptcha/reCAPTCHA. Empty = no hook (rely on stealth auto-solve).
  captchaSolverCmd: process.env.CAPTCHA_SOLVER_CMD || '',
  captchaSolverTimeoutMs: Math.max(5, parseInt(process.env.CAPTCHA_SOLVER_TIMEOUT_SEC || '120', 10)) * 1000,

  // How long the interactive-login window stays open to capture a session profile.
  interactiveLoginTimeoutMs: Math.max(30, parseInt(process.env.INTERACTIVE_LOGIN_TIMEOUT_SEC || '300', 10)) * 1000,

  // Optional FlareSolverr endpoint (a local proxy that drives an undetected
  // browser to clear Cloudflare Turnstile/managed challenges the stealth Chromium
  // can't pass). Empty = disabled. When set, it's the last-resort CF recovery step:
  // POST <url>/v1 {cmd:'request.get', url, maxTimeout} → {solution:{cookies,userAgent}}.
  // Default points at FlareSolverr's standard local port; left empty so it's opt-in.
  flaresolverrUrl: process.env.FLARESOLVERR_URL || '',
  flaresolverrTimeoutMs: Math.max(10, parseInt(process.env.FLARESOLVERR_TIMEOUT_SEC || '60', 10)) * 1000,
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
