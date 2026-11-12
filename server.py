"""Local viewer for keyframed parachute crops.

Start it from the project folder with the private environment's Python:

    .venv/Scripts/python.exe server.py

The page opens at http://127.0.0.1:8765. Running some other Python skips the
libraries and fails with ``No module named 'fastapi'``.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import subprocess
import sys
import threading
import traceback
import uuid
from contextlib import asynccontextmanager
from pathlib import Path


def _missing_library(exc: ModuleNotFoundError) -> None:
    missing = exc.name or "a required library"
    print(
        f"Python could not find {missing}.\n"
        "\n"
        "The libraries for this app are not installed in the Python that just started.\n"
        "The library name is fastapi, one word.\n"
        "\n"
        "From a terminal, in this folder:\n"
        "  python -m venv .venv\n"
        "  .venv\\Scripts\\python.exe -m pip install -r requirements.txt\n"
        "  .venv\\Scripts\\python.exe server.py\n"
        "\n"
        "On macOS or Linux, use .venv/bin/python instead of .venv\\Scripts\\python.exe.\n",
        file=sys.stderr,
    )
    raise SystemExit(1)


try:
    from fastapi import Body, FastAPI, HTTPException
    from fastapi.responses import FileResponse, JSONResponse, Response
    from fastapi.staticfiles import StaticFiles

    from engine import CancelToken, probe, render_pdf, render_preview, render_proxy
    from zoom_math import clean_aspect, clean_keys
except ModuleNotFoundError as exc:
    _missing_library(exc)

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
OUTPUT = ROOT / "output"
JOB_DIR = OUTPUT / "jobs"
PROJECT_DIR = OUTPUT / "projects"

LOCK = threading.Lock()
STATE: dict = {"video": None, "meta": None, "proxy": None}
JOBS: dict[str, "Job"] = {}


class Job:
    def __init__(self, kind: str) -> None:
        self.id = uuid.uuid4().hex[:12]
        self.kind = kind
        self.status = "queued"
        self.progress = 0.0
        self.message = "Queued"
        self.error: str | None = None
        self.path: Path | None = None
        self.meta: dict = {}
        self.token = CancelToken()


def job_view(job: Job) -> dict:
    ready = job.status == "done" and job.path is not None
    return {
        "id": job.id,
        "kind": job.kind,
        "status": job.status,
        "progress": job.progress,
        "message": job.message,
        "error": job.error,
        "meta": job.meta,
        "file": f"/api/jobs/{job.id}/file" if ready else None,
    }


def _cleanup_old_jobs(max_age_hours: float = 48) -> None:
    if not JOB_DIR.exists():
        return
    import time

    cutoff = time.time() - max_age_hours * 3600
    for path in JOB_DIR.iterdir():
        try:
            if path.is_file() and path.stat().st_mtime < cutoff:
                path.unlink()
        except OSError:
            pass


@asynccontextmanager
async def lifespan(_app: FastAPI):
    JOB_DIR.mkdir(parents=True, exist_ok=True)
    PROJECT_DIR.mkdir(parents=True, exist_ok=True)
    _cleanup_old_jobs()
    yield


app = FastAPI(title="Vid2PDF Zoom", lifespan=lifespan)


@app.middleware("http")
async def no_store_assets(request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.exception_handler(ValueError)
async def _value_error(_request, exc: ValueError):
    return JSONResponse({"detail": str(exc)}, status_code=400)


@app.exception_handler(FileNotFoundError)
async def _missing(_request, exc: FileNotFoundError):
    return JSONResponse({"detail": str(exc)}, status_code=404)


@app.exception_handler(RuntimeError)
async def _runtime(_request, exc: RuntimeError):
    return JSONResponse({"detail": str(exc)}, status_code=400)


def _video() -> Path:
    with LOCK:
        video = STATE.get("video")
    if video is None:
        raise ValueError("Open a video first")
    return Path(video)


def _meta() -> dict:
    with LOCK:
        meta = STATE.get("meta")
    if not meta:
        raise ValueError("Open a video first")
    return dict(meta)


def _project_paths(video: Path) -> list[Path]:
    digest = hashlib.sha1(str(video.resolve()).lower().encode()).hexdigest()[:12]
    return [video.with_name(video.name + ".zoom.json"), PROJECT_DIR / f"{digest}.json"]


def load_project(video: Path) -> dict | None:
    for path in _project_paths(video):
        try:
            if path.is_file():
                return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
    return None


def save_project(video: Path, data: dict) -> None:
    payload = json.dumps(data, indent=2)
    saved = False
    last_error = "Could not save the project"
    for path in _project_paths(video):
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            temp = path.with_suffix(path.suffix + ".tmp")
            temp.write_text(payload, encoding="utf-8")
            temp.replace(path)
            saved = True
        except OSError as exc:
            last_error = str(exc)
    if not saved:
        raise OSError(last_error)


def open_video(path_str: str) -> dict:
    raw = str(path_str).strip().strip('"').strip("'")
    path = Path(raw).expanduser()
    if not path.is_file():
        raise FileNotFoundError(f"No video at {path}")
    meta = probe(path)
    project = load_project(path)
    with LOCK:
        STATE["video"] = path.resolve()
        STATE["meta"] = meta
        STATE["proxy"] = None
    return {"meta": meta, "project": project}


def _as_int(value, default: int = 1) -> int:
    try:
        return max(1, int(round(float(value))))
    except (TypeError, ValueError):
        return default


def normalize_project(body: dict, meta: dict) -> dict:
    aspect_w = float(body.get("aspect_w", 16))
    aspect_h = float(body.get("aspect_h", 9))
    clean_aspect(aspect_w, aspect_h)
    duration = float(meta["duration"])
    try:
        start = float(body.get("start", 0))
        end = float(body.get("end", duration))
    except (TypeError, ValueError) as exc:
        raise ValueError("Start and end times have to be numbers") from exc
    start = min(max(0.0, start), duration)
    end = min(max(0.0, end), duration)
    if end <= start:
        start, end = 0.0, duration
    return {
        "version": 1,
        "aspect_w": aspect_w,
        "aspect_h": aspect_h,
        "start": start,
        "end": end,
        "preview_step": _as_int(body.get("preview_step", 1)),
        "pdf_step": _as_int(body.get("pdf_step", 1)),
        "crosshair": bool(body.get("crosshair", True)),
        "keyframes": clean_keys(body.get("keyframes") or [], meta),
    }


def build_params(body: dict, meta: dict) -> dict:
    aspect = clean_aspect(body.get("aspect_w", 16), body.get("aspect_h", 9))
    duration = float(meta["duration"])
    try:
        start = float(body.get("start", 0))
        end = float(body.get("end", duration))
    except (TypeError, ValueError) as exc:
        raise ValueError("Start and end times have to be numbers") from exc
    start = min(max(0.0, start), duration)
    end = min(max(0.0, end), duration)
    if end - start < 1e-3:
        raise ValueError("The end time has to be after the start time")
    step = _as_int(body.get("step", 1))
    return {
        "aspect": aspect,
        "start": start,
        "end": end,
        "step": step,
        "crosshair": bool(body.get("crosshair", True)),
        "keyframes": clean_keys(body.get("keyframes") or [], meta),
    }


def _busy() -> bool:
    return any(job.status in {"queued", "running"} for job in JOBS.values())


def start_job(kind: str, work) -> dict:
    job = Job(kind)
    with LOCK:
        if _busy():
            raise HTTPException(status_code=409, detail="A render is already running")
        JOBS[job.id] = job
        job.status = "running"
        job.message = "Starting"

    def runner() -> None:
        try:
            result = work(job)
            if job.token.cancelled() or (isinstance(result, dict) and result.get("cancelled")):
                job.status = "cancelled"
                job.message = "Cancelled"
                return
            job.meta = result or {}
            job.status = "done"
            job.progress = 1
            job.message = "Done"
        except Exception as exc:
            if job.token.cancelled():
                job.status = "cancelled"
                job.message = "Cancelled"
                return
            job.status = "error"
            job.error = str(exc)
            job.message = "Failed"
            traceback.print_exc()

    threading.Thread(target=runner, name=f"vid2pdf-{kind}", daemon=True).start()
    return job_view(job)


def browse_dialog() -> str:
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        return filedialog.askopenfilename(
            title="Select a video",
            filetypes=[
                ("Video", "*.mp4 *.mov *.mkv *.avi *.m4v *.webm *.wmv *.mpeg *.mpg"),
                ("All files", "*.*"),
            ],
        )
    finally:
        root.destroy()


@app.get("/api/health")
def health():
    try:
        from engine import ffmpeg_exe

        return {"ok": True, "ffmpeg": ffmpeg_exe()}
    except Exception as exc:
        return {"ok": False, "ffmpeg": None, "error": str(exc)}


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/favicon.ico")
def favicon():
    return Response(status_code=204)


@app.post("/api/browse")
async def browse():
    try:
        selected = await asyncio.to_thread(browse_dialog)
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Could not open the file dialog ({exc}). Paste the path instead.",
        ) from exc
    if not selected:
        return {"cancelled": True}
    return await asyncio.to_thread(open_video, selected)


@app.post("/api/open")
async def open_endpoint(body: dict = Body(...)):
    return await asyncio.to_thread(open_video, str(body.get("path", "")))


@app.get("/api/media")
def media(which: str = "source"):
    with LOCK:
        path = STATE.get("proxy") if which == "proxy" else STATE.get("video")
    if not path or not Path(path).is_file():
        raise HTTPException(status_code=404, detail="No video is open")
    return FileResponse(path)


@app.get("/api/project")
def get_project():
    return {"project": load_project(_video())}


@app.put("/api/project")
async def put_project(body: dict = Body(...)):
    video = _video()
    data = normalize_project(body, _meta())
    await asyncio.to_thread(save_project, video, data)
    return {"ok": True, "project": data}


@app.post("/api/preview")
async def preview(body: dict = Body(...)):
    video = _video()
    meta = _meta()
    params = build_params(body, meta)

    def work(job: Job) -> dict:
        dest = JOB_DIR / f"{job.id}.mp4"
        job.path = dest

        def report(frac: float, message: str) -> None:
            job.progress = frac
            job.message = message

        return render_preview(video, dest, meta, params, progress=report, token=job.token)

    return start_job("preview", work)


@app.post("/api/export")
async def export(body: dict = Body(...)):
    video = _video()
    meta = _meta()
    params = build_params(body, meta)

    def work(job: Job) -> dict:
        dest = JOB_DIR / f"{job.id}.pdf"
        job.path = dest

        def report(frac: float, message: str) -> None:
            job.progress = frac
            job.message = message

        return render_pdf(video, dest, meta, params, progress=report, token=job.token)

    return start_job("pdf", work)


@app.post("/api/proxy")
async def proxy():
    video = _video()
    meta = _meta()

    def work(job: Job) -> dict:
        dest = JOB_DIR / f"{job.id}.mp4"
        job.path = dest
        job.message = "Making a playable preview"

        def report(frac: float, message: str) -> None:
            job.progress = frac
            job.message = message

        result = render_proxy(video, dest, meta, progress=report, token=job.token)
        if not result.get("cancelled"):
            with LOCK:
                STATE["proxy"] = dest
        return result

    return start_job("proxy", work)


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="No such render")
    return job_view(job)


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str):
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="No such render")
    job.token.cancel()
    return {"ok": True}


@app.get("/api/jobs/{job_id}/file")
def job_file(job_id: str):
    job = JOBS.get(job_id)
    if job is None or job.status != "done" or job.path is None or not job.path.is_file():
        raise HTTPException(status_code=404, detail="That file is not ready")
    path = job.path.resolve()
    if JOB_DIR.resolve() not in path.parents:
        raise HTTPException(status_code=400, detail="Bad job file")
    name = (job.meta or {}).get("download_name") or path.name
    media_type = "video/mp4" if path.suffix.lower() == ".mp4" else "application/pdf"
    return FileResponse(
        path,
        media_type=media_type,
        filename=name,
        content_disposition_type="inline",
    )


@app.post("/api/jobs/{job_id}/reveal")
def reveal_job(job_id: str):
    job = JOBS.get(job_id)
    if job is None or job.path is None:
        raise HTTPException(status_code=404, detail="That file is gone")
    path = job.path.resolve()
    if os.name == "nt":
        subprocess.run(["explorer", f"/select,{path}"], check=False)
    elif sys.platform == "darwin":
        subprocess.run(["open", "-R", str(path)], check=False)
    else:
        subprocess.run(["xdg-open", str(path.parent)], check=False)
    return {"ok": True}


app.mount("/static", StaticFiles(directory=STATIC), name="static")


def main() -> None:
    import argparse
    import webbrowser

    import uvicorn

    parser = argparse.ArgumentParser(description="Vid2PDF Zoom")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    url = f"http://{args.host}:{args.port}"
    print(f"Vid2PDF Zoom  {url}")
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
