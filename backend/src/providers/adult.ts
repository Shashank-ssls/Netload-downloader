import { BaseProvider, ProviderCapabilities } from './base';

export class AdultProvider extends BaseProvider {
  name = 'adult';
  capabilities: ProviderCapabilities = {
    supportsCookies: true,
    supportsM3U8: true,
    requiresReferer: true,
    requiresImpersonation: true,
    retryStrategy: 'exponential'
  };

  match(url: string): boolean {
    const adultSites = [
      'pornhub', 'xvideos', 'xnxx', 'spankbang', 'youporn',
      'eporner', 'redtube', 'tube8', 'xhamster', 'tnaflix',
      'porntrex', 'txxx', 'empflix', 'pornone', 'hclips',
      'hardsextube', 'befuck', 'anyporn', 'pornhat',
      'javhd', 'javbus', 'javdb', 'dmm.co.jp',
      'fc2.com', 'caribbeancom', 'heyzo', '1pondo',
      'patreon.com', 'onlyfans.com', 'fansly.com',
      'hanime.tv', 'hanime2.org',
      'mitaku.net', 'iwara.tv', 'kemono.party',
    ];
    return adultSites.some(site => url.includes(site));
  }

  getSpecificArgs(url: string): string[] {
    return [
      '--add-header', 'Referer:https://www.google.com/',
      '--extractor-args', 'generic:impersonate',
      '--age-limit', '99',
      '--hls-prefer-native',
      '--socket-timeout', '30',
    ];
  }

  getImpersonateTarget(): string | null {
    return 'safari:macos';
  }

  getFormatStrategy(): string {
    return 'bestvideo+bestaudio/best';
  }
}
