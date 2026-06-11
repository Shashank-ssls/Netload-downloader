import { describe, it, expect } from 'vitest';
import {
  classifyOutcome, matchesExpect,
  evaluateExpectation, summarizeByCategory, diffRuns,
} from '../src/corpus/classify';

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

describe('evaluateExpectation (richer fixtures)', () => {
  it('still supports the string form', () => {
    expect(evaluateExpectation('ok', { title: 'V', duration: 120 }).ok).toBe(true);
    expect(evaluateExpectation('ok', { title: 'V', duration: 0 }).ok).toBe(false);
  });

  it('enforces a duration floor (object form)', () => {
    expect(evaluateExpectation({ outcome: 'ok', minDurationSec: 90 }, { title: 'V', duration: 120 }).ok).toBe(true);
    const short = evaluateExpectation({ outcome: 'ok', minDurationSec: 90 }, { title: 'V', duration: 30 });
    expect(short.ok).toBe(false);
    expect(short.reason).toMatch(/duration 30s < 90s/);
  });

  it('enforces an expected extractor (case-insensitive)', () => {
    expect(evaluateExpectation({ extractor: 'youtube' }, { title: 'V', duration: 9, extractor: 'YouTube' }).ok).toBe(true);
    expect(evaluateExpectation({ extractor: 'youtube' }, { title: 'V', duration: 9, extractor: 'generic' }).ok).toBe(false);
  });

  it('object form with no outcome passes any non-error result that clears the floor', () => {
    expect(evaluateExpectation({ minDurationSec: 5 }, { title: 'V', duration: 9 }).ok).toBe(true); // 'resolved', not error
  });
});

describe('summarizeByCategory', () => {
  it('tallies pass/total per category', () => {
    const out = summarizeByCategory([
      { category: 'anime', ok: true }, { category: 'anime', ok: false },
      { category: 'movie', ok: true }, { ok: true },
    ]);
    expect(out).toEqual({ anime: { pass: 1, total: 2 }, movie: { pass: 1, total: 1 }, uncategorized: { pass: 1, total: 1 } });
  });
});

describe('diffRuns (regression detection)', () => {
  it('flags pass→fail as a regression and fail→pass as a recovery', () => {
    const prev = { 'a': true, 'b': false, 'c': true };
    const curr = { 'a': false, 'b': true, 'c': true };
    expect(diffRuns(prev, curr)).toEqual({ regressions: ['a'], recoveries: ['b'] });
  });

  it('treats URLs unseen in the previous run as neither', () => {
    expect(diffRuns({}, { 'new': false })).toEqual({ regressions: [], recoveries: [] });
  });
});
