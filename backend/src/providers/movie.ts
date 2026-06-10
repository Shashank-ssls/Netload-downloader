import { BaseProvider, ProviderCapabilities } from './base';

export class MovieProvider extends BaseProvider {
  name = 'movie';
  capabilities: ProviderCapabilities = {
    supportsCookies: false,
    supportsM3U8: true,
    requiresReferer: true,
    requiresImpersonation: true,
    retryStrategy: 'exponential'
  };

  match(url: string): boolean {
    const movieSites = [
      // Embed players
      'dood.watch', 'doodstream', 'filemoon', 'vidplay', 'mixdrop',
      'mp4upload', 'streamwish', 'voe.sx', 'rabbitstream', 'megacloud',
      'vidcloud', 'upstream', 'streamtape', 'gofile', 'sendvid',
      'vidmoly', 'embedsito', 'fembed', 'vidhide', 'streamlare', 'vtube',
      'wishembed', 'uqload', 'supervideo', 'gounlimited', 'waaw',
      // Movie streaming frontends
      'miruro.tv', 'yoyomovies', 'sflix', 'fmovies', 'solarmovie',
      'lookmovie', '123movies', 'gomovies', 'putlocker', 'flixhq',
      'cinezone', 'vumoo', 'soap2day', 'bflix', 'afdah', 'myflixer',
      'tubi.tv', 'pluto.tv',
    ];
    return movieSites.some(site => url.includes(site));
  }

  getSpecificArgs(url: string): string[] {
    return [
      '--extractor-args', 'generic:impersonate',
      '--socket-timeout', '30',
      '--hls-prefer-native',
      '--hls-use-mpegts',
    ];
  }

  getImpersonateTarget(): string | null {
    return 'chrome';
  }

  getFormatStrategy(): string {
    return 'bestvideo+bestaudio/best';
  }
}
