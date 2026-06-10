NetLoad Downloader Backend - Program Summary

  Overview
  NetLoad Downloader is a robust, TypeScript-based media downloader backend built around yt-dlp and Playwright. It is designed to extract and
  download video streams from a wide variety of platforms, including mainstream sites (YouTube), anime streaming sites (Miruro, Gogoanime), movie
  embedders (DoodStream, Filemoon), and adult sites. 

  To overcome modern anti-bot protections, it incorporates a sophisticated two-tier fallback extraction system that bypasses Cloudflare protection
  and dynamically generated Single Page Applications (SPAs) without relying on a headless browser as the primary downloader.

  ---

  Architecture & Components

  1. API & Queue Layer
   - src/index.ts: The Express server exposing /api/analyze and /api/download endpoints. It integrates WebSockets (src/progress.ts) to broadcast
     real-time download progress and status to the frontend. Graceful shutdown handlers ensure all stealth browsers are cleanly killed on exit.
   - src/queue.ts: Manages concurrent download tasks (limited to 3 parallel downloads by default) to prevent system or network overload.
   - src/database.ts: Uses SQLite (better-sqlite3) to persist task states, ensuring downloads can be tracked across server restarts.

  2. Provider Routing (src/providers/)
  The system uses a strategy pattern to dynamically apply specific HTTP headers, yt-dlp arguments, and impersonation targets depending on the
  matched domain.
   - Detector.ts: Routes the incoming URL to the correct provider. The order is strict (e.g., specific providers like Anime and Movie must execute
     before the Generic fallback).
   - Supported Providers: YouTube, Hanime, Anime (SPAs), Movie (Iframes), Adult, and Generic.

  3. Downloader Engine (src/yt-dlp.ts & src/analyzer.ts & src/downloader.ts)
   - Core Engine: Spawns native yt-dlp child processes via child_process.spawn. No wrapper libraries are used, ensuring maximum performance and
     argument control.
   - Error Classification: YTDLPProcessManager parses stderr to classify specific failures such as CLOUDFLARE_BLOCKED,
     DYNAMIC_CONTENT_UNSUPPORTED, RATE_LIMITED, or CONNECTION_RESET.
   - Retry Loop: The analyzer and downloader employ a robust retry loop. If yt-dlp fails with a recoverable error, the system escalates the task
     to the Cloudflare Recovery or Fallback Extraction layers.

  ---

  Advanced Extraction & Recovery

  Two-Tier Fallback System (src/extractors/fallbackExtractor.ts)
  When yt-dlp fails to natively extract a URL (common with SPAs and heavily protected sites), the system escalates:
   - Tier 1 (Lightweight Scraping): Uses axios and cheerio to fetch the raw HTML. It aggressively scans for .m3u8 or .mp4 URLs, base64 encoded
     streams, standard video tags, and known iframe embed chains. Fast (~2s) but fails on purely JS-rendered players.
   - Tier 2 (Deep Extraction): Launches a stealth Chromium browser via Playwright. It loads the page, clicks play buttons to trigger lazy-loaded
     streams, and intercepts the exact network requests the player makes to the CDN. It captures the stream URL along with essential headers
     (Referer, Origin, User-Agent) and passes them back to yt-dlp.

  Cloudflare Clearance Harvesting (src/recovery/cloudflare.ts)
   - When a 403 Forbidden or Cloudflare challenge is detected, this manager spins up the stealth browser to load the site and automatically solve
     the challenge.
   - It harvests the cf_clearance cookie and the matching User-Agent, which are then injected into subsequent yt-dlp retries to completely bypass
     the block.

  ---

  Strict Operational Rules
  The backend operates under strict constraints designed to maintain system integrity and performance:
   1. Drive Isolation: All dependencies, caches (npm, pip), and Playwright Chromium binaries are strictly contained within the F:\ drive to
      prevent C:\ drive contamination. This is enforced by scripts/install-backend.ps1.
   2. No Puppeteer/Playwright as Primary Downloader: Playwright is strictly reserved for Cloudflare bypass and network interception (Tier 2).
      yt-dlp always handles the actual media downloading.
   3. Graceful Browser Management: The stealth browser (src/utils/browserManager.ts) is a singleton that lazy-loads on first use. Browser contexts
      are strictly isolated per request and immediately closed after use to prevent memory leaks.