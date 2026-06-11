import { describe, it, expect } from 'vitest';
import { suggestRemedy } from '../src/utils/remedy';

const URL = 'https://www.hanime.tv/videos/hentai/x';

describe('suggestRemedy', () => {
  it('points a gated preview at netload login (with the www-stripped host)', () => {
    const r = suggestRemedy({ status: 'completed', note: 'LIKELY_PREVIEW_ADD_COOKIES', url: URL });
    expect(r).toMatch(/netload login hanime\.tv/);
    expect(r).toMatch(/preview/i);
  });

  it('points a Cloudflare block at netload login', () => {
    const r = suggestRemedy({ status: 'failed', error: 'CLOUDFLARE_BLOCKED', url: 'https://yoyomovies.net/x' });
    expect(r).toMatch(/netload login yoyomovies\.net/);
    expect(r).toMatch(/cloudflare/i);
  });

  it('points auth errors at login too', () => {
    expect(suggestRemedy({ error: 'AUTH_REQUIRED', url: URL })).toMatch(/netload login hanime\.tv/);
    expect(suggestRemedy({ error: 'COOKIE_INVALID', url: URL })).toMatch(/netload login/);
  });

  it('explains DRM as unfixable', () => {
    expect(suggestRemedy({ error: 'DRM_PROTECTED', url: URL })).toMatch(/DRM/);
  });

  it('returns null for a clean success or an unrelated error', () => {
    expect(suggestRemedy({ status: 'completed', note: '', url: URL })).toBeNull();
    expect(suggestRemedy({ status: 'failed', error: 'NETWORK_TIMEOUT', url: URL })).toBeNull();
  });

  it('falls back to "the site" when the url is unparseable', () => {
    expect(suggestRemedy({ error: 'CLOUDFLARE_BLOCKED', url: 'garbage' })).toMatch(/netload login the site/);
  });
});
