import { describe, it, expect } from 'vitest';
import { toNetscapeCookies, type PlaywrightCookie } from '../src/utils/cookieHarvester';

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
