import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { config } from '../src/config';
import { CookieResolver } from '../src/utils/cookieResolver';

// Unique per-test host so we never collide with a real cookies file.
const HOST = 'unit-test-host.example';
const hostFile = path.join(config.cookiesDir, `${HOST}.txt`);

afterEach(() => {
  fs.rmSync(hostFile, { force: true });
});

const writeNetscape = (p: string) => fs.writeFileSync(p, '# Netscape HTTP Cookie File\n');

describe('CookieResolver.resolve', () => {
  it('returns null when no host file and no valid global cookies exist', () => {
    // (the project default global cookies.txt is absent in CI/test)
    expect(CookieResolver.resolve(`https://${HOST}/video`)).toBeNull();
  });

  it('matches a per-host cookies file', () => {
    writeNetscape(hostFile);
    expect(CookieResolver.resolve(`https://${HOST}/video`)).toBe(hostFile);
  });

  it('strips www and still matches the host file', () => {
    writeNetscape(hostFile);
    expect(CookieResolver.resolve(`https://www.${HOST}/video`)).toBe(hostFile);
  });

  it('matches a parent domain for a subdomain URL', () => {
    writeNetscape(hostFile);
    expect(CookieResolver.resolve(`https://cdn.${HOST}/stream/x.m3u8`)).toBe(hostFile);
  });

  it('ignores an invalid (empty) host cookie file', () => {
    fs.writeFileSync(hostFile, ''); // empty → not valid Netscape
    expect(CookieResolver.resolve(`https://${HOST}/video`)).toBeNull();
  });
});
