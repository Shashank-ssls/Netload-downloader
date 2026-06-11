import { describe, it, expect } from 'vitest';
import {
  buildRequestPayload,
  endpointFor,
  toPlaywrightCookies,
  findCfClearance,
  cookieHeaderFor,
  flareCookiesToNetscape,
  flareCookiesToStorageState,
  type FlareCookie,
} from '../src/recovery/flaresolverr';

const fc = (over: Partial<FlareCookie>): FlareCookie => ({
  name: 'cf_clearance', value: 'TOKEN', domain: '.yoyomovies.net', path: '/',
  expires: 1893456000, httpOnly: true, secure: true, sameSite: 'None', ...over,
});

describe('buildRequestPayload', () => {
  it('builds the request.get command FlareSolverr expects', () => {
    expect(buildRequestPayload('https://yoyomovies.net/x', 60000)).toEqual({
      cmd: 'request.get', url: 'https://yoyomovies.net/x', maxTimeout: 60000,
    });
  });
});

describe('endpointFor', () => {
  it('appends /v1 to a bare base', () => {
    expect(endpointFor('http://localhost:8191')).toBe('http://localhost:8191/v1');
    expect(endpointFor('http://localhost:8191/')).toBe('http://localhost:8191/v1');
  });
  it('leaves an explicit /v1 (or other version) endpoint untouched', () => {
    expect(endpointFor('http://localhost:8191/v1')).toBe('http://localhost:8191/v1');
    expect(endpointFor('http://host/v2/')).toBe('http://host/v2');
  });
});

describe('toPlaywrightCookies', () => {
  it('fills defaults and drops nameless cookies', () => {
    const out = toPlaywrightCookies([fc({}), fc({ name: '', value: 'x' }), { name: 'a', value: 'b', domain: 'd' } as FlareCookie]);
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({ name: 'a', value: 'b', domain: 'd', path: '/', expires: -1, httpOnly: false, secure: false });
  });
});

describe('findCfClearance', () => {
  it('returns the cf_clearance value when present', () => {
    expect(findCfClearance([fc({ name: 'cf_chl_rc_ni', value: 'junk' }), fc({ value: 'WIN' })])).toBe('WIN');
  });
  it('returns null when cf_clearance is absent or empty', () => {
    expect(findCfClearance([fc({ name: 'other' })])).toBeNull();
    expect(findCfClearance([fc({ value: '' })])).toBeNull();
    expect(findCfClearance([])).toBeNull();
  });
});

describe('cookieHeaderFor (scoped Cookie header)', () => {
  it('joins the site own cookies, dropping third-party ones', () => {
    const header = cookieHeaderFor(
      [fc({ name: 'cf_clearance', value: 'CF' }), fc({ name: 'sess', value: 'S' }), fc({ name: 'ad', value: 'A', domain: '.doubleclick.net' })],
      'yoyomovies.net',
    );
    expect(header).toBe('cf_clearance=CF; sess=S');
  });
});

describe('flareCookiesToNetscape (the response→cookies.txt mapping)', () => {
  it('produces a yt-dlp-readable Netscape file scoped to the host', () => {
    const out = flareCookiesToNetscape(
      [fc({ name: 'cf_clearance', value: 'CF' }), fc({ name: 'ad', value: 'A', domain: '.tracker.io' })],
      'yoyomovies.net',
    );
    expect(out.startsWith('# Netscape HTTP Cookie File')).toBe(true);
    expect(out).toContain('cf_clearance');
    expect(out).not.toContain('tracker.io'); // third-party dropped
    const row = out.trim().split('\n').pop()!;
    expect(row).toBe(['.yoyomovies.net', 'TRUE', '/', 'TRUE', '1893456000', 'cf_clearance', 'CF'].join('\t'));
  });
});

describe('flareCookiesToStorageState (A4 profile seed)', () => {
  it('scopes cookies to host, normalises sameSite, and emits no localStorage origins', () => {
    const state = flareCookiesToStorageState(
      [fc({ sameSite: 'None' }), fc({ name: 'lax', sameSite: 'unspecified' }), fc({ name: 'ad', domain: '.ads.io' })],
      'yoyomovies.net',
    );
    expect(state.origins).toEqual([]);
    expect(state.cookies.map((c) => c.name)).toEqual(['cf_clearance', 'lax']); // third-party dropped
    expect(state.cookies[0].sameSite).toBe('None');
    expect(state.cookies[1].sameSite).toBe('Lax'); // unknown → Lax
  });
});
