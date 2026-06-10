import { BaseProvider, ProviderCapabilities } from './base';

export class GenericProvider extends BaseProvider {
  name = 'generic';
  capabilities: ProviderCapabilities = {
    supportsCookies: true,
    supportsM3U8: true,
    requiresReferer: false,
    requiresImpersonation: true,
    retryStrategy: 'immediate'
  };

  match(url: string): boolean {
    return true; // Match everything else
  }

  getSpecificArgs(url: string): string[] {
    return [
      '--extractor-args', 'generic:impersonate'
    ];
  }

  getImpersonateTarget(): string | null {
    return 'safari:macos';
  }

  getFormatStrategy(): string {
    return 'bestvideo+bestaudio/best';
  }
}
