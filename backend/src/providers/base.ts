import { AnalysisResult } from '../types';

export interface ProviderCapabilities {
  supportsCookies: boolean;
  supportsM3U8: boolean;
  requiresReferer: boolean;
  requiresImpersonation: boolean;
  retryStrategy: 'exponential' | 'immediate' | 'none';
}

export abstract class BaseProvider {
  abstract readonly name: string;
  abstract readonly capabilities: ProviderCapabilities;

  abstract match(url: string): boolean;
  
  // Return specific yt-dlp arguments for this provider
  abstract getSpecificArgs(url: string): string[];

  // Return impersonation target (e.g. 'chrome', 'safari')
  getImpersonateTarget(): string | null {
    return null; // Default to no impersonation
  }

  // Return specific format strategy
  abstract getFormatStrategy(): string;

  // Optional: Provider-specific error mapping
  classifyError(stderr: string): string | null {
    return null; // Fallback to default
  }
}
