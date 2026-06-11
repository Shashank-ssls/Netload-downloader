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

/** Strip the boilerplate sites tack onto a title — a leading "Watch ", a trailing
 *  "- Watch on Anikage" / "| SomeSite" / "- site.tld" suffix. Pure. */
export function cleanTitle(raw: string): string {
  let t = (raw || '').trim();
  t = t.replace(/\s*[-|–—]\s*watch\s+(online|on)\b.*$/i, '');     // "- Watch on/online …"
  t = t.replace(/\s*[-|–—]\s*[\w-]+\.[a-z]{2,6}\s*$/i, '');        // trailing "- hanime.tv"
  t = t.replace(/\s*\|\s*[^|]{1,40}$/, '');                        // trailing "| SiteName"
  t = t.replace(/^\s*watch\s+/i, '');                             // leading "Watch "
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

/** Pull the first image URL embedded in a string (e.g. a player-iframe URL that
 *  carries the poster as a query param, often percent-encoded). Returns '' if none.
 *  Pure — unit-tested. Used only for trusted same-site frames, so it's safe to trust. */
export function extractImageUrlFromText(text: string): string {
  if (!text) return '';
  let decoded = text;
  try { decoded = decodeURIComponent(text); } catch { /* keep raw on malformed % */ }
  const m = /https?:\/\/[^\s,'"<>()]+\.(?:webp|jpe?g|png|gif)(?:\?[^\s,'"<>()]*)?/i.exec(decoded);
  return m ? m[0] : '';
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

// Metadata read from a page's RENDERED DOM (during a Tier 2 browser pass), keyed by
// URL. SPAs like hanime.tv inject og:image/og:title via JS, so a static HTML fetch
// sees nothing — but the browser fallback already renders the page, so we stash what
// it sees here and let fetch() prefer it. Bounded FIFO so it can't grow unbounded.
const RENDERED_CACHE = new Map<string, PageMetaInfo>();
const RENDERED_CACHE_MAX = 50;

export class PageMeta {
  /** Record metadata observed in a page's rendered DOM (Tier 2). Non-empty fields
   *  only; merges with anything already remembered for the URL. */
  static remember(url: string, info: PageMetaInfo): void {
    if (!url || !info || (!info.title && !info.thumbnail)) return;
    const prev = RENDERED_CACHE.get(url) || {};
    const merged: PageMetaInfo = {
      title: info.title || prev.title,
      thumbnail: info.thumbnail || prev.thumbnail,
    };
    RENDERED_CACHE.delete(url); // re-insert to keep FIFO recency
    RENDERED_CACHE.set(url, merged);
    while (RENDERED_CACHE.size > RENDERED_CACHE_MAX) {
      RENDERED_CACHE.delete(RENDERED_CACHE.keys().next().value as string);
    }
  }

  /**
   * Fetch + parse a page's metadata, preferring values seen in the rendered DOM
   * (Tier 2) over the static HTML — so a JS-injected og:image is used when the
   * static fetch has none. Best-effort: returns {} on any failure.
   */
  static async fetch(url: string): Promise<PageMetaInfo> {
    const rendered = RENDERED_CACHE.get(url) || {};
    // Nothing more to gain from a static fetch if the render already gave us both.
    if (rendered.title && rendered.thumbnail) return rendered;

    let staticMeta: PageMetaInfo = {};
    try {
      const r = await axios.get(url, {
        headers: { 'User-Agent': UA },
        timeout: 10000,
        validateStatus: () => true,
        responseType: 'text',
        transformResponse: (d) => d,
      });
      if (r.status < 400 && typeof r.data === 'string') staticMeta = extractMeta(r.data);
    } catch {
      /* fall back to whatever the render gave us */
    }
    return {
      title: rendered.title || staticMeta.title,
      thumbnail: rendered.thumbnail || staticMeta.thumbnail,
    };
  }
}
