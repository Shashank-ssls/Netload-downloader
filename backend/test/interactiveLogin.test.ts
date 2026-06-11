import { describe, it, expect } from 'vitest';
import { summarizeLogin } from '../src/recovery/interactiveLogin';

describe('summarizeLogin', () => {
  it('marks the session saved when a profile was persisted', () => {
    const r = summarizeLogin('hanime.tv', true, 7, true, 1000, 4000);
    expect(r).toEqual({ host: 'hanime.tv', saved: true, reason: 'window-closed', cookies: 7, durationMs: 3000 });
  });

  it('can be saved via localStorage even with zero cookies', () => {
    expect(summarizeLogin('site.tv', true, 0, true, 0, 1000)).toMatchObject({ saved: true, cookies: 0 });
  });

  it('is not saved when nothing was captured', () => {
    const r = summarizeLogin('site.tv', false, 0, false, 0, 5000);
    expect(r).toMatchObject({ saved: false, reason: 'timeout', cookies: 0 });
  });
});
