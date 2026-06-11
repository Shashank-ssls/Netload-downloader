import { describe, it, expect } from 'vitest';
import { SegmentStitcher } from '../src/extractors/segmentStitcher';

const MASTER = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="subs/en.m3u8"',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Spanish",LANGUAGE="es",DEFAULT=NO,URI="subs/es.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Japanese",LANGUAGE="ja",DEFAULT=YES,URI="audio/ja.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud2",NAME="Muxed",DEFAULT=NO',  // no URI → skipped
  '#EXT-X-STREAM-INF:BANDWIDTH=5000000,SUBTITLES="subs",AUDIO="aud"',
  '1080/index.m3u8',
].join('\n');

describe('SegmentStitcher.parseMediaRenditions', () => {
  it('extracts subtitle tracks with absolute URIs', () => {
    const subs = SegmentStitcher.parseMediaRenditions(MASTER, 'https://cdn.test/stream/', 'SUBTITLES');
    expect(subs).toEqual([
      { lang: 'en', name: 'English', uri: 'https://cdn.test/stream/subs/en.m3u8', isDefault: true },
      { lang: 'es', name: 'Spanish', uri: 'https://cdn.test/stream/subs/es.m3u8', isDefault: false },
    ]);
  });

  it('extracts audio renditions, skipping muxed-in ones with no URI', () => {
    const audio = SegmentStitcher.parseMediaRenditions(MASTER, 'https://cdn.test/stream/', 'AUDIO');
    expect(audio).toEqual([
      { lang: 'ja', name: 'Japanese', uri: 'https://cdn.test/stream/audio/ja.m3u8', isDefault: true },
    ]);
  });

  it('returns [] when there are no renditions of that type', () => {
    expect(SegmentStitcher.parseMediaRenditions('#EXTM3U\n#EXTINF:8,\nseg0.ts', 'https://b/', 'SUBTITLES')).toEqual([]);
  });
});

describe('SegmentStitcher.pickDefaultRendition', () => {
  it('prefers the DEFAULT=YES rendition, else the first', () => {
    const subs = SegmentStitcher.parseMediaRenditions(MASTER, 'https://cdn.test/stream/', 'SUBTITLES');
    expect(SegmentStitcher.pickDefaultRendition(subs)?.lang).toBe('en');
    expect(SegmentStitcher.pickDefaultRendition([{ lang: 'x', name: '', uri: 'u', isDefault: false }])?.lang).toBe('x');
    expect(SegmentStitcher.pickDefaultRendition([])).toBeUndefined();
  });
});
