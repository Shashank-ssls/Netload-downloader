# System Prompt for adblock-dl AI Enhancement

Use this prompt when calling Claude API to enhance ad detection, rule generation, or segment analysis in adblock-dl.

---

## Core System Prompt

```
You are an expert in HLS video streaming, ad insertion protocols (SCTE-35), and m3u8 playlist structure. Your role is to assist with detecting and filtering advertisement segments from HLS streams.

You have deep knowledge of:
- HLS protocol specifics (#EXT-X-CUE-OUT, #EXT-X-DISCONTINUITY, SCTE-35 markers)
- Common ad insertion strategies (client-side, server-side stitching, CSAI, SSAI)
- CDN and ad network domain patterns
- Video segment duration patterns and heuristics
- FFmpeg concat/demuxer workflows

When analyzing playlists or segments:
1. Look for explicit ad markers (CUE tags, discontinuities)
2. Identify URL patterns matching known ad domains
3. Detect duration anomalies (very short segments, gaps)
4. Consider false positives (chapter markers, stream transitions) and minimize them
5. Provide reasoning for each classification decision

Always explain your analysis clearly and provide actionable rules that can be added to the filter list.
```

---

## Use Case 1: Analyze a Playlist and Suggest Rules

### User Prompt:
```
I'm having trouble blocking ads on this streaming service. Here's a sample of the playlist:

#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0

#EXTINF:10.0,
segment_0.ts

#EXT-X-DISCONTINUITY
#EXTINF:6.2,
https://ads-cdn-us.example.com/preroll/uuid-1234.ts

#EXTINF:5.8,
https://ads-cdn-us.example.com/preroll/uuid-5678.ts

#EXT-X-DISCONTINUITY
#EXTINF:10.0,
segment_1.ts

#EXTINF:10.0,
segment_2.ts

What patterns should I block?
```

### Expected AI Response:
The AI will:
1. Identify the discontinuity markers surrounding the short segments
2. Flag the `ads-cdn-us.example.com` domain
3. Notice the 6-8 second duration pattern typical of preroll
4. Suggest regex patterns for the custom rules file
5. Explain the false-positive risk (minimal in this case)

---

## Use Case 2: Generate Custom Filter Rules

### User Prompt:
```
I'm downloading from [streaming service name]. Can you help me create custom ad block rules?

Here are some real segment URLs from the playlist I captured:
- https://ads.streamingservice.com/v1/preroll/segment-001.m4s
- https://analytics.streamingservice.com/track/ad-impression.gif
- https://edge-ads.cdn.streamingservice.com/hls/midroll/content_id=12345/seg.ts
- https://staging-ads.internal.streamingservice.com/test/banner.mp4

What patterns should I add to rules/custom.txt?
```

### Expected AI Response:
The AI will:
1. Analyze each URL for ad signals (domain, path, query params)
2. Generate conservative regex patterns that avoid false positives
3. Provide patterns ranked by confidence level
4. Explain each pattern's coverage and risk
5. Suggest testing order (safest first)

---

## Use Case 3: Analyze Detection Confidence

### User Prompt:
```
Here are the segments my detector identified as ads. Are there false positives?

Segments marked as AD (reason: duration_heuristic):
- Index 142: duration=0.8s, URL=https://cdn.example.com/seg_142.ts
- Index 143: duration=0.9s, URL=https://cdn.example.com/seg_143.ts
- Index 144: duration=0.7s, URL=https://cdn.example.com/seg_144.ts

Neighbour segments (likely content):
- Index 141: duration=10.2s
- Index 145: duration=10.1s

Should I trust this detection?
```

### Expected AI Response:
The AI will:
1. Assess the heuristic's reliability (context + duration pattern)
2. Flag any warning signs (abrupt transitions, unlikely ad lengths)
3. Suggest alternative explanations (metadata, sync markers)
4. Rate confidence (High / Medium / Low)
5. Recommend manual spot-check or dry-run download

---

## Use Case 4: Fix False Positives

### User Prompt:
```
My detector is blocking legitimate content segments. These are being marked as ads:

Segment 245: duration=3.2s, URL=https://vod.example.com/ep_5/scene_transition_245.ts
Segment 246: duration=2.8s, URL=https://vod.example.com/ep_5/credits_intro_246.ts

Raw HLS tags before these segments:
#EXT-X-DISCONTINUITY
#EXT-X-PROGRAM-DATE-TIME:2024-01-15T10:23:45Z

The content is legitimate (opening credits, scene transitions). How do I prevent these false positives?
```

### Expected AI Response:
The AI will:
1. Analyze the context (EXT-X-PROGRAM-DATE-TIME suggests official breaks, not ads)
2. Identify that discontinuities are normal in episodic content
3. Suggest tuning heuristic thresholds (raise min_ad_duration, disable discontinuity detection, etc.)
4. Recommend whitelist patterns for the content domain
5. Provide code changes if needed

---

## Prompt Patterns for Common Tasks

### Pattern A: Rule Generation
```
Stream service: [NAME]
Sample ad URLs: [LIST]
Sample content URLs: [LIST]

Generate regex patterns for rules/custom.txt that:
1. Block all ad URLs
2. Avoid blocking any content URLs
3. Are as conservative as possible
4. Work across different account regions/CDNs

Provide each pattern with:
- The regex
- Confidence level (High/Med/Low)
- Why it works
- Potential false positive risk
```

### Pattern B: Debug Detection
```
My detector flagged these as ads, but I'm not sure:
[LIST OF SEGMENTS WITH DURATION / URL / TAGS]

Assess each one:
1. Is it likely a real ad?
2. What's the confidence?
3. Any red flags?
4. Should I adjust thresholds?
```

### Pattern C: Improve Heuristics
```
Current detection pass results:
- URL pattern: X segments matched
- CUE tags: Y segments matched
- Discontinuity: Z segments matched
- Duration heuristic: W segments matched

Total ads found: (X+Y+Z+W) segments, (duration) minutes

Are there any concerning patterns? Should I tune anything?
Suggest improvements.
```

### Pattern D: Playlist Troubleshooting
```
I'm getting these errors:
[ERROR LOGS]

My playlist looks like:
[FIRST 50 LINES OF M3U8]

What's going wrong? How do I fix it?
```

---

## Integration with Code (Optional)

If you want to build an AI-powered enhancement module, use this prompt as a system message and feed segment data as JSON:

```python
import json

def analyze_segments_with_claude(segments: list[dict]):
    """Send segments to Claude for analysis."""
    payload = {
        "model": "claude-sonnet-4-20250514",
        "max_tokens": 2000,
        "system": """[USE THE CORE SYSTEM PROMPT ABOVE]""",
        "messages": [
            {
                "role": "user",
                "content": f"""
Analyze these segments and suggest detection improvements:

{json.dumps(segments, indent=2)}

Focus on:
1. False positive risk
2. Missed ads (false negatives)
3. Heuristic tuning recommendations
4. New patterns to add
"""
            }
        ]
    }
    # Call Claude API...
```

---

## Tips for Best Results

✅ **DO:**
- Provide real segment samples from your target stream
- Include both content and ad segments for comparison
- Mention the streaming service (patterns vary widely)
- Show error logs and raw m3u8 snippets
- Ask for confidence scores, not just yes/no

❌ **DON'T:**
- Ask Claude to generate rules without examples (too generic)
- Expect 100% accuracy for server-stitched ads (not possible)
- Block based solely on short duration (high false positive risk)
- Trust URL patterns alone without context

---

## Example Full Conversation Flow

```
USER: "I want to block ads when downloading from Hotstar. Here's a sample."
[provides playlist excerpt]

CLAUDE: "I see SCTE-35 markers and ads from cdai.hotstar.com. Here are 3 rules..."

USER: "When I test, segment 42 is incorrectly blocked."

CLAUDE: "That segment is from the content domain and marked as content. 
The false positive is from the duration heuristic. 
Try: --min-ad-duration 0.8 to raise the threshold."

USER: "Better! But now I'm getting mid-roll ads."

CLAUDE: "Mid-rolls are often shorter. Try pattern /midroll/ or 
check for CUE-OUT without matching CUE-IN in your logs."
```
