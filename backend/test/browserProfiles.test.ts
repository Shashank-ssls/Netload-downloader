import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { hostOf, filterStorageState, isMeaningfulState, BrowserProfiles } from '../src/utils/browserProfiles';

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

describe('BrowserProfiles.list / remove', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-'));
    fs.writeFileSync(path.join(dir, 'hanime.tv.json'), JSON.stringify({ cookies: [cookie('.hanime.tv'), cookie('.hanime.tv')], origins: [{ origin: 'https://hanime.tv' }] }));
    fs.writeFileSync(path.join(dir, 'anikage.cc.json'), JSON.stringify({ cookies: [cookie('.anikage.cc')], origins: [] }));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('lists saved profiles with cookie/origin counts', () => {
    const list = BrowserProfiles.list(dir);
    const hanime = list.find((s) => s.host === 'hanime.tv')!;
    expect(hanime).toMatchObject({ cookies: 2, origins: 1 });
    expect(list.map((s) => s.host).sort()).toEqual(['anikage.cc', 'hanime.tv']);
  });

  it('removes a profile (and sanitizes the host)', () => {
    expect(BrowserProfiles.remove('www.HANIME.tv', dir)).toBe(true); // normalised to hanime.tv
    expect(BrowserProfiles.list(dir).map((s) => s.host)).toEqual(['anikage.cc']);
    expect(BrowserProfiles.remove('nope.com', dir)).toBe(false);
  });

  it('returns [] for a missing dir', () => {
    expect(BrowserProfiles.list(path.join(dir, 'nonexistent'))).toEqual([]);
  });
});
