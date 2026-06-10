"""
Downloader & Stitcher
---------------------
1. Downloads each clean (non-ad) segment to a temp directory.
2. Uses FFmpeg to concatenate them into a single output file.

FFmpeg concat strategy
----------------------
We write a concat demuxer list file:

    file 'seg_0001.ts'
    file 'seg_0003.ts'
    ...

Then call:
    ffmpeg -f concat -safe 0 -i list.txt -c copy output.mp4

This is lossless — no re-encoding.

Missing-segment safety
----------------------
With ``-c copy`` a dropped segment becomes a silent gap in the output. The
downloader therefore tracks failures and aborts (by default) when more than
``max_failure_ratio`` of the clean segments could not be fetched, so you don't
end up with a corrupt file you think is complete.
"""

import os
import time
import tempfile
import subprocess
import concurrent.futures
from pathlib import Path
from typing import Optional

import requests
from tqdm import tqdm

from core.detector import Segment


class TooManyFailures(RuntimeError):
    """Raised when the fraction of failed segment downloads exceeds the limit."""


# ---------------------------------------------------------------------------
# Segment downloader
# ---------------------------------------------------------------------------

def _download_segment(args: tuple) -> Optional[Path]:
    """Download a single segment with backoff. Returns local path or None."""
    seg, tmp_dir, headers, retries = args
    dest = Path(tmp_dir) / f"seg_{seg.index:05d}.ts"

    for attempt in range(retries):
        try:
            resp = requests.get(seg.uri, headers=headers, timeout=20, stream=True)
            resp.raise_for_status()
            with open(dest, "wb") as f:
                for chunk in resp.iter_content(chunk_size=65536):
                    f.write(chunk)
            if dest.stat().st_size == 0:
                raise IOError("empty segment")
            return dest
        except Exception as e:
            if attempt == retries - 1:
                print(f"  ✗ Failed to download segment {seg.index}: {e}")
                return None
            time.sleep(0.5 * (2 ** attempt))  # 0.5s, 1s, 2s, ...
    return None


def download_segments(
    segments: list[Segment],
    tmp_dir: str,
    headers: Optional[dict] = None,
    workers: int = 8,
    retries: int = 3,
    max_failure_ratio: float = 0.02,
) -> dict[int, Path]:
    """
    Download all non-ad segments in parallel.

    Returns a mapping of ``{segment_index: local_path}``.
    Raises :class:`TooManyFailures` if more than ``max_failure_ratio`` of the
    clean segments fail (set the ratio to ``1.0`` to disable the guard).
    """
    clean = [s for s in segments if not s.is_ad]
    hdrs = headers or {}

    if not clean:
        return {}

    print(f"\n⬇  Downloading {len(clean)} segments ({workers} workers)…")
    args = [(seg, tmp_dir, hdrs, retries) for seg in clean]

    results: dict[int, Path] = {}
    failures = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {ex.submit(_download_segment, a): a[0] for a in args}
        for fut in tqdm(
            concurrent.futures.as_completed(futures),
            total=len(futures),
            unit="seg",
            ncols=72,
        ):
            seg = futures[fut]
            path = fut.result()
            if path:
                results[seg.index] = path
            else:
                failures += 1

    ratio = failures / len(clean)
    if ratio > max_failure_ratio:
        raise TooManyFailures(
            f"{failures}/{len(clean)} segments failed "
            f"({ratio:.1%} > {max_failure_ratio:.1%} limit). "
            f"Output would contain gaps — aborting."
        )
    if failures:
        print(f"  ⚠ {failures} segment(s) failed but within tolerance — continuing.")

    return results


# ---------------------------------------------------------------------------
# FFmpeg stitcher
# ---------------------------------------------------------------------------

def stitch_segments(
    segment_paths: dict[int, Path],
    output_path: str,
    ffmpeg_bin: str = "ffmpeg",
) -> bool:
    """
    Concatenate downloaded segments into a single video file using FFmpeg.
    Returns True on success.
    """
    if not segment_paths:
        print("✗ No segments to stitch.")
        return False

    list_path = None
    try:
        # Write concat list in index order. delete=False so FFmpeg (a separate
        # process) can reopen it on Windows; we clean it up in finally.
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".txt", delete=False, encoding="utf-8"
        ) as list_file:
            list_path = list_file.name
            for idx in sorted(segment_paths):
                # FFmpeg concat needs forward slashes and ' escaped.
                p = str(segment_paths[idx]).replace("\\", "/").replace("'", r"'\''")
                list_file.write(f"file '{p}'\n")

        print(f"\n🎬 Stitching {len(segment_paths)} segments → {output_path}")

        cmd = [
            ffmpeg_bin,
            "-y",                   # overwrite output if exists
            "-f", "concat",
            "-safe", "0",
            "-i", list_path,
            "-c", "copy",           # lossless copy, no re-encode
            output_path,
        ]

        result = subprocess.run(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
        )

        if result.returncode != 0:
            print("✗ FFmpeg error:\n", result.stderr[-2000:])
            return False

        size_mb = Path(output_path).stat().st_size / (1024 * 1024)
        print(f"✓ Done! Output: {output_path}  ({size_mb:.1f} MB)")
        return True

    except FileNotFoundError:
        print(f"✗ FFmpeg not found at '{ffmpeg_bin}'. Install FFmpeg and retry.")
        return False
    finally:
        if list_path and os.path.exists(list_path):
            os.unlink(list_path)
