import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isHealthyVersion, backupBinary, restoreBinary } from '../src/utils/binaryVersions';

describe('isHealthyVersion', () => {
  it('accepts a real yt-dlp version (date, optional .N suffix)', () => {
    expect(isHealthyVersion('2024.08.06')).toBe(true);
    expect(isHealthyVersion('2025.01.15.232045')).toBe(true);
    expect(isHealthyVersion('  2024.08.06\n')).toBe(true); // trimmed
  });

  it('rejects garbage / error output / empty', () => {
    expect(isHealthyVersion('')).toBe(false);
    expect(isHealthyVersion('Traceback (most recent call last):')).toBe(false);
    expect(isHealthyVersion('ERROR: something')).toBe(false);
    expect(isHealthyVersion('1.2.3')).toBe(false);
  });
});

describe('backupBinary / restoreBinary', () => {
  let dir: string;
  let bin: string;
  let lkg: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdlp-safety-'));
    bin = path.join(dir, 'yt-dlp.exe');
    lkg = `${bin}.lkg`;
    fs.writeFileSync(bin, 'GOOD-BINARY-v1');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('backs up the current binary, then restores it after a bad "update"', () => {
    expect(backupBinary(bin, lkg)).toBe(true);
    expect(fs.readFileSync(lkg, 'utf8')).toBe('GOOD-BINARY-v1');

    // Simulate a self-update that corrupted the binary.
    fs.writeFileSync(bin, 'BROKEN-BUILD');
    expect(restoreBinary(bin, lkg)).toBe(true);
    expect(fs.readFileSync(bin, 'utf8')).toBe('GOOD-BINARY-v1'); // rolled back
  });

  it('backupBinary returns false when the source is missing', () => {
    fs.rmSync(bin);
    expect(backupBinary(bin, lkg)).toBe(false);
  });

  it('restoreBinary returns false when there is no backup', () => {
    expect(restoreBinary(bin, lkg)).toBe(false);
    expect(fs.readFileSync(bin, 'utf8')).toBe('GOOD-BINARY-v1'); // untouched
  });
});
