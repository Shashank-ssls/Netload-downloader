import { describe, it, expect } from 'vitest';
import { YTDLPProcessManager } from '../src/yt-dlp';

const classify = (s: string) => YTDLPProcessManager.classifyError(s);

describe('YTDLPProcessManager.classifyError', () => {
  it('maps auth-required messages', () => {
    expect(classify('ERROR: Sign in to confirm your age')).toBe('AUTH_REQUIRED');
    expect(classify('This is a Private video')).toBe('AUTH_REQUIRED');
    expect(classify('This video is members only')).toBe('AUTH_REQUIRED');
  });

  it('maps cookie problems', () => {
    expect(classify('Incomplete cookies provided')).toBe('COOKIE_INVALID');
  });

  it('maps missing ffmpeg/ffprobe', () => {
    expect(classify('ffmpeg not found')).toBe('FFMPEG_MISSING');
    expect(classify('ffprobe not found on this system')).toBe('FFMPEG_MISSING');
  });

  it('maps rate limiting', () => {
    expect(classify('HTTP Error 429: Too Many Requests')).toBe('RATE_LIMITED');
    expect(classify('Rate-limited, try again later')).toBe('RATE_LIMITED');
  });

  it('maps geo blocking', () => {
    expect(classify('This video is not available in your country')).toBe('GEO_BLOCKED');
  });

  it('maps timeouts and connection resets', () => {
    expect(classify('The read operation timed out')).toBe('NETWORK_TIMEOUT');
    expect(classify('Connection reset by peer')).toBe('CONNECTION_RESET');
    expect(classify('RemoteDisconnected: Remote end closed connection')).toBe('CONNECTION_RESET');
  });

  it('maps curl/SSL transient connection failures (the pornhub cold-start flake)', () => {
    expect(classify('ERROR: [PornHub] x: Unable to download webpage: Failed to perform, curl: (35) Recv failure: Connection was reset')).toBe('CONNECTION_RESET');
    expect(classify('curl: (56) Recv failure')).toBe('CONNECTION_RESET');
    expect(classify('curl: (52) Empty reply from server')).toBe('CONNECTION_RESET');
  });

  it('maps Cloudflare / 403', () => {
    expect(classify('Just a moment... cf-browser-verification')).toBe('CLOUDFLARE_BLOCKED');
    expect(classify('HTTP Error 403: Forbidden')).toBe('CLOUDFLARE_BLOCKED');
  });

  it('distinguishes dynamic-content fallback from plain unsupported URL', () => {
    expect(
      classify('Unsupported URL\nFalling back on generic information extractor'),
    ).toBe('DYNAMIC_CONTENT_UNSUPPORTED');
    expect(classify('ERROR: Unsupported URL: https://x.test')).toBe('UNSUPPORTED_URL');
    expect(classify('Unable to extract video data')).toBe('UNSUPPORTED_URL');
  });

  it('maps format unavailable and video unavailable', () => {
    expect(classify('Requested format is not available')).toBe('FORMAT_UNAVAILABLE');
    expect(classify('Video unavailable. This video has been removed')).toBe('VIDEO_UNAVAILABLE');
  });

  it('falls back to DOWNLOAD_FAILED then UNKNOWN_ERROR', () => {
    expect(classify('ERROR: something odd happened')).toBe('DOWNLOAD_FAILED');
    expect(classify('just a normal progress line')).toBe('UNKNOWN_ERROR');
  });
});
