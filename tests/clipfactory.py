"""Synthetic clip with a canopy-sized dot moving in a straight line."""

from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from engine import NO_WINDOW, ffmpeg_exe


def tracking_geometry() -> dict:
    return {
        "width": 960,
        "height": 540,
        "fps": 20,
        "frames": 40,
        "radius": 30,
        "start": (240, 270),
        "end": (720, 200),
        "box_w": 0.2,
    }


def center_at(index: int, geo: dict | None = None) -> tuple[float, float]:
    geo = geo or tracking_geometry()
    span = max(geo["frames"] - 1, 1)
    u = index / span
    x0, y0 = geo["start"]
    x1, y1 = geo["end"]
    return x0 + (x1 - x0) * u, y0 + (y1 - y0) * u


def norm_center(index: int, geo: dict | None = None) -> tuple[float, float]:
    geo = geo or tracking_geometry()
    x, y = center_at(index, geo)
    return x / geo["width"], y / geo["height"]


def write_tracking_clip(path: Path, geo: dict | None = None) -> dict:
    geo = geo or tracking_geometry()
    path.parent.mkdir(parents=True, exist_ok=True)
    width, height = geo["width"], geo["height"]
    cmd = [
        ffmpeg_exe(),
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-s",
        f"{width}x{height}",
        "-r",
        str(geo["fps"]),
        "-i",
        "pipe:0",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "17",
        "-pix_fmt",
        "yuv420p",
        "-g",
        "1",
        str(path),
    ]
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        bufsize=0,
        creationflags=NO_WINDOW,
    )
    assert proc.stdin is not None
    try:
        for index in range(geo["frames"]):
            image = Image.new("RGB", (width, height), (70, 130, 180))
            draw = ImageDraw.Draw(image)
            x, y = center_at(index, geo)
            radius = geo["radius"]
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=(255, 255, 255))
            bar = int(width * index / max(geo["frames"] - 1, 1))
            draw.rectangle((0, height - 8, bar, height), fill=(240, 180, 40))
            proc.stdin.write(np.asarray(image).tobytes())
        proc.stdin.close()
    except Exception:
        proc.kill()
        raise
    err = proc.stderr.read() if proc.stderr else b""
    if proc.stderr is not None:
        proc.stderr.close()
    code = proc.wait(timeout=60)
    if code != 0:
        raise RuntimeError(err.decode("utf-8", "replace") or f"ffmpeg exited {code}")
    return geo
