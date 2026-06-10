import { BaseProvider, ProviderCapabilities } from './base';

export class AnimeProvider extends BaseProvider {
  name = 'anime';
  capabilities: ProviderCapabilities = {
    supportsCookies: false,
    supportsM3U8: true,
    requiresReferer: true,
    requiresImpersonation: true,
    retryStrategy: 'exponential'
  };

  match(url: string): boolean {
    const animeSites = [
      // Streaming frontends
      'miruro.tv', 'miruro.online',
      'gogoanime', 'anitaku', 'gogoanimehd',
      'zoro.to', 'aniwatch.to', 'hianime.to',
      '9anime', 'aniwave.to', 'animepahe',
      'animesuge', 'animefever', 'animeowl',
      'twist.moe', 'allanime', 'kawaiifu',
      'animixplay', '4anime', 'animefreak',
      // Embed players used by anime sites
      'megacloud', 'rabbitstream', 'vidcloud9',
      'rapid-cloud', 'filemoon',
    ];
    return animeSites.some(site => url.includes(site));
  }

  getSpecificArgs(url: string): string[] {
    return [
      '--extractor-args', 'generic:impersonate',
      '--hls-prefer-native',
      '--hls-use-mpegts',
      '--socket-timeout', '30',
    ];
  }

  getImpersonateTarget(): string | null {
    return 'chrome';
  }

  getFormatStrategy(): string {
    return 'bestvideo+bestaudio/best';
  }
}
