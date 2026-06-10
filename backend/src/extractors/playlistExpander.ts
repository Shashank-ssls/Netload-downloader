import { randomUUID } from 'crypto';
import { YTDLPProcessManager } from '../yt-dlp';
import logger from '../logger';

/**
 * Expands a playlist/channel URL into its individual video URLs using a fast
 * `--flat-playlist` probe. `--yes-playlist` overrides the `--no-playlist` in the
 * base args (yt-dlp takes the last flag), so this only enumerates — it never
 * downloads. Returns [] for a non-playlist URL.
 */
export class PlaylistExpander {
  static async expand(url: string): Promise<string[]> {
    const spawnId = randomUUID();
    try {
      const { stdout } = await YTDLPProcessManager.spawn(spawnId, {
        args: ['--flat-playlist', '--yes-playlist', '-J', url],
        captureStdout: true,
      });
      const info = JSON.parse(stdout);
      if (!Array.isArray(info.entries)) return [];

      const urls: string[] = [];
      for (const e of info.entries) {
        const u = e?.url || e?.webpage_url;
        if (typeof u === 'string' && /^https?:\/\//i.test(u)) urls.push(u);
      }
      logger.info({ url, count: urls.length }, 'Expanded playlist');
      return urls;
    } catch (err: any) {
      logger.warn({ url, err: err.message }, 'Playlist expansion failed');
      return [];
    }
  }
}
