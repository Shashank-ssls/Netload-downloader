import { describe, it, expect } from 'vitest';
import { cleanTitle, sanitizeFilename, extractMeta, extractImageUrlFromText, pickImageUrl, PageMeta } from '../src/utils/pageMeta';

describe('cleanTitle', () => {
  it('strips a "Watch on <site>" suffix (the anikage case)', () => {
    expect(cleanTitle("The Ancient Magus' Bride - Episode 2 - Watch on Anikage"))
      .toBe("The Ancient Magus' Bride - Episode 2");
  });
  it('strips a trailing "| Site" suffix', () => {
    expect(cleanTitle('Some Movie (2021) | YoyoMovies')).toBe('Some Movie (2021)');
  });
  it('strips a leading "Watch " and a trailing "- site.tld" (the hanime case)', () => {
    expect(cleanTitle('Watch Kegareboshi 2 Hentai Video in 1080p HD - hanime.tv'))
      .toBe('Kegareboshi 2 Hentai Video in 1080p HD');
  });
  it('leaves a clean title untouched', () => {
    expect(cleanTitle('Just A Title')).toBe('Just A Title');
    expect(cleanTitle('Avengers - Endgame')).toBe('Avengers - Endgame');
  });
});

describe('extractImageUrlFromText', () => {
  it('pulls a percent-encoded poster URL out of a player-iframe URL (the hanime case)', () => {
    const frameUrl = 'https://player.hanime.tv/?&#v2,3397,kegareboshi-aka,' +
      'https%3A%2F%2Fhanime-cdn.com%2Fimages%2Fposters%2Fkegareboshi-aka-pv1.webp,no';
    expect(extractImageUrlFromText(frameUrl)).toBe('https://hanime-cdn.com/images/posters/kegareboshi-aka-pv1.webp');
  });
  it('matches a plain jpg/png with a query string and returns "" when there is no image', () => {
    expect(extractImageUrlFromText('foo=https://cdn/x.jpg?w=100&h=2 bar')).toBe('https://cdn/x.jpg?w=100&h=2');
    expect(extractImageUrlFromText('https://site/video/abc.m3u8')).toBe('');
    expect(extractImageUrlFromText('')).toBe('');
  });
});

describe('pickImageUrl', () => {
  it('pulls the inner image out of an og:image wrapper page (the hanime omni-player case)', () => {
    expect(pickImageUrl('https://hanime.tv/omni-player/index.html?poster_url=https://hanime-cdn.com/images/posters/kegareboshi-aka-pv1.webp'))
      .toBe('https://hanime-cdn.com/images/posters/kegareboshi-aka-pv1.webp');
  });
  it('returns a direct image URL as-is and keeps an extensionless plain URL', () => {
    expect(pickImageUrl('https://cdn/x.jpg')).toBe('https://cdn/x.jpg');
    expect(pickImageUrl('https://cdn/image/12345')).toBe('https://cdn/image/12345');
  });
  it('drops a non-image wrapper/page URL with no embedded image', () => {
    expect(pickImageUrl('https://site/player/index.html?id=abc')).toBe('');
    expect(pickImageUrl('')).toBe('');
  });
});

describe('PageMeta rendered-meta cache', () => {
  it('fetch() returns remembered rendered meta without a network call when both fields are present', async () => {
    const url = 'https://spa.example/video/cache-both';
    PageMeta.remember(url, { title: 'Rendered Title', thumbnail: 'https://cdn/x.jpg' });
    // No axios mock — if it hit the network this would not resolve to the cached value.
    expect(await PageMeta.fetch(url)).toEqual({ title: 'Rendered Title', thumbnail: 'https://cdn/x.jpg' });
  });
  it('remember() ignores empty info and merges non-empty fields', () => {
    const url = 'https://spa.example/video/cache-merge';
    PageMeta.remember(url, { title: 'T' });
    PageMeta.remember(url, {});                       // no-op
    PageMeta.remember(url, { thumbnail: 'https://cdn/y.jpg' });
    return expect(PageMeta.fetch(url)).resolves.toEqual({ title: 'T', thumbnail: 'https://cdn/y.jpg' });
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
