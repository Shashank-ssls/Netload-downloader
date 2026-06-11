/**
 * standalone-bootstrap.ts
 *
 * MUST be imported FIRST by standalone.ts (before config/database/browser modules),
 * because it sets environment variables that those modules read at import time.
 *
 * When running from the PORTABLE bundle, point every data + binary dir at the folder
 * that holds netload.exe, so the whole thing is self-contained and writes
 * downloads/cookies/db next to itself rather than into some random CWD. In a normal
 * dev run this is a no-op — config's repo-relative defaults apply.
 *
 * The portable launcher (netload.exe) sets NETLOAD_HOME to its own directory before
 * starting node; we also honour pkg/SEA in case of a future single-file build.
 *
 * Expected portable layout (next to netload.exe):
 *   netload.exe   thin launcher → runtime\node.exe app\standalone.js
 *   bin/          yt-dlp.exe, ffmpeg.exe, ffprobe.exe
 *   chromium/     the Playwright Chromium browser (PLAYWRIGHT_BROWSERS_PATH)
 *   downloads/    finished files
 *   data/         db, cookies, profiles, temp, logs (created on first run)
 */

import path from 'path';

const home = process.env.NETLOAD_HOME;
const packaged = !!home || !!(process as { pkg?: unknown }).pkg || !!(process as { isSEA?: unknown }).isSEA;

if (packaged) {
  const baseDir = home ? path.resolve(home) : path.dirname(process.execPath);
  const set = (k: string, v: string) => { if (!process.env[k]) process.env[k] = v; };

  set('YTDLP_PATH', path.join(baseDir, 'bin', 'yt-dlp.exe'));
  set('FFMPEG_PATH', path.join(baseDir, 'bin')); // dir holding ffmpeg.exe / ffprobe.exe
  set('PLAYWRIGHT_BROWSERS_PATH', path.join(baseDir, 'chromium'));
  set('STORAGE_PATH', path.join(baseDir, 'downloads'));
  set('DATABASE_PATH', path.join(baseDir, 'data', 'netload.db'));
  set('TEMP_PATH', path.join(baseDir, 'data', 'temp'));
  set('COOKIES_DIR', path.join(baseDir, 'data', 'cookies'));
  set('COOKIES_PATH', path.join(baseDir, 'data', 'cookies', 'cookies.txt'));
  set('PROFILES_DIR', path.join(baseDir, 'data', 'profiles'));
  set('LOG_PATH', path.join(baseDir, 'data', 'logs'));
  // Keep stdout clean for the prompt UX — only warnings/errors, no INFO chatter.
  set('LOG_LEVEL', 'warn');
  // yt-dlp self-update writes into its own dir; harmless but skip it for an end-user exe.
  set('YTDLP_AUTO_UPDATE', 'false');
}

export {};
