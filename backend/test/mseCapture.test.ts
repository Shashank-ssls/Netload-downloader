import { describe, it, expect } from 'vitest';
import { classifyTrack, buildMuxArgs, type TrackKind } from '../src/extractors/mseCapture';

describe('classifyTrack', () => {
  it('classifies a video-only SourceBuffer', () => {
    expect(classifyTrack('video/mp4; codecs="avc1.4d401f"')).toBe('video');
    expect(classifyTrack('video/mp4; codecs="hev1.1.6.L93.B0"')).toBe('video');
    expect(classifyTrack('video/webm; codecs="vp9"')).toBe('video');
    expect(classifyTrack('video/mp4; codecs="av01.0.05M.08"')).toBe('video');
  });

  it('classifies an audio-only SourceBuffer', () => {
    expect(classifyTrack('audio/mp4; codecs="mp4a.40.2"')).toBe('audio');
    expect(classifyTrack('audio/webm; codecs="opus"')).toBe('audio');
    expect(classifyTrack('audio/mp4; codecs="ec-3"')).toBe('audio');
  });

  it('classifies a muxed SourceBuffer carrying both codecs', () => {
    expect(classifyTrack('video/mp4; codecs="avc1.4d401f, mp4a.40.2"')).toBe('muxed');
    expect(classifyTrack('video/mp4; codecs="avc1.640028,mp4a.40.5"')).toBe('muxed');
  });

  it('falls back to the mime type when codecs are absent', () => {
    expect(classifyTrack('video/mp4')).toBe('video');
    expect(classifyTrack('audio/mp4')).toBe('audio');
  });

  it('returns other for unknown/empty mimes', () => {
    expect(classifyTrack('')).toBe('other');
    expect(classifyTrack('application/octet-stream')).toBe('other');
  });
});

describe('buildMuxArgs', () => {
  const out = 'C:/out/x.mp4';

  it('remuxes a single muxed track', () => {
    const args = buildMuxArgs([{ path: 'a.mp4', kind: 'muxed' }], out);
    expect(args).toEqual(['-y', '-i', 'a.mp4', '-map', '0', '-c', 'copy', out]);
  });

  it('orders video before audio and maps every input', () => {
    const inputs: { path: string; kind: TrackKind }[] = [
      { path: 'audio.mp4', kind: 'audio' },
      { path: 'video.mp4', kind: 'video' },
    ];
    const args = buildMuxArgs(inputs, out);
    // video input first, audio second, both mapped
    expect(args).toEqual([
      '-y', '-i', 'video.mp4', '-i', 'audio.mp4',
      '-map', '0', '-map', '1', '-c', 'copy', out,
    ]);
  });

  it('puts other-kind tracks last', () => {
    const inputs: { path: string; kind: TrackKind }[] = [
      { path: 'misc.mp4', kind: 'other' },
      { path: 'audio.mp4', kind: 'audio' },
      { path: 'video.mp4', kind: 'video' },
    ];
    const args = buildMuxArgs(inputs, out);
    const order = args.filter((a) => a.endsWith('.mp4') && a !== out);
    expect(order).toEqual(['video.mp4', 'audio.mp4', 'misc.mp4']);
  });
});
