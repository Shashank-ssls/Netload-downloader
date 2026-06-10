import { describe, it, expect } from 'vitest';
import { inferRecoveryHeaders } from '../src/providers/inference';

describe('inferRecoveryHeaders', () => {
  it('adds a self-referer + origin on a forbidden/blocked error with no referer', () => {
    expect(inferRecoveryHeaders('CLOUDFLARE_BLOCKED', 'https://cdn.test/stream/x.m3u8', false)).toEqual({
      Referer: 'https://cdn.test/',
      Origin: 'https://cdn.test',
    });
    expect(inferRecoveryHeaders('DOWNLOAD_FAILED', 'https://h.test/v', false)).toEqual({
      Referer: 'https://h.test/',
      Origin: 'https://h.test',
    });
  });

  it('returns null once a referer is already set (one-shot, no repeats)', () => {
    expect(inferRecoveryHeaders('CLOUDFLARE_BLOCKED', 'https://cdn.test/x', true)).toBeNull();
  });

  it('returns null for non-forbidden error types', () => {
    expect(inferRecoveryHeaders('NETWORK_TIMEOUT', 'https://cdn.test/x', false)).toBeNull();
    expect(inferRecoveryHeaders('VIDEO_UNAVAILABLE', 'https://cdn.test/x', false)).toBeNull();
    expect(inferRecoveryHeaders('RATE_LIMITED', 'https://cdn.test/x', false)).toBeNull();
  });

  it('returns null on an unparseable URL', () => {
    expect(inferRecoveryHeaders('CLOUDFLARE_BLOCKED', 'not a url', false)).toBeNull();
  });
});
