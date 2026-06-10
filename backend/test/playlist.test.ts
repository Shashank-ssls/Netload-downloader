import { describe, it, expect } from 'vitest';
import { SegmentStitcher } from '../src/extractors/segmentStitcher';
import type { CapturedStream } from '../src/types';

const seg = (url: string, isManifest = false, bytes?: number): CapturedStream => ({
  url,
  referer: '',
  userAgent: '',
  headers: {},
  magnitude: { isManifest, ...(bytes !== undefined ? { bytes } : {}) },
});

const SMALL = 1.3 * 1024 * 1024; // chunk-sized
const LARGE = 200 * 1024 * 1024; // full progressive file

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

describe('SegmentStitcher.normalizePlaylist', () => {
  const base = 'https://cdn.test/stream/';

  it('rewrites relative segment URIs to absolute', () => {
    const out = SegmentStitcher.normalizePlaylist('#EXTM3U\n#EXTINF:8,\nseg0.ts\n', base);
    expect(out).toContain('https://cdn.test/stream/seg0.ts');
  });

  it('rewrites the #EXT-X-KEY URI (AES-128) to absolute and keeps other attrs', () => {
    const pl = '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x123\n';
    const out = SegmentStitcher.normalizePlaylist(pl, base);
    expect(out).toContain('URI="https://cdn.test/stream/key.bin"');
    expect(out).toContain('METHOD=AES-128');
    expect(out).toContain('IV=0x123');
  });

  it('rewrites the #EXT-X-MAP init-segment URI (fMP4)', () => {
    const out = SegmentStitcher.normalizePlaylist('#EXT-X-MAP:URI="init.mp4"\n', base);
    expect(out).toContain('URI="https://cdn.test/stream/init.mp4"');
  });

  it('leaves absolute URIs and non-URI tags untouched', () => {
    const pl = '#EXTM3U\n#EXT-X-TARGETDURATION:9\n#EXTINF:8,\nhttps://other.test/a.ts\n';
    const out = SegmentStitcher.normalizePlaylist(pl, base);
    expect(out).toContain('https://other.test/a.ts');
    expect(out).toContain('#EXT-X-TARGETDURATION:9');
  });
});

describe('SegmentStitcher.needsFfmpeg', () => {
  it('is true for AES-128 / SAMPLE-AES encrypted playlists', () => {
    expect(SegmentStitcher.needsFfmpeg('#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:8,\na.ts')).toBe(true);
    expect(SegmentStitcher.needsFfmpeg('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k"\n')).toBe(true);
  });

  it('is true for fMP4 (#EXT-X-MAP init segment)', () => {
    expect(SegmentStitcher.needsFfmpeg('#EXT-X-MAP:URI="init.mp4"\n#EXTINF:8,\na.m4s')).toBe(true);
  });

  it('is false for plain MPEG-TS (no key/map, or METHOD=NONE)', () => {
    expect(SegmentStitcher.needsFfmpeg('#EXTM3U\n#EXTINF:8,\nseg0.ts\n#EXTINF:8,\nseg1.ts')).toBe(false);
    expect(SegmentStitcher.needsFfmpeg('#EXT-X-KEY:METHOD=NONE\n#EXTINF:8,\nseg0.ts')).toBe(false);
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

  it('ignores manifests and returns null below the threshold (unmeasured)', () => {
    const candidates = [
      seg('https://prox.test/stream/aaa'),
      seg('https://prox.test/stream/bbb'),
      seg('https://prox.test/master.m3u8', true),
    ];
    expect(SegmentStitcher.looksLikeSegmentRun(candidates)).toBeNull();
  });

  it('triggers on a SINGLE chunk-sized same-dir candidate (rate-limited Tier-2)', () => {
    const candidates = [seg('https://prox.test/stream/aaa', false, SMALL)];
    expect(SegmentStitcher.looksLikeSegmentRun(candidates)).toBe('https://prox.test/stream/');
  });

  it('does NOT trigger on a lone large (progressive) candidate', () => {
    const candidates = [seg('https://cdn.test/videos/movie.mp4', false, LARGE)];
    expect(SegmentStitcher.looksLikeSegmentRun(candidates)).toBeNull();
  });

  it('triggers on 3+ same-dir siblings even when unmeasured', () => {
    const candidates = [
      seg('https://prox.test/stream/a'),
      seg('https://prox.test/stream/b'),
      seg('https://prox.test/stream/c'),
    ];
    expect(SegmentStitcher.looksLikeSegmentRun(candidates)).toBe('https://prox.test/stream/');
  });
});
