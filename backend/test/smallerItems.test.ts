import { describe, it, expect } from 'vitest';
import { FallbackExtractor } from '../src/extractors/fallbackExtractor';
import { CloudflareRecoveryManager } from '../src/recovery/cloudflare';

describe('FallbackExtractor.pickBestVariant (master playlist follow)', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
    '360/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720',
    '720/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080',
    'https://cdn.test/abs/1080/index.m3u8',
  ].join('\n');

  it('returns the highest-bandwidth variant, resolved absolute', () => {
    expect(FallbackExtractor.pickBestVariant(master, 'https://cdn.test/stream/')).toBe('https://cdn.test/abs/1080/index.m3u8');
  });

  it('resolves a relative variant URI against the base', () => {
    const twoRel = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000',
      '360/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=2500000',
      '720/index.m3u8',
    ].join('\n');
    expect(FallbackExtractor.pickBestVariant(twoRel, 'https://cdn.test/stream/')).toBe('https://cdn.test/stream/720/index.m3u8');
  });

  it('returns undefined when there is no variant URI', () => {
    expect(FallbackExtractor.pickBestVariant('#EXTM3U\n', 'https://cdn.test/stream/')).toBeUndefined();
  });
});

describe('CloudflareRecoveryManager.cycleImpersonateTarget', () => {
  it('uses the provider default on the first attempt', () => {
    expect(CloudflareRecoveryManager.cycleImpersonateTarget(1, 'safari:macos')).toBe('safari:macos');
    expect(CloudflareRecoveryManager.cycleImpersonateTarget(1, null)).toBeNull();
  });

  it('rotates through distinct fingerprints on retries', () => {
    const rot = CloudflareRecoveryManager.IMPERSONATE_ROTATION;
    expect(CloudflareRecoveryManager.cycleImpersonateTarget(2, 'safari:macos')).toBe(rot[0]);
    expect(CloudflareRecoveryManager.cycleImpersonateTarget(3, 'safari:macos')).toBe(rot[1]);
    expect(CloudflareRecoveryManager.cycleImpersonateTarget(4, 'safari:macos')).toBe(rot[2]);
    // wraps around
    expect(CloudflareRecoveryManager.cycleImpersonateTarget(2 + rot.length, 'safari:macos')).toBe(rot[0]);
  });
});

describe('CloudflareRecoveryManager.genericExtractorArgs', () => {
  it('forces the generic extractor with impersonation', () => {
    expect(CloudflareRecoveryManager.genericExtractorArgs()).toEqual([
      '--force-generic-extractor', '--extractor-args', 'generic:impersonate',
    ]);
  });
});
