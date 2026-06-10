"""
Ad Segment Detector
-------------------
Identifies ad segments in HLS (.m3u8) playlists using:
  1. URL pattern matching against known ad domains/paths (built-in + custom rules)
  2. CUE tag detection (#EXT-X-CUE-OUT / SCTE-35 metadata)
  3. Discontinuity-delimited ad pods (runs whose *total* duration falls inside
     a typical ad-break window)
  4. Duration heuristics (isolated, suspiciously short segments)

A segment can match more than one pass; all matching reasons are recorded.
"""

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Optional

# ---------------------------------------------------------------------------
# Known ad-related URL patterns (extend via rules/custom.txt)
# ---------------------------------------------------------------------------
AD_URL_PATTERNS: list[str] = [
    r"ads?\.",                      # ads. / ad.
    r"/ad(s)?/",                    # /ad/ or /ads/
    r"doubleclick\.net",
    r"googleadservices\.com",
    r"googlesyndication\.com",
    r"adnxs\.com",
    r"amazon-adsystem\.com",
    r"moatads\.com",
    r"spotxchange\.com",
    r"freewheel\.tv",
    r"yume\.com",
    r"adswizz\.com",
    r"pubads\.g\.doubleclick",
    r"/preroll",
    r"/midroll",
    r"/postroll",
    r"imasdk\.googleapis",
    r"/commercial/",
    r"tracking.*pixel",
    r"beacon\.",
]

# HLS tags that mark the start / end of a SCTE-35 ad break
AD_CUE_TAGS = (
    "#EXT-X-CUE-OUT",
    "#EXT-X-AD",
    "#EXT-OATCLS-SCTE35",
    "#EXT-X-DATERANGE",        # used with SCTE-35 metadata
    "#EXT-X-SCTE35",
)

AD_CUE_END_TAGS = (
    "#EXT-X-CUE-IN",
)

DISCONTINUITY_TAG = "#EXT-X-DISCONTINUITY"


# ---------------------------------------------------------------------------
# Custom rule loading
# ---------------------------------------------------------------------------

def load_custom_patterns(rules_path: Optional[str]) -> list[str]:
    """
    Read regex patterns from a rules file (one per line, '#' lines are comments).
    Invalid regexes are skipped with a warning rather than aborting the run.
    Returns an empty list if the file is missing.
    """
    if not rules_path:
        return []
    path = Path(rules_path)
    if not path.is_file():
        return []

    patterns: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        try:
            re.compile(line)
        except re.error as e:
            print(f"  ! Skipping invalid custom rule {line!r}: {e}")
            continue
        patterns.append(line)
    return patterns


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class Segment:
    uri: str
    duration: float
    index: int
    is_ad: bool = False
    reasons: list[str] = field(default_factory=list)
    raw_tags: list[str] = field(default_factory=list)

    def flag(self, reason: str) -> None:
        self.is_ad = True
        if reason not in self.reasons:
            self.reasons.append(reason)

    @property
    def reason(self) -> str:
        """Primary reason, kept for backward compatibility / display."""
        return self.reasons[0] if self.reasons else ""


# ---------------------------------------------------------------------------
# Detector
# ---------------------------------------------------------------------------

class AdDetector:
    """
    Classifies each HLS segment as ad or content.

    Parameters
    ----------
    min_ad_duration   : Isolated segments shorter than this (seconds) are suspicious.
    use_discontinuity : Treat discontinuity-delimited runs as candidate ad pods.
    ad_pod_min        : Minimum total duration (s) of a discontinuity run to be an ad pod.
    ad_pod_max        : Maximum total duration (s) of a discontinuity run to be an ad pod.
                        Content blocks (full episodes/movies) run far longer than this,
                        so they are not flagged.
    extra_patterns    : Additional regex strings merged with the built-in ad patterns.
    """

    def __init__(
        self,
        min_ad_duration: float = 1.0,
        use_discontinuity: bool = True,
        ad_pod_min: float = 3.0,
        ad_pod_max: float = 120.0,
        extra_patterns: Optional[Iterable[str]] = None,
    ):
        self.min_ad_duration = min_ad_duration
        self.use_discontinuity = use_discontinuity
        self.ad_pod_min = ad_pod_min
        self.ad_pod_max = ad_pod_max

        all_patterns = list(AD_URL_PATTERNS) + list(extra_patterns or [])
        self._ad_re = re.compile("|".join(all_patterns), re.IGNORECASE)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def classify(self, segments: list[Segment]) -> list[Segment]:
        """Run all detection passes and return annotated segments."""
        self._pass_url_patterns(segments)
        self._pass_cue_tags(segments)
        if self.use_discontinuity:
            self._pass_discontinuity_pods(segments)
        self._pass_duration_heuristic(segments)
        return segments

    # ------------------------------------------------------------------
    # Detection passes
    # ------------------------------------------------------------------

    def _pass_url_patterns(self, segments: list[Segment]) -> None:
        for seg in segments:
            if self._ad_re.search(seg.uri):
                seg.flag("url_pattern")

    def _pass_cue_tags(self, segments: list[Segment]) -> None:
        """Mark segments enclosed by CUE-OUT / CUE-IN pairs."""
        in_ad_block = False
        for seg in segments:
            for tag in seg.raw_tags:
                tag_upper = tag.strip().upper()
                if tag_upper.startswith(AD_CUE_TAGS):
                    in_ad_block = True
                if tag_upper.startswith(AD_CUE_END_TAGS):
                    in_ad_block = False
            if in_ad_block:
                seg.flag("cue_tag")

    def _pass_discontinuity_pods(self, segments: list[Segment]) -> None:
        """
        Split the timeline at #EXT-X-DISCONTINUITY boundaries and flag runs whose
        *total* duration falls inside the ad-pod window.

        Per-segment averaging (the old approach) wrongly flagged content, because
        content segments are also short (~4-6s). Ad pods are instead identified by
        their total length: ad breaks are typically a few seconds to ~2 minutes,
        whereas a content block between discontinuities is much longer.
        """
        run: list[Segment] = []

        def evaluate(group: list[Segment]) -> None:
            if not group:
                return
            total = sum(s.duration for s in group)
            if self.ad_pod_min <= total <= self.ad_pod_max:
                for seg in group:
                    seg.flag("discontinuity_pod")

        for seg in segments:
            if DISCONTINUITY_TAG in seg.raw_tags and run:
                evaluate(run)
                run = []
            run.append(seg)
        evaluate(run)

    def _pass_duration_heuristic(self, segments: list[Segment]) -> None:
        """
        Very short isolated segments surrounded by normal content are likely
        tracking / ad ping segments.
        """
        for i, seg in enumerate(segments):
            if seg.is_ad:
                continue
            if seg.duration < self.min_ad_duration:
                neighbours = segments[max(0, i - 2): i] + segments[i + 1: i + 3]
                if neighbours and all(not s.is_ad for s in neighbours):
                    seg.flag("duration_heuristic")
