import { describe, it, expect } from 'vitest';
import { ProviderDetector } from '../src/providers/detector';

const detect = (url: string) => ProviderDetector.detect(url).name;

describe('ProviderDetector.detect', () => {
  it('matches YouTube', () => {
    expect(detect('https://www.youtube.com/watch?v=abc')).toBe('youtube');
    expect(detect('https://youtu.be/abc')).toBe('youtube');
  });

  it('matches hanime BEFORE the generic anime/adult providers (order matters)', () => {
    expect(detect('https://hanime.tv/videos/hentai/foo')).toBe('hanime');
  });

  it('matches anime streaming sites', () => {
    expect(detect('https://miruro.tv/watch/123')).toBe('anime');
    expect(detect('https://hianime.to/watch/abc')).toBe('anime');
  });

  it('matches adult sites', () => {
    expect(detect('https://www.pornhub.com/view_video.php?viewkey=x')).toBe('adult');
    expect(detect('https://xvideos.com/video123')).toBe('adult');
  });

  it('falls back to generic for unknown sites', () => {
    expect(detect('https://some-random-site.example/watch/1')).toBe('generic');
  });

  it('generic provider matches everything as a last resort', () => {
    const generic = ProviderDetector.detect('https://anything.test');
    expect(generic.match('https://literally-anything.test')).toBe(true);
  });
});
