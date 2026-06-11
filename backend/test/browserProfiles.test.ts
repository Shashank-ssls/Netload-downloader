import { describe, it, expect } from 'vitest';
import { hostOf, filterStorageState, isMeaningfulState } from '../src/utils/browserProfiles';

const cookie = (domain: string) => ({
  name: 'sid', value: 'v', domain, path: '/', expires: -1, httpOnly: false, secure: true,
});

describe('hostOf', () => {
  it('returns a www-stripped lowercase host', () => {
    expect(hostOf('https://www.Example.com/x')).toBe('example.com');
    expect(hostOf('https://cdn.site.tv/a')).toBe('cdn.site.tv');
  });
  it('returns empty for an unparseable URL', () => {
    expect(hostOf('nonsense')).toBe('');
  });
});

describe('filterStorageState', () => {
  it('keeps the site cookies, drops third-party ones, preserves origins', () => {
    const state = {
      cookies: [cookie('.example.com'), cookie('cdn.example.com'), cookie('.doubleclick.net')],
      origins: [{ origin: 'https://example.com', localStorage: [{ name: 'k', value: '1' }] }],
    };
    const out = filterStorageState(state, 'example.com');
    expect(out.cookies.map((c: any) => c.domain)).toEqual(['.example.com', 'cdn.example.com']);
    expect(out.origins).toEqual(state.origins);
  });

  it('tolerates missing arrays', () => {
    expect(filterStorageState({ cookies: undefined as any, origins: undefined as any }, 'x.com'))
      .toEqual({ cookies: [], origins: [] });
  });
});

describe('isMeaningfulState', () => {
  it('is true when there are cookies or localStorage origins', () => {
    expect(isMeaningfulState({ cookies: [cookie('.a.com')], origins: [] })).toBe(true);
    expect(isMeaningfulState({ cookies: [], origins: [{ origin: 'https://a.com', localStorage: [] }] })).toBe(true);
  });
  it('is false for an empty session', () => {
    expect(isMeaningfulState({ cookies: [], origins: [] })).toBe(false);
  });
});
