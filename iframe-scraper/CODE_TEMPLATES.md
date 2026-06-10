# iframe Video Scraper - Code Templates

Use these as starting points when asking Claude for help. Fill in [BRACKETS] with your site info.

---

## Template 1: Static iframe (Fastest)

**Use when:** iframe src is visible in page HTML

```python
import requests
from bs4 import BeautifulSoup

url = "[YOUR_VIDEO_PAGE_URL]"

# Fetch and parse
html = requests.get(url).text
soup = BeautifulSoup(html, 'html.parser')

# Extract iframe src
iframe = soup.find('iframe')
if iframe:
    iframe_src = iframe.get('src')
    print(f"Iframe URL: {iframe_src}")
    
    # Optional: resolve the final video URL
    import yt_dlp
    with yt_dlp.YoutubeDL({'quiet': True}) as ydl:
        info = ydl.extract_info(url, download=False)
        video_url = info.get('url')
        print(f"Video URL: {video_url}")
else:
    print("No iframe found")
```

---

## Template 2: JS-Injected iframe (Medium)

**Use when:** iframe is created by JavaScript

```python
from playwright.sync_api import sync_playwright

url = "[YOUR_VIDEO_PAGE_URL]"

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    page.goto(url)
    
    # Wait for iframe to load
    iframe_locator = page.locator("iframe")
    iframe_locator.wait_for()
    
    # Extract src
    iframe_src = iframe_locator.first.get_attribute("src")
    print(f"Iframe URL: {iframe_src}")
    
    browser.close()
```

---

## Template 3: Nested iframes (Complex)

**Use when:** iframe contains another iframe

```python
from playwright.sync_api import sync_playwright

url = "[YOUR_VIDEO_PAGE_URL]"

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    page.goto(url)
    
    # Find video in any frame
    for frame in page.frames:
        try:
            video_tag = frame.locator("video").first
            video_tag.wait_for(timeout=2000)
            
            video_src = video_tag.get_attribute("src")
            if video_src:
                print(f"Found video: {video_src}")
                break
        except:
            continue
    
    browser.close()
```

---

## Template 4: Network Interception (XHR/API)

**Use when:** Video URL comes from API response

```python
from playwright.sync_api import sync_playwright
import json

url = "[YOUR_VIDEO_PAGE_URL]"
extracted_urls = []

def handle_response(response):
    # Check if this is the request we want
    if "[API_ENDPOINT]" in response.url:  # e.g., "/api/video"
        try:
            data = response.json()
            # Parse based on your API response structure
            video_url = data.get("url") or data.get("video")
            if video_url:
                extracted_urls.append(video_url)
                print(f"Found: {video_url}")
        except:
            pass

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    
    # Set up interception before navigation
    page.on("response", handle_response)
    
    page.goto(url)
    page.wait_for_load_state("networkidle")
    
    print(f"Total URLs found: {len(extracted_urls)}")
    
    browser.close()
```

---

## Template 5: With Anti-Bot Detection

**Use when:** Site blocks Playwright

```python
from playwright.sync_api import sync_playwright
from playwright_stealth import stealth_sync

url = "[YOUR_VIDEO_PAGE_URL]"

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    
    # Apply stealth patches
    stealth_sync(page)
    
    # Set realistic headers
    page.set_extra_http_headers({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    })
    
    page.goto(url)
    
    # Extract as usual
    iframe = page.locator("iframe").first
    iframe.wait_for()
    iframe_src = iframe.get_attribute("src")
    print(f"Iframe: {iframe_src}")
    
    browser.close()
```

---

## Template 6: Batch Extraction (Sync)

**Use when:** Extracting from 10-100 videos

```python
from playwright.sync_api import sync_playwright
import time
import csv

video_pages = [
    "[PAGE_1_URL]",
    "[PAGE_2_URL]",
    "[PAGE_3_URL]",
]

results = []

with sync_playwright() as p:
    browser = p.chromium.launch()
    
    for page_url in video_pages:
        page = browser.new_page()
        
        try:
            page.goto(page_url, timeout=10000)
            
            # Extract iframe
            iframe = page.locator("iframe").first
            iframe.wait_for(timeout=5000)
            iframe_src = iframe.get_attribute("src")
            
            results.append({
                "page": page_url,
                "iframe": iframe_src,
            })
            print(f"✓ {page_url}")
            
        except Exception as e:
            print(f"✗ {page_url}: {e}")
            results.append({
                "page": page_url,
                "iframe": None,
            })
        
        finally:
            page.close()
        
        # Be respectful
        time.sleep(1)
    
    browser.close()

# Save results
with open("results.csv", "w", newline="") as f:
    writer = csv.DictWriter(f, fieldnames=["page", "iframe"])
    writer.writeheader()
    writer.writerows(results)

print(f"Done! Extracted {sum(1 for r in results if r['iframe'])} URLs")
```

---

## Template 7: Batch Extraction (Async - Fast)

**Use when:** Extracting from 100+ videos, need speed

```python
import asyncio
from playwright.async_api import async_playwright
import csv

video_pages = [
    "[PAGE_1_URL]",
    "[PAGE_2_URL]",
    # ... more pages
]

async def extract_from_page(page, url):
    """Extract iframe URL from a single page."""
    try:
        await page.goto(url, timeout=10000)
        iframe = page.locator("iframe").first
        await iframe.wait_for(timeout=5000)
        src = await iframe.get_attribute("src")
        return {"page": url, "iframe": src, "status": "OK"}
    except Exception as e:
        return {"page": url, "iframe": None, "status": str(e)}

async def batch_extract():
    results = []
    
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        
        # Process in parallel (max 5 concurrent)
        sem = asyncio.Semaphore(5)
        
        async def extract_with_limit(url):
            async with sem:
                page = await browser.new_page()
                result = await extract_from_page(page, url)
                await page.close()
                print(f"✓ {url[:50]}... - {result['status']}")
                return result
        
        tasks = [extract_with_limit(url) for url in video_pages]
        results = await asyncio.gather(*tasks)
        
        await browser.close()
    
    # Save results
    with open("results.csv", "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["page", "iframe", "status"])
        writer.writeheader()
        writer.writerows(results)
    
    success = sum(1 for r in results if r["iframe"])
    print(f"\nDone! Extracted {success}/{len(results)} URLs")

# Run
asyncio.run(batch_extract())
```

---

## Template 8: Error Handling & Logging

**Use when:** You want robust code with debugging

```python
from playwright.sync_api import sync_playwright
import logging
import json
from datetime import datetime

# Setup logging
logging.basicConfig(
    filename='scraper.log',
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)

url = "[YOUR_VIDEO_PAGE_URL]"

try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        
        logging.info(f"Visiting {url}")
        page.goto(url)
        
        # Try multiple selectors
        selectors = ["iframe", "iframe#player", "[class*='player']"]
        iframe_src = None
        
        for selector in selectors:
            try:
                iframe = page.locator(selector).first
                iframe.wait_for(timeout=2000)
                iframe_src = iframe.get_attribute("src")
                logging.info(f"Found with selector: {selector}")
                break
            except:
                continue
        
        if iframe_src:
            logging.info(f"Extracted: {iframe_src}")
            print(f"Success: {iframe_src}")
        else:
            logging.warning(f"No iframe found at {url}")
            print("Failed to find iframe")
        
        browser.close()

except Exception as e:
    logging.error(f"Script failed: {e}", exc_info=True)
    print(f"Error: {e}")
```

---

## Template 9: Direct yt-dlp (Auto-resolve)

**Use when:** You want automatic resolution (simplest)

```python
import yt_dlp

url = "[YOUR_VIDEO_PAGE_URL]"

ydl_opts = {
    'quiet': False,
    'no_warnings': False,
    'extract_flat': 'in_playlist',  # don't download, just extract
}

try:
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)
        
        # Extract relevant info
        print(f"Title: {info.get('title')}")
        print(f"Duration: {info.get('duration')} seconds")
        print(f"URL: {info.get('url')}")
        
        # Save to JSON
        import json
        with open('info.json', 'w') as f:
            json.dump(info, f, indent=2, default=str)

except Exception as e:
    print(f"Failed: {e}")
```

---

## Template 10: Debugging (When nothing works)

**Use when:** Your script isn't finding what you expect

```python
from playwright.sync_api import sync_playwright

url = "[YOUR_VIDEO_PAGE_URL]"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=False)  # Open browser window
    page = browser.new_page()
    
    page.goto(url)
    
    # Debug: print all available frames
    print(f"Total frames: {len(page.frames)}")
    for i, frame in enumerate(page.frames):
        print(f"Frame {i}: {frame.url}")
    
    # Debug: find all iframes
    all_iframes = page.locator("iframe")
    count = all_iframes.count()
    print(f"\nTotal iframes: {count}")
    for i in range(count):
        src = all_iframes.nth(i).get_attribute("src")
        print(f"  Iframe {i}: {src}")
    
    # Debug: find all videos
    all_videos = page.locator("video")
    count = all_videos.count()
    print(f"\nTotal videos: {count}")
    for i in range(count):
        src = all_videos.nth(i).get_attribute("src")
        print(f"  Video {i}: {src}")
    
    # Debug: check network requests
    print("\nMonitoring network... (keeping browser open for 5 seconds)")
    import time
    time.sleep(5)
    
    browser.close()
```

---

## Installation Command

```bash
# Basic
pip install playwright yt-dlp beautifulsoup4

# With anti-bot
pip install playwright yt-dlp beautifulsoup4 playwright-stealth

# For batch async
pip install playwright yt-dlp beautifulsoup4 aiofiles

# Full setup
pip install -r requirements.txt

# Setup Playwright
playwright install chromium
```

---

## Which Template to Use?

| Situation | Template |
|---|---|
| iframe src visible in HTML | #1 (Static) |
| iframe created by JS | #2 (JS-Injected) |
| iframe inside iframe | #3 (Nested) |
| Video URL in API response | #4 (Network Interception) |
| Site blocks Playwright | #5 (Anti-Bot) |
| 10-100 videos | #6 (Sync Batch) |
| 100+ videos, need speed | #7 (Async Batch) |
| Want robust code | #8 (Error Handling) |
| Just want it to work | #9 (yt-dlp) |
| Script not working | #10 (Debug) |

---

## How to Use These

1. **Copy the template** that matches your situation
2. **Fill in [BRACKETS]** with your site/page URLs
3. **Test on ONE page** first
4. **If it fails**, paste your code + error into Claude prompt
5. **Claude will help debug** or suggest a different approach

