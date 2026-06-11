import { describe, it, expect } from 'vitest';
import { toNetscapeCookies, registrableDomain, filterCookiesForHost, type PlaywrightCookie } from '../src/utils/cookieHarvester';

const cookie = (over: Partial<PlaywrightCookie>): PlaywrightCookie => ({
  name: 'sid', value: 'abc', domain: '.example.com', path: '/',
  expires: 1893456000, httpOnly: false, secure: true, ...over,
});

describe('toNetscapeCookies', () => {
  it('emits the Netscape header (so CookieValidator accepts it)', () => {
    expect(toNetscapeCookies([cookie({})]).startsWith('# Netscape HTTP Cookie File')).toBe(true);
  });

  it('writes a tab-delimited row: domain, includeSub, path, secure, expiry, name, value', () => {
    const out = toNetscapeCookies([cookie({})]);
    const row = out.trim().split('\n').pop()!;
    expect(row).toBe(['.example.com', 'TRUE', '/', 'TRUE', '1893456000', 'sid', 'abc'].join('\t'));
  });

  it('marks includeSubdomains FALSE for a host-only domain and secure FALSE', () => {
    const row = toNetscapeCookies([cookie({ domain: 'host.example.com', secure: false })]).trim().split('\n').pop()!;
    expect(row.split('\t').slice(0, 4)).toEqual(['host.example.com', 'FALSE', '/', 'FALSE']);
  });

  it('writes 0 expiry for a session cookie (expires <= 0)', () => {
    const row = toNetscapeCookies([cookie({ expires: -1 })]).trim().split('\n').pop()!;
    expect(row.split('\t')[4]).toBe('0');
  });

  it('skips cookies with no name', () => {
    const out = toNetscapeCookies([cookie({ name: '' })]);
    expect(out.trim().split('\n').some((l) => l.includes('\t'))).toBe(false);
  });
});

describe('registrableDomain', () => {
  it('reduces a host to its last two labels', () => {
    expect(registrableDomain('a.b.example.com')).toBe('example.com');
    expect(registrableDomain('example.com')).toBe('example.com');
    expect(registrableDomain('.Example.COM')).toBe('example.com');
  });
});

describe('filterCookiesForHost (privacy scoping)', () => {
  const c = (domain: string): PlaywrightCookie => cookie({ domain, name: 'x', value: 'y' });

  it('keeps the site own + subdomain cookies, drops third-party/tracker cookies', () => {
    const kept = filterCookiesForHost(
      [c('.example.com'), c('cdn.example.com'), c('.doubleclick.net'), c('tracker.ads.io')],
      'example.com',
    );
    expect(kept.map((k) => k.domain)).toEqual(['.example.com', 'cdn.example.com']);
  });

  it('matches the exact page host even on a deep subdomain', () => {
    const kept = filterCookiesForHost([c('watch.site.tv'), c('.site.tv'), c('evil.com')], 'watch.site.tv');
    expect(kept.map((k) => k.domain)).toEqual(['watch.site.tv', '.site.tv']);
  });
});
