# NetLoad Downloader Backend

Hardened **yt-dlp orchestration backend** for media extraction and download, with a
browser-based fallback pipeline (Playwright) for sites yt-dlp can't handle natively —
including generic **segmented-stream capture + stitching** for players that expose no manifest.

## Environment

- Runs from the `F:` drive with **project-local** `yt-dlp.exe`, `ffmpeg.exe`, and `ffprobe.exe`
  (no global installs).
- Paths are configured in `backend/.env.local` (see `src/config.ts` for the keys and defaults).
- Node.js **20+** (`.nvmrc`).

## Setup

```powershell
cd F:\Dev\myproject\Main_scrapper\main_main\netload-downloader\backend
npm install
npm run download-binaries   # fetches yt-dlp.exe + ffmpeg/ffprobe into the project
```

Configure `backend/.env.local` (storage path, binary paths, cookies path, port). Defaults
live in `src/config.ts`.

## Running

```powershell
cd backend
npm run dev      # ts-node-dev, http://127.0.0.1:4000
# or
npm run build && npm start
```

## Development

```powershell
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm test             # vitest (unit tests, no network/browser/db)
npm run format       # prettier --write
```

CI (`.github/workflows/ci.yml`) runs typecheck + lint + tests on every push/PR to `main`.

## Architecture

- **Express API** (`src/index.ts`) — bound to `127.0.0.1`, localhost-only CORS.
- **Provider strategy** (`src/providers/*`) — per-site yt-dlp args / headers / format strategy,
  resolved by `ProviderDetector` (order matters; `GenericProvider` is the catch-all).
- **Tiered fallback extraction** (`src/extractors/fallbackExtractor.ts`) — Tier 1 HTML scrape →
  Tier 2 Playwright network interception. Candidates are ranked by **measured size/duration**
  (site-agnostic), with keyword scoring only as a tiebreaker.
- **Segment stitching** (`src/extractors/segmentStitcher.ts`) — for sites that stream short
  sibling chunks with no manifest: intercepts the decrypted m3u8 (Blob/fetch/XHR hook),
  downloads all segments, and concats with ffmpeg.
- **Recovery** (`src/recovery/cloudflare.ts`) — Cloudflare clearance harvesting via stealth
  Chromium.
- **Queue** (`src/queue.ts`) — concurrency-limited, atomic `claimNext()` DB transaction.
- **SQLite** (`src/database.ts`) — WAL mode, status index, stale-task recovery on restart.
- **WebSocket** (`src/progress.ts`) — event-driven task broadcasts + heartbeat.

## API

| Method | Endpoint | Notes |
|--------|----------|-------|
| `GET`  | `/api/health` | `{ status, version }` |
| `POST` | `/api/analyze` | Body `{ url }`. Returns metadata + `formats`, plus `isLikelyPreview`, `requiresAuth`, `cookiesPresent`, `cookiesValid`, `warnings[]`. |
| `POST` | `/api/download` | Body `{ url, format?, audioOnly? }` → `{ taskId }`. |
| `GET`  | `/api/tasks` / `/api/tasks/:id` | Task list / single task (incl. `note`, e.g. `LIKELY_PREVIEW_ADD_COOKIES`, `PARTIAL_CAPTURE`). |
| `PUT`  | `/api/tasks/:id/status` | Update status. |
| `POST` | `/api/tasks/:id/cancel` | Cancel + kill the yt-dlp process. |
| `DELETE` | `/api/tasks/:id` | Delete (kills process first). |
| `GET` / `POST` | `/api/settings` | Read / validate-and-write settings. |
| `GET`  | `/api/cookies/status` | `{ exists, valid, path }` (Netscape-format check). |
| `WS`   | `/ws` | `task_created` / `task_updated` events + `initial_state` snapshot on connect. |

## Storage

- **Downloads**: `F:/MediaDownloads` (configurable)
- **Database**: `backend/database/downloader.db` (WAL)
- **Logs**: `backend/logs` · **Temp**: `backend/temp`
- **Cookies**: `backend/cookies/cookies.txt` (Netscape format; optional, for gated content)
