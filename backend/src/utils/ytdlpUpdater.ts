/**
 * ytdlpUpdater.ts
 *
 * Roadmap #4 — yt-dlp freshness. yt-dlp adds/fixes site extractors almost daily;
 * a stale binary silently loses the cheapest reach of all (native support). The
 * manual `POST /api/update/ytdlp` already exists; this keeps the binary fresh
 * automatically: one throttled update on startup, then weekly.
 *
 * The startup update is throttled by a small marker file so frequent restarts
 * (ts-node-dev respawns, crashes) don't re-hit the network every time. Updates run
 * in the background (non-blocking) and a failure is logged, never fatal — a stale
 * binary still works, it just covers fewer sites.
 */

import fs from 'fs';
import path from 'path';
import { config } from '../config';
import logger from '../logger';
import { safeUpdateYtdlp } from './binaryVersions';

// Marker recording when we last successfully updated, kept next to the binary.
const MARKER_PATH = path.join(path.dirname(config.ytdlpPath), '.ytdlp-last-update.json');

/** Pure: is an update due given the last-update time, now, and the interval? */
export function shouldUpdate(lastAt: number, now: number, intervalMs: number): boolean {
  return now - lastAt >= intervalMs;
}

export class YtdlpUpdater {
  private static timer: NodeJS.Timeout | null = null;

  /** Kick off the startup (throttled) + weekly auto-update schedule. */
  static start(): void {
    if (!config.ytdlpAutoUpdate) {
      logger.info('yt-dlp auto-update disabled (YTDLP_AUTO_UPDATE=false)');
      return;
    }

    if (shouldUpdate(this.lastUpdate(), Date.now(), config.ytdlpUpdateIntervalMs)) {
      void this.runOnce('startup');
    } else {
      const daysAgo = ((Date.now() - this.lastUpdate()) / 86_400_000).toFixed(1);
      logger.info({ daysAgo, channel: config.ytdlpChannel }, 'yt-dlp updated recently — skipping startup update');
    }

    this.timer = setInterval(() => void this.runOnce('scheduled'), config.ytdlpUpdateIntervalMs);
    // Don't keep the process alive just for the update timer.
    this.timer.unref?.();
  }

  static stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private static async runOnce(trigger: string): Promise<void> {
    logger.info({ trigger, channel: config.ytdlpChannel }, 'Running yt-dlp auto-update');
    // Safe update: backs up, smoke-tests, and auto-rolls-back a bad build.
    const result = await safeUpdateYtdlp(config.ytdlpChannel);
    if (result.ok) {
      this.markUpdated();
    } else if (result.rolledBack) {
      // A bad build was rolled back — mark updated so we don't immediately retry
      // the same broken channel build every startup; the weekly tick will retry.
      logger.warn({ output: result.output }, 'yt-dlp update rolled back to last known good');
      this.markUpdated();
    } else {
      // A binary installed via pip/system package can't self-update; that's fine.
      logger.warn({ output: result.output?.slice(0, 200) }, 'yt-dlp auto-update did not succeed (continuing)');
    }
  }

  private static lastUpdate(): number {
    try {
      const at = JSON.parse(fs.readFileSync(MARKER_PATH, 'utf8')).at;
      return typeof at === 'number' ? at : 0;
    } catch {
      return 0;
    }
  }

  private static markUpdated(): void {
    try {
      fs.writeFileSync(MARKER_PATH, JSON.stringify({ at: Date.now() }));
    } catch (err: any) {
      logger.warn({ err: err.message, path: MARKER_PATH }, 'Could not write yt-dlp update marker');
    }
  }
}
