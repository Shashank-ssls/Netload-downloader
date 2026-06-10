# Using the System Prompt - Practical Examples

This document shows real-world scenarios where you'd use the system prompt with Claude.

---

## Scenario 1: You Download a Stream and It Has Ads

**What you do:**
1. Run with `--dry-run` to see what gets detected:
```bash
python main.py "https://stream.example.com/master.m3u8" --dry-run
```

**Output shows:**
```
Content        : 180 segments  (1800.5s)
Ads blocked    : 8 segments    (45.3s)

Blocked by reason:
  • url_pattern     : 5 segments
  • cue_tag         : 2 segments
  • duration_heuristic : 1 segment
```

**You notice:** Still getting ads in the video. The detector missed some.

**What you ask Claude:**
```
I'm downloading from [STREAM URL]. The detector found 8 ad segments 
but the video still has ads. Here's the full segment list:

[PASTE DETECTED ADS + THEIR TAGS/DURATIONS]

Are there patterns I'm missing? Show me new regex rules I should add.
```

**Claude will:**
- Spot patterns the detector missed (different domain, path pattern, etc.)
- Suggest 3-5 new rules with confidence levels
- Warn about false positives
- Recommend which rules to try first

---

## Scenario 2: You're Getting False Positives

**What happens:**
You download, but the output video is missing parts (legitimate content blocked).

**What you do:**
Extract the segments that were incorrectly blocked:

```python
# In main.py, add debug mode to show what was blocked
python main.py "https://stream.example.com/master.m3u8" --dry-run > analysis.txt
```

Look for segments that:
- Come from the main content domain
- Have normal duration (8-12 seconds)
- Should not be ads

**What you ask Claude:**
```
These segments were marked as ads but they're actually content:

Index 45: 
  URL: https://vod.example.com/episode_5/segment_45.ts
  Duration: 9.5s
  Tags: #EXT-X-DISCONTINUITY, #EXT-X-PROGRAM-DATE-TIME
  Reason flagged: discontinuity_block

Index 56:
  URL: https://vod.example.com/episode_5/segment_56.ts
  Duration: 0.3s
  Tags: [none]
  Reason flagged: duration_heuristic

How do I fix these false positives? Should I adjust thresholds?
```

**Claude will:**
- Explain why each is a false positive
- Suggest specific CLI flag changes (e.g., `--min-ad-duration 0.5`)
- Propose code changes if needed
- Rate the risk of each adjustment

---

## Scenario 3: Building Rules for a Specific Service

**You have:**
- Access to multiple streams from the same service
- Captured real ad segment URLs
- Want a bulletproof rule set

**What you do:**
Collect 10-20 real ad URLs from different videos:

```
https://ads-us-east.hotstar.com/v1/csai/preroll/uuid-xxx.m4s
https://ads-us-east.hotstar.com/v1/csai/midroll/uuid-yyy.m4s
https://ads-ap.hotstar.com/v1/ssai/segment-001.ts
https://tracking.hotstar.com/event/ad_impression?id=123
https://cdn.hotstar-ads.com/preroll/seg_001.ts
```

**What you ask Claude:**
```
I want to block all ads from Hotstar. Here are real ad URLs I captured:

[PASTE 15+ REAL AD URLS]

And here are real content URLs (should NOT block):
[PASTE 5-10 CONTENT URLS]

Create a comprehensive set of regex rules that:
1. Blocks ALL ad URLs
2. Never blocks content URLs
3. Works across regions/CDNs
4. Is as simple as possible

For each rule, tell me:
- The regex pattern
- Why it works
- Test URLs it catches
- Potential false positives
```

**Claude will:**
- Generate 5-8 optimized patterns
- Show test cases for each
- Warn about edge cases
- Rank by priority/confidence

You then add to `rules/custom.txt`:
```
# Hotstar ad CDN patterns
ads-us-east\.hotstar\.com
ads-ap\.hotstar\.com
cdn\.hotstar-ads\.com
/csai/
/ssai/
tracking\.hotstar\.com
```

---

## Scenario 4: Debugging Detection Logic

**You notice:**
- Some ads are getting through
- Some content is being blocked
- Unclear what's happening

**What you do:**
1. Add debug output to detector.py temporarily:
```python
# In core/detector.py, after each pass
print(f"After URL pass: {sum(1 for s in segments if s.is_ad)} ads")
print(f"After CUE pass: {sum(1 for s in segments if s.is_ad)} ads")
# ... etc
```

2. Run and capture which pass caught what:
```bash
python main.py "URL" --dry-run 2>&1 | tee debug.log
```

**What you ask Claude:**
```
I'm trying to understand why some ads slip through. Here's my detection output:

After URL pass: 3 ads detected
After CUE pass: 5 ads detected  
After Discontinuity pass: 7 ads detected
After Duration pass: 8 ads detected

But the output video still has ads visible in minutes 5-7 and 23-25.

Full playlist debug info:
[PASTE SEGMENT DATA + DETECTION RESULTS]

Why am I missing ads? What detection pass should catch them?
```

**Claude will:**
- Pinpoint which detection pass is missing what
- Suggest new patterns or heuristic tuning
- Explain why certain ads are hard to detect
- Recommend adding a 5th detection pass if needed

---

## Scenario 5: Handling Server-Stitched Ads (The Hard Case)

**What happens:**
Even with perfect ad detection, the video has audio/video from ads.

**Why:**
The ad is baked into the same `.ts` file as content (server-side stitching).

**What you ask Claude:**
```
I'm seeing ads in the output video, but the ad segments aren't being 
flagged by my detector. This suggests server-side ad stitching.

Sample segment info:
[PASTE SEGMENT WITH AD]

Is it server-stitched? How can I detect it? Should I:
1. Use frame analysis / AI video understanding?
2. Try black frame detection?
3. Match against a silence/ad audio signature?
4. Give up and accept the ads?

What's practical for a home downloader?
```

**Claude will:**
- Confirm it's server-stitched
- Explain the limitations
- Suggest practical (but imperfect) solutions
- Help you decide if it's worth pursuing

---

## Using Claude API Programmatically

If you want to build AI analysis into the tool itself:

```python
# ai_helper.py - Optional enhancement module

import json
import requests

def analyze_with_claude(segments_data: dict, task: str) -> str:
    """
    Call Claude API to analyze segments and suggest improvements.
    
    Args:
        segments_data: Dict with 'content', 'ads', 'missed', etc.
        task: 'suggest_rules', 'debug_fps', 'tune_heuristics', etc.
    
    Returns:
        Claude's analysis as a string
    """
    
    system_prompt = open('SYSTEM_PROMPT.md').read()
    
    tasks = {
        'suggest_rules': f"""
            Analyze these segments and suggest new URL patterns to block:
            {json.dumps(segments_data, indent=2)}
            
            For each pattern, explain why it works and the false positive risk.
        """,
        
        'debug_fps': f"""
            These content segments are being marked as ads. Why?
            {json.dumps(segments_data['false_positives'], indent=2)}
            
            Suggest threshold changes or new whitelist rules.
        """,
        
        'tune_heuristics': f"""
            Given this detection breakdown:
            {json.dumps(segments_data['detection_breakdown'], indent=2)}
            
            How should I tune the heuristics? What's the risk?
        """,
    }
    
    response = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": os.getenv("ANTHROPIC_API_KEY"),
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": "claude-sonnet-4-20250514",
            "max_tokens": 1500,
            "system": system_prompt,
            "messages": [
                {
                    "role": "user",
                    "content": tasks[task],
                }
            ],
        },
    )
    
    return response.json()['content'][0]['text']

# Usage:
# result = analyze_with_claude(my_segments, 'suggest_rules')
# print(result)
```

---

## Quick Reference: What to Ask Claude For

| Problem | Best Prompt |
|---|---|
| Ads still in output | "Here are segments I detected as ads. Which patterns am I missing?" |
| Content is being blocked | "These legitimate segments were marked as ads. Why? How do I fix?" |
| Building rule set from scratch | "I have real ad URLs. Generate regex patterns with confidence levels." |
| Heuristic tuning | "My detector has X false positives and Y false negatives. How do I tune?" |
| Understanding why ad slipped through | "Here's a segment that has ads. Can you see any pattern I missed?" |
| Picking detection strategy | "Should I focus on URL patterns, CUE tags, or heuristics for this service?" |

---

## Important Notes

⚠️ **Don't ask Claude for:**
- General "how do I block ads" without context (too vague)
- Help reverse-engineering streams (licensing issues)
- Ways to circumvent publisher protections (legal/ethical issues)

✅ **DO ask Claude for:**
- Pattern analysis on data you've captured
- Detection algorithm tuning
- Understanding HLS protocol specifics
- Code improvements and debugging

