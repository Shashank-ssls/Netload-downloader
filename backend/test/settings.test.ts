import { describe, it, expect } from 'vitest';
import { SettingsSchema } from '../src/types';

describe('SettingsSchema.downloadDir bounding', () => {
  it('accepts an absolute path with no traversal', () => {
    expect(SettingsSchema.safeParse({ downloadDir: '/data/media' }).success).toBe(true);
  });

  it('rejects a relative path', () => {
    expect(SettingsSchema.safeParse({ downloadDir: 'media/out' }).success).toBe(false);
  });

  it('rejects a path containing ".."', () => {
    expect(SettingsSchema.safeParse({ downloadDir: '/data/../etc' }).success).toBe(false);
  });

  it('applies the default maxConcurrentDownloads', () => {
    const parsed = SettingsSchema.parse({ downloadDir: '/data/media' });
    expect(parsed.maxConcurrentDownloads).toBe(3);
  });
});
