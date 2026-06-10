# NetLoad Downloader Backend - Architecture & Rules

This document outlines the foundational rules and architecture for the NetLoad Downloader backend project. ALL future Gemini CLI agents interacting with this folder MUST strictly adhere to these rules.

## Strict Environmental Constraints
- **F: Drive Isolation**: All tooling, dependencies, and caches MUST remain inside `F:\Dev\myproject\netload-downloader`. ABSOLUTELY NO dependencies, caches, binaries, or environments may touch the `C:` drive.
- **Python**: Use `F:\Apps\Python\python.exe`. Virtual environments MUST be created INSIDE the project at `F:\Dev\myproject\netload-downloader\venv`.
- **Node.js**: Use `F:\Apps\NodeJS`. Before `npm install`, configure the cache: `npm config set cache F:\Dev\npm-cache --global`.
- **Binaries**: Use only localized binaries stored in `backend/yt-dlp/` and `backend/ffmpeg/`. NEVER rely on the system `PATH` for these tools.

## Architecture
- **No Wrappers**: Use native `child_process.spawn` for `yt-dlp.exe`. DO NOT use libraries like `youtube-dl-exec`.
- **No Browser Scraping**: Authentication must strictly use Netscape `cookies.txt` files located in `backend/cookies/cookies.txt`. DO NOT use `--cookies-from-browser` or attempt to scrape Chrome SQLite databases.
- **No Forced Transcoding**: Do not use `--embed-thumbnail`. FFmpeg should only run when DASH merging or explicit audio extraction is requested.
- **Provider System**: URLs are routed through `ProviderDetector` in `backend/src/providers/` to inject specific headers, User-Agents, and `yt-dlp` flags.
- **Fallback Extraction**: For unsupported URLs or Cloudflare blocks, use `backend/src/extractors/fallbackExtractor.ts` (powered by `axios` and `cheerio`) to hunt for hidden `.m3u8` or `.mp4` links. DO NOT use Puppeteer, Playwright, or headless browsers.

## How to Run
```powershell
cd F:\Dev\myproject\netload-downloader
.\start-dev.ps1
```
Interactive testing script: `.\test-download.ps1`
