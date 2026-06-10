# iframe Video Scraper - Practical Usage Guide

Real-world examples showing how to use the system prompt effectively.

---

## Scenario 1: Your First Target Site

**What you do:**
1. Visit the site in your browser
2. Right-click video → Inspect → find the `<iframe>` tag
3. Check DevTools Network tab for video requests

**Example HTML you find:**
```html
<div class="video-player">
  <iframe id="player" src="https://embed.example.com/video/abc123"></iframe>
</div>
```

**What you ask Claude:**
```
I want to scrape video URLs from example.com.

Here's the iframe structure:
<iframe id="player" src="https://embed.example.com/video/abc123"></iframe>

The iframe src is visible in the page HTML. When I open the iframe URL in DevTools,
I see a <video> tag with src="https://cdn.example.com/video.mp4"

How should I extract the video URL? Show me a Python script using the simplest approach.
```

**Claude will:**
1. Recognize this is a static iframe with direct MP4
2. Suggest using `requests` + `BeautifulSoup` OR `yt-dlp`
3. Provide working code skeleton
4. Explain pros/cons of each approach

**Typical response:**
```python
# Option 1: Direct (fastest for this case)
from bs4 import BeautifulSoup
import requests

url = "https://example.com/video-page"
html = requests.get(url).text
soup = BeautifulSoup(html, 'html.parser')

iframe_src = soup.find('iframe')['src']
print(f"Iframe URL: {iframe_src}")

# Option 2: Auto-resolve with yt-dlp (handles redirects)
import yt_dlp
with yt_dlp.YoutubeDL({'quiet': True}) as ydl:
    info = ydl.extract_info(url, download=False)
    video_url = info['url']
    print(f"Video URL: {video_url}")
```

---

## Scenario 2: JavaScript-Injected iframe

**What happens:**
You check the HTML, but there's no `<iframe>` tag initially.

```html
<div id="player"></div>
<script>
  // JavaScript dynamically creates the iframe
  loadPlayer('video123');
</script>
```

**What you ask Claude:**
```
The iframe is created by JavaScript, not in the HTML. 

Here's the page structure:
<div id="player"></div>
<script>loadPlayer('video123');</script>

When I look in DevTools after page loads, I see:
<iframe src="https://embed.example.com/xyz"></iframe>

How do I extract the iframe src dynamically using Python?
```

**Claude will:**
1. Tell you that `requests` won't work (no JS execution)
2. Recommend Playwright
3. Provide code that waits for iframe to load, then extracts

**Typical response:**
```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    page.goto("https://example.com/video-page")
    
    # Wait for iframe to be created
    iframe = page.locator("iframe").first
    iframe.wait_for()
    
    # Extract src
    iframe_src = iframe.get_attribute("src")
    print(f"Iframe URL: {iframe_src}")
    
    browser.close()
```

---

## Scenario 3: Nested iframes (The Trickier Case)

**What you discover:**
```
Target Page
  └── <iframe src="https://player.example.com/embed.html">
        └── Inside that iframe:
              <iframe src="https://cdn.example.com/stream.html">
                    └── Inside that iframe:
                          <video src="blob:...">
```

**What you ask Claude:**
```
My target site has nested iframes. Here's what I find:

Main page: https://example.com/video
  - Contains: <iframe src="https://player.example.com/embed.html">
    
Inside player iframe: https://player.example.com/embed.html
  - Contains: <iframe src="https://cdn.example.com/stream.html">
    
Inside stream iframe: https://cdn.example.com/stream.html
  - Contains: <video src="blob:...">

How do I navigate through all three levels to extract the video URL?
```

**Claude will:**
1. Explain how to access frames using Playwright
2. Provide code to iterate through nested frames
3. Show where to intercept network requests

**Typical response:**
```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    page.goto("https://example.com/video")
    
    # Access all frames
    all_frames = page.frames
    print(f"Found {len(all_frames)} frames")
    
    # Try to find video in each frame
    for i, frame in enumerate(all_frames):
        try:
            video_src = frame.locator("video").get_attribute("src")
            if video_src:
                print(f"Found video in frame {i}: {video_src}")
        except:
            pass
    
    browser.close()
```

---

## Scenario 4: Intercepting Network Requests

**What happens:**
You inspect the page, but there's no visible video URL in the HTML/DOM.
The URL must be loaded via XHR/fetch (AJAX).

**What you see in DevTools Network tab:**
```
Request: GET https://cdn.example.com/api/video
Response: {
  "url": "https://cdn.example.com/playlist.m3u8",
  "format": "hls"
}
```

**What you ask Claude:**
```
The video URL is loaded dynamically via an API request. I can see it in 
DevTools Network tab:

Request: GET https://cdn.example.com/api/video
Response body contains: "url": "https://cdn.example.com/playlist.m3u8"

How do I intercept this response in Python to extract the URL?
```

**Claude will:**
1. Explain request/response interception with Playwright
2. Show code using page.on("response")
3. Provide JSON parsing example

**Typical response:**
```python
from playwright.sync_api import sync_playwright
import json

urls = []

def handle_response(response):
    if "api/video" in response.url:
        try:
            data = response.json()
            url = data.get("url")
            if url:
                urls.append(url)
                print(f"Intercepted: {url}")
        except:
            pass

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    
    page.on("response", handle_response)
    page.goto("https://example.com/video-page")
    page.wait_for_load_state("networkidle")
    
    print(f"Found {len(urls)} video URLs")
    browser.close()
```

---

## Scenario 5: Handling Cloudflare / Anti-Bot

**What happens:**
Script works locally, but when deployed, the site blocks it.

```
Error: 403 Forbidden
Page contains: "Checking your browser before accessing..."
```

**What you ask Claude:**
```
The website blocks my Playwright script. I get a Cloudflare challenge page.

Error: HTTP 403 / "Checking your browser"

How do I bypass this detection ethically? The site allows regular users.
```

**Claude will:**
1. Recommend playwright-stealth plugin
2. Show how to install and use it
3. Suggest additional techniques (user-agent rotation, delays)
4. Warn about legal implications

**Typical response:**
```bash
pip install playwright-stealth
```

```python
from playwright.sync_api import sync_playwright
from playwright_stealth import stealth_sync

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    
    # Apply stealth patches
    stealth_sync(page)
    
    # Set realistic user-agent
    page.set_extra_http_headers({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    })
    
    page.goto("https://example.com/video-page")
    # ... rest of code
    
    browser.close()
```

---

## Scenario 6: URL Type Detection and Resolution

**What you extract:**
```
1. https://example.com/video.mp4
2. https://cdn.example.com/stream.m3u8
3. blob:https://player.example.com/uuid-xxx
4. /videos/segment.ts (relative URL)
5. https://example.com/video/xyz (unknown)
```

**What you ask Claude:**
```
I extracted these URLs from different sites. What should I do with each?

1. https://example.com/video.mp4
2. https://cdn.example.com/stream.m3u8
3. blob:https://player.example.com/uuid-xxx
4. /videos/segment.ts
5. https://example.com/video/xyz (appears to be a player page, not direct video)

Which ones can I use directly? Which need processing? Which need resolution?
```

**Claude will:**
1. Classify each URL type
2. Explain what to do with each
3. Provide code for resolution/parsing

**Typical response:**

| URL | Type | Action |
|---|---|---|
| `https://.../video.mp4` | Direct MP4 | Download directly with requests |
| `https://.../stream.m3u8` | HLS Playlist | Parse with m3u8 lib, get segments |
| `blob:...` | In-memory | Use intercepted request body |
| `/videos/segment.ts` | Relative | Resolve with `urljoin(base_url, path)` |
| `https://.../video/xyz` | Unknown | Use `yt-dlp` to resolve |

---

## Scenario 7: Batch Extraction (Multiple Videos)

**What you need:**
Extract video URLs from 100+ videos on a site.

**What you ask Claude:**
```
I want to scrape video URLs from [SITE] at scale.

Site has:
- Video listing page: https://example.com/videos?page=1,2,3...
- Each video has a URL: https://example.com/video/id-123
- Video player uses iframe: <iframe src="https://embed.example.com/...">

Requirements:
- Extract 1000+ video URLs
- Handle pagination
- Rate-limit to be respectful (1 req/sec)
- Save results to CSV
- Handle failures gracefully

Show me the architecture/code skeleton.
```

**Claude will:**
1. Design pagination logic
2. Suggest async approach for speed
3. Provide rate-limiting code
4. Show error handling and logging

**Typical response:**
```python
import asyncio
from playwright.async_api import async_playwright
import csv
import time

async def scrape_video(page, video_url):
    """Extract video URL from a single page."""
    try:
        await page.goto(video_url, timeout=10000)
        iframe = page.locator("iframe").first
        await iframe.wait_for(timeout=5000)
        src = await iframe.get_attribute("src")
        return src
    except Exception as e:
        print(f"Failed {video_url}: {e}")
        return None

async def scrape_batch():
    """Scrape multiple video pages."""
    results = []
    
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        
        # Scrape pages 1-10
        for page_num in range(1, 11):
            page = await browser.new_page()
            list_url = f"https://example.com/videos?page={page_num}"
            
            await page.goto(list_url)
            
            # Get all video links on page
            video_links = await page.locator("a.video-link").get_attribute("href", timeout=5000)
            
            for link in video_links:
                video_url = f"https://example.com{link}"
                iframe_src = await scrape_video(page, video_url)
                if iframe_src:
                    results.append({"video_url": video_url, "iframe_src": iframe_src})
                
                # Rate limit
                await asyncio.sleep(1)
            
            await page.close()
        
        await browser.close()
    
    # Save to CSV
    with open("results.csv", "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["video_url", "iframe_src"])
        writer.writeheader()
        writer.writerows(results)
    
    print(f"Scraped {len(results)} videos")

asyncio.run(scrape_batch())
```

---

## Scenario 8: Debugging a Broken Scraper

**What happens:**
Your scraper worked last week, now it's broken.

```
Error: Could not find iframe
Element not found: video source
Status 403: Access Denied
```

**What you ask Claude:**
```
My scraper stopped working on [SITE]. Here's the error:

Error: Could not find iframe (was working last week)

Code:
[YOUR CODE]

HTML I see now:
[CURRENT HTML SNIPPET]

What changed? How do I fix it?
```

**Claude will:**
1. Ask what changed on the site
2. Suggest debugging steps
3. Offer fixes (updated selectors, new pattern, etc.)

**Common fixes:**
- Selector changed: Update `locator()` to new element
- Anti-bot added: Add stealth plugin
- Structure changed: Adapt frame traversal logic
- Rate-limited: Add delays
- Authentication required: Store and use cookies

---

## Quick Decision Tree

```
Can I extract iframe src from page HTML directly?
├─ YES → Use requests + BeautifulSoup (fast)
└─ NO (JS-injected)
    └─ Use Playwright
        └─ Is video URL in DOM <video src="...">?
            ├─ YES → Extract with locator()
            └─ NO (loaded via API/XHR)
                └─ Intercept with page.on("response")
                    └─ Is it a blob URL?
                        ├─ YES → Use intercepted response body
                        └─ NO → Use yt-dlp for final resolution
```

---

## Tools Cheat Sheet

### When to Use Each Tool

```
yt-dlp       → Know the site / need auto-resolution
Requests     → Static HTML, iframe src visible
BeautifulSoup → Parse static HTML
Playwright   → Dynamic JS, hidden content, custom players
m3u8 lib     → Parse HLS playlists
ffmpeg       → Process video segments
```

### Key Playwright Methods

```python
page.goto(url)                    # Navigate
page.locator("selector").wait_for()   # Wait for element
page.locator("selector").get_attribute("src")  # Get attr
page.frames                       # All frames in page
frame.locator("selector")         # Find in specific frame
page.on("response", handler)      # Intercept responses
page.wait_for_load_state("networkidle")  # Wait for net
```

### Key BeautifulSoup Methods

```python
soup.find("iframe")['src']        # Get iframe src
soup.find("video")['src']         # Get video src
soup.select("div.video iframe")   # CSS selector
soup.find_all("iframe")           # Multiple elements
```

---

## Error Messages and Fixes

| Error | Cause | Fix |
|---|---|---|
| `Element not found` | Selector wrong / element not loaded | Update selector, add wait_for() |
| `403 Forbidden` | Anti-bot detection | Add stealth plugin, user-agent |
| `Connection timeout` | Site too slow / network issue | Increase timeout, add retries |
| `blob:... is not a URL` | Blob URL from memory | Intercept XHR request instead |
| `403 on iframe src` | Cross-origin, CORS blocked | Try Playwright network interception |
| `"Checking your browser"` | Cloudflare challenge | playwright-stealth plugin |

---

## Remember

✅ **Do:**
- Test on one site first before scaling
- Use `--dry-run` or sample extraction to verify
- Add delays between requests (be respectful)
- Check site's robots.txt and ToS
- Handle errors gracefully
- Log extraction progress

❌ **Don't:**
- Spam requests rapidly (rate-limit)
- Bypass DRM/encryption
- Violate copyright
- Ignore site ToS
- Assume structure won't change

---

## Example Full Conversation

```
USER: "I want to scrape video URLs from example.com"

CLAUDE: "Quick questions:
1. Is the iframe src visible in the page HTML?
2. What does DevTools show for network requests?"

USER: "Iframe is JS-injected. I see a GET request to /api/video returning JSON."

CLAUDE: "Perfect. Use Playwright with response interception. Here's the code..."
[provides template]

USER: "Works! But getting 403 on some requests."

CLAUDE: "Site is blocking. Add stealth plugin and delays."
[provides updated code]

USER: "Fixed! Now I need to extract from 500 videos."

CLAUDE: "Use async + pagination. Here's the batch script..."
[provides full async code]

USER: "Deployed and working!"
```

