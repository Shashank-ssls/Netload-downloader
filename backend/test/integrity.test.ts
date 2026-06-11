import { describe, it, expect } from 'vitest';
import { parseFfprobeJson, evaluateIntegrity } from '../src/utils/validators';

const probeJson = (streams: { codec_type: string; codec_name?: string }[], duration?: string) =>
  JSON.stringify({ streams, format: duration !== undefined ? { duration } : {} });

describe('parseFfprobeJson', () => {
  it('counts video + audio streams and reads duration', () => {
    const out = parseFfprobeJson(probeJson(
      [{ codec_type: 'video', codec_name: 'h264' }, { codec_type: 'audio', codec_name: 'aac' }],
      '1234.5',
    ));
    expect(out).toEqual({ durationSec: 1234.5, videoStreams: 1, audioStreams: 1, codecs: ['h264', 'aac'] });
  });

  it('handles a video-only file', () => {
    const out = parseFfprobeJson(probeJson([{ codec_type: 'video', codec_name: 'h264' }], '10'));
    expect(out).toMatchObject({ videoStreams: 1, audioStreams: 0 });
  });

  it('leaves duration undefined when absent/unparseable', () => {
    expect(parseFfprobeJson(probeJson([{ codec_type: 'video' }]))?.durationSec).toBeUndefined();
    expect(parseFfprobeJson(probeJson([{ codec_type: 'video' }], 'N/A'))?.durationSec).toBeUndefined();
  });

  it('returns 0/0 for an empty container', () => {
    expect(parseFfprobeJson(probeJson([]))).toMatchObject({ videoStreams: 0, audioStreams: 0 });
  });

  it('returns undefined for unparseable output (broken container)', () => {
    expect(parseFfprobeJson('')).toBeUndefined();
    expect(parseFfprobeJson('not json')).toBeUndefined();
  });
});

describe('evaluateIntegrity', () => {
  const probe = (v: number, a: number, durationSec?: number) => ({ videoStreams: v, audioStreams: a, codecs: [], durationSec });

  it('rejects an unreadable file', () => {
    expect(evaluateIntegrity(undefined)).toMatchObject({ ok: false });
  });

  it('rejects a container with no A/V streams', () => {
    expect(evaluateIntegrity(probe(0, 0)).ok).toBe(false);
  });

  it('requires a video stream when asked (rejects audio-only)', () => {
    expect(evaluateIntegrity(probe(0, 1), { requireVideo: true }).ok).toBe(false);
    expect(evaluateIntegrity(probe(1, 0), { requireVideo: true }).ok).toBe(true);
  });

  it('accepts audio-only when video is not required', () => {
    expect(evaluateIntegrity(probe(0, 1)).ok).toBe(true);
  });

  it('enforces a duration floor when given', () => {
    expect(evaluateIntegrity(probe(1, 1, 30), { requireVideo: true, minDurationSec: 90 }).ok).toBe(false);
    expect(evaluateIntegrity(probe(1, 1, 120), { requireVideo: true, minDurationSec: 90 }).ok).toBe(true);
    expect(evaluateIntegrity(probe(1, 1, undefined), { minDurationSec: 90 }).ok).toBe(false);
  });
});
