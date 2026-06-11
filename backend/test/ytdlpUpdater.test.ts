import { describe, it, expect } from 'vitest';
import { updateArgs } from '../src/utils/binaryVersions';
import { shouldUpdate } from '../src/utils/ytdlpUpdater';

describe('updateArgs', () => {
  it('uses -U for the stable channel (or unset)', () => {
    expect(updateArgs()).toEqual(['-U']);
    expect(updateArgs('stable')).toEqual(['-U']);
  });

  it('targets a non-stable channel via --update-to', () => {
    expect(updateArgs('nightly')).toEqual(['--update-to', 'nightly']);
    expect(updateArgs('master')).toEqual(['--update-to', 'master']);
  });
});

describe('shouldUpdate', () => {
  const WEEK = 7 * 24 * 60 * 60 * 1000;

  it('updates when the interval has elapsed', () => {
    expect(shouldUpdate(0, WEEK, WEEK)).toBe(true);
    expect(shouldUpdate(1000, 1000 + WEEK + 1, WEEK)).toBe(true);
  });

  it('skips when updated more recently than the interval', () => {
    const now = 10 * WEEK;
    expect(shouldUpdate(now - 1, now, WEEK)).toBe(false);
    expect(shouldUpdate(now - WEEK + 1, now, WEEK)).toBe(false);
  });

  it('updates on a fresh install (lastAt = 0)', () => {
    expect(shouldUpdate(0, Date.now(), WEEK)).toBe(true);
  });
});
