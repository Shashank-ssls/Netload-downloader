✦ Here is the comprehensive documentation for the NetLoad Downloader project. Because I am currently running with limited system access, please copy the content below and save it as
  NETLOAD_DOWNLOADER_GUIDE.md in the root of your project folder.

  ---

    1 # NetLoad Downloader: Complete Project Guide
    2
    3 ## 1. Project Overview
    4 NetLoad Downloader is a highly resilient, TypeScript-based media downloader backend. It acts as an orchestration layer around the `yt-dlp` core, significantly extending its
      capabilities to handle Cloudflare-protected sites, dynamic Single Page Applications (SPAs), and complex iframe-embedded video players.
    5
    6 The system is designed for high reliability, utilizing a tiered fallback system and stealth browser networking to intercept media streams that standard CLI tools cannot access
      natively.
    7
    8 ## 2. Core Architecture
    9 The backend is built on Node.js and Express, with the following core pillars:
   10 - **API Server:** Handles REST requests for analysis (`/api/analyze`) and downloading (`/api/download`), and provides real-time progress updates via WebSockets.
   11 - **Task Queue:** A concurrency-limited queue (`QueueManager`) ensures system resources aren't overwhelmed by simultaneous downloads. Task state is persisted in SQLite.
   12 - **Provider Routing:** A strategy pattern (`ProviderDetector`) that routes URLs to specific configuration classes based on the domain.
   13 - **Downloader Engine:** Native `child_process.spawn` wrappers around `yt-dlp.exe` to execute analysis and downloads with precise argument control and error parsing.
   14 - **Fallback Extraction:** A two-tier system (`FallbackExtractor`) activated when `yt-dlp` natively fails to parse dynamic or protected sites.
   15 - **Stealth Browser:** A singleton Playwright instance (`BrowserManager`) used exclusively for CF clearance harvesting and network interception.
   16
   17 ## 3. Strict Environment Isolation
   18 A critical constraint of this project is absolute drive isolation to prevent `C:` drive contamination.
   19 - **Location:** The entire project, including all caches, dependencies, and binaries, MUST reside on the `F:\` drive (e.g., `F:\Dev\myproject\netload-downloader`).
   20 - **Dependencies:** `npm` cache and `pip` cache are localized to `F:\Dev`.
   21 - **Playwright:** The Chromium binary required for stealth operations is explicitly forced to download into `backend/playwright-browsers` via the `$env:PLAYWRIGHT_BROWSERS_PATH`
      variable.
   22
   23 ## 4. Directory Structure & File Index
   24
   25 ### Root Scripts
   26 - **`start-dev.ps1`**: Activates the Python virtual environment and starts the Node.js backend using `ts-node-dev`.
   27 - **`test-download.ps1`**: An interactive PowerShell client for testing the `/api/analyze` and `/api/download` endpoints.
   28 - **`GEMINI.md`**: Foundational project rules and constraints for AI agents operating in the workspace.
   29
   30 ### Backend Application (`backend/src/`)
   31 - **`index.ts`**: The main entry point. Sets up the Express server, API routes, WebSocket integration, and graceful shutdown handlers for the stealth browser.
   32 - **`config.ts`**: Centralized configuration management, reading from `.env.local` and defining critical paths (temp, storage, database).
   33 - **`logger.ts`**: Configures the `pino` structured logger for detailed, readable console output.
   34 - **`types.ts`**: Defines Zod schemas and TypeScript interfaces (e.g., `Task`, `CapturedStream`, `AnalysisResult`).
   35 - **`database.ts`**: Manages the SQLite connection (`better-sqlite3`) and provides CRUD operations for download tasks.
   36 - **`queue.ts`**: Implements the `QueueManager` to process download tasks sequentially up to a configured concurrency limit.
   37 - **`yt-dlp.ts`**: The `YTDLPProcessManager`. Handles spawning native `yt-dlp` processes, parsing stdout for progress/paths, and crucially, classifying stderr output into
      actionable error types (e.g., `CLOUDFLARE_BLOCKED`, `DYNAMIC_CONTENT_UNSUPPORTED`).
   38 - **`analyzer.ts`**: Executes the pre-download analysis (`yt-dlp -J`). Includes the primary retry loop that orchestrates CF clearance and fallback extraction if the initial attempt
      fails.
   39 - **`downloader.ts`**: Executes the actual media download. Mirrors the analyzer's retry logic to ensure successful stream capture even if tokens expire between analysis and
      download.
   40
   41 ### Providers (`backend/src/providers/`)
   42 Providers determine the specific HTTP headers, `yt-dlp` arguments, and impersonation strategies required for different domains.
   43 - **`base.ts`**: The abstract `BaseProvider` class.
   44 - **`detector.ts`**: The `ProviderDetector`. Contains an array of instantiated providers and routes URLs to the first match. *Order is critical* (Generic must be last).
   45 - **`youtube.ts`**: Optimized args for YouTube extraction.
   46 - **`anime.ts`**: Targets anime streaming frontends (SPAs like Miruro, Gogoanime) that require Tier 2 network interception.
   47 - **`hanime.ts`**: Specific configuration for Hanime domains, preferring native HLS extraction.
   48 - **`movie.ts`**: Targets iframe embedders (Doodstream, Voe, Filemoon) and movie streaming sites.
   49 - **`adult.ts`**: Targets adult platforms, injecting specific Referer headers and age-limit arguments.
   50 - **`generic.ts`**: The catch-all fallback provider for any unmatched URL.
   51
   52 ### Advanced Extraction (`backend/src/extractors/` & `backend/src/recovery/`)
   53 - **`fallbackExtractor.ts`**: The core of the system's resilience. When `yt-dlp` encounters dynamic content or blocks, it attempts:
   54   - *Tier 1 (Lightweight):* Uses `axios` and `cheerio` to scan HTML for hidden `.m3u8`/`.mp4` links, base64 blobs, or iframe chains.
   55   - *Tier 2 (Deep):* Uses Playwright to render the page, click play buttons, and intercept the raw media CDN request, returning a `CapturedStream` object containing the URL and
      required authentication headers.
   56 - **`cloudflare.ts`**: The `CloudflareRecoveryManager`. Solves CF challenges by navigating to the blocked URL in a stealth browser, waiting for the `cf_clearance` cookie, and
      returning it alongside the matching `User-Agent`.
   57
   58 ### Utilities (`backend/src/utils/`)
   59 - **`browserManager.ts`**: Singleton manager for the Playwright stealth Chromium instance. Ensures the browser is only launched when needed and that isolated contexts are used and
      destroyed per request to prevent memory leaks.
   60 - **`headers.ts`**: The `HeaderBuilder`. Constructs dynamic HTTP headers based on the active provider.
   61 - **`userAgents.ts`**: Provides realistic, rotating desktop and mobile User-Agents.
   62 - **`validators.ts`**: Utilities for verifying file existence and cleaning up stale temporary files.
   63
   64 ## 5. The Two-Tier Extraction Lifecycle
   65
   66 The most significant feature of this system is the fallback lifecycle, triggered when `yt-dlp` fails with `DYNAMIC_CONTENT_UNSUPPORTED` or `UNSUPPORTED_URL`:
   67
   68 1.  **Initial Attempt:** `yt-dlp` tries to parse the URL natively. If the site is an SPA (like Miruro) or uses obfuscated embedders (like Mitaku), `yt-dlp` sees an empty HTML shell
      and fails.
   69 2.  **Tier 1 Execution:** The system uses `axios` to grab the HTML. It runs aggressive regexes to find media links or follows known embedder iframes. If Cloudflare blocks `axios`
      (HTTP 403), it immediately escalates.
   70 3.  **Tier 2 Execution:** `BrowserManager` provides an isolated context. Playwright loads the URL in a stealth Chromium instance. 
   71 4.  **Network Interception:** Playwright listens to all network traffic matching media patterns (`.m3u8`, `.mp4`).
   72 5.  **Interaction:** Playwright attempts to click known "Play" button CSS selectors to trigger lazy-loaded streams (crucial for players like Video.js or Plyr).
   73 6.  **Capture:** When the browser requests the media file, the exact URL, `Referer`, `Origin`, and any custom API tokens are captured and returned as a `CapturedStream`.
   74 7.  **Retry:** The analyzer or downloader retries, passing the intercepted direct stream URL and the captured headers directly to `yt-dlp`, bypassing the website entirely.
   75
   76 ## 6. Setup & Installation Guide
   77
   78 To recreate this environment from scratch:
   79
   80 1.  **Prerequisites:** 
   81     - Node.js installed in `F:\Apps\NodeJS`.
   82     - Python installed in `F:\Apps\Python`.
   83     - FFmpeg binaries placed in `backend/ffmpeg/ffmpeg.exe` and `ffprobe.exe`.
   84     - `yt-dlp.exe` placed in `backend/yt-dlp/`.
   85
   86 2.  **Initialize the Project:**
   87     Clone or copy the codebase into `F:\Dev\myproject\netload-downloader`.
   88
   89 3.  **Run the Installer:**
   90     The `install-backend.ps1` script is crucial as it enforces the F: drive isolation.
      cd F:\Dev\myproject\netload-downloader
      powershell -ExecutionPolicy Bypass -File .\backend\scripts\install-backend.ps1

   1     This script will:
   2     - Create necessary cache directories on `F:\Dev\`.
   3     - Run `npm install` for standard Node.js dependencies.
   4     - Install `playwright-core`, `playwright-extra`, and `puppeteer-extra-plugin-stealth`.
   5     - Download the Chromium browser explicitly into `backend/playwright-browsers`.
   6     - Verify that the `C:` drive was not contaminated.
   7
   8 4.  **Environment Variables:**
   9     Ensure `backend/.env.local` exists with at least:
      PORT=4000
      LOG_LEVEL=info
      PLAYWRIGHT_BROWSERS_PATH=./playwright-browsers
   1
   2 5.  **Start the System:**
  In terminal window 1 (Start the server)
      .\start-dev.ps1