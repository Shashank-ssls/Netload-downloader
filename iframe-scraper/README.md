# iframe Video URL Scraper - Prompt Collection

Complete guide for asking AI models (Claude, Gemini, etc.) how to extract video URLs from iframe-embedded players.

**Mostly prompts and strategies.** For the ground-truth answers (so you don't
have to ask an LLM the fundamentals), see **TECHNICAL_NOTES.md**.

---

## What's Inside

### 1. **SYSTEM_PROMPT.md** ← Start here
The main system prompt to use with Claude/Gemini. Contains:
- Core expertise areas (HLS, SCTE-35, iframe architecture)
- 8 detailed use cases with examples
- Prompt patterns for common tasks
- What NOT to ask
- Integration examples

**How to use:**
- Copy the "Core System Prompt" section
- Paste as your system message when calling Claude API
- OR use as reference when typing free-form questions

### 2. **PROMPT_GUIDE.md**
Real-world scenarios showing how to apply the system prompt:
- Scenario 1: Your first target site
- Scenario 2: JS-injected iframes
- Scenario 3: Nested iframes
- Scenario 4: Network request interception
- Scenario 5: Anti-bot detection bypass
- Scenario 6: URL type detection
- Scenario 7: Batch extraction
- Scenario 8: Debugging broken scrapers

Each scenario includes:
- What you encounter
- What to ask Claude
- What Claude will respond
- Typical code example

**When to use:** Read this when you have a specific problem to solve.

### 3. **QUICK_REFERENCE.md**
Fast prompting cheat sheet:
- 30-second prompt templates
- Common question templates
- What to paste in your prompt
- Response checklist
- Tool selection flowchart
- Common mistakes to avoid

**When to use:** Copy templates when asking quick questions.

### 4. **CODE_TEMPLATES.md**
10 ready-to-use code templates:
1. Static iframe (fastest)
2. JS-injected iframe
3. Nested iframes
4. Network interception
5. Anti-bot detection
6. Batch extraction (sync)
7. Batch extraction (async)
8. Error handling & logging
9. Direct yt-dlp approach
10. Debugging template

Each template includes:
- When to use it
- What to fill in [BRACKETS]
- How it works
- Installation commands

**When to use:** Copy a template as your starting point, then ask Claude for help.

---

## Quick Start (3 Steps)

### Step 1: Understand Your Problem
Read the **PROMPT_GUIDE.md** to find your scenario.

### Step 2: Ask Claude
Use the template from **QUICK_REFERENCE.md** or **CODE_TEMPLATES.md**.

### Step 3: Get Help
Paste your code + error into Claude using the **SYSTEM_PROMPT.md**.

---

## Workflow

```
┌─────────────────────────────────────────────┐
│ 1. Understand the Problem                   │
│    └─ Read PROMPT_GUIDE.md (your scenario)  │
├─────────────────────────────────────────────┤
│ 2. Ask Claude a Question                    │
│    └─ Use template from QUICK_REFERENCE.md  │
├─────────────────────────────────────────────┤
│ 3. Get Code or Advice                       │
│    └─ Claude provides working solution      │
├─────────────────────────────────────────────┤
│ 4. Code Doesn't Work?                       │
│    └─ Ask again with CODE_TEMPLATES.md      │
└─────────────────────────────────────────────┘
```

---

## Files Explained

| File | Purpose | Read Time |
|---|---|---|
| TECHNICAL_NOTES.md | Ground-truth answers (start here for the fundamentals) | 8 min |
| SYSTEM_PROMPT.md | Main prompt + use cases | 15 min |
| PROMPT_GUIDE.md | Real scenarios + examples | 20 min |
| QUICK_REFERENCE.md | Cheat sheet for fast prompting | 5 min |
| CODE_TEMPLATES.md | 10 code templates | 10 min |
| README.md | This file | 5 min |

**Total:** ~2000 lines, ~1.5 hours to read completely.

**Start with:** QUICK_REFERENCE.md (5 min) → PROMPT_GUIDE.md (your scenario, 10 min) → ask Claude.

---

## How to Use With Claude

### Option 1: Copy-Paste System Prompt
1. Open **SYSTEM_PROMPT.md**
2. Copy the "Core System Prompt" section
3. Paste into Claude's system message (if using API)
4. Ask your question

### Option 2: Reference During Conversation
1. Open **QUICK_REFERENCE.md**
2. Find your question type
3. Type question using the template
4. Claude will understand better because it recognizes the patterns

### Option 3: Code-First Approach
1. Pick a template from **CODE_TEMPLATES.md**
2. Fill in your site URLs
3. Run the code
4. If it fails, ask Claude with your error

---

## Common Use Cases

### "I've never scraped before"
→ Read: PROMPT_GUIDE.md Scenario 1
→ Use: CODE_TEMPLATES.md #1 or #9
→ Ask: QUICK_REFERENCE.md "For Beginners"

### "iframe is JS-injected"
→ Read: PROMPT_GUIDE.md Scenario 2
→ Use: CODE_TEMPLATES.md #2
→ Ask: QUICK_REFERENCE.md "Which tool should I use?"

### "I need to extract from 1000 videos"
→ Read: PROMPT_GUIDE.md Scenario 7
→ Use: CODE_TEMPLATES.md #7 (async)
→ Ask: QUICK_REFERENCE.md "How do I handle X at scale?"

### "My script is broken"
→ Read: PROMPT_GUIDE.md Scenario 8
→ Use: CODE_TEMPLATES.md #10 (debugging)
→ Ask: QUICK_REFERENCE.md "My scraper is broken"

### "Site blocks my scraper"
→ Read: PROMPT_GUIDE.md Scenario 5
→ Use: CODE_TEMPLATES.md #5
→ Ask: QUICK_REFERENCE.md "How do I handle anti-bot?"

---

## Key Concepts (Quick Summary)

### iframe Types
1. **Static** → src visible in HTML → use Requests + BeautifulSoup
2. **JS-Injected** → created by JavaScript → use Playwright
3. **Nested** → iframe inside iframe → iterate frames
4. **API-Based** → URL in API response → intercept network

### URL Types
1. **Direct MP4** → download with requests
2. **HLS playlist** (.m3u8) → parse with m3u8 lib
3. **DASH manifest** (.mpd) → parse with mpd lib
4. **Blob URL** → intercept XHR request
5. **Unknown** → use yt-dlp to resolve

### Tools
| Tool | Speed | Compatibility | Use When |
|---|---|---|---|
| yt-dlp | Very Fast | 1000+ sites | you know the site |
| Requests | Very Fast | Static HTML only | iframe src visible |
| Playwright | Slow | Anything | JS-injected, unknown |
| BeautifulSoup | Fast | HTML parsing | static HTML |

### Anti-Bot
- **Detection:** Cloudflare, 403 errors, "checking browser"
- **Bypass:** playwright-stealth plugin, delays, user-agent rotation
- **Respect:** Add 1-2 second delays between requests

---

## Before You Ask Claude

Prepare these:

✅ **Website URL** - exact URL you're scraping
✅ **HTML snippet** - paste the iframe element
✅ **What you've tried** - your current code
✅ **The error** - exact error message
✅ **Your goal** - 1 video? 100? 1000?

---

## Pro Tips

1. **Test on ONE site first** before scaling
2. **Add delays** between requests (1-2 seconds)
3. **Check robots.txt** and site ToS before scraping
4. **Use async** for 100+ videos (way faster)
5. **Log everything** so you can debug later
6. **Ask Claude early** - don't struggle alone!

---

## Legal & Ethical

> ⚠️ This is **not legal advice**, and "scraping is legal" is not a blanket
> truth. Legality depends on your jurisdiction, the site's Terms of Service,
> the type of content, and how the data is used. Courts have ruled both ways.
> Treat the lists below as a risk gradient, not permission.

**Lower risk:**
- Publicly accessible, non-copyrighted content
- Honouring `robots.txt`
- Conservative rate limits (1–2s between requests)
- Content you own or are licensed to access

**Higher risk / likely prohibited:**
- Bypassing DRM or encryption (illegal in many jurisdictions, e.g. DMCA §1201)
- Redistributing copyrighted material
- Violating a site's Terms of Service (can carry civil liability)
- Circumventing authentication or paywalls
- Request volumes that degrade the service

**When in doubt, check the site's ToS and consult a lawyer for anything
commercial or high-volume.**

---

## Tools You'll Need

```bash
pip install playwright yt-dlp beautifulsoup4 playwright-stealth
playwright install chromium
```

---

## FAQ

**Q: Which file should I read first?**
A: QUICK_REFERENCE.md (5 min), then PROMPT_GUIDE.md (your scenario, 10 min).

**Q: Should I use yt-dlp or Playwright?**
A: yt-dlp if site is supported (way faster), Playwright for custom/unknown players.

**Q: My script works for site A but not site B?**
A: Each site's player structure is different. Ask Claude for debugging help using CODE_TEMPLATES.md #10.

**Q: Is scraping legal?**
A: It depends — see the Legal & Ethical section. There is no universal "yes."
Respecting robots.txt and rate limits lowers risk but doesn't guarantee legality;
ToS violations and DRM circumvention can be unlawful even on public pages.

**Q: Can I scrape 10,000 videos?**
A: Yes, but use async (CODE_TEMPLATES.md #7) and add delays (respect the site).

**Q: How do I handle Cloudflare?**
A: Use playwright-stealth plugin (CODE_TEMPLATES.md #5).

---

## Credits

This prompt collection is designed to work with:
- Claude (Anthropic)
- Gemini (Google)
- Other capable LLMs

The prompts are **not tied to any specific model** and should work across platforms.

---

## How to Use This Repo

### For a Single Project
1. Read QUICK_REFERENCE.md
2. Read PROMPT_GUIDE.md (your scenario)
3. Copy a CODE_TEMPLATES.md template
4. Ask Claude with the SYSTEM_PROMPT.md context

### For Multiple Projects
1. Keep QUICK_REFERENCE.md handy
2. Keep CODE_TEMPLATES.md as your template library
3. Reference PROMPT_GUIDE.md when hitting new scenarios
4. Use SYSTEM_PROMPT.md with each Claude conversation

### For Team/Documentation
- Share SYSTEM_PROMPT.md with your team
- Reference specific scenarios from PROMPT_GUIDE.md
- Use CODE_TEMPLATES.md as code review baseline
- Use QUICK_REFERENCE.md as part of coding guidelines

---

## Next Steps

1. **Read:** QUICK_REFERENCE.md (5 minutes)
2. **Choose:** Which code template matches your site
3. **Ask:** Claude using the template
4. **Iterate:** Until you have working code

**Good luck! 🎥**

---

## Support

If Claude/LLM can't help:
1. Check PROMPT_GUIDE.md Scenario 8 (debugging)
2. Add more context (screenshot, full HTML, etc.)
3. Try a different code template
4. Search the specific site's structure (maybe there's a pattern)

