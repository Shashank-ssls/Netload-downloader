import { describe, it, expect } from 'vitest';
import { summarizeLogin } from '../src/recovery/interactiveLogin';

describe('summarizeLogin', () => {
  it('marks the session saved when cookies were captured', () => {
    const r = summarizeLogin('hanime.tv', 7, true, 1000, 4000);
    expect(r).toEqual({ host: 'hanime.tv', saved: true, reason: 'window-closed', cookies: 7, durationMs: 3000 });
  });

  it('is not saved when no cookies were captured', () => {
    const r = summarizeLogin('site.tv', 0, false, 0, 5000);
    expect(r).toMatchObject({ saved: false, reason: 'timeout', cookies: 0 });
  });
});
