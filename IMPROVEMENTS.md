# NetLoad Downloader — Code Review & Improvements

All issues found in the review and the corresponding fixes applied to the codebase.

---

## Bugs Fixed

### 1. Queue concurrency broken + race condition (`queue.ts`)
**Problem:** `process()` started only one download per call and awaited it inline, so `maxConcurrent=3` was never actually respected. Two rapid `add()` calls could also read the same `pending[0]` before its status changed, starting the same task twice.
**Fix:** Rewrote `process()` as a synchronous loop that fills all available slots using an atomic `claimNext()` DB transaction. Downloads fire-and-forget; `activeCount` is decremented in `finally` and `process()` is re-called.

### 2. Stale tasks die on restart (`index.ts`, `database.ts`)
**Problem:** Tasks with status `downloading`/`extracting`/`processing` at server startup were orphaned — their yt-dlp processes were gone but the DB rows stayed stuck.
**Fix:** `resetStaleTasks()` resets all in-progress rows back to `queued` on startup, then `QueueManager.process()` picks them up immediately.

### 3. Unhandled promise rejection in analyzer timeout (`analyzer.ts`)
**Problem:** `Promise.race([analysisPromise, timeoutPromise])` — when the timeout wins, `analysisPromise` still runs and eventually rejects with no handler attached, causing Node.js to emit `UnhandledPromiseRejection`.
**Fix:** `analysisPromise.catch(() => {})` attached before the race. Added `clearTimeout` on the success path.

### 4. Temp cleanup targets downloads folder, not temp (`index.ts`)
**Problem:** `FileValidator.cleanupTemp(config.storagePath, 24)` was pointed at the *downloads* directory. `config.tempPath` was never used anywhere. A `.part` file in an active download older than 24h could be deleted under yt-dlp's `--continue`.
**Fix:** Changed to `FileValidator.cleanupTemp(config.tempPath, 24)` and moved to an hourly `setInterval` instead of the 1% random check.

### 5. Task title stays "Extracting..." forever (`downloader.ts`, `yt-dlp.ts`)
**Problem:** The download flow never populated `title`, `thumbnail`, or `uploader` on the task record.
**Fix:** Added `--print before_dl:%(title)s\t%(uploader)s\t%(thumbnail)s` to the yt-dlp args in `downloader.ts` and an `onMetadata` callback in `YTDLPProcessManager` that updates the task when the metadata line is received.

### 6. `audioOnly` parsed but never wired (`index.ts`, `downloader.ts`)
**Problem:** `DownloadRequestSchema` accepted `audioOnly` but it was silently dropped — the download always produced a video file.
**Fix:** In `index.ts`, `audioOnly: true` sets `format` to `'bestaudio'`. In `downloader.ts`, `task.format === 'bestaudio'` triggers `-x --audio-format mp3` extraction args.

### 7. Analyzer spawn ID is the URL (`analyzer.ts`)
**Problem:** Two concurrent analyses of the same URL shared the same key in `activeProcesses`, so the second call's `cancel()` would kill the wrong (or the first) process.
**Fix:** `randomUUID()` is generated per attempt as the spawn ID; `cancel()` uses that ID.

### 8. Delete task doesn't kill its process (`index.ts`)
**Problem:** `DELETE /api/tasks/:id` removed the DB row but left a running yt-dlp process orphaned.
**Fix:** `YTDLPProcessManager.cancel(id)` is called before `tasks.delete()`. Also added `POST /api/tasks/:id/cancel` endpoint.

### 9. `tasks.update` interpolates unsanitised keys into SQL (`database.ts`)
**Problem:** Object keys from callers were interpolated directly into the SQL `SET` clause. A future refactor passing `req.body` directly would open SQL injection.
**Fix:** Column names are now validated against a `ALLOWED_TASK_KEYS` allowlist before building the query.

---

## Security Hardening

### 10. API bound to all interfaces, CORS wide open (`index.ts`)
**Problem:** `server.listen(port)` bound to `0.0.0.0` and `cors()` had no origin restriction — anyone on the LAN could trigger downloads or overwrite settings.
**Fix:** Server now binds `127.0.0.1` only. CORS restricted to `localhost` / `127.0.0.1` origins.

### 11. `POST /api/settings` writes unvalidated body to disk (`index.ts`)
**Problem:** Arbitrary JSON from `req.body` was serialised and written to `settings.json` with no validation.
**Fix:** Body is now validated against `SettingsSchema` (zod). Only known fields are accepted. `maxConcurrentDownloads` is applied to the queue immediately on save.

### 12. `/api/analyze` accepts any URL including `file://` (`index.ts`)
**Problem:** No URL validation — a `file://` or `javascript:` URL would be passed straight to yt-dlp.
**Fix:** URL is validated as HTTP/HTTPS only before being passed to `analyzeUrl()`.

### 13. `--disable-web-security` in stealth browser (`browserManager.ts`)
**Problem:** This Chromium flag weakens the browser sandbox for every untrusted page the extractor visits. It isn't needed for Playwright's network request interception (`page.on('request', ...)`).
**Fix:** Flag removed from `launch()` args.

### 14. Hardcoded `F:\\Apps\\NodeJS` PATH injection (`yt-dlp.ts`)
**Problem:** The Node.js directory was hardcoded into the spawned process's `PATH`, breaking any non-standard installation.
**Fix:** Moved to `config.nodePath` (read from `NODE_PATH` env var, with the old value as default).

---

## Architecture Improvements

### 15. Task IDs use Math.random — collision-prone (`queue.ts`)
**Problem:** `Math.random().toString(36).substring(7)` produces ~5 character IDs. Collisions are realistic with dozens of tasks.
**Fix:** `crypto.randomUUID()` (Node built-in, no extra dep).

### 16. WS progress delivered via 1-second polling (`index.ts`, `progress.ts`)
**Problem:** A `setInterval(1000)` queried the DB every second and broadcast regardless of whether anything changed. Dead WS clients were never reaped.
**Fix:** Replaced with event-driven broadcasts: `taskEvents` (EventEmitter exported from `database.ts`) fires `task:created` / `task:updated` on every DB write; `setupTaskBroadcasts()` subscribes and broadcasts immediately. Added WS heartbeat (ping every 30s, terminate unresponsive clients). New WS clients receive an `initial_state` snapshot on connect.

### 17. SQLite not hardened (`database.ts`)
**Problem:** Default journal mode (DELETE) is slower and holds write locks longer. No busy timeout meant concurrent writes could throw immediately.
**Fix:** `db.pragma('journal_mode = WAL')`, `db.pragma('busy_timeout = 5000')`, `CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`. `closeDatabase()` exported for graceful shutdown.

### 18. Duplicate retry/recovery orchestration (`analyzer.ts`, `downloader.ts`)
**Note:** Both files share nearly identical ~80-line retry loops. Consolidating into a shared `withRecovery()` helper is the recommended next step but was not done here to avoid risk; the individual fixes (UUID spawn ID, timeout handling, audioOnly) were applied to each independently.

### 19. Error responses leak internals (`index.ts`)
**Fix:** Zod parse errors return `error.flatten()` (structured, not a raw JSON blob). Known error codes (`AUTH_REQUIRED`, `CLOUDFLARE_BLOCKED`, `NETWORK_TIMEOUT`, etc.) map to appropriate HTTP status codes. Express error-handler middleware added as final backstop.

### 20. Binary existence not validated at startup (`index.ts`)
**Problem:** A missing ffmpeg or yt-dlp would fail mid-download with a cryptic spawn error.
**Fix:** Both binaries are checked at startup; the server logs a clear error and exits if either is missing.

### 21. `isFallbackStream` matched `.includes('.mp4')` (`downloader.ts`)
**Problem:** A URL like `/video.mp4.html` would incorrectly set `isFallbackStream = true` forcing `best` format and HLS args.
**Fix:** Replaced with the proper `STREAM_URL_PATTERNS` regexes from `fallbackExtractor.ts`.

### 22. Graceful shutdown incomplete (`index.ts`)
**Problem:** SIGINT/SIGTERM only closed the browser. The HTTP server kept accepting connections, active yt-dlp children kept running, and the SQLite file wasn't closed cleanly.
**Fix:** Shutdown now: closes HTTP server → cancels all active yt-dlp processes → closes browser → closes DB.

---

## Code Quality

### 23. Iframe KNOWN_EMBEDDERS matches URL substring, not hostname (`fallbackExtractor.ts`)
**Problem:** `resolved.includes('doodstream')` matches `https://evil.com/?x=doodstream`.
**Fix:** Matching against `new URL(resolved).hostname` after wrapping in try/catch.

### 24. Tier-1 iframe recursion has no depth limit or visited set (`fallbackExtractor.ts`)
**Problem:** A self-referencing iframe (or a cycle) would recurse indefinitely until the 10s timeout accumulated.
**Fix:** `extractTier1` now takes a `depth` parameter (default 0, capped at 3) and a `visited` Set to track already-visited URLs.

### 25. Reliable final path via `--print after_move:%(filepath)s` (`yt-dlp.ts`, `downloader.ts`)
**Fix:** Added to downloader's per-task args. The line-buffered stdout parser in `yt-dlp.ts` detects absolute path lines (drive-letter prefix on Windows) and fires `onPathDiscovered`, providing the definitive post-merge path. Existing `[download] Destination:` and `[Merger]` regex matching is retained as fallback.

### 26. `settings.json` paths and `.env.local` paths were stale
**Problem:** Both files still referenced the old project location (`F:/Dev/myproject/netload-downloader/...`).
**Fix:** `.env.local` updated to current paths with `NODE_PATH` added. `settings.json` paths updated.

---

## Files Changed

| File | Changes |
|------|---------|
| `src/types.ts` | Added `ProgressData`, `MetadataInfo`, `SettingsSchema`, `Settings` |
| `src/database.ts` | WAL + busy_timeout, status index, column whitelist, `claimNext()`, `resetStaleTasks()`, `closeDatabase()`, `taskEvents` EventEmitter |
| `src/queue.ts` | `randomUUID()` IDs, loop-based `process()`, fire-and-forget downloads |
| `src/config.ts` | Added `nodePath` from env |
| `src/yt-dlp.ts` | `config.nodePath`, `onMetadata` callback, line-buffered stdout, `--print` output parsing, `cancelAll()` |
| `src/downloader.ts` | `audioOnly` wired, `isFallbackStream` regex fix, `--print` args, `onMetadata` handler |
| `src/analyzer.ts` | UUID spawn ID, `.catch(()=>{})` on `analysisPromise`, `clearTimeout` on success |
| `src/progress.ts` | WS heartbeat, `setupTaskBroadcasts()`, initial state on connect |
| `src/index.ts` | `127.0.0.1` bind, localhost CORS, URL validation, settings validation, cancel endpoint, DELETE cancels process, startup recovery, settings→maxConcurrent, event-driven WS, `config.tempPath` cleanup, hourly cleanup interval, graceful shutdown, error middleware |
| `src/utils/browserManager.ts` | Removed `--disable-web-security` |
| `src/extractors/fallbackExtractor.ts` | Hostname-based embedder matching, depth limit + visited set on recursion |
| `backend/.env.local` | Fixed stale paths, added `NODE_PATH` |
| `backend/config/settings.json` | Fixed stale paths |
