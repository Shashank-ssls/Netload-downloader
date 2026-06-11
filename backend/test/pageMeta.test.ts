import { describe, it, expect } from 'vitest';
import { cleanTitle, sanitizeFilename, extractMeta } from '../src/utils/pageMeta';

describe('cleanTitle', () => {
  it('strips a "Watch on <site>" suffix (the anikage case)', () => {
    expect(cleanTitle("The Ancient Magus' Bride - Episode 2 - Watch on Anikage"))
      .toBe("The Ancient Magus' Bride - Episode 2");
  });
  it('strips a trailing "| Site" suffix', () => {
    expect(cleanTitle('Some Movie (2021) | YoyoMovies')).toBe('Some Movie (2021)');
  });
  it('leaves a clean title untouched', () => {
    expect(cleanTitle('Just A Title')).toBe('Just A Title');
  });
});

describe('sanitizeFilename', () => {
  it('removes reserved chars and spaces', () => {
    expect(sanitizeFilename("The Ancient Magus' Bride - Episode 2"))
      .toBe("The_Ancient_Magus'_Bride_Episode_2");
  });
  it('falls back to "video" for an empty/garbage name', () => {
    expect(sanitizeFilename('***')).toBe('video');
    expect(sanitizeFilename('')).toBe('video');
  });
});

describe('extractMeta', () => {
  it('reads og:title + og:image', () => {
    const html = '<html><head>' +
      '<meta property="og:title" content="Ep 2 - Watch on X">' +
      '<meta property="og:image" content="https://cdn/x.png">' +
      '<title>fallback</title></head></html>';
    expect(extractMeta(html)).toEqual({ title: 'Ep 2 - Watch on X', thumbnail: 'https://cdn/x.png' });
  });
  it('falls back to <title> when no OG title', () => {
    expect(extractMeta('<html><head><title>Plain Title</title></head></html>'))
      .toMatchObject({ title: 'Plain Title' });
  });
  it('returns empty for tagless html', () => {
    expect(extractMeta('<html></html>')).toEqual({ title: undefined, thumbnail: undefined });
  });
});
