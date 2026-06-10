import { BaseProvider, ProviderCapabilities } from './base';

export class HanimeProvider extends BaseProvider {
  name = 'hanime';
  capabilities: ProviderCapabilities = {
    supportsCookies: true,
    supportsM3U8: true,
    requiresReferer: true,
    requiresImpersonation: true,
    retryStrategy: 'exponential'
  };

  match(url: string): boolean {
    return (
      url.includes('hanime.tv') ||
      url.includes('hanime2.org') ||
      url.includes('hentaihaven') ||
      url.includes('hentaistream') ||
      url.includes('hstream.moe')
    );
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
