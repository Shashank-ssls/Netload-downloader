import { describe, it, expect } from 'vitest';
import { SegmentStitcher } from '../src/extractors/segmentStitcher';
import type { CapturedStream } from '../src/types';

const seg = (url: string, isManifest = false): CapturedStream => ({
  url,
  referer: '',
  userAgent: '',
  headers: {},
  magnitude: { isManifest },
});

describe('SegmentStitcher.dirPrefix', () => {
  it('returns origin + directory', () => {
    expect(SegmentStitcher.dirPrefix('https://h.test/stream/abc123')).toBe('https://h.test/stream/');
    expect(SegmentStitcher.dirPrefix('https://h.test/a/b/c.ts')).toBe('https://h.test/a/b/');
  });

  it('returns null for a non-URL', () => {
    expect(SegmentStitcher.dirPrefix('garbage')).toBeNull();
  });
});

describe('SegmentStitcher.resolveSegUrl', () => {
  it('passes through absolute URLs', () => {
    expect(SegmentStitcher.resolveSegUrl('https://h/x.ts', 'https://b/d/')).toBe('https://h/x.ts');
  });
  it('upgrades protocol-relative URLs', () => {
    expect(SegmentStitcher.resolveSegUrl('//h/x.ts', 'https://b/d/')).toBe('https://h/x.ts');
  });
  it('resolves relative URIs against the base hint', () => {
    expect(SegmentStitcher.resolveSegUrl('seg5.ts', 'https://b/stream/')).toBe('https://b/stream/seg5.ts');
  });
});

describe('SegmentStitcher.parsePlaylist', () => {
  it('returns null when there are no #EXTINF lines (e.g. a master playlist)', () => {
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nvariant.m3u8\n';
    expect(SegmentStitcher.parsePlaylist(master, 'https://b/')).toBeNull();
  });

  it('parses a media playlist into ordered segments + total duration', () => {
    const media = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:9',
      '#EXTINF:8.8,',
      'https://cdn/seg0.ts',
      '#EXTINF:8.8,',
      'seg1.ts',
      '#EXT-X-ENDLIST',
    ].join('\n');
    const out = SegmentStitcher.parsePlaylist(media, 'https://cdn/stream/');
    expect(out).not.toBeNull();
    expect(out!.segments).toEqual(['https://cdn/seg0.ts', 'https://cdn/stream/seg1.ts']);
    expect(out!.durationSec).toBeCloseTo(17.6, 5);
  });
});

describe('SegmentStitcher.looksLikeSegmentRun', () => {
  it('detects 4+ sibling non-manifest chunks and returns their directory prefix', () => {
    const candidates = [
      seg('https://prox.test/stream/aaa'),
      seg('https://prox.test/stream/bbb'),
      seg('https://prox.test/stream/ccc'),
      seg('https://prox.test/stream/ddd'),
    ];
    expect(SegmentStitcher.looksLikeSegmentRun(candidates)).toBe('https://prox.test/stream/');
  });

  it('ignores manifests and returns null below the threshold', () => {
    const candidates = [
      seg('https://prox.test/stream/aaa'),
      seg('https://prox.test/stream/bbb'),
      seg('https://prox.test/master.m3u8', true),
    ];
    expect(SegmentStitcher.looksLikeSegmentRun(candidates)).toBeNull();
  });
});
