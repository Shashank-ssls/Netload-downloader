import { describe, it, expect } from 'vitest';
import { DashDownloader, parseProbeStreams, planDashMaps, parseDashSubtitleTracks, type DashStream } from '../src/extractors/dashDownloader';

const s = (over: Partial<DashStream>): DashStream =>
  ({ index: 0, type: 'video', lang: 'und', bitrate: 0, pixels: 0, ...over });

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

describe('parseProbeStreams', () => {
  it('flattens ffprobe -show_streams JSON, reading type / language / bitrate / pixels', () => {
    const json = JSON.stringify({
      streams: [
        { index: 0, codec_type: 'video', width: 1920, height: 1080, bit_rate: '5000000' },
        { index: 1, codec_type: 'audio', tags: { language: 'eng' }, bit_rate: '128000' },
        { index: 2, codec_type: 'subtitle', tags: { language: 'Eng' } },
        { index: 3, codec_type: 'data' },
      ],
    });
    expect(parseProbeStreams(json)).toEqual([
      { index: 0, type: 'video', lang: 'und', bitrate: 5000000, pixels: 1920 * 1080 },
      { index: 1, type: 'audio', lang: 'eng', bitrate: 128000, pixels: 0 },
      { index: 2, type: 'subtitle', lang: 'eng', bitrate: 0, pixels: 0 },
      { index: 3, type: 'other', lang: 'und', bitrate: 0, pixels: 0 },
    ]);
  });
  it('returns [] on malformed or empty JSON', () => {
    expect(parseProbeStreams('not json')).toEqual([]);
    expect(parseProbeStreams('{}')).toEqual([]);
  });
});

describe('planDashMaps', () => {
  it('picks the best video, one best audio per language, and all subtitle tracks', () => {
    const plan = planDashMaps([
      s({ index: 0, type: 'video', pixels: 1280 * 720, bitrate: 2_000_000 }),
      s({ index: 1, type: 'video', pixels: 1920 * 1080, bitrate: 5_000_000 }), // best video
      s({ index: 2, type: 'audio', lang: 'eng', bitrate: 128_000 }),
      s({ index: 3, type: 'audio', lang: 'eng', bitrate: 256_000 }),           // best eng audio
      s({ index: 4, type: 'audio', lang: 'jpn', bitrate: 192_000 }),
      s({ index: 5, type: 'subtitle', lang: 'eng' }),
      s({ index: 6, type: 'subtitle', lang: 'jpn' }),
    ]);
    expect(plan.videoIndex).toBe(1);
    expect(plan.audioTracks).toEqual([{ index: 3, lang: 'eng' }, { index: 4, lang: 'jpn' }]);
    expect(plan.subtitleTracks).toEqual([{ index: 5, lang: 'eng' }, { index: 6, lang: 'jpn' }]);
  });
  it('handles a single untagged audio + no subs (degrades to default-like selection)', () => {
    const plan = planDashMaps([
      s({ index: 0, type: 'video', pixels: 1280 * 720 }),
      s({ index: 1, type: 'audio', lang: 'und', bitrate: 128_000 }),
    ]);
    expect(plan.videoIndex).toBe(0);
    expect(plan.audioTracks).toEqual([{ index: 1, lang: 'und' }]);
    expect(plan.subtitleTracks).toEqual([]);
  });
  it('returns null video index when there are no video streams', () => {
    expect(planDashMaps([s({ index: 0, type: 'audio', lang: 'und' })]).videoIndex).toBeNull();
  });
});

describe('parseDashSubtitleTracks', () => {
  const manifest = 'https://cdn.test/dash264/TestCases/4b/q/1/movie_Subtitles.mpd';

  it('extracts ttml text AdaptationSets and resolves each BaseURL file against the manifest', () => {
    const mpd =
      '<MPD><Period>' +
      '<AdaptationSet mimeType="video/mp4"><Representation id="1"><BaseURL>v.mp4</BaseURL></Representation></AdaptationSet>' +
      '<AdaptationSet mimeType="application/ttml+xml" lang="en"><Role schemeIdUri="urn:mpeg:dash:role:2011" value="subtitle"/>' +
      '<Representation id="7"><BaseURL>English_track.xml</BaseURL></Representation></AdaptationSet>' +
      '<AdaptationSet mimeType="application/ttml+xml" lang="de"><Representation id="8"><BaseURL>German_track.xml</BaseURL></Representation></AdaptationSet>' +
      '</Period></MPD>';
    expect(parseDashSubtitleTracks(mpd, manifest)).toEqual([
      { lang: 'en', uri: 'https://cdn.test/dash264/TestCases/4b/q/1/English_track.xml' },
      { lang: 'de', uri: 'https://cdn.test/dash264/TestCases/4b/q/1/German_track.xml' },
    ]);
  });

  it('detects a text track by contentType / codecs (wvtt) and honours a top-level BaseURL', () => {
    const mpd =
      '<MPD><BaseURL>https://subs.cdn/base/</BaseURL><Period>' +
      '<AdaptationSet contentType="text" lang="fr"><Representation codecs="wvtt"><BaseURL>fr.vtt</BaseURL></Representation></AdaptationSet>' +
      '</Period></MPD>';
    expect(parseDashSubtitleTracks(mpd, manifest)).toEqual([
      { lang: 'fr', uri: 'https://subs.cdn/base/fr.vtt' },
    ]);
  });

  it('ignores audio/video sets and returns [] when there are no text tracks', () => {
    const mpd = '<MPD><AdaptationSet mimeType="audio/mp4" lang="en"><Representation><BaseURL>a.mp4</BaseURL></Representation></AdaptationSet></MPD>';
    expect(parseDashSubtitleTracks(mpd, manifest)).toEqual([]);
    expect(parseDashSubtitleTracks('', manifest)).toEqual([]);
  });
});
