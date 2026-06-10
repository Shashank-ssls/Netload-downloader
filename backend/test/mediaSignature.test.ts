import { describe, it, expect } from 'vitest';
import {
  classifyContentType,
  classifyBytes,
  classifyResponse,
  isManifestKind,
} from '../src/extractors/mediaSignature';

const bytes = (...parts: (number | string)[]): Uint8Array => {
  const out: number[] = [];
  for (const p of parts) {
    if (typeof p === 'number') out.push(p);
    else for (const ch of p) out.push(ch.charCodeAt(0));
  }
  return Uint8Array.from(out);
};

describe('classifyContentType', () => {
  it('recognises HLS manifest content-types (all spellings)', () => {
    expect(classifyContentType('application/vnd.apple.mpegurl')).toBe('hls');
    expect(classifyContentType('application/x-mpegURL')).toBe('hls');
    expect(classifyContentType('audio/mpegurl')).toBe('hls');
    expect(classifyContentType('application/vnd.apple.mpegurl; charset=utf-8')).toBe('hls');
  });

  it('recognises DASH, TS, and generic video', () => {
    expect(classifyContentType('application/dash+xml')).toBe('dash');
    expect(classifyContentType('video/mp2t')).toBe('ts');
    expect(classifyContentType('video/mp4')).toBe('mp4');
    expect(classifyContentType('video/webm')).toBe('mp4');
  });

  it('treats octet-stream as generic media (needs corroboration)', () => {
    expect(classifyContentType('application/octet-stream')).toBe('media');
  });

  it('rejects non-media and empty content-types', () => {
    expect(classifyContentType('text/html')).toBeNull();
    expect(classifyContentType('image/jpeg')).toBeNull();
    expect(classifyContentType('application/json')).toBeNull();
    expect(classifyContentType('')).toBeNull();
    expect(classifyContentType(undefined)).toBeNull();
  });
});

describe('classifyBytes', () => {
  it('detects an HLS playlist by #EXTM3U (with BOM / leading whitespace)', () => {
    expect(classifyBytes(bytes('#EXTM3U\n#EXT-X-VERSION:3'))).toBe('hls');
    expect(classifyBytes(bytes('\n  #EXTM3U'))).toBe('hls');
    expect(classifyBytes(bytes(0xef, 0xbb, 0xbf, '#EXTM3U'))).toBe('hls');
  });

  it('detects a DASH manifest by <MPD, including xml-declared', () => {
    expect(classifyBytes(bytes('<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">'))).toBe('dash');
    expect(classifyBytes(bytes('<?xml version="1.0"?>\n<MPD profiles="...">'))).toBe('dash');
  });

  it('detects MP4 / fMP4 by an ISO-BMFF box at bytes 4-8', () => {
    expect(classifyBytes(bytes(0, 0, 0, 0x18, 'ftyp', 'isom'))).toBe('mp4');
    expect(classifyBytes(bytes(0, 0, 0, 0x10, 'styp', 'msdh'))).toBe('mp4');
    expect(classifyBytes(bytes(0, 0, 0, 0x08, 'moof'))).toBe('mp4');
  });

  it('detects MPEG-TS by the 0x47 sync byte, confirmed at offset 188', () => {
    const ts = new Uint8Array(376);
    ts[0] = 0x47;
    ts[188] = 0x47;
    expect(classifyBytes(ts)).toBe('ts');
    // A short buffer starting with the sync byte still classifies (can't confirm).
    expect(classifyBytes(Uint8Array.from([0x47, 0x40, 0x00]))).toBe('ts');
  });

  it('does not classify a stray 0x47 when the second packet sync is absent', () => {
    const notTs = new Uint8Array(376);
    notTs[0] = 0x47;
    notTs[188] = 0x00; // no second sync
    expect(classifyBytes(notTs)).toBeNull();
  });

  it('returns null for html, json, and empty buffers', () => {
    expect(classifyBytes(bytes('<!DOCTYPE html>'))).toBeNull();
    expect(classifyBytes(bytes('{"ok":true}'))).toBeNull();
    expect(classifyBytes(new Uint8Array())).toBeNull();
    expect(classifyBytes(undefined)).toBeNull();
  });
});

describe('classifyResponse', () => {
  it('prefers a specific content-type over a byte sniff', () => {
    expect(classifyResponse('application/vnd.apple.mpegurl', bytes('garbage'))).toBe('hls');
  });

  it('falls back to bytes when content-type is generic or lying', () => {
    // CDN lies: an MPEG-TS segment served as image/jpeg.
    const ts = new Uint8Array(376);
    ts[0] = 0x47; ts[188] = 0x47;
    expect(classifyResponse('image/jpeg', ts)).toBe('ts');
    // octet-stream carrying a real HLS playlist.
    expect(classifyResponse('application/octet-stream', bytes('#EXTM3U'))).toBe('hls');
  });

  it('keeps generic media from octet-stream when no bytes are available', () => {
    expect(classifyResponse('application/octet-stream', undefined)).toBe('media');
  });

  it('returns null when neither signal is media', () => {
    expect(classifyResponse('text/html', bytes('<html>'))).toBeNull();
  });
});

describe('isManifestKind', () => {
  it('flags hls and dash as manifests', () => {
    expect(isManifestKind('hls')).toBe(true);
    expect(isManifestKind('dash')).toBe(true);
    expect(isManifestKind('ts')).toBe(false);
    expect(isManifestKind('mp4')).toBe(false);
    expect(isManifestKind('media')).toBe(false);
    expect(isManifestKind(null)).toBe(false);
  });
});
