import { describe, it, expect } from 'vitest';
import { HeaderBuilder } from '../src/utils/headers';

describe('HeaderBuilder.getHeadersForProvider', () => {
  it('always returns base navigation headers', () => {
    const h = HeaderBuilder.getHeadersForProvider('generic', 'https://x.test/v');
    expect(h['Accept-Language']).toBe('en-US,en;q=0.9');
    expect(h['Sec-Fetch-Mode']).toBe('navigate');
  });

  it('sets self-referer + same-origin for anime', () => {
    const h = HeaderBuilder.getHeadersForProvider('anime', 'https://cdn.test/stream/x.m3u8');
    expect(h['Referer']).toBe('https://cdn.test/stream/x.m3u8');
    expect(h['Origin']).toBe('https://cdn.test');
    expect(h['Sec-Fetch-Site']).toBe('same-origin');
  });

  it('pins hanime.tv referer/origin', () => {
    const h = HeaderBuilder.getHeadersForProvider('hanime', 'https://hanime.tv/videos/x');
    expect(h['Referer']).toBe('https://hanime.tv/');
    expect(h['Origin']).toBe('https://hanime.tv');
  });

  it('spoofs a Google referer for adult provider', () => {
    const h = HeaderBuilder.getHeadersForProvider('adult', 'https://pornhub.com/v');
    expect(h['Referer']).toBe('https://www.google.com/');
    expect(h['Sec-Fetch-Site']).toBe('cross-site');
  });

  it('does not throw on a malformed URL', () => {
    expect(() => HeaderBuilder.getHeadersForProvider('movie', 'not a url')).not.toThrow();
  });
});

describe('HeaderBuilder.formatForYTDLP', () => {
  it('emits --user-agent and --add-header pairs', () => {
    const args = HeaderBuilder.formatForYTDLP({ Referer: 'https://x.test/' }, 'UA/1.0');
    expect(args).toContain('--user-agent');
    expect(args).toContain('UA/1.0');
    expect(args).toContain('--add-header');
    expect(args).toContain('Referer:https://x.test/');
  });

  it('omits user-agent when not provided', () => {
    const args = HeaderBuilder.formatForYTDLP({ Origin: 'https://x.test' });
    expect(args).not.toContain('--user-agent');
  });
});
