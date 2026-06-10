"""
M3U8 Playlist Parser
--------------------
Downloads and parses an HLS master/media playlist into Segment objects
that the AdDetector can classify.

The media playlist is fetched exactly once; segment URIs, per-segment tags
(including #EXT-X-DISCONTINUITY) and durations are all read from that single
response so they stay perfectly aligned.
"""

import urllib.parse
from typing import Optional

import m3u8
import requests

from core.detector import Segment

_TIMEOUT = 20


def _abs_uri(base_url: str, uri: str) -> str:
    """Resolve a relative URI against the playlist base URL."""
    if uri.startswith("http://") or uri.startswith("https://"):
        return uri
    return urllib.parse.urljoin(base_url, uri)


def fetch_best_stream(
    master_url: str,
    headers: Optional[dict] = None,
    max_height: Optional[int] = None,
) -> str:
    """
    Given a master playlist URL, return the URI of the best media playlist.

    If ``max_height`` is set, the highest-bandwidth variant at or below that
    vertical resolution is chosen; otherwise the highest-bandwidth variant.
    If the URL is already a media playlist it is returned unchanged.
    """
    hdrs = headers or {}
    text = requests.get(master_url, headers=hdrs, timeout=_TIMEOUT).text
    playlist = m3u8.loads(text, uri=master_url)

    if not playlist.is_variant:
        return master_url

    variants = list(playlist.playlists)

    if max_height is not None:
        capped = [
            p for p in variants
            if p.stream_info.resolution and p.stream_info.resolution[1] <= max_height
        ]
        if capped:
            variants = capped

    best = max(variants, key=lambda p: p.stream_info.bandwidth or 0)
    return _abs_uri(master_url, best.uri)


def parse_segments(media_url: str, headers: Optional[dict] = None) -> list[Segment]:
    """
    Parse a media playlist and return a list of Segment objects, each carrying
    the raw HLS tags that appeared before it (so the detector can see CUE and
    discontinuity markers).
    """
    hdrs = headers or {}
    text = requests.get(media_url, headers=hdrs, timeout=_TIMEOUT).text
    playlist = m3u8.loads(text, uri=media_url)

    # Walk the raw text once to collect the tag block preceding each URI line.
    raw_pairs: list[tuple[str, list[str]]] = []
    tag_buffer: list[str] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith("#"):
            tag_buffer.append(line)
        else:
            raw_pairs.append((line, tag_buffer))
            tag_buffer = []

    segments: list[Segment] = []
    parsed = playlist.segments

    # Align by position; fall back to whichever list is shorter so a malformed
    # tail never raises. Durations come from the m3u8 parse, tags from raw text.
    count = min(len(parsed), len(raw_pairs))
    for idx in range(count):
        m3u8_seg = parsed[idx]
        raw_uri, tags = raw_pairs[idx]
        uri = _abs_uri(media_url, m3u8_seg.uri or raw_uri)
        segments.append(
            Segment(
                uri=uri,
                duration=m3u8_seg.duration or 0.0,
                index=idx,
                raw_tags=tags,
            )
        )

    return segments
