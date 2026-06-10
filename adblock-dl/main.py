#!/usr/bin/env python3
"""
adblock-dl  —  Download HLS video streams without ad segments
--------------------------------------------------------------

Usage
-----
    python main.py <URL> [options]

Examples
--------
    # Basic usage
    python main.py "https://example.com/stream/master.m3u8"

    # Custom output file
    python main.py "https://example.com/stream/master.m3u8" -o my_video.mp4

    # Pass a custom header (e.g. auth token)
    python main.py "https://example.com/stream/master.m3u8" \
        --header "Authorization: Bearer abc123"

    # Cap resolution to 1080p
    python main.py "https://example.com/stream/master.m3u8" --max-height 1080

    # Dry run — show what would be blocked without downloading
    python main.py "https://example.com/stream/master.m3u8" --dry-run
"""

import argparse
import sys
import tempfile
from pathlib import Path

from core.parser import fetch_best_stream, parse_segments
from core.detector import AdDetector, load_custom_patterns
from core.downloader import download_segments, stitch_segments, TooManyFailures


# ---------------------------------------------------------------------------
# Pretty printer helpers
# ---------------------------------------------------------------------------

GREEN  = "\033[92m"
RED    = "\033[91m"
YELLOW = "\033[93m"
CYAN   = "\033[96m"
RESET  = "\033[0m"
BOLD   = "\033[1m"

DEFAULT_RULES = Path(__file__).parent / "rules" / "custom.txt"


def print_banner():
    print(f"""
{CYAN}{BOLD}
  ╔═══════════════════════════════╗
  ║   adblock-dl  v1.1            ║
  ║   HLS stream ad filter        ║
  ╚═══════════════════════════════╝
{RESET}""")


def print_summary(segments, label="Segment Analysis"):
    total   = len(segments)
    ad_segs = [s for s in segments if s.is_ad]
    clean   = [s for s in segments if not s.is_ad]

    ad_dur    = sum(s.duration for s in ad_segs)
    clean_dur = sum(s.duration for s in clean)

    reasons: dict[str, int] = {}
    for s in ad_segs:
        reasons[s.reason] = reasons.get(s.reason, 0) + 1

    print(f"\n{BOLD}── {label} ──{RESET}")
    print(f"  Total segments : {total}")
    print(f"  {GREEN}Content        : {len(clean)}  ({clean_dur:.1f}s){RESET}")
    print(f"  {RED}Ads blocked    : {len(ad_segs)}  ({ad_dur:.1f}s){RESET}")

    if reasons:
        print(f"\n  {BOLD}Blocked by reason:{RESET}")
        for reason, count in sorted(reasons.items(), key=lambda x: -x[1]):
            print(f"    {YELLOW}• {reason:<25}{RESET} {count} segments")
    print()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args():
    parser = argparse.ArgumentParser(
        prog="adblock-dl",
        description="Download HLS streams without ad segments",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("url", help="Master or media playlist URL (.m3u8)")
    parser.add_argument("-o", "--output", default="output.mp4",
                        help="Output file path (default: output.mp4)")
    parser.add_argument("--header", action="append", metavar="KEY:VALUE",
                        help="HTTP header to send (repeatable)")
    parser.add_argument("--workers", type=int, default=8,
                        help="Parallel download workers (default: 8)")
    parser.add_argument("--ffmpeg", default="ffmpeg",
                        help="Path to ffmpeg binary")
    parser.add_argument("--max-height", type=int, default=None,
                        help="Cap variant selection to this vertical resolution (e.g. 1080)")
    parser.add_argument("--min-ad-duration", type=float, default=1.0,
                        help="Isolated segments shorter than this (s) are suspicious (default: 1.0)")
    parser.add_argument("--ad-pod-min", type=float, default=3.0,
                        help="Min total duration (s) of a discontinuity run to count as an ad pod (default: 3.0)")
    parser.add_argument("--ad-pod-max", type=float, default=120.0,
                        help="Max total duration (s) of a discontinuity run to count as an ad pod (default: 120.0)")
    parser.add_argument("--no-discontinuity", action="store_true",
                        help="Disable discontinuity-based detection")
    parser.add_argument("--rules", default=str(DEFAULT_RULES),
                        help=f"Custom rules file (default: {DEFAULT_RULES})")
    parser.add_argument("--max-failures", type=float, default=0.02,
                        help="Abort if more than this fraction of segments fail (default: 0.02; 1.0 disables)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Analyse playlist only, do not download")
    return parser.parse_args()


def build_headers(raw: list[str] | None) -> dict:
    headers = {}
    for item in (raw or []):
        if ":" in item:
            k, _, v = item.partition(":")
            headers[k.strip()] = v.strip()
    return headers


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    print_banner()
    args = parse_args()
    headers = build_headers(args.header)

    # 1. Resolve best media playlist
    print(f"{CYAN}Fetching playlist…{RESET}")
    try:
        media_url = fetch_best_stream(args.url, headers=headers, max_height=args.max_height)
        print(f"  Media playlist: {media_url}")
    except Exception as e:
        print(f"{RED}✗ Could not fetch playlist: {e}{RESET}")
        sys.exit(1)

    # 2. Parse segments
    print(f"{CYAN}Parsing segments…{RESET}")
    try:
        segments = parse_segments(media_url, headers=headers)
        print(f"  Found {len(segments)} segments")
    except Exception as e:
        print(f"{RED}✗ Could not parse playlist: {e}{RESET}")
        sys.exit(1)

    if not segments:
        print(f"{RED}✗ Playlist contained no segments.{RESET}")
        sys.exit(1)

    # 3. Detect ads
    custom_patterns = load_custom_patterns(args.rules)
    if custom_patterns:
        print(f"  Loaded {len(custom_patterns)} custom rule(s) from {args.rules}")

    detector = AdDetector(
        min_ad_duration=args.min_ad_duration,
        use_discontinuity=not args.no_discontinuity,
        ad_pod_min=args.ad_pod_min,
        ad_pod_max=args.ad_pod_max,
        extra_patterns=custom_patterns,
    )
    segments = detector.classify(segments)
    print_summary(segments)

    if args.dry_run:
        print(f"{YELLOW}Dry run — exiting without downloading.{RESET}")
        return

    # 4. Download + stitch
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="adblock_dl_") as tmp:
        try:
            segment_paths = download_segments(
                segments,
                tmp_dir=tmp,
                headers=headers,
                workers=args.workers,
                max_failure_ratio=args.max_failures,
            )
        except TooManyFailures as e:
            print(f"{RED}✗ {e}{RESET}")
            sys.exit(1)

        ok = stitch_segments(segment_paths, output_path=str(output), ffmpeg_bin=args.ffmpeg)
        sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
