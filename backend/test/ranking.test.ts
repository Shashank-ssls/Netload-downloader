import { describe, it, expect } from 'vitest';
import {
  FallbackExtractor,
  DURATION_FLOOR_SEC,
  BYTES_FLOOR,
} from '../src/extractors/fallbackExtractor';
import type { CapturedStream, StreamMagnitude } from '../src/types';

const stream = (url: string, magnitude?: StreamMagnitude): CapturedStream => ({
  url,
  referer: '',
  userAgent: '',
  headers: {},
  magnitude,
});

describe('FallbackExtractor.scoreStream', () => {
  it('ranks manifest types above progressive mp4', () => {
    expect(FallbackExtractor.scoreStream('https://x/master.m3u8')).toBe(100);
    expect(FallbackExtractor.scoreStream('https://x/index.m3u8')).toBe(90);
    expect(FallbackExtractor.scoreStream('https://x/playlist.m3u8')).toBe(90);
    expect(FallbackExtractor.scoreStream('https://x/v.m3u8')).toBe(80);
    expect(FallbackExtractor.scoreStream('https://x/v.mpd')).toBe(70);
    expect(FallbackExtractor.scoreStream('https://x/v.mp4')).toBe(40);
  });

  it('heavily penalises ad hosts and placeholder keywords', () => {
    expect(FallbackExtractor.scoreStream('https://adtng.com/creatives/x.mp4')).toBeLessThanOrEqual(-100);
    expect(FallbackExtractor.scoreStream('https://x/preview.mp4')).toBe(40 - 90);
    expect(FallbackExtractor.scoreStream('https://x/black_screen.mp4')).toBe(40 - 90);
  });
});

describe('FallbackExtractor.parseIso8601Duration', () => {
  it('parses HMS and day components', () => {
    expect(FallbackExtractor.parseIso8601Duration('PT24M10S')).toBe(1450);
    expect(FallbackExtractor.parseIso8601Duration('PT1H2M3S')).toBe(3723);
    expect(FallbackExtractor.parseIso8601Duration('P1DT0H0M0S')).toBe(86400);
  });

  it('returns undefined for garbage', () => {
    expect(FallbackExtractor.parseIso8601Duration('nope')).toBeUndefined();
  });
});

describe('FallbackExtractor.isAboveFloor / isMeasured', () => {
  it('applies duration and byte floors', () => {
    expect(FallbackExtractor.isAboveFloor({ durationSec: DURATION_FLOOR_SEC, isManifest: true })).toBe(true);
    expect(FallbackExtractor.isAboveFloor({ durationSec: DURATION_FLOOR_SEC - 1, isManifest: true })).toBe(false);
    expect(FallbackExtractor.isAboveFloor({ bytes: BYTES_FLOOR, isManifest: false })).toBe(true);
    expect(FallbackExtractor.isAboveFloor({ bytes: BYTES_FLOOR - 1, isManifest: false })).toBe(false);
    expect(FallbackExtractor.isAboveFloor(undefined)).toBe(false);
  });

  it('treats a zero-but-present measurement as measured', () => {
    expect(FallbackExtractor.isMeasured({ durationSec: 0, isManifest: true })).toBe(true);
    expect(FallbackExtractor.isMeasured({ isManifest: true })).toBe(false);
  });
});

describe('FallbackExtractor.candidateRank', () => {
  it('orders: full manifest > big file > unmeasured > tiny preview > ad host', () => {
    const fullManifest = stream('https://x/master.m3u8', { durationSec: 971, isManifest: true });
    const bigFile = stream('https://x/v.mp4', { bytes: 200 * 1024 * 1024, isManifest: false });
    const unmeasured = stream('https://embed.x/iframe'); // no magnitude
    const tinyPreview = stream('https://x/preview.mp4', { bytes: 2 * 1024 * 1024, isManifest: false });
    const adHost = stream('https://adtng.com/creatives/ad.mp4', { bytes: 500 * 1024, isManifest: false });

    const ranked = [tinyPreview, adHost, unmeasured, bigFile, fullManifest]
      .sort((a, b) => FallbackExtractor.candidateRank(b) - FallbackExtractor.candidateRank(a))
      .map((c) => c.url);

    expect(ranked[0]).toBe(fullManifest.url);
    expect(ranked[1]).toBe(bigFile.url);
    expect(ranked[2]).toBe(unmeasured.url);
    expect(ranked[ranked.length - 1]).toBe(adHost.url);
  });
});
