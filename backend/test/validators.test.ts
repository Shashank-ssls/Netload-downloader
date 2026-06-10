import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CookieValidator, FileValidator } from '../src/utils/validators';

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netload-test-'));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('CookieValidator.isValid', () => {
  it('is false when the file does not exist', () => {
    expect(CookieValidator.isValid(path.join(dir, 'nope.txt'))).toBe(false);
  });

  it('is false for an empty file', () => {
    const p = path.join(dir, 'empty.txt');
    fs.writeFileSync(p, '');
    expect(CookieValidator.isValid(p)).toBe(false);
  });

  it('is false without the Netscape header', () => {
    const p = path.join(dir, 'plain.txt');
    fs.writeFileSync(p, 'just some text\n');
    expect(CookieValidator.isValid(p)).toBe(false);
  });

  it('is true for a Netscape-format cookie file', () => {
    const p = path.join(dir, 'cookies.txt');
    fs.writeFileSync(p, '# Netscape HTTP Cookie File\n.x.test\tTRUE\t/\tFALSE\t0\tk\tv\n');
    expect(CookieValidator.isValid(p)).toBe(true);
  });
});

describe('FileValidator.isContentSane', () => {
  const opts = { minBytes: 1024 * 1024, minDurationSec: 90 };

  it('is false for a missing file', () => {
    expect(FileValidator.isContentSane(path.join(dir, 'ghost.mp4'), opts)).toBe(false);
  });

  it('passes on size alone when above the byte floor', () => {
    const p = path.join(dir, 'big.mp4');
    fs.writeFileSync(p, Buffer.alloc(2 * 1024 * 1024));
    expect(FileValidator.isContentSane(p, opts)).toBe(true);
  });

  it('rejects a small file with no readable duration', () => {
    const p = path.join(dir, 'tiny.bin');
    fs.writeFileSync(p, Buffer.alloc(100));
    expect(FileValidator.isContentSane(p, opts)).toBe(false);
  });
});

describe('FileValidator.getFreeSpaceMB', () => {
  it('returns a non-negative number for a real directory', () => {
    expect(FileValidator.getFreeSpaceMB(os.tmpdir())).toBeGreaterThanOrEqual(0);
  });

  it('returns -1 for an unreadable path', () => {
    expect(FileValidator.getFreeSpaceMB(path.join(dir, 'no', 'such', 'mount'))).toBe(-1);
  });
});
