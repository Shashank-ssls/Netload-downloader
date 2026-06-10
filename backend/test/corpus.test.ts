import { describe, it, expect } from 'vitest';
import { classifyOutcome, matchesExpect } from '../src/corpus/classify';

describe('classifyOutcome', () => {
  it('flags previews and auth before ok', () => {
    expect(classifyOutcome({ isLikelyPreview: true, title: 'x', duration: 10 })).toBe('preview');
    expect(classifyOutcome({ requiresAuth: true, title: 'x', duration: 10 })).toBe('auth');
  });

  it('is ok when there is a title and a real duration', () => {
    expect(classifyOutcome({ title: 'Video', duration: 120 })).toBe('ok');
  });

  it('is resolved when it returned something but no duration', () => {
    expect(classifyOutcome({ title: 'stream', duration: 0 })).toBe('resolved');
    expect(classifyOutcome({})).toBe('resolved');
  });
});

describe('matchesExpect', () => {
  it("lenient default ('resolve') passes any non-error outcome", () => {
    for (const a of ['ok', 'preview', 'auth', 'resolved']) {
      expect(matchesExpect(undefined, a), a).toBe(true);
      expect(matchesExpect('resolve', a), a).toBe(true);
    }
    expect(matchesExpect('resolve', 'error:UNSUPPORTED_URL')).toBe(false);
  });

  it("'error' matches any error outcome", () => {
    expect(matchesExpect('error', 'error:VIDEO_UNAVAILABLE')).toBe(true);
    expect(matchesExpect('error', 'ok')).toBe(false);
  });

  it('exact expectations require an exact match', () => {
    expect(matchesExpect('ok', 'ok')).toBe(true);
    expect(matchesExpect('ok', 'preview')).toBe(false);
    expect(matchesExpect('error:VIDEO_UNAVAILABLE', 'error:VIDEO_UNAVAILABLE')).toBe(true);
    expect(matchesExpect('error:VIDEO_UNAVAILABLE', 'error:NETWORK_TIMEOUT')).toBe(false);
  });
});
