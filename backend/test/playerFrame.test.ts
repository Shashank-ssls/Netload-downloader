import { describe, it, expect } from 'vitest';
import { looksLikePlayerFrame, PLAYER_GLOBALS, FallbackExtractor } from '../src/extractors/fallbackExtractor';
import type { CapturedStream } from '../src/types';

describe('looksLikePlayerFrame', () => {
  it('is a player frame when it contains a <video>', () => {
    expect(looksLikePlayerFrame({ hasVideo: true, playerGlobals: [] })).toBe(true);
  });

  it('is a player frame when it exposes a known player global', () => {
    expect(looksLikePlayerFrame({ hasVideo: false, playerGlobals: ['jwplayer'] })).toBe(true);
    expect(looksLikePlayerFrame({ hasVideo: false, playerGlobals: ['Hls', 'videojs'] })).toBe(true);
  });

  it('is NOT a player frame with neither a <video> nor a player global', () => {
    expect(looksLikePlayerFrame({ hasVideo: false, playerGlobals: [] })).toBe(false);
  });

  it('exports the recognised player globals', () => {
    expect(PLAYER_GLOBALS).toEqual(expect.arrayContaining(['jwplayer', 'videojs', 'Hls', 'dashjs', 'Plyr']));
  });
});

describe('FallbackExtractor.mergeCandidates', () => {
  const s = (url: string): CapturedStream => ({ url, referer: '', userAgent: '', headers: {} });

  it('appends only candidates whose URL is not already present', () => {
    const a = [s('https://h/a'), s('https://h/b')];
    const b = [s('https://h/b'), s('https://h/c')];
    expect(FallbackExtractor.mergeCandidates(a, b).map((c) => c.url)).toEqual(['https://h/a', 'https://h/b', 'https://h/c']);
  });

  it('keeps the primary list first and unchanged when extra is empty', () => {
    const a = [s('https://h/a')];
    expect(FallbackExtractor.mergeCandidates(a, []).map((c) => c.url)).toEqual(['https://h/a']);
  });
});
