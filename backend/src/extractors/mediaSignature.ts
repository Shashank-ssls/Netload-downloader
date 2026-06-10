/**
 * mediaSignature.ts
 *
 * Content-based media classification — the counterpart to URL-pattern matching.
 *
 * Tier-2 capture historically only recorded a request when its *URL* contained a
 * known substring (`.m3u8`, `/hls/`, a hardcoded CDN name, …). A new site whose
 * media URLs are opaque tokens with none of those substrings was never even
 * captured, so nothing downstream (ranking, stitching, ffmpeg) could run on it.
 *
 * These pure helpers classify a network response as media by what it *is* rather
 * than what it's *named*: its Content-Type, and — when that's ambiguous — the
 * first bytes of its body (the proxy in front of an obfuscated player frequently
 * lies about the Content-Type, e.g. labelling MPEG-TS segments `image/jpeg`).
 *
 * Kept dependency-free and side-effect-free so the classification logic can be
 * unit-tested directly without a browser.
 */

/** What kind of media a response carries. `media` = generic/binary (kind unknown). */
export type MediaKind = 'hls' | 'dash' | 'ts' | 'mp4' | 'media';

/**
 * Classify by Content-Type alone (cheap — header only, no body read).
 * Returns null for anything not recognisably media.
 *
 * `application/octet-stream` is treated as generic media: obfuscating CDNs serve
 * real progressive files and manifests under it. It's broad, so callers gate it
 * by resource type and/or follow up with a byte sniff to avoid false positives.
 */
export function classifyContentType(contentType?: string | null): MediaKind | null {
  if (!contentType) return null;
  const t = contentType.toLowerCase().split(';')[0].trim();
  if (!t) return null;

  // HLS manifests: application/vnd.apple.mpegurl, application/x-mpegurl,
  // audio/mpegurl, application/mpegurl, vnd.apple.mpegURL, …
  if (t.includes('mpegurl')) return 'hls';
  if (t === 'application/dash+xml') return 'dash';
  if (t === 'video/mp2t' || t === 'video/mpts') return 'ts';
  if (t.startsWith('video/')) return 'mp4';
  if (t === 'application/octet-stream') return 'media';
  return null;
}

/**
 * Classify by the first bytes of a response body — the authoritative signal when
 * the Content-Type is missing, generic (`octet-stream`), or an outright lie.
 *
 *   #EXTM3U                  → HLS playlist
 *   <MPD … / <?xml … <MPD    → DASH manifest
 *   "ftyp"/"moov"/… at b4-8  → MP4 / fragmented-MP4
 *   0x47 sync byte (×188)    → MPEG-TS
 */
export function classifyBytes(buf?: Uint8Array | null): MediaKind | null {
  if (!buf || buf.length === 0) return null;

  // Text-based manifests — sniff a small prefix as UTF-8, tolerating a BOM and
  // leading whitespace.
  const prefix = bufToString(buf, 0, 512);
  // Strip a leading UTF-8 BOM (decoded latin1 as \xEF\xBB\xBF), then whitespace.
  const trimmed = prefix.replace(/^ï»¿/, '').replace(/^\s+/, '');
  if (trimmed.startsWith('#EXTM3U')) return 'hls';
  if (/^<\?xml/i.test(trimmed) ? /<MPD[\s>]/i.test(prefix) : /^<MPD[\s>]/i.test(trimmed)) return 'dash';

  // ISO-BMFF (MP4 / fMP4): a top-level box whose 4-char type sits at bytes 4–8.
  if (buf.length >= 8) {
    const box = bufToString(buf, 4, 4);
    if (box === 'ftyp' || box === 'moov' || box === 'moof' || box === 'styp' || box === 'sidx') {
      return 'mp4';
    }
  }

  // MPEG-TS: 188-byte packets each beginning with the 0x47 sync byte. Require a
  // second sync at offset 188 when the buffer is long enough, to avoid matching a
  // stray leading 0x47 in some other binary format.
  if (buf[0] === 0x47 && (buf.length < 189 || buf[188] === 0x47)) return 'ts';

  return null;
}

/**
 * Convenience: best-effort classification from a Content-Type, falling back to a
 * byte sniff. `media`/`mp4` from a generic octet-stream content-type is only
 * trusted when the bytes confirm it (callers may pass bytes=undefined to skip).
 */
export function classifyResponse(contentType?: string | null, bytes?: Uint8Array | null): MediaKind | null {
  const byCt = classifyContentType(contentType);
  if (byCt && byCt !== 'media') return byCt;
  const byBytes = classifyBytes(bytes);
  if (byBytes) return byBytes;
  return byCt; // may be 'media' from octet-stream when no bytes were sniffed
}

/** A manifest describes a full quality ladder, so it should settle/rank like one. */
export function isManifestKind(kind: MediaKind | null | undefined): boolean {
  return kind === 'hls' || kind === 'dash';
}

function bufToString(buf: Uint8Array, start: number, len: number): string {
  const end = Math.min(buf.length, start + len);
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(buf[i]);
  return s;
}
