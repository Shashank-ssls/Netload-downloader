# Further Upgrades — extending reach to NEW / unknown sites

**Goal of this doc:** features/changes to make netload-downloader handle *more sites that are
new to it*, without adding per-site code. Guiding principle (unchanged from the project's whole
trajectory): improve the **generic mechanisms** so they cover more delivery patterns, keep
graceful fallback, no DRM, and validate reactively via the reach corpus (`npm run corpus`).

Everything below was verified against the code (file:line references are current as of this
writing). Ordered roughly by leverage.

---

## The 3 biggest reach limiters (verified gaps)

> **STATUS (updated):** #1 ✅, #5 ✅, #2 ✅, #4 ✅, #3 ✅, #6 ✅ (commits 5a2db15,
> 85290de, 411ad8a, be45ff5, ba0644f, 7f30fce). All six numbered roadmap items are
> done; only the smaller/opportunistic items below remain — do those reactively as
> real corpus failures surface them.

### 1. Tier-2 capture is URL-pattern-gated — opaque media URLs slip through entirely  ⭐ deepest fix  ✅ DONE
- **Where:** `src/extractors/fallbackExtractor.ts:34-49` (`STREAM_URL_PATTERNS`) + the capture
  filter in `extractTier2`. A request is only recorded if its URL contains `.m3u8` / `.mp4` /
  `/hls/` / `/dash/` / `/stream/` or a few **hardcoded CDN names** (`sprintcdn`, `ultracloud`,
  `cdnfile`, `delivery.cdn`, `akamaized`, `cloudfront`).
- **Problem:** a new site whose media URLs are opaque tokens with none of those substrings is
  **never even captured** — and nothing downstream (ranking, stitching, ffmpeg) can run on what
  we didn't see. (anikage only worked because it happened to use `/stream/`.) Reach on unknown
  sites is bottlenecked here, at capture.
- **Fix:** make capture **content-based, not name-based**. For `xhr`/`fetch`/`media`/`other`
  responses, classify as media by **Content-Type** (`video/*`, `application/vnd.apple.mpegurl`,
  `application/dash+xml`, `video/mp2t`, `application/octet-stream`) **and/or first-bytes
  signature** (`0x47` MPEG-TS sync byte, `ftyp`/`moov` for MP4/fMP4, `#EXTM3U`, `<MPD`). Keep the
  URL patterns as a cheap fast-path hint, but fall back to content sniffing so unknown CDNs are
  caught. This is the single highest-leverage change for "deal with sites new to it."

### 2. No MSE / `appendBuffer` interception  ✅ DONE
- **Where:** confirmed zero matches for `appendBuffer|MediaSource|SourceBuffer` in `src`. The
  in-page hook in `src/extractors/segmentStitcher.ts` (`captureViaPlaylist`'s `addInitScript`)
  taps `Blob` / `fetch` / `XHR` for `#EXTM3U` only.
- **Problem:** a growing class of players decrypt segments in JS and feed them straight to the
  video element via `SourceBuffer.prototype.appendBuffer()`. The `<video>` has a `blob:` src and
  there is **nothing useful on the network**. Our playlist hook misses this entirely.
- **Fix:** extend the `addInitScript` hook to wrap `SourceBuffer.prototype.appendBuffer`, capture
  the raw appended `ArrayBuffer`s in order (with their `SourceBuffer` mime type), then mux/concat
  with ffmpeg. Natural successor to the anikage playlist-intercept; covers "video plays but
  nothing downloads."

### 3. DASH (`.mpd`) is detected but never downloaded  ✅ DONE
- **Where:** `.mpd` appears only for scoring + duration probing
  (`fallbackExtractor.ts:197, 393, 566`; `probeDashDuration`). It is never reassembled/downloaded.
- **Problem:** DASH is the #2 manifest format and common on newer sites; today they fall through.
- **Fix:** route an intercepted `.mpd` through **ffmpeg** exactly like R1 routes HLS (serve via
  the ephemeral 127.0.0.1 http server, `ffmpeg -i .../manifest.mpd -c copy …`; ffmpeg handles
  DASH SegmentTemplate/Timeline natively). Also extend the intercept hook to scan for `<MPD`
  (today it only scans for `#EXTM3U`).

---

## High-value supporting work

### 4. yt-dlp freshness is manual only  ✅ DONE
- **Where:** only `setInterval`s are temp-cleanup (`index.ts:308`) and the WS heartbeat
  (`progress.ts:15`). Self-update exists but is manual via `POST /api/update/ytdlp`.
- **Problem:** yt-dlp adds/fixes extractors almost daily; a stale binary silently loses native
  reach (the cheapest reach of all).
- **Fix:** scheduled auto-update (on startup + weekly), optionally support yt-dlp's nightly/master
  channel and a plugins directory. Report version in `/api/health` (already done) so drift is
  visible.

### 5. A `diagnose` / inspect mode  ⭐ force-multiplier  ✅ DONE
- **Idea:** when a new site fails, open it headless and dump **everything** to a report: every
  request (URL + resource type + Content-Type + first bytes), detected `<video>`/player globals,
  Blob/MSE activity, and the full iframe chain.
- **Why:** turns "why didn't this work?" from an hour of log-reading into minutes, and makes
  *every subsequent* new site faster to onboard. Feeds straight into the reach corpus. Smartest
  infrastructure investment here.
- **Shape:** a `netload diagnose <url>` CLI subcommand + `POST /api/diagnose` returning the report
  JSON (reuse the Tier-2 browser plumbing, just log instead of filter).

### 6. Structural embed/player detection (beyond the hostname list)  ✅ DONE
- **Where:** `KNOWN_EMBEDDER_HOSTNAMES` in `fallbackExtractor.ts` is a hardcoded allowlist.
- **Fix:** detect a frame as a *player frame* by **structure** — contains a `<video>`, emits
  stream traffic, or exposes known player globals (`jwplayer`, `videojs`, `Hls`, `dashjs`, `Plyr`)
  — rather than by domain, so unknown embedders get followed automatically.

---

## Smaller / opportunistic  ✅ ALL DONE (commit 19a5ae4)

- **Master-playlist variant follow:** ✅ `segmentStitcher.ts`'s in-page playlist intercept now
  reuses `FallbackExtractor.pickBestVariant` (made public) to follow a captured master →
  highest-bandwidth media playlist (fetched with the player's headers, normalized against the
  variant's base).
- **Impersonation escalation in recovery:** ✅ `CloudflareRecoveryManager.cycleImpersonateTarget`
  rotates `--impersonate` through `chrome`/`safari`/`edge` on retries instead of a fixed target.
- **Interactive cookie harvesting:** ✅ `utils/cookieHarvester.ts` persists the stealth context's
  cookies as a per-site Netscape `cookies.txt` after Tier 2 render (never clobbers an existing
  file); `CookieResolver` then reuses them. (The one-time *interactive login* UX is not built —
  this is the automatic harvest-after-render mechanism.)
- **Lean on yt-dlp's generic extractor:** ✅ a non-generic provider whose dedicated extractor fails
  gets one cheap `--force-generic-extractor` run (with the player's headers + impersonation) BEFORE
  Chromium (`genericExtractorArgs`, gated once).

Everything in this roadmap is now implemented. Further work is reactive — driven by real corpus
failures (`npm run corpus`).

---

## Recommended sequencing

1. **#1 (content-based capture) + #5 (diagnose mode)** — they compound: #1 catches more sites
   automatically; #5 makes the ones it doesn't catch fast to onboard.
2. **#2 (MSE/appendBuffer)** — flagship feature for the actively-growing delivery pattern.
3. **#4 (yt-dlp freshness)** — near-free, broad; do alongside.
4. **#3 (DASH)** — closes the second manifest format.
5. Then the smaller items as real corpus failures surface them.

**Most important takeaway:** #1 is the deepest fix. Reach on unknown sites is bottlenecked at
*capture* — if we can't see the media request, nothing downstream matters. Making capture
content-based instead of URL-pattern-based most directly answers "deal with sites new to it."

---

## How to validate any of these
`cd backend` → `npm run typecheck && npm run lint && npm test`, then a live run
(`npm run dev` → analyze/download a real site → ffprobe the result), then `npm run corpus`
(add representative URLs of the newly-supported sites to your local, gitignored
`backend/corpus/urls.json`). Commit per change; no Co-Authored-By trailer.
