/**
 * pageMeta.ts
 *
 * Lightweight page metadata (title + thumbnail) from a site's OpenGraph/HTML tags.
 *
 * The custom-capture download paths (segment stitch, MSE, DASH) don't go through
 * yt-dlp's title handling, so they used to name files `<taskId>.mp4` with no human
 * title or thumbnail. Worse, some players (e.g. anikage) expose an OBFUSCATED title
 * in JS that yt-dlp's generic extractor picks up — while the page's `og:title` is
 * perfectly clean ("… - Episode 2 - Watch on …"). So we read the OG/HTML tags
 * directly to name the file and set the task title/thumbnail.
 *
 * Parsing + cleanup are pure, so they're unit-tested directly.
 */

import axios from 'axios';
import * as cheerio from 'cheerio';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const RESERVED = /[<>:"/\\|?* -]/g; // Windows-reserved filename chars (incl. space/hyphen)

export interface PageMetaInfo {
  title?: string;
  thumbnail?: string;
}

/** Strip the boilerplate site suffix sites tack onto a title
 *  (" - Watch on Anikage", " | SomeSite", " - Watch online"). Pure. */
export function cleanTitle(raw: string): string {
  let t = (raw || '').trim();
  t = t.replace(/\s*[-|–—]\s*watch\s+(online|on)\b.*$/i, '');
  t = t.replace(/\s*\|\s*[^|]{1,40}$/, '');
  return t.trim() || (raw || '').trim();
}

/** Make a title safe to use as a Windows filename. Pure. */
export function sanitizeFilename(name: string): string {
  const s = (name || '')
    .replace(RESERVED, ' ')        // reserved chars → space
    .replace(/[-\s]+/g, '_')       // runs of space/hyphen → single underscore
    .replace(/^[_.]+|[_.]+$/g, '') // trim leading/trailing _ or .
    .slice(0, 150)
    .replace(/[_.]+$/g, '');
  return s || 'video';
}

/** Extract title + thumbnail from page HTML (OG tags first, then twitter, then
 *  <title>). Pure — unit-tested without a network round-trip. */
export function extractMeta(html: string): PageMetaInfo {
  const $ = cheerio.load(html || '');
  const title =
    $('meta[property="og:title"]').attr('content') ||
    $('meta[name="twitter:title"]').attr('content') ||
    $('title').first().text() ||
    undefined;
  const thumbnail =
    $('meta[property="og:image"]').attr('content') ||
    $('meta[name="twitter:image"]').attr('content') ||
    undefined;
  return { title: title?.trim() || undefined, thumbnail: thumbnail?.trim() || undefined };
}

export class PageMeta {
  /** Fetch + parse a page's metadata. Best-effort: returns {} on any failure. */
  static async fetch(url: string): Promise<PageMetaInfo> {
    try {
      const r = await axios.get(url, {
        headers: { 'User-Agent': UA },
        timeout: 10000,
        validateStatus: () => true,
        responseType: 'text',
        transformResponse: (d) => d,
      });
      if (r.status >= 400 || typeof r.data !== 'string') return {};
      return extractMeta(r.data);
    } catch {
      return {};
    }
  }
}
