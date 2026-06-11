import { describe, it, expect } from 'vitest';
import { DashDownloader } from '../src/extractors/dashDownloader';

describe('DashDownloader.isDashUrl', () => {
  it('matches a .mpd manifest URL, with or without a query', () => {
    expect(DashDownloader.isDashUrl('https://cdn.test/video/manifest.mpd')).toBe(true);
    expect(DashDownloader.isDashUrl('https://cdn.test/v/x.mpd?token=abc&t=1')).toBe(true);
    expect(DashDownloader.isDashUrl('https://cdn.test/MANIFEST.MPD')).toBe(true);
  });

  it('does not match HLS / progressive / opaque URLs', () => {
    expect(DashDownloader.isDashUrl('https://cdn.test/master.m3u8')).toBe(false);
    expect(DashDownloader.isDashUrl('https://cdn.test/video.mp4')).toBe(false);
    expect(DashDownloader.isDashUrl('https://cdn.test/stream/abc123')).toBe(false);
    // ".mpd" only counts as the path extension, not anywhere in the URL
    expect(DashDownloader.isDashUrl('https://cdn.test/x.mpd.ts')).toBe(false);
  });
});
