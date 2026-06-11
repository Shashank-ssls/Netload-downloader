import { describe, it, expect } from 'vitest';
import { summarizeLogin, looksEstablished } from '../src/recovery/interactiveLogin';

describe('summarizeLogin', () => {
  it('marks the session saved when a profile was persisted', () => {
    const r = summarizeLogin('hanime.tv', true, 7, 'window-closed', 1000, 4000);
    expect(r).toEqual({ host: 'hanime.tv', saved: true, reason: 'window-closed', cookies: 7, durationMs: 3000 });
  });

  it('carries the auto-finish reason', () => {
    expect(summarizeLogin('site.tv', true, 3, 'session-captured', 0, 1000)).toMatchObject({ reason: 'session-captured', saved: true });
  });

  it('is not saved when nothing was captured', () => {
    expect(summarizeLogin('site.tv', false, 0, 'timeout', 0, 5000)).toMatchObject({ saved: false, reason: 'timeout' });
  });
});

describe('looksEstablished', () => {
  it('is true when cf_clearance is present (Cloudflare cleared)', () => {
    expect(looksEstablished(['__cf_bm', 'cf_clearance'])).toBe(true);
  });

  it('is true for common session/auth cookie names', () => {
    expect(looksEstablished(['PHPSESSID'])).toBe(true);
    expect(looksEstablished(['remember_token'])).toBe(true);
    expect(looksEstablished(['auth_id'])).toBe(true);
    expect(looksEstablished(['user_session'])).toBe(true);
  });

  it('is false for non-auth cookies only', () => {
    expect(looksEstablished(['_ga', 'theme', 'lang'])).toBe(false);
    expect(looksEstablished([])).toBe(false);
  });
});
