# ROADMAP: RECOMMENDED FUNCTIONALITIES FOR NETLOAD DOWNLOADER

To bring this download engine to a "production-grade, zero-fail" state, the following three architectural upgrades should be implemented.

## 1. Advanced Fallback Extraction (Deep Web Scraping)
**Context:** The current `FallbackExtractor` (`backend/src/extractors/fallbackExtractor.ts`) performs a surface-level HTML scan using Cheerio. While effective, it misses highly obfuscated or deeply nested players.
**The Implementation Task:**
*   **Recursive Iframe Unrolling**: Upgrade the `extractMediaUrl` function to recursively fetch the HTML of discovered `iframes` (up to a depth of 2 or 3) and run the extraction logic inside the child document.
*   **JWPlayer & VideoJS Parsing**: Implement regex to locate `setup({...})` or `videojs({...})` configuration blocks in `<script>` tags, and parse the JSON-like objects to extract the `file:` or `src:` properties containing `.m3u8` links.
*   **Obfuscated JSON Configs**: Many anime/movie sites inject base64-encoded or URI-encoded JSON into `data-*` attributes. Add logic to decode these attributes on DOM elements like `#player-config` and extract the stream URLs.
*   **Constraint Reminder**: This must be done purely via HTTP requests (`axios`) and HTML parsing (`cheerio`). Do NOT use Puppeteer or browser automation.

## 2. FFprobe Deep File Validation
**Context:** Currently, `FileValidator.validate()` (`backend/src/utils/validators.ts`) only checks if the file exists on the disk and is greater than 0 bytes. This is insufficient; a 5MB Cloudflare "403 Forbidden" HTML page saved as an `.mp4` will pass this check.
**The Implementation Task:**
*   **FFprobe Integration**: Utilize the local `ffprobe.exe` located at `F:\Dev\myproject\netload-downloader\backend\ffmpeg\ffprobe.exe`.
*   **Validation Logic**: After `yt-dlp` finishes, spawn `ffprobe` as a child process against the final downloaded file.
*   **Execution Args**: Run `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "filepath.mp4"`.
*   **Success Condition**: If `ffprobe` returns a valid numerical duration and exits with code `0`, the file is a valid media container. If it fails or returns nothing, mark the task as `FILE_CORRUPTED` in the SQLite database and optionally trigger a retry.

## 3. Proactive Cookie Validation System
**Context:** The engine relies on Netscape `cookies.txt` files (stored in `backend/cookies/`) to bypass age restrictions and paywalls (e.g., YouTube Premium, Adult sites). Currently, the system only checks if the file physically exists. If the cookies expire, the engine fails deep in the download phase.
**The Implementation Task:**
*   **Cookie Parser utility**: Create a utility (e.g., `backend/src/utils/cookieManager.ts`) to parse the Netscape HTTP Cookie File format.
*   **Expiration Check**: Read the Unix timestamps in the 5th column of the `cookies.txt` file. Determine if critical domain cookies (like `.youtube.com` or `.pornhub.com`) have expired or will expire within 24 hours.
*   **API Endpoint**: Update `/api/cookies/status` in `backend/src/index.ts` to return an array of supported domains and their health status (e.g., `{"youtube": "healthy", "pornhub": "expired"}`).
*   **Pre-flight Check**: Update `downloader.ts` to check cookie health *before* spawning `yt-dlp`. If a required cookie is expired, pause the task and alert the frontend instead of wasting resources on a doomed extraction attempt.