# NetLoad Downloader Backend

Hardened **yt-dlp orchestration backend** for media extraction and download, with a
browser-based fallback pipeline (Playwright) for sites yt-dlp can't handle natively —
including generic **segmented-stream capture + stitching** for players that expose no manifest.

## How universal is it?

The core is **site-agnostic**; per-site lists are optimizations, not gates. An unknown site
still works — it just falls through to the generic path. From most to least universal:

1. **Native yt-dlp** — the primary path; ~1,800 sites supported out of the box.
2. **Generic fallback** — for sites yt-dlp can't parse: Tier 1 HTML scrape → Tier 2 Playwright
   network interception, with candidates ranked by **measured size/duration** (not keywords).
3. **Segment stitching** — for players with no manifest: intercept the decrypted m3u8 and
   reassemble the chunks with ffmpeg. This is a generic mechanism (it worked on a never-seen
   site with no site-specific code).
4. **Cloudflare recovery, per-site cookies, playlist expansion** — all generic.

The **only** site-tailored pieces are *hints* that make known sites work better, and they never
block unknown sites: the provider hostname lists in `src/providers/*` (youtube/hanime/anime/
movie/adult, with `GenericProvider` as the catch-all), the per-provider header tweaks in
`src/utils/headers.ts`, the embed-host list in `fallbackExtractor.ts`, and the ad/placeholder
keyword penalties in `scoreStream()` (demoted to a tiebreaker behind the size/duration signal).
The recent direction has been deliberately *away* from per-site heuristics toward universal
ranking + interception.

## Environment

- Runs from the `F:` drive with **project-local** `yt-dlp.exe`, `ffmpeg.exe`, and `ffprobe.exe`
  (no global installs).
- Configured via `backend/.env.local` (see `src/config.ts` for all keys + defaults).
- Node.js **20+** (`.nvmrc`).

## Setup

```powershell
cd F:\Dev\myproject\Main_scrapper\main_main\netload-downloader\backend
npm install
npm run download-binaries   # fetches yt-dlp.exe + ffmpeg/ffprobe into the project
```

## Running

```powershell
cd backend
npm run dev      # ts-node-dev, http://127.0.0.1:4000
# or
npm run build && npm start
```

## CLI

A thin client over the running API:

```powershell
npm run build                       # produces dist/cli.js
node dist/cli.js <url> [options]     # or: netload <url>  (via the package bin)

  --audio          audio only (mp3)
  --format <id>    specific format id (from analyze)
  --playlist       expand a playlist/channel into individual downloads
  --subs           download + embed English subtitles
  --thumb          embed thumbnail
```

Set `NETLOAD_API` to target a non-default host (default `http://127.0.0.1:4000`).

## Development

```powershell
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm test             # vitest (60 unit tests, no network/browser/db)
npm run format       # prettier --write
```

CI (`.github/workflows/ci.yml`) runs typecheck + lint + tests on every push/PR to `main`.

## Architecture

- **Express API** (`src/index.ts`) — bound to `127.0.0.1`, localhost-only CORS, optional token
  auth, per-IP rate limiting, request-size cap, and an SSRF guard.
- **Provider strategy** (`src/providers/*`) — per-site yt-dlp args / headers / format strategy,
  resolved by `ProviderDetector` (order matters; `GenericProvider` is the catch-all).
- **Tiered fallback extraction** (`src/extractors/fallbackExtractor.ts`) — Tier 1 HTML scrape →
  Tier 2 Playwright network interception, ranked by **measured size/duration** (site-agnostic).
- **Segment stitching** (`src/extractors/segmentStitcher.ts`) — intercepts the decrypted m3u8
  (Blob/fetch/XHR hook), downloads all segments (throttle-resilient), concats with ffmpeg, and
  verifies the result against the reported duration.
- **Playlist expansion** (`src/extractors/playlistExpander.ts`) — `--flat-playlist` enumeration.
- **Recovery** (`src/recovery/cloudflare.ts`) — Cloudflare clearance harvesting via stealth
  Chromium (`harvestAndInject` shared by analyze + download).
- **Per-site cookies** (`src/utils/cookieResolver.ts`) — `cookies/<host>.txt`, global fallback.
- **Queue** (`src/queue.ts`) — concurrency-limited, atomic `claimNext()` DB transaction.
- **SQLite** (`src/database.ts`) — WAL mode, status index, stale-task recovery, guarded migrations.
- **WebSocket** (`src/progress.ts`) — event-driven task broadcasts + heartbeat.

## API

| Method | Endpoint | Notes |
|--------|----------|-------|
| `GET`  | `/api/health` | `{ status, version, binaries:{ytdlp,ffmpeg}, queue:{active,maxConcurrent}, tasks:{<status>:n} }` |
| `POST` | `/api/analyze` | Body `{ url }`. Returns metadata + `formats`, plus `isLikelyPreview`, `requiresAuth`, `cookiesPresent`, `cookiesValid`, `warnings[]`. Rate-limited. |
| `POST` | `/api/download` | Body `{ url, format?, audioOnly?, playlist?, formatId?, subtitles?, embedThumbnail? }`. Single → `{ taskId }`; playlist → `{ playlist:true, count, taskIds[] }`. Rate-limited. |
| `GET`  | `/api/tasks` / `/api/tasks/:id` | Task list / single task (incl. `note`, e.g. `LIKELY_PREVIEW_ADD_COOKIES`, `PARTIAL_CAPTURE`). |
| `PUT`  | `/api/tasks/:id/status` | Update status. |
| `POST` | `/api/tasks/:id/cancel` | Cancel + kill the yt-dlp process. |
| `POST` | `/api/tasks/:id/pause` | Pause (kills process, keeps `.part`). |
| `POST` | `/api/tasks/:id/resume` | Resume a paused task (`--continue`). |
| `DELETE` | `/api/tasks/:id` | Delete (kills process first). |
| `GET` / `POST` | `/api/settings` | Read / validate-and-write settings (`downloadDir` must be absolute). |
| `GET`  | `/api/cookies/status` | `{ exists, valid, path }` (Netscape-format check). |
| `POST` | `/api/update/ytdlp` | Run yt-dlp's built-in self-update (`-U`). |
| `WS`   | `/ws` | `task_created` / `task_updated` events + `initial_state` snapshot on connect. |

When `API_TOKEN` is set, every endpoint except `/api/health` requires
`X-API-Token: <token>` (or `Authorization: Bearer <token>`).

## Configuration (`.env.local`)

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `4000` | API port (bound to `127.0.0.1`). |
| `STORAGE_PATH` | `F:/MediaDownloads` | Download output directory. |
| `FFMPEG_PATH` / `YTDLP_PATH` | `./ffmpeg`, `./yt-dlp/yt-dlp.exe` | Binary locations. |
| `COOKIES_PATH` / `COOKIES_DIR` | `./cookies/cookies.txt`, `./cookies` | Global + per-site (`<host>.txt`) cookies. |
| `MAX_FILESIZE_MB` | `0` (off) | Per-file size cap (`--max-filesize`). |
| `MIN_FREE_SPACE_MB` | `500` | Refuse to start a download below this free space (`DISK_FULL`). |
| `SEGMENT_CONCURRENCY` | `3` | Parallel segment downloads for stitching. |
| `API_TOKEN` | _(empty = off)_ | Shared-secret auth. |
| `RATE_LIMIT_PER_MIN` | `60` | Per-IP limit on analyze/download (`0` = off). |
| `MAX_REQUEST_BODY_KB` | `256` | JSON body size cap. |
| `ALLOW_PRIVATE_URLS` | `false` | Bypass the SSRF guard (private/loopback hosts). |
| `LOG_PATH` / `LOG_LEVEL` | `./logs`, `info` | Daily log file + level. |

## Storage

- **Downloads**: `F:/MediaDownloads` (configurable)
- **Database**: `backend/database/downloader.db` (WAL)
- **Logs**: `backend/logs/app-YYYY-MM-DD.log` · **Temp**: `backend/temp`
- **Cookies**: `backend/cookies/` — global `cookies.txt` + optional per-site `<host>.txt`
