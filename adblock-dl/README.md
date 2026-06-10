# adblock-dl

Download HLS video streams with ad segments automatically filtered out.

## How It Works

```
Master .m3u8 URL
      │
      ▼
  Parse Playlist          ← m3u8 library
      │
      ▼
  Detect Ad Segments      ← 4 detection passes (see below)
      │
      ├── URL Pattern Match    (built-in + rules/custom.txt)
      ├── CUE Tag Detection   (#EXT-X-CUE-OUT / SCTE-35)
      ├── Discontinuity Pod   (runs whose *total* length looks like an ad break)
      └── Duration Heuristic  (isolated suspiciously short segments)
      │
      ▼
  Download Clean Segments ← parallel, with retries
      │
      ▼
  FFmpeg Concat           ← lossless, no re-encode
      │
      ▼
  output.mp4
```

## Installation

```bash
# 1. Clone / download this folder
cd adblock-dl

# 2. Install Python dependencies
pip install -r requirements.txt

# 3. Install FFmpeg  (needed for stitching)
# Ubuntu/Debian:
sudo apt install ffmpeg

# macOS:
brew install ffmpeg

# Windows: download from https://ffmpeg.org/download.html
```

## Usage

```bash
# Basic
python main.py "https://example.com/stream/master.m3u8"

# Custom output filename
python main.py "https://example.com/stream/master.m3u8" -o movie.mp4

# Pass auth header
python main.py "https://example.com/stream/master.m3u8" \
    --header "Authorization: Bearer YOUR_TOKEN"

# Dry run — see what would be blocked, no download
python main.py "https://example.com/stream/master.m3u8" --dry-run

# Tune heuristics — widen the ad-pod window and the short-segment threshold
python main.py "https://example.com/stream/master.m3u8" \
    --min-ad-duration 0.5 \
    --ad-pod-min 2.0 \
    --ad-pod-max 90.0

# Cap the chosen variant to 1080p
python main.py "https://example.com/stream/master.m3u8" --max-height 1080

# More parallel workers for faster download
python main.py "https://example.com/stream/master.m3u8" --workers 16
```

## CLI Options

| Flag | Default | Description |
|---|---|---|
| `url` | required | Master or media `.m3u8` playlist URL |
| `-o / --output` | `output.mp4` | Output file path |
| `--header KEY:VALUE` | — | HTTP header (repeatable) |
| `--workers N` | `8` | Parallel download threads |
| `--ffmpeg PATH` | `ffmpeg` | Path to ffmpeg binary |
| `--max-height N` | — | Cap variant selection to this vertical resolution |
| `--min-ad-duration` | `1.0` | Isolated short-segment heuristic threshold (s) |
| `--ad-pod-min` | `3.0` | Min total duration of a discontinuity run to flag as an ad pod (s) |
| `--ad-pod-max` | `120.0` | Max total duration of a discontinuity run to flag as an ad pod (s) |
| `--no-discontinuity` | off | Disable discontinuity-based detection |
| `--rules PATH` | `rules/custom.txt` | Custom block-rule file |
| `--max-failures` | `0.02` | Abort if more than this fraction of segments fail (`1.0` disables) |
| `--dry-run` | off | Analyse only, skip download |

## Adding Custom Block Rules

Edit `rules/custom.txt` (or point `--rules` at your own file) — one regex per
line; `#` lines are comments. These patterns are merged with the built-in ad
patterns and matched against each segment URI. Invalid regexes are reported and
skipped rather than aborting the run.

```
# Block segments from a specific CDN
cdn\.adnetwork\.com

# Block any path containing /preroll/
/preroll/
```

## Why "ad pod" instead of "discontinuity block"?

Earlier versions flagged *every* segment between two `#EXT-X-DISCONTINUITY`
tags as an ad whenever the per-segment average was short. Because real content
segments are also short (~4–6s), this frequently deleted actual content. The
detector now looks at the **total** duration of each discontinuity-delimited
run: ad breaks are typically a few seconds to ~2 minutes, while a content block
runs far longer, so only runs inside the `--ad-pod-min … --ad-pod-max` window
are flagged.

## Project Structure

```
adblock-dl/
├── main.py              ← CLI entry point
├── requirements.txt
├── rules/
│   └── custom.txt       ← your custom block patterns
├── core/
│   ├── detector.py      ← ad detection engine (4 passes)
│   ├── parser.py        ← m3u8 playlist parser
│   └── downloader.py    ← parallel downloader + FFmpeg stitcher
└── output/              ← default output directory
```

## Limitations

| Scenario | Can block? |
|---|---|
| Client-side ad insertion (separate URLs) | ✅ Yes |
| SCTE-35 / CUE-OUT tagged breaks | ✅ Yes |
| Discontinuity-delimited ad blocks | ✅ Yes |
| **Server-side ad stitching (same stream)** | ❌ No |
| Ads without any URL/tag signal | ⚠️ Partial (duration heuristic) |

Server-stitched ads (where the ad is baked into the same `.ts` segments as
the content) cannot be reliably removed without re-encoding and AI-based
scene detection — a much harder problem.
