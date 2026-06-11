import { describe, it, expect } from 'vitest';
import {
  tallyResourceTypes,
  mediaRequestsOf,
  deriveHints,
  toHex,
  type DiagRequest,
  type DiagnosticReport,
} from '../src/extractors/diagnostics';

const req = (over: Partial<DiagRequest>): DiagRequest => ({
  url: 'https://x/a', method: 'GET', resourceType: 'xhr', ...over,
});

const emptyPage = (): DiagnosticReport['page'] => ({
  videos: [], playerGlobals: [], mediaSourceUsed: false,
  appendBufferCount: 0, sourceBufferMimes: [], blobUrlCount: 0, iframeChain: [],
});

const baseReport = (over: Partial<Omit<DiagnosticReport, 'hints'>>): Omit<DiagnosticReport, 'hints'> => ({
  url: 'https://x', finalUrl: 'https://x', durationMs: 1000, totalRequests: 0,
  byResourceType: {}, mediaRequests: [], requests: [], page: emptyPage(), ...over,
});

describe('tallyResourceTypes / mediaRequestsOf', () => {
  it('counts by resource type', () => {
    const reqs = [req({ resourceType: 'xhr' }), req({ resourceType: 'xhr' }), req({ resourceType: 'media' })];
    expect(tallyResourceTypes(reqs)).toEqual({ xhr: 2, media: 1 });
  });

  it('selects only requests carrying a media kind', () => {
    const reqs = [req({ mediaKind: 'hls' }), req({}), req({ mediaKind: 'ts' })];
    expect(mediaRequestsOf(reqs).map((r) => r.mediaKind)).toEqual(['hls', 'ts']);
  });
});

describe('toHex', () => {
  it('hex-encodes the first N bytes', () => {
    expect(toHex(Uint8Array.from([0x47, 0x40, 0x00, 0xff]), 3)).toBe('474000');
    expect(toHex(Uint8Array.from([0x00, 0x0a]))).toBe('000a');
  });
});

describe('deriveHints', () => {
  it('reports HLS as downloadable', () => {
    const hints = deriveHints(baseReport({ mediaRequests: [req({ mediaKind: 'hls' })] }));
    expect(hints.join(' ')).toMatch(/HLS manifest/i);
  });

  it('flags DASH as downloadable via ffmpeg (roadmap #3)', () => {
    const hints = deriveHints(baseReport({ mediaRequests: [req({ mediaKind: 'dash' })] }));
    expect(hints.join(' ')).toMatch(/DASH.*ffmpeg|roadmap #3/i);
  });

  it('flags MSE/appendBuffer with no network media as needing interception (roadmap #2)', () => {
    const page = { ...emptyPage(), appendBufferCount: 42, sourceBufferMimes: ['video/mp4; codecs="avc1.4d401f"'] };
    const hints = deriveHints(baseReport({ page, mediaRequests: [] }));
    const joined = hints.join(' ');
    expect(joined).toMatch(/MSE\/appendBuffer/i);
    expect(joined).toMatch(/roadmap #2/i);
    expect(joined).toMatch(/avc1/); // includes the captured mime
  });

  it('flags a blob: video with no network media even without appendBuffer hook hits', () => {
    const page = { ...emptyPage(), videos: [{ src: '', currentSrc: 'blob:https://x/abc', duration: 0, usesBlob: true }] };
    const hints = deriveHints(baseReport({ page, mediaRequests: [] }));
    expect(hints.join(' ')).toMatch(/blob:.*MSE\/Blob|roadmap #2/i);
  });

  it('says nothing-detected when there is no media, MSE, or blob', () => {
    const hints = deriveHints(baseReport({ mediaRequests: [] }));
    expect(hints.join(' ')).toMatch(/No media detected/i);
  });

  it('lists detected player globals', () => {
    const page = { ...emptyPage(), playerGlobals: ['jwplayer', 'Hls'] };
    const hints = deriveHints(baseReport({ page }));
    expect(hints.join(' ')).toMatch(/jwplayer, Hls/);
  });
});
