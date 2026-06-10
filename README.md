# NetLoad Downloader Backend

Hardened yt-dlp orchestration backend for high-performance media extraction.

## Environment Constraints
- **Drive Isolation**: Runs entirely from the `F:` drive.
- **Local Binaries**: Uses project-local `yt-dlp.exe` and `ffmpeg.exe`.
- **No Global Dependencies**: Everything is contained within the project folder.

## Setup Instructions

1. **Configure Environment**
   Ensure Python is at `F:\Apps\Python\python.exe` and Node.js at `F:\Apps\NodeJS`.

2. **Initialize Workspace**
   Run the following commands in order:

   ```powershell
   cd F:\Dev\myproject\netload-downloader
   npm config set cache F:\Dev\npm-cache --global
   F:\Apps\Python\python.exe -m venv venv
   .\venv\Scripts\Activate.ps1
   cd backend
   npm install
   npm run download-binaries
   ```

3. **Start Development Server**
   ```powershell
   cd F:\Dev\myproject\netload-downloader
   .\start-dev.ps1
   ```

## Architecture
- **Express API**: REST endpoints for task management and analysis.
- **WebSocket**: Real-time progress updates.
- **SQLite**: Reliable task and settings persistence.
- **Process Manager**: Direct `yt-dlp` orchestration with regex-based progress parsing.
- **Auth Layer**: Netscape `cookies.txt` support with graceful fallbacks.

## API Endpoints
- `POST /api/analyze`: Extract metadata from URL.
- `POST /api/download`: Add URL to download queue.
- `GET /api/tasks`: List all tasks.
- `GET /api/settings`: Get current configuration.
- `GET /api/cookies/status`: Check for `cookies.txt` existence.

## Storage
- **Downloads**: `F:/MediaDownloads`
- **Database**: `backend/database/downloader.db`
- **Logs**: `backend/logs`
- **Temp**: `backend/temp`
