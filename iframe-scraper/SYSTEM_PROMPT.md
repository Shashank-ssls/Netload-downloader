# System Prompt for iframe Video URL Scraper

Use this prompt when working with Claude or other LLMs to build/debug video URL extraction from iframe-embedded players.

---

## Core System Prompt

```
You are an expert in web scraping, iframe player architectures, and video streaming protocols. Your role is to help extract video URLs from websites that embed players in iframes.

You have deep knowledge of:
- HTML iframe structures and nested frame hierarchies
- JavaScript player frameworks (Flowplayer, JW Player, HLS.js, Shaka Player, etc.)
- Network request interception and XHR/fetch APIs
- Browser automation (Playwright, Selenium) and their capabilities
- Video URL patterns (direct .mp4, HLS .m3u8, DASH .mpd, blob URLs)
- Stream resolution techniques (yt-dlp, ffmpeg, direct HTTP)
- Common anti-scraping techniques and how to bypass them ethically
- Cross-origin iframe restrictions and CORS policies

When analyzing scraping challenges:
1. Identify iframe structure (static src vs. JS-injected vs. nested)
2. Determine URL type (direct MP4, HLS/DASH manifest, blob URL, encrypted)
3. Recommend the appropriate extraction tool (yt-dlp vs. Playwright vs. hybrid)
4. Account for anti-bot protections and suggest ethical workarounds
5. Provide concrete extraction patterns and code strategies

Always explain your approach clearly and prioritize ethical, legal scraping methods.
```

---

## Use Case 1: Identifying iframe Structure

### User Prompt:
```
I need to extract video URLs from [WEBSITE]. Here's the page HTML:

[PASTE HTML SNIPPET SHOWING IFRAME]

Is the video URL in the iframe src directly, or is it loaded by JavaScript?
How should I extract it?
```

### Expected Claude Response:
Claude will:
1. Analyze the HTML structure
2. Identify if iframe is static or JS-injected
3. Suggest extraction method (direct parsing vs. Playwright)
4. Provide code skeleton
5. Warn about any CORS or cross-origin issues

---

## Use Case 2: Choosing the Right Tool

### User Prompt:
```
I'm trying to scrape video URLs from [WEBSITE]. Which tool should I use?

Site details:
- Uses iframe player: [YES/NO]
- Player framework: [if known]
- URL type: Direct MP4 / HLS playlist / Unknown
- Anti-bot protection: [YES/NO, any details?]
- Scale needed: Single video / 100s / 1000s

Should I use yt-dlp, Playwright, or both?
```

### Expected Claude Response:
Claude will:
1. Assess site complexity
2. Recommend primary tool (yt-dlp if supported, Playwright for custom players)
3. Explain tradeoffs (speed vs. compatibility)
4. Suggest fallback strategies
5. Rate difficulty level (1-10)

---

## Use Case 3: Handling Nested iframes

### User Prompt:
```
My target site has this iframe structure:

Page HTML
  └── <iframe src="https://embed.example.com/player.html">
        └── [inside embed player]
          └── <iframe src="https://cdn.example.com/stream.html">
                └── <video src="blob:https://...">

How do I navigate through nested iframes to reach the video?
```

### Expected Claude Response:
Claude will:
1. Explain nested frame traversal with Playwright
2. Show code for accessing frames at each level
3. Suggest where to intercept network requests
4. Provide debugging tips

---

## Use Case 4: Network Interception Strategy

### User Prompt:
```
I'm using Playwright to scrape [WEBSITE]. The iframe loads, but I can't 
find the video URL in the DOM. I think it's loaded via XHR/fetch.

How do I intercept network requests to find the video URL?
```

### Expected Claude Response:
Claude will:
1. Explain request/response interception
2. Show code using page.on("request") and page.on("response")
3. Suggest filters to catch only media requests (.m3u8, .mp4, etc.)
4. Help parse response bodies if needed

---

## Use Case 5: Handling Blob URLs

### User Prompt:
```
The video URL is a blob URL (blob:https://player.example.com/uuid-123).
I can't fetch blob URLs directly. How do I get the actual stream URL?
```

### Expected Claude Response:
Claude will:
1. Explain that blob URLs are in-memory only
2. Suggest intercepting the XHR/fetch that created the blob
3. Show code to parse the response body
4. Provide fallback strategies

---

## Use Case 6: Anti-Bot Detection Bypass

### User Prompt:
```
The website blocks my scraper:
- Blocking request user-agent
- Blocking Playwright/Selenium detection
- Using Cloudflare protection

How do I bypass this ethically and legally?
```

### Expected Claude Response:
Claude will:
1. Recommend playwright-stealth plugin
2. Suggest rotating user-agents
3. Advise on delay/rate-limiting to appear human
4. Warn about legal/ToS implications
5. Suggest proxy rotation if appropriate

---

## Use Case 7: Debugging Extraction Failures

### User Prompt:
```
My script works on [WEBSITE A] but fails on [WEBSITE B]. 
Here's the error: [ERROR MESSAGE]

Page URL: [URL]
HTML structure: [SNIPPET]
My code: [CODE SNIPPET]

Why is it failing?
```

### Expected Claude Response:
Claude will:
1. Analyze error message and code
2. Identify common failure patterns:
   - Wrong selector/locator
   - Timing issue (element not loaded yet)
   - Cross-origin/CORS blocking
   - Wrong extraction method for URL type
3. Suggest fixes with code examples

---

## Use Case 8: URL Validation and Resolution

### User Prompt:
```
I extracted these URLs from the page:
1. https://example.com/video.mp4
2. https://cdn.example.com/playlist.m3u8
3. blob:https://player.example.com/uuid
4. data:video/mp4;base64,...

Which ones are valid? How do I resolve relative URLs? 
What should I do with each type?
```

### Expected Claude Response:
Claude will:
1. Classify each URL type
2. Explain validity (direct vs. requires resolution)
3. Show code for yt-dlp resolution
4. Explain m3u8 parsing for HLS playlists

---

## Prompt Patterns for Common Tasks

### Pattern A: Tool Selection
```
Website: [NAME/URL]
Player type: [IFRAME/CUSTOM/UNKNOWN]
URL pattern: [DIRECT MP4 / HLS / DASH / UNKNOWN]
Scale: [SINGLE / BATCH / BULK]
Anti-bot: [NONE / BASIC / ADVANCED]

Which tool(s) should I use? Show pros/cons and code skeleton.
```

### Pattern B: Frame Navigation
```
My target video is in a nested iframe. Here's the structure:

[PASTE FRAME HIERARCHY]

Show me the Playwright code to access it and extract the URL.
```

### Pattern C: Network Interception
```
The video URL is loaded dynamically. I can see it in DevTools Network tab.
[PASTE NETWORK REQUEST DETAILS]

Show me how to intercept this with Playwright.
```

### Pattern D: Extraction Failure Debug
```
My script fails on [WEBSITE]. Here's what I tried:

[CODE]

Error: [ERROR MESSAGE / UNEXPECTED BEHAVIOR]

Why isn't it working? What should I try instead?
```

### Pattern E: Batch Extraction
```
I need to extract video URLs from [NUMBER] pages of [WEBSITE].

URL pattern: [EXAMPLE URLS]
Page structure: [DESCRIPTION / HTML SNIPPET]

Show me:
1. Async Playwright script for batch extraction
2. How to handle rate-limiting
3. Error handling for failed pages
4. How to save results to file
```

### Pattern F: Stream Resolution
```
I have this URL: [URL]
It might be:
- Direct MP4
- HLS playlist
- DASH manifest
- Encrypted/protected

How do I determine its type and get the actual playable URL?
```

---

## Integration Examples

### Scenario A: Single-Site Scraper

```
User: "I want to scrape videos from [SITE]. Can you build the full script?"

Claude should:
1. Ask about iframe structure
2. Ask about URL type
3. Ask about anti-bot measures
4. Ask about volume needed
5. Provide complete working script with:
   - HTML parsing
   - iframe detection
   - Network interception
   - Error handling
   - Comments explaining each step
```

### Scenario B: Multi-Site Scraper (more complex)

```
User: "Build a scraper that works on [SITE1], [SITE2], [SITE3]."

Claude should:
1. Ask about what differs between sites
2. Ask about commonalities
3. Design modular architecture with:
   - Site-specific adapters
   - Shared network/iframe utilities
   - Factory pattern for tool selection
4. Provide code with examples
```

### Scenario C: Scraper Maintenance

```
User: "My scraper stopped working on [SITE]. Here's the error: [ERROR]"

Claude should:
1. Ask about recent changes to site
2. Suggest debugging steps
3. Offer fixes (updated selectors, new pattern recognition, etc.)
4. Suggest monitoring strategy to catch future breaks
```

---

## Key Technical Context

### Tools and Their Strengths

| Tool | Best For | Weakness |
|---|---|---|
| **yt-dlp** | 1000+ known sites, auto-resolution | Fails on custom/unknown players |
| **Playwright** | Dynamic JS, custom players, complex flows | Slower, more resource-heavy |
| **BeautifulSoup** | Static HTML, iframe src extraction | Can't handle JS-injected content |
| **Requests** | Direct HTTP, speed | No JS execution |
| **m3u8 lib** | HLS playlist parsing | Needs manifest URL first |

### URL Types You'll Encounter

```
1. Direct MP4
   https://cdn.example.com/video.mp4
   → Use requests or yt-dlp, can download directly

2. HLS Playlist (.m3u8)
   https://cdn.example.com/stream/master.m3u8
   → Parse with m3u8 lib, get segment URLs, stitch with ffmpeg

3. DASH Manifest (.mpd)
   https://cdn.example.com/stream.mpd
   → Parse with Python mpd parsing lib, complex

4. Blob URL
   blob:https://player.example.com/uuid-123
   → In-memory only, intercept request that created it

5. Relative URLs
   /videos/segment-001.ts
   → Resolve against base URL: urljoin(base, relative)
```

### Anti-Bot Techniques and Ethical Workarounds

| Technique | What Sites Do | Ethical Workaround |
|---|---|---|
| User-Agent check | Block known bots | Rotate real user-agents |
| JavaScript execution | Render dynamic content | Use Playwright/browser |
| Cloudflare challenge | Require proof-of-work | playwright-stealth plugin |
| Rate-limiting | Ban fast requests | Add delays between requests |
| IP blocking | Ban certain IPs | Rotate through proxies |
| Honeypots | Detect crawlers | Avoid trap URLs |

**Always respect robots.txt and site ToS.**

---

## What NOT to Ask Claude For

❌ **Don't ask for:**
- Bypassing DRM/encryption (legal issues)
- Circumventing paywall authentication (licensing violation)
- Extracting copyrighted content for redistribution
- Methods to avoid being detected by site security
- Scraping sites that explicitly forbid it in ToS

✅ **DO ask for:**
- How to extract URLs efficiently and ethically
- Debugging extraction failures
- Optimizing Playwright for performance
- Handling CORS and frame restrictions
- Rate-limiting and respectful crawling practices

---

## Quick Reference Checklist

Before asking Claude, gather:

- [ ] Target website URL(s)
- [ ] HTML snippet showing iframe structure
- [ ] Whether iframe src is static or JS-injected
- [ ] What you see in DevTools Network tab (video requests)
- [ ] Any error messages from your script
- [ ] Whether site has anti-bot protection
- [ ] How many videos you need to scrape
- [ ] Your current code (if debugging)

---

## Example Conversation Flow

```
USER: "I want to extract video URLs from example.com"

CLAUDE: "Is the video URL in the iframe src attribute, or loaded by JavaScript?"

USER: "Here's the HTML... it's loaded by JS"

CLAUDE: "You'll need Playwright. Does the site block Playwright detection?"

USER: "I don't know, let me check... it seems to block it"

CLAUDE: "Add playwright-stealth plugin. Here's the code skeleton..."

USER: "I tried, but the video URL is a blob URL"

CLAUDE: "Intercept the fetch/XHR request that loads the blob. 
         Here's code using page.on('response')..."

USER: "Got it! The URL is now in the response body. It's an .m3u8 file"

CLAUDE: "Perfect! That's an HLS playlist. Use the m3u8 library to parse it.
         Here's the next step..."
```

---

## Remember

- **Iframe structure varies widely** — ask Claude to analyze your specific HTML
- **Tool selection matters** — yt-dlp is fast but limited; Playwright is slow but flexible
- **Network interception is powerful** — when DOM parsing fails, intercept requests
- **Blob URLs require special handling** — can't fetch them directly
- **Anti-bot is normal** — use ethical workarounds (stealth plugins, delays, proxies)
- **Test on one site first** — then scale to multiple sites with adapters
```

