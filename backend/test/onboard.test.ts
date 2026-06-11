import { describe, it, expect } from 'vitest';
import { suggestOnboarding, suggestFixtureExpect, hostOfUrl } from '../src/corpus/onboard';

const URL = 'https://www.NewSite.tv/watch/123';

describe('hostOfUrl', () => {
  it('strips www and lowercases', () => {
    expect(hostOfUrl(URL)).toBe('newsite.tv');
    expect(hostOfUrl('garbage')).toBe('');
  });
});

describe('suggestFixtureExpect', () => {
  it('maps analyze outcomes to expectations', () => {
    expect(suggestFixtureExpect({ requiresAuth: true })).toBe('auth');
    expect(suggestFixtureExpect({ isLikelyPreview: true })).toBe('preview');
    expect(suggestFixtureExpect({})).toBe('resolve');
    expect(suggestFixtureExpect({ title: 'V', duration: 600 })).toEqual({ outcome: 'ok', minDurationSec: 480 });
  });
});

describe('suggestOnboarding', () => {
  it('proposes NO rule when the site already resolves', () => {
    const s = suggestOnboarding(URL, undefined, {}, { title: 'V', duration: 600, extractor: 'generic' });
    expect(s.alreadyWorks).toBe(true);
    expect(s.rule).toBeUndefined();
    expect(s.fixture).toMatchObject({ url: URL, category: 'onboard', expect: { outcome: 'ok', minDurationSec: 480 } });
    expect(s.notes.join(' ')).toMatch(/already resolves/i);
  });

  it('scaffolds an HLS rule when analyze fails but the diagnose saw an HLS stream', () => {
    const diag: any = { mediaRequests: [{ mediaKind: 'hls' }], page: { playerGlobals: ['Hls'] } };
    const s = suggestOnboarding(URL, 'New Site', diag, {});
    expect(s.alreadyWorks).toBe(false);
    expect(s.rule).toMatchObject({ match: ['newsite.tv'], impersonate: 'chrome', referer: 'self', hlsNative: true });
    expect(s.fixture.name).toBe('New Site');
    expect(s.notes.join(' ')).toMatch(/Media seen on the network: hls/);
  });

  it('flags gated sites and sets an auth fixture', () => {
    const s = suggestOnboarding(URL, undefined, {}, { requiresAuth: true });
    expect(s.fixture.expect).toBe('auth');
    expect(s.notes.join(' ')).toMatch(/login-required|cookies/i);
  });

  it('notes MSE delivery when appendBuffer is seen without network media', () => {
    const diag: any = { page: { appendBufferCount: 12, videos: [{ usesBlob: true }] }, mediaRequests: [] };
    const s = suggestOnboarding(URL, undefined, diag, {});
    expect(s.notes.join(' ')).toMatch(/MSE\/appendBuffer/);
    expect(s.rule).toBeDefined();
  });
});
