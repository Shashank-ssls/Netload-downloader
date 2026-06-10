# iframe Video Scraper - Quick Reference Card

**Use this when you need to ask Claude about scraping video URLs from iframes.**

---

## 30-Second Prompt Template

```
Website: [SITE NAME/URL]

Iframe structure:
[PASTE HTML SHOWING IFRAME]

Video URL location:
- Is it in iframe src? [YES/NO]
- Is it in <video src>? [YES/NO]
- How is it loaded? [STATIC HTML / JAVASCRIPT / API]

What I've tried:
[YOUR CODE / APPROACH]

Question:
[WHAT DO YOU NEED HELP WITH?]
```

---

## Common Question Templates

### "Which tool should I use?"
```
Website: [NAME]
Iframe: Static src visible / JS-injected / Nested
Anti-bot: None / Cloudflare / Custom
Scale: 1 video / 10 / 1000+

Which tool(s) - yt-dlp, Playwright, requests? Why?
```

### "How do I extract X?"
```
I'm trying to extract: [WHAT YOU WANT]
From: [WEBSITE]
Current approach: [WHAT YOU'VE TRIED]
Problem: [WHAT'S NOT WORKING]

Show me code to do this.
```

### "My scraper is broken"
```
Site: [WEBSITE]
Error: [ERROR MESSAGE]
Code: [YOUR CODE]
When it broke: [WHEN DID THIS START?]

Why is it failing? How do I fix it?
```

### "How do I handle X at scale?"
```
I need to scrape: [NUMBER] videos from [SITE]
Pagination: [HOW PAGES WORK]
Extraction: [ONE IFRAME/COMPLEX STRUCTURE]
Rate-limit: [RESPECTFUL DELAY NEEDED?]

Show me async batch code.
```

---

## What to Paste

✅ **Always include:**
- Website URL
- HTML snippet (iframe structure)
- Error message (if debugging)
- What you've already tried
- Your code (if not working)

✅ **Include for faster response:**
- DevTools Network tab screenshot (shows requests)
- Page structure description
- Whether site has anti-bot
- Scale requirements (1 vs 1000 videos)

---

## Response Checklist

After Claude gives you code, verify:

- [ ] Code is runnable (imports are correct)
- [ ] Has error handling
- [ ] Has comments explaining steps
- [ ] Shows how to extract the URL
- [ ] Suggests next steps

---

## Key Patterns to Mention

| Pattern | Example | Best Claude Question |
|---|---|---|
| Static iframe | `<iframe src="...">` in HTML | "Extract iframe src from static HTML" |
| JS-injected iframe | Created by `<script>` tag | "Extract dynamically-created iframe" |
| Nested frames | Iframe inside iframe | "Navigate nested iframes" |
| API response | URL in JSON response | "Intercept API response to extract URL" |
| Blob URL | `blob:https://...` | "Intercept the manifest behind a blob: video src" |
| Anti-bot | 403, Cloudflare | "Bypass Cloudflare / anti-bot detection" |

---

## Minimal Reproduction Example

If something isn't working, give Claude this:

```python
# What I'm trying to do
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    page.goto("https://example.com/video")
    
    # This doesn't work:
    iframe_src = page.locator("iframe").get_attribute("src")
    print(iframe_src)  # Returns: None
    
    browser.close()

# Question: Why is it returning None?
# HTML I see: <iframe id="player" src="https://..."></iframe>
```

Claude will immediately spot:
- Timing issue (element not loaded yet)
- Wrong selector
- Cross-origin access issue
- Needs different approach

---

## Tool Selection Flowchart (For Claude)

```
"Which tool should I use?"

Is iframe src in the HTML directly?
├─ YES, it's static → requests + BeautifulSoup
├─ NO, it's loaded by JS → Playwright
└─ NO, it's from an API → Playwright + intercept

URL type: MP4 vs .m3u8 vs blob vs unknown?
├─ MP4 → download directly
├─ .m3u8 → parse with m3u8 lib
├─ blob: → CANNOT fetch directly. It's a Media Source Extensions handle.
│         Intercept the underlying .m3u8/.mpd manifest or segment requests
│         in the Network tab instead.
└─ unknown → use yt-dlp

Site has anti-bot detection?
├─ YES → playwright-stealth + delays
└─ NO → plain Playwright

Need 1 video or 1000?
├─ 1-10 → sync Playwright
└─ 100+ → async Playwright
```

---

## Common Mistakes to Avoid

❌ **Don't say:**
- "Extract video URLs" (too vague - from what site?)
- "Make a scraper" (need more details first)
- "Fix my broken code" (need to paste the code)

✅ **Do say:**
- "From example.com, how do I extract the iframe src that's loaded by JavaScript?"
- "Here's my code [PASTE], it returns None instead of the URL. Why?"
- "I need to batch scrape 500 videos. Here's the page structure... show me async code"

---

## Pre-Scraping Checklist

Before asking Claude, do yourself:

1. **Open DevTools (F12) and look at:**
   - HTML source → iframe structure
   - Network tab → what requests load the video URL?
   - Console → any errors?

2. **Ask yourself:**
   - Is iframe src visible in page HTML? YES / NO
   - Is video URL in <video src>? YES / NO / UNKNOWN
   - Does site block bots / scrapers? YES / NO / MAYBE

3. **Note down:**
   - Exact website URL
   - Iframe HTML snippet
   - Network request that carries the video URL (if visible)
   - Error message (if script fails)

4. **Then ask Claude with this info**

---

## Fast Track Questions

### For Beginners
"I've never scraped before. Show me the simplest way to extract the video URL from [SITE]."

### For Speed
"What's the fastest tool to extract URLs from [SITE]? Trade-offs?"

### For Scale
"I need to extract 1000 video URLs from [SITE]. What architecture should I use?"

### For Debugging
"This code fails: [PASTE]. Error: [PASTE]. Why?"

### For Anti-Bot
"Site blocks my scraper. How do I bypass [CLOUDFLARE/403/etc]?"

---

## One-Minute Prompt Template

Copy and fill in:

```
WEBSITE: 
IFRAME VISIBLE IN HTML: YES / NO
URL TYPE: MP4 / HLS / UNKNOWN
ANTI-BOT: NONE / YES
SCALE: [NUMBER] videos

PROBLEM: [YOUR QUESTION]

HTML SNIPPET:
[PASTE]

MY CODE:
[PASTE IF DEBUGGING]

QUESTION: [WHAT DO YOU NEED?]
```

---

## After You Get Claude's Response

1. **Copy the code** into your project
2. **Test on ONE site/video** first
3. **Verify it extracts the URL** correctly
4. **Then scale** to multiple videos
5. **If it breaks**, ask Claude with the error message

---

## Key Takeaways

- **yt-dlp**: Fast, works on 1000+ sites, limited flexibility
- **Playwright**: Slow, works on anything, maximum control
- **Requests**: Very fast, only for static HTML
- **Network interception**: Powerful when DOM doesn't have URL
- **Anti-bot**: Use stealth plugin + delays, don't over-automate

Ask Claude early, ask with examples, iterate together.

