"""Decode a video, crop each frame with the interpolated box, and write a review or a PDF.

ffmpeg is resolved the same way vid2pdf looks for it: ``FFMPEG_PATH``, then PATH,
then the binary shipped with imageio-ffmpeg. Decoding goes through ffmpeg so
rotation metadata is applied and the frame clock matches the keyframes.
"""

from __future__ import annotations

import math
import os
import re
import shutil
import subprocess
import threading
from io import BytesIO
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from zoom_math import (
    box_pixels,
    clamp_box,
    default_box,
    interpolate_box,
    output_size,
    page_points,
)

PREVIEW_LONG_EDGE = 1280
PDF_LONG_EDGE = 1650
NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0

_PROBE = re.compile(
    r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)"
    r".*?Video:\s*(\w+)"
    r".*?(\d{2,5})x(\d{2,5})"
    r".*?(\d+(?:\.\d+)?)\s*fps",
    re.S,
)
_ROTATION = re.compile(
    r"rotation of (-?\d+(?:\.\d+)?) degrees|rotate\s*:\s*(-?\d+(?:\.\d+)?)"
)


class CancelToken:
    def __init__(self) -> None:
        self._event = threading.Event()
        self.procs: list[subprocess.Popen] = []

    def cancelled(self) -> bool:
        return self._event.is_set()

    def cancel(self) -> None:
        self._event.set()
        for proc in self.procs:
            if proc.poll() is None:
                proc.kill()


def ffmpeg_exe() -> str:
    env = os.environ.get("FFMPEG_PATH", "").strip()
    if env:
        candidate = Path(env)
        if candidate.is_dir():
            name = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
            nested = candidate / name
            if nested.is_file():
                return str(nested)
        if candidate.is_file():
            return str(candidate)
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg
    except ImportError as exc:
        raise RuntimeError(
            "ffmpeg was not found. Install it, set FFMPEG_PATH, or install imageio-ffmpeg."
        ) from exc
    return imageio_ffmpeg.get_ffmpeg_exe()


def probe(path: Path) -> dict:
    proc = subprocess.run(
        [ffmpeg_exe(), "-hide_banner", "-i", str(path)],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
        creationflags=NO_WINDOW,
    )
    text = proc.stderr or ""
    meta = parse_probe(text, path)
    if meta is None:
        detail = text.strip().splitlines()
        tail = detail[-1] if detail else "ffmpeg could not read that file"
        raise RuntimeError(tail)
    return meta


def parse_probe(text: str, path: Path) -> dict | None:
    match = _PROBE.search(text)
    if not match:
        return None
    hours, minutes, seconds, codec, width_s, height_s, fps_s = match.groups()
    duration = int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    fps = float(fps_s)
    width = int(width_s)
    height = int(height_s)
    turned = _ROTATION.search(text)
    if turned:
        angle = float(turned.group(1) or turned.group(2))
        if abs(abs(angle) - 90) < 1 or abs(abs(angle) - 270) < 1:
            width, height = height, width
    if width < 2 or height < 2 or fps <= 0 or duration <= 0:
        return None
    frames = max(1, int(round(duration * fps)))
    return {
        "path": str(path.resolve()),
        "name": path.name,
        "width": width,
        "height": height,
        "fps": fps,
        "frames": frames,
        "duration": duration,
        "codec": codec,
        "browser_safe": _browser_safe(path, codec),
    }


def crop_image(frame: np.ndarray, box: dict, aspect: float, out_size: tuple[int, int]) -> Image.Image:
    """Resample the aspect-locked box to ``out_size``. Pixels outside the frame are black.

    ``rot`` is clockwise radians. 0 keeps the labeled top edge at the top of the page.
    """
    frame_h, frame_w = frame.shape[:2]
    _x0, _y0, box_w, box_h = box_pixels(box, frame_w, frame_h, aspect)
    try:
        rot = float(box.get("rot", 0) or 0)
    except (TypeError, ValueError):
        rot = 0.0
    if not math.isfinite(rot):
        rot = 0.0
    cx = float(box["cx"]) * frame_w
    cy = float(box["cy"]) * frame_h
    cos = math.cos(rot)
    sin = math.sin(rot)
    out_w, out_h = out_size
    # Output (x, y) samples the source point reached by rotating the page-local
    # offset clockwise about the crosshair. At rot 0 this is the old axis-aligned crop.
    image = Image.fromarray(frame, mode="RGB")
    return image.transform(
        (out_w, out_h),
        Image.AFFINE,
        (
            (box_w / out_w) * cos,
            -(box_h / out_h) * sin,
            cx - 0.5 * box_w * cos + 0.5 * box_h * sin,
            (box_w / out_w) * sin,
            (box_h / out_h) * cos,
            cy - 0.5 * box_w * sin - 0.5 * box_h * cos,
        ),
        resample=Image.Resampling.BILINEAR,
        fillcolor=(0, 0, 0),
    )


def draw_crosshair(image: Image.Image) -> None:
    """Review-only mark at the page center, with a gap so the subject pixel stays visible."""
    draw = ImageDraw.Draw(image)
    width, height = image.size
    cx = (width - 1) / 2
    cy = (height - 1) / 2
    gap = min(max(6, int(round(min(width, height) * 0.015))), width // 4, height // 4)
    segments = (
        (0, cy, cx - gap, cy),
        (cx + gap, cy, width - 1, cy),
        (cx, 0, cx, cy - gap),
        (cx, cy + gap, cx, height - 1),
    )
    for color, stroke in (((0, 0, 0), 3), ((255, 214, 90), 1)):
        for x1, y1, x2, y2 in segments:
            draw.line((x1, y1, x2, y2), fill=color, width=stroke)


def render_preview(
    video: Path,
    dest: Path,
    meta: dict,
    params: dict,
    *,
    long_edge: int = PREVIEW_LONG_EDGE,
    progress=None,
    token: CancelToken | None = None,
) -> dict:
    dest.parent.mkdir(parents=True, exist_ok=True)
    out_w, out_h = output_size(params["aspect"], long_edge)
    out_fps = float(meta["fps"]) / int(params["step"])
    encoder = _popen(
        token,
        [
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
            f"{out_w}x{out_h}",
            "-framerate",
            f"{out_fps:.8f}",
            "-i",
            "pipe:0",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(dest),
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    enc_err: list[bytes] = []
    enc_thread = threading.Thread(target=_drain, args=(encoder.stderr, enc_err), daemon=True)
    enc_thread.start()
    count = 0
    try:
        def handle(image: Image.Image, _t: float, _index: int) -> None:
            nonlocal count
            if params.get("crosshair", True):
                draw_crosshair(image)
            assert encoder.stdin is not None
            encoder.stdin.write(image.tobytes())
            count += 1

        _for_each_frame(video, meta, params, (out_w, out_h), handle, progress, token)
    except Exception:
        _close_pipe(encoder.stdin)
        if encoder.poll() is None:
            encoder.kill()
        dest.unlink(missing_ok=True)
        raise
    cancelled = bool(token and token.cancelled())
    _close_pipe(encoder.stdin)
    if cancelled:
        if encoder.poll() is None:
            encoder.kill()
        encoder.wait(timeout=15)
        dest.unlink(missing_ok=True)
        return {"frames": count, "cancelled": True}
    _finish(encoder, enc_err, enc_thread)
    if count < 1:
        dest.unlink(missing_ok=True)
        raise RuntimeError("No frames were decoded for that range. Check the start and end.")
    return {
        "frames": count,
        "start": float(params["start"]),
        "fps": out_fps,
        "download_name": f"{video.stem}_zoom_review.mp4",
    }


def render_pdf(
    video: Path,
    dest: Path,
    meta: dict,
    params: dict,
    *,
    long_edge: int = PDF_LONG_EDGE,
    progress=None,
    token: CancelToken | None = None,
) -> dict:
    from fpdf import FPDF

    dest.parent.mkdir(parents=True, exist_ok=True)
    out_w, out_h = output_size(params["aspect"], long_edge)
    page_w, page_h = page_points(params["aspect"])
    pdf = FPDF(unit="pt", format=(page_w, page_h))
    pdf.set_margin(0)
    pdf.set_auto_page_break(auto=False, margin=0)
    buffers: list[BytesIO] = []
    count = 0

    def handle(image: Image.Image, _t: float, _index: int) -> None:
        nonlocal count
        pdf.add_page()
        buffer = BytesIO()
        image.save(buffer, format="JPEG", quality=90)
        buffer.seek(0)
        buffers.append(buffer)
        pdf.image(buffer, x=0, y=0, w=page_w, h=page_h)
        count += 1

    try:
        _for_each_frame(video, meta, params, (out_w, out_h), handle, progress, token)
        if token and token.cancelled():
            dest.unlink(missing_ok=True)
            return {"frames": count, "cancelled": True}
        if count < 1:
            raise RuntimeError("No frames were decoded for that range. Check the start and end.")
        pdf.output(dest)
    except Exception:
        dest.unlink(missing_ok=True)
        raise
    finally:
        buffers.clear()
    return {
        "frames": count,
        "start": float(params["start"]),
        "fps": float(meta["fps"]) / int(params["step"]),
        "download_name": f"{video.stem}_zoom.pdf",
    }


def render_proxy(
    video: Path,
    dest: Path,
    meta: dict,
    *,
    progress=None,
    token: CancelToken | None = None,
) -> dict:
    """H.264 proxy so the editor can scrub files the browser cannot play."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    duration = max(float(meta["duration"]), 0.001)
    proc = _popen(
        token,
        [
            ffmpeg_exe(),
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(video),
            "-vf",
            "scale='trunc(min(1600,iw)/2)*2':-2",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-an",
            "-movflags",
            "+faststart",
            "-progress",
            "pipe:1",
            "-nostats",
            str(dest),
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    err: list[bytes] = []
    thread = threading.Thread(target=_drain, args=(proc.stderr, err), daemon=True)
    thread.start()
    assert proc.stdout is not None
    try:
        for raw_line in proc.stdout:
            if token and token.cancelled():
                break
            line = raw_line.decode("utf-8", "replace").strip()
            seconds = _progress_seconds(line, duration)
            if seconds is None or progress is None:
                continue
            progress(min(0.99, seconds / duration), f"Playable preview {seconds / duration * 100:.0f}%")
    finally:
        if token and token.cancelled() and proc.poll() is None:
            proc.kill()
    if token and token.cancelled():
        proc.wait(timeout=15)
        dest.unlink(missing_ok=True)
        return {"cancelled": True}
    _finish(proc, err, thread)
    return {"download_name": f"{video.stem}_proxy.mp4"}


def _for_each_frame(video, meta, params, out_size, handle, progress, token) -> int:
    fps = float(meta["fps"])
    width = int(meta["width"])
    height = int(meta["height"])
    start = float(params["start"])
    end = float(params["end"])
    step = max(1, int(params["step"]))
    aspect = float(params["aspect"])
    keys = list(params.get("keyframes") or [])
    fallback = default_box(width, height, aspect)
    out_fps = fps / step
    estimated = max(1, int(round((end - start) * out_fps)))
    proc = _popen(
        token,
        [
            ffmpeg_exe(),
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            f"{start:.6f}",
            "-to",
            f"{end + step / fps:.6f}",
            "-i",
            str(video),
            "-vf",
            f"fps={out_fps:.8f}",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-an",
            "-sn",
            "-dn",
            "pipe:1",
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    err: list[bytes] = []
    thread = threading.Thread(target=_drain, args=(proc.stderr, err), daemon=True)
    thread.start()
    index = 0
    stopped_early = False
    failed = False
    assert proc.stdout is not None
    try:
        while True:
            if token and token.cancelled():
                stopped_early = True
                break
            raw = _read_exact(proc.stdout, width * height * 3)
            if raw is None:
                break
            t = start + index * step / fps
            if t > end + 1e-3:
                # Drop the tail instead of leaving ffmpeg blocked on a full pipe.
                stopped_early = True
                break
            frame = np.frombuffer(raw, dtype=np.uint8).reshape((height, width, 3)).copy()
            box = clamp_box(interpolate_box(t, keys, fallback), width, height, aspect)
            image = crop_image(frame, box, aspect, out_size)
            handle(image, t, index)
            index += 1
            if progress is not None:
                progress(min(0.99, index / estimated), f"Frame {index} of about {estimated}")
    except Exception:
        failed = True
        raise
    finally:
        if proc.poll() is None and (stopped_early or failed):
            proc.kill()
        try:
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=10)
        thread.join(timeout=5)
        if proc.stdout is not None:
            proc.stdout.close()
    if token and token.cancelled():
        return index
    err_text = b"".join(err).decode("utf-8", "replace").strip()
    if index == 0:
        raise RuntimeError(err_text or "No frames were decoded for that range. Check the start and end.")
    if not stopped_early and proc.returncode not in (0, None):
        raise RuntimeError(err_text or f"ffmpeg exited with code {proc.returncode}")
    return index


def _progress_seconds(line: str, duration: float) -> float | None:
    if line.startswith("out_time_us="):
        return int(line.split("=", 1)[1] or 0) / 1_000_000
    if line.startswith("out_time_ms="):
        raw = int(line.split("=", 1)[1] or 0)
        # Older ffmpeg reports microseconds in out_time_ms.
        if raw > duration * 1500:
            return raw / 1_000_000
        return raw / 1000
    return None


def _browser_safe(path: Path, codec: str) -> bool:
    ext = path.suffix.lower()
    codec = codec.lower()
    if ext == ".webm":
        return codec in {"vp8", "vp9", "av1"}
    if ext in {".mp4", ".m4v"}:
        return codec in {"h264", "avc", "avc1", "av1"}
    return False


def _popen(token: CancelToken | None, cmd: list[str], **kwargs) -> subprocess.Popen:
    proc = subprocess.Popen(cmd, creationflags=NO_WINDOW, bufsize=0, **kwargs)
    if token is not None:
        token.procs.append(proc)
    return proc


def _drain(stream, sink: list[bytes]) -> None:
    try:
        if stream is not None:
            sink.append(stream.read())
    except Exception:
        pass
    finally:
        try:
            if stream is not None:
                stream.close()
        except Exception:
            pass


def _read_exact(stream, size: int) -> bytes | None:
    chunks = []
    got = 0
    while got < size:
        chunk = stream.read(size - got)
        if not chunk:
            if got == 0:
                return None
            raise RuntimeError("ffmpeg returned a partial frame. The video may be damaged.")
        chunks.append(chunk)
        got += len(chunk)
    return b"".join(chunks)


def _close_pipe(pipe) -> None:
    if pipe is None or pipe.closed:
        return
    try:
        pipe.close()
    except OSError:
        pass


def _finish(proc: subprocess.Popen, err: list[bytes], thread: threading.Thread) -> None:
    try:
        code = proc.wait(timeout=120)
    except subprocess.TimeoutExpired:
        proc.kill()
        code = proc.wait(timeout=10)
    thread.join(timeout=5)
    if code != 0:
        text = b"".join(err).decode("utf-8", "replace").strip()
        raise RuntimeError(text or f"ffmpeg exited with code {code}")
