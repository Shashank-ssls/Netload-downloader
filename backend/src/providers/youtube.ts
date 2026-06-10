import { BaseProvider, ProviderCapabilities } from './base';

export class YouTubeProvider extends BaseProvider {
  name = 'youtube';
  capabilities: ProviderCapabilities = {
    supportsCookies: true,
    supportsM3U8: true,
    requiresReferer: false,
    requiresImpersonation: false,
    retryStrategy: 'exponential'
  };

  match(url: string): boolean {
    return url.includes('youtube.com') || url.includes('youtu.be');
  }

  getSpecificArgs(url: string): string[] {
    return [
      '--extractor-args', 'youtube:player_client=android_vr,web',
      '--socket-timeout', '30'
    ];
  }

  getFormatStrategy(): string {
    return 'bestvideo+bestaudio/best';
  }
}
