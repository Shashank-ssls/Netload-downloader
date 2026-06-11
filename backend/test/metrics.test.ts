import { describe, it, expect, beforeEach } from 'vitest';
import { Metrics } from '../src/utils/metrics';
import { categorizeError } from '../src/utils/errorCatalog';

describe('categorizeError', () => {
  it('maps known codes to categories', () => {
    expect(categorizeError('CLOUDFLARE_BLOCKED')).toBe('blocked');
    expect(categorizeError('AUTH_REQUIRED')).toBe('auth');
    expect(categorizeError('NETWORK_TIMEOUT')).toBe('network');
    expect(categorizeError('DRM_PROTECTED')).toBe('drm');
    expect(categorizeError('DISK_FULL')).toBe('system');
  });

  it('falls back to unknown for unrecognised codes', () => {
    expect(categorizeError('SOMETHING_NEW')).toBe('unknown');
    expect(categorizeError('')).toBe('unknown');
  });
});

describe('Metrics', () => {
  beforeEach(() => Metrics.reset());

  it('tracks attempts, successes and success rate per provider', () => {
    Metrics.recordSuccess('anime');
    Metrics.recordSuccess('anime');
    Metrics.recordFailure('anime', 'CLOUDFLARE_BLOCKED');
    const snap = Metrics.snapshot();
    expect(snap.anime).toMatchObject({ attempts: 3, successes: 2, failures: 1 });
    expect(snap.anime.successRate).toBe(0.667);
  });

  it('breaks failures down by code and by category', () => {
    Metrics.recordFailure('generic', 'RATE_LIMITED');
    Metrics.recordFailure('generic', 'CLOUDFLARE_BLOCKED');
    Metrics.recordFailure('generic', 'AUTH_REQUIRED');
    const g = Metrics.snapshot().generic;
    expect(g.byError).toEqual({ RATE_LIMITED: 1, CLOUDFLARE_BLOCKED: 1, AUTH_REQUIRED: 1 });
    expect(g.byCategory).toEqual({ blocked: 2, auth: 1 });
  });

  it('keeps providers separate and reports 0 rate for a fresh/empty provider', () => {
    Metrics.recordSuccess('movie');
    const snap = Metrics.snapshot();
    expect(snap.movie.successRate).toBe(1);
    expect(snap.anime).toBeUndefined();
  });

  it('counts a gated preview as an attempt but NOT a full success', () => {
    Metrics.recordSuccess('hanime');
    Metrics.recordPreview('hanime');
    const h = Metrics.snapshot().hanime;
    expect(h).toMatchObject({ attempts: 2, successes: 1, previews: 1, failures: 0 });
    expect(h.successRate).toBe(0.5); // preview drags the real-reach rate down
  });
});
