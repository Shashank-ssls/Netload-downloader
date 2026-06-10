# iframe Video Scraping — Technical Notes (Ground Truth)

The rest of this collection teaches you *how to ask an LLM*. This file gives the
**actual answers** so you don't have to round-trip for the fundamentals. Use it
as the reference the prompts point toward.

---

## 1. The four iframe delivery patterns

| Pattern | How to recognise it | Extraction approach |
|---|---|---|
| **Static `src`** | `<iframe src="https://...">` present in `view-source:` | `requests` + `BeautifulSoup`; read the attribute |
| **JS-injected** | iframe absent from raw HTML, appears in DevTools Elements | Render with Playwright, then read the live DOM |
| **Nested** | iframe whose document contains another iframe | Iterate `page.frames()`; don't assume one level |
| **API-driven** | player calls an endpoint that returns the stream URL as JSON | Intercept the network response, not the DOM |

The reliable order of attack: **static → rendered DOM → network interception**.
Most "the URL isn't in the HTML" problems are solved by network interception,
not by fighting the DOM.

---

## 2. Video URL types and what to do with each

| Type | Looks like | Action |
|---|---|---|
| Direct MP4 | `https://cdn/.../file.mp4` | Stream it with `requests` (send `Range` if resumable) |
| HLS | `.../master.m3u8` | Fetch master → pick variant → download `.ts`/`.m4s` segments → concat |
| DASH | `.../manifest.mpd` | Parse the MPD, fetch init + media segments per representation |
| **Blob** | `blob:https://site/uuid` | **Not fetchable.** It's an in-memory MSE handle. Find the real `.m3u8`/`.mpd`/segment requests in the Network tab and use those. |
| Unknown / many sites | a watch page URL | Let `yt-dlp` resolve it before writing custom code |

**Key point about blob URLs:** a `blob:` value is created by
`URL.createObjectURL()` over a `MediaSource`. The bytes are assembled in the
browser from segment requests the player already made. You capture *those*
requests — the blob itself has no server behind it.

---

## 3. Network interception is the workhorse

When the URL isn't in the DOM, hook requests instead of scraping markup:

```python
# Playwright (sync) — capture the manifest/segment request the player fires
from playwright.sync_api import sync_playwright

STREAM_HINTS = (".m3u8", ".mpd", ".mp4")
captured = []

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.on("request", lambda r: captured.append(r.url)
            if any(h in r.url for h in STREAM_HINTS) else None)
    page.goto("https://example.com/watch/123", wait_until="domcontentloaded")
    page.wait_for_timeout(3000)          # let the player initialise
    # Many players only fetch the manifest after a play interaction:
    page.locator("video, .play, .vjs-big-play-button").first.click(timeout=3000)
    page.wait_for_timeout(3000)
    browser.close()

print([u for u in captured if ".m3u8" in u] or captured)
```

Capture **`.ts`/`.m4s` segment requests too** — their shared path prefix often
reveals the manifest URL even when the manifest request itself is missed. Grab
the request **headers** (`Referer`, `Origin`, `Authorization`, cookies) at the
same time; CDN URLs frequently 403 without them.

---

## 4. Anti-bot reality check

- **Detection signals:** HTTP 403/503, "Just a moment…", `cf-chl` cookies,
  Turnstile/hCaptcha widgets, `navigator.webdriver === true`.
- **What helps:** a stealth plugin to mask automation fingerprints, a realistic
  User-Agent that *matches* the browser you actually launch, real viewport,
  human-like delays, and reusing a warmed-up context/cookies.
- **What doesn't:** spoofing a Chrome UA on a headless build with a mismatched
  `Sec-CH-UA`, or hammering without delays. Inconsistent fingerprints are a
  stronger bot signal than no spoofing at all.
- **Turnstile/hCaptcha** interactive challenges are not reliably solvable by
  automation. Budget for failure and fall back gracefully rather than assuming
  a bypass.

---

## 5. Common failure modes (and the real cause)

| Symptom | Usual cause | Fix |
|---|---|---|
| `iframe.get_attribute("src")` returns `None` | read before JS injected it | `wait_for_selector` / render first |
| Can read iframe but not its contents | cross-origin frame | switch to `page.frames()` / network interception |
| Manifest 403s when you fetch it | missing `Referer`/`Origin`/cookies | replay the captured request headers |
| Works once, then blocked | rate/fingerprint flagged | delays, rotate context, reuse cookies |
| `.m3u8` downloads but won't play | relative segment URIs not resolved | `urljoin` each segment against the playlist URL |
| Only audio or wrong resolution | picked the wrong variant | sort master playlist by bandwidth/resolution |

---

## 6. When to stop writing custom code

Try `yt-dlp <url>` **first**. It already handles 1000+ sites, variant
selection, segment download, header replay, and merging. Only drop to Playwright
interception when yt-dlp reports `Unsupported URL` or the player is a bespoke
embed it doesn't recognise. Reaching for a headless browser on a site yt-dlp
already supports is the most common time sink in this whole problem space.
