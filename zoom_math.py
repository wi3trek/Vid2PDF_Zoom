"""Crop-box math for Vid2PDF Zoom.

Coordinates are normalized to the source frame. ``cx`` and ``cy`` are the
crosshair, 0..1 from the top-left. ``w`` is the box width as a fraction of the
frame width. Box height comes from the output aspect (width / height), so the
crop matches the PDF page. ``rot`` is a clockwise turn in radians. 0 keeps the
labeled top edge at the top of the page.

Zoom 1 is the largest box of that aspect that still fits in the frame.
``DEFAULT_ZOOM`` is 2. ``MAX_ZOOM`` is 30. The same rules are duplicated in
``static/app.js``.
"""

from __future__ import annotations

import math

MAX_ZOOM = 30.0
DEFAULT_ZOOM = 2.0


def clean_aspect(width: float, height: float) -> float:
    w = float(width)
    h = float(height)
    if not math.isfinite(w) or not math.isfinite(h) or w <= 0 or h <= 0:
        raise ValueError("Aspect ratio must use positive numbers")
    aspect = w / h
    if aspect < 0.15 or aspect > 8:
        raise ValueError("Aspect ratio is too extreme")
    return aspect


def max_width_fraction(frame_w: float, frame_h: float, aspect: float) -> float:
    """Largest box width, as a fraction of frame width, that fits in the frame."""
    max_w_px = min(float(frame_w), float(frame_h) * float(aspect))
    if frame_w <= 0 or max_w_px <= 0:
        raise ValueError("Video frame size is invalid")
    return max_w_px / float(frame_w)


def default_box(frame_w: float, frame_h: float, aspect: float) -> dict:
    max_w = max_width_fraction(frame_w, frame_h, aspect)
    return {"cx": 0.5, "cy": 0.5, "w": max_w / DEFAULT_ZOOM, "rot": 0.0}


def wrap_angle(rot: float) -> float:
    """Fold a turn into (-pi, pi]. 0 keeps the labeled top edge toward the top of the page."""
    if not math.isfinite(rot):
        return 0.0
    return math.atan2(math.sin(rot), math.cos(rot))


def clamp_box(box: dict, frame_w: float, frame_h: float, aspect: float) -> dict:
    max_w = max_width_fraction(frame_w, frame_h, aspect)
    min_w = max_w / MAX_ZOOM
    w = float(box["w"])
    if not math.isfinite(w):
        w = max_w / DEFAULT_ZOOM
    return {
        "cx": min(1.0, max(0.0, float(box["cx"]))),
        "cy": min(1.0, max(0.0, float(box["cy"]))),
        "w": min(max_w, max(min_w, w)),
        "rot": wrap_angle(_angle(box)),
    }


def box_pixels(box: dict, frame_w: float, frame_h: float, aspect: float) -> tuple[float, float, float, float]:
    """Return x0, y0, box width, box height in source pixels."""
    box_w = float(box["w"]) * float(frame_w)
    box_h = box_w / float(aspect)
    x0 = float(box["cx"]) * float(frame_w) - box_w / 2.0
    y0 = float(box["cy"]) * float(frame_h) - box_h / 2.0
    return x0, y0, box_w, box_h


def interpolate_box(t: float, keyframes: list[dict], default: dict) -> dict:
    """Linear blend of center, width, and turn. Outside the keys, the nearest key holds.

    The turn takes the short way around, so a frame near upright does not spin the
    long way and land upside down between keys.
    """
    if not keyframes:
        return _copy_box(default)
    keys = sorted(keyframes, key=lambda item: float(item["t"]))
    if t <= float(keys[0]["t"]):
        return _copy_box(keys[0])
    if t >= float(keys[-1]["t"]):
        return _copy_box(keys[-1])
    hi = 1
    while hi < len(keys) and float(keys[hi]["t"]) < t:
        hi += 1
    a = keys[hi - 1]
    b = keys[hi]
    span = float(b["t"]) - float(a["t"])
    u = 0.0 if span <= 0 else (t - float(a["t"])) / span
    return {
        "cx": float(a["cx"]) + (float(b["cx"]) - float(a["cx"])) * u,
        "cy": float(a["cy"]) + (float(b["cy"]) - float(a["cy"])) * u,
        "w": float(a["w"]) + (float(b["w"]) - float(a["w"])) * u,
        "rot": _lerp_angle(_angle(a), _angle(b), u),
    }


def clean_keys(raw: list, meta: dict) -> list[dict]:
    """Keep one box per frame. Times are snapped onto the source frame grid."""
    fps = float(meta["fps"])
    duration = float(meta["duration"])
    if fps <= 0:
        raise ValueError("Video frame rate is invalid")
    by_frame: dict[int, dict] = {}
    for item in raw or []:
        try:
            t = float(item["t"])
            cx = float(item["cx"])
            cy = float(item["cy"])
            w = float(item["w"])
        except (KeyError, TypeError, ValueError):
            continue
        if not math.isfinite(t) or not math.isfinite(cx) or not math.isfinite(cy) or not math.isfinite(w):
            continue
        if w <= 0:
            continue
        try:
            rot = float(item.get("rot", 0) or 0)
        except (TypeError, ValueError):
            rot = 0.0
        t = min(max(0.0, t), duration)
        frame = int(round(t * fps))
        by_frame[frame] = {
            "t": frame / fps,
            "cx": min(1.0, max(0.0, cx)),
            "cy": min(1.0, max(0.0, cy)),
            "w": w,
            "rot": wrap_angle(rot),
        }
    return [by_frame[frame] for frame in sorted(by_frame)]


def output_size(aspect: float, long_edge: int) -> tuple[int, int]:
    """Even pixel size whose long edge is ``long_edge`` and whose shape matches ``aspect``."""
    long_edge = int(long_edge)
    if long_edge < 2:
        raise ValueError("Output size is too small")
    if aspect >= 1:
        width = long_edge
        height = max(2, int(round(long_edge / aspect)))
    else:
        height = long_edge
        width = max(2, int(round(long_edge * aspect)))
    width -= width % 2
    height -= height % 2
    return max(2, width), max(2, height)


def page_points(aspect: float, long_edge: float = 792.0) -> tuple[float, float]:
    """PDF page size in points. 792 pt is 11 inches, the long edge of US Letter."""
    if aspect >= 1:
        return float(long_edge), float(long_edge) / aspect
    return float(long_edge) * aspect, float(long_edge)


def _angle(box: dict) -> float:
    try:
        rot = float(box.get("rot", 0) or 0)
    except (TypeError, ValueError):
        return 0.0
    return rot if math.isfinite(rot) else 0.0


def _lerp_angle(a: float, b: float, u: float) -> float:
    delta = wrap_angle(b - a)
    return wrap_angle(a + delta * u)


def _copy_box(box: dict) -> dict:
    return {
        "cx": float(box["cx"]),
        "cy": float(box["cy"]),
        "w": float(box["w"]),
        "rot": wrap_angle(_angle(box)),
    }
