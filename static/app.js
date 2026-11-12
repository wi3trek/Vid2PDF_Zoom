// Crop interaction for Vid2PDF Zoom.
// Box math matches zoom_math.py: cx/cy are 0..1, w is a fraction of frame width,
// and height follows the output aspect. Zoom 1 fits the frame. MAX_ZOOM is 30.

const MAX_ZOOM = 30;
const DEFAULT_ZOOM = 2;
const PRESETS = [
  ["16:9", 16, 9],
  ["4:3", 4, 3],
  ["3:2", 3, 2],
  ["1:1", 1, 1],
  ["4:5", 4, 5],
  ["9:16", 9, 16],
  ["Letter portrait", 8.5, 11],
  ["Letter landscape", 11, 8.5],
  ["A4 portrait", 210, 297],
  ["A4 landscape", 297, 210],
];

const $ = (id) => document.getElementById(id);

const els = {
  status: $("status"),
  modeEdit: $("mode-edit"),
  modeReview: $("mode-review"),
  editor: $("editor-view"),
  layer: $("frame-layer"),
  video: $("source"),
  reviewStage: $("review-stage"),
  review: $("review"),
  reviewZoom: $("review-zoom"),
  overlay: $("overlay"),
  hudMode: $("hud-mode"),
  hudZoom: $("hud-zoom"),
  empty: $("empty"),
  loading: $("loading"),
  keyThis: $("key-this"),
  stale: $("stale"),
  path: $("path"),
  browse: $("browse"),
  open: $("open"),
  proxy: $("proxy"),
  meta: $("meta"),
  preset: $("preset"),
  aspectW: $("aspect-w"),
  aspectH: $("aspect-h"),
  start: $("start"),
  end: $("end"),
  cx: $("cx"),
  cy: $("cy"),
  zoomSlider: $("zoom-slider"),
  zoom: $("zoom"),
  rot: $("rot"),
  level: $("level"),
  cropPx: $("crop-px"),
  setKey: $("set-key"),
  deleteKey: $("delete-key"),
  keyList: $("key-list"),
  keyEmpty: $("key-empty"),
  gap: $("gap"),
  previewStep: $("preview-step"),
  pdfStep: $("pdf-step"),
  crosshair: $("crosshair"),
  render: $("render"),
  exportBtn: $("export"),
  estimates: $("estimates"),
  job: $("job"),
  jobLabel: $("job-label"),
  jobBar: $("job-bar"),
  jobCancel: $("job-cancel"),
  results: $("results"),
  pdfLink: $("pdf-link"),
  reveal: $("reveal"),
  play: $("play"),
  stepBack: $("step-back"),
  stepFwd: $("step-fwd"),
  timecode: $("timecode"),
  frameLabel: $("frame-label"),
  rate: $("rate"),
  setIn: $("set-in"),
  setOut: $("set-out"),
  resetView: $("reset-view"),
  timeline: $("timeline"),
  shadeL: $("shade-l"),
  shadeR: $("shade-r"),
  keys: $("keys"),
  playhead: $("playhead"),
  trimIn: $("trim-in"),
  trimOut: $("trim-out"),
  timelineRange: $("timeline-range"),
  timelineTrim: $("timeline-trim"),
  timelineFit: $("timeline-fit"),
};

const state = {
  meta: null,
  keyframes: [],
  undo: [],
  redo: [],
  start: 0,
  end: 0,
  aspectW: 16,
  aspectH: 9,
  override: null,
  editing: false,
  drag: null,
  panning: null,
  hydrating: false,
  preview: null,
  previewStale: true,
  pdfJob: null,
  job: null,
  mode: "edit",
  view: { scale: 1, panX: 0, panY: 0, baseW: 0, baseH: 0 },
  reviewView: { scale: 1, panX: 0, panY: 0 },
  timeline: { start: 0, span: 0 },
  saveTimer: 0,
  nudgeTimer: 0,
};

function clamp(n, a, b) {
  return Math.min(b, Math.max(a, n));
}

function fps() {
  return state.meta ? state.meta.fps : 30;
}

function duration() {
  return state.meta ? state.meta.duration : 0;
}

function aspect() {
  return state.aspectW / state.aspectH;
}

function maxWidthFrac() {
  const maxW = Math.min(state.meta.width, state.meta.height * aspect());
  return maxW / state.meta.width;
}

function defaultBox() {
  return { cx: 0.5, cy: 0.5, w: maxWidthFrac() / DEFAULT_ZOOM, rot: 0 };
}

function boxAngle(box) {
  const rot = Number(box && box.rot);
  return Number.isFinite(rot) ? rot : 0;
}

function wrapAngle(rad) {
  if (!Number.isFinite(rad)) return 0;
  return Math.atan2(Math.sin(rad), Math.cos(rad));
}

function lerpAngle(a, b, u) {
  const delta = wrapAngle(b - a);
  return wrapAngle(a + delta * u);
}

function copyBox(box) {
  return { cx: box.cx, cy: box.cy, w: box.w, rot: boxAngle(box) };
}

function clampBox(box) {
  const maxW = maxWidthFrac();
  return {
    cx: clamp(box.cx, 0, 1),
    cy: clamp(box.cy, 0, 1),
    w: clamp(box.w, maxW / MAX_ZOOM, maxW),
    rot: wrapAngle(boxAngle(box)),
  };
}

function interpolate(t, keys, fallback) {
  if (!keys.length) return copyBox(fallback);
  if (t <= keys[0].t) return copyBox(keys[0]);
  const last = keys[keys.length - 1];
  if (t >= last.t) return copyBox(last);
  let hi = 1;
  while (hi < keys.length && keys[hi].t < t) hi += 1;
  const a = keys[hi - 1];
  const b = keys[hi];
  const span = b.t - a.t;
  const u = span <= 0 ? 0 : (t - a.t) / span;
  return {
    cx: a.cx + (b.cx - a.cx) * u,
    cy: a.cy + (b.cy - a.cy) * u,
    w: a.w + (b.w - a.w) * u,
    rot: lerpAngle(boxAngle(a), boxAngle(b), u),
  };
}

function snap(t) {
  const rate = fps();
  return clamp(Math.round(t * rate) / rate, 0, duration());
}

function keyAt(t) {
  const tol = 0.51 / fps();
  return state.keyframes.find((key) => Math.abs(key.t - t) <= tol) || null;
}

function displayedBox() {
  if (state.override) return state.override;
  return interpolate(currentSourceTime(), state.keyframes, defaultBox());
}

function currentSourceTime() {
  if (state.mode === "review" && state.preview) {
    return clamp(state.preview.start + (els.review.currentTime || 0), 0, duration());
  }
  return els.video.currentTime || 0;
}

function activeVideo() {
  return state.mode === "review" ? els.review : els.video;
}

function activeFps() {
  if (state.mode === "review" && state.preview) return state.preview.fps || fps();
  return fps();
}

function formatTime(t) {
  const sign = t < 0 ? "-" : "";
  const ms = Math.round(Math.abs(t) * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const milli = ms % 1000;
  const tail = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(milli).padStart(3, "0")}`;
  return h > 0 ? `${sign}${h}:${tail}` : `${sign}${tail}`;
}

function parseTime(text) {
  const value = text.trim();
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value);
  const match = value.match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function trimNum(n) {
  return String(Math.round(n * 1000) / 1000);
}

function sliderToZoom(value) {
  return MAX_ZOOM ** (Number(value) / 100);
}

function zoomToSlider(zoom) {
  return (100 * Math.log(clamp(zoom, 1, MAX_ZOOM))) / Math.log(MAX_ZOOM);
}

function setStatus(text, kind = "") {
  els.status.textContent = text || "";
  els.status.dataset.kind = kind;
}

async function api(path, options = {}) {
  const opts = { ...options };
  if (opts.body) {
    opts.headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  }
  const response = await fetch(path, opts);
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { detail: text };
    }
  }
  if (!response.ok) {
    const detail = data && data.detail;
    const message = typeof detail === "string" ? detail : detail ? JSON.stringify(detail) : response.statusText;
    throw new Error(message);
  }
  return data;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function snapshot() {
  return JSON.stringify({
    keyframes: state.keyframes,
    aspectW: state.aspectW,
    aspectH: state.aspectH,
    start: state.start,
    end: state.end,
  });
}

function pushUndo() {
  state.undo.push(snapshot());
  if (state.undo.length > 100) state.undo.shift();
  state.redo.length = 0;
}

function restore(raw) {
  const data = JSON.parse(raw);
  state.keyframes = data.keyframes;
  state.aspectW = data.aspectW;
  state.aspectH = data.aspectH;
  state.start = data.start;
  state.end = data.end;
  state.override = null;
  state.editing = false;
  state.previewStale = true;
  syncAspectFields();
  refresh();
  draw();
  saveProject();
}

function undo() {
  clearTimeout(state.nudgeTimer);
  state.override = null;
  state.editing = false;
  if (!state.undo.length) return;
  state.redo.push(snapshot());
  restore(state.undo.pop());
}

function redo() {
  clearTimeout(state.nudgeTimer);
  state.override = null;
  if (!state.redo.length) return;
  state.undo.push(snapshot());
  restore(state.redo.pop());
}

function sameBox(a, b) {
  return Math.abs(a.cx - b.cx) < 1e-4
    && Math.abs(a.cy - b.cy) < 1e-4
    && Math.abs(a.w - b.w) < 1e-4
    && Math.abs(wrapAngle(boxAngle(a) - boxAngle(b))) < 1e-3;
}

function commitBox(box) {
  if (!state.meta) return false;
  const t = snap(state.mode === "edit" ? els.video.currentTime || 0 : currentSourceTime());
  const existing = keyAt(t);
  state.override = null;
  state.editing = false;
  if (existing && sameBox(existing, box)) {
    draw();
    return false;
  }
  pushUndo();
  const tol = 0.51 / fps();
  const next = state.keyframes.filter((key) => Math.abs(key.t - t) >= tol);
  next.push({ t, cx: box.cx, cy: box.cy, w: box.w, rot: boxAngle(box) });
  next.sort((a, b) => a.t - b.t);
  state.keyframes = next;
  state.previewStale = true;
  refresh();
  draw();
  saveProject();
  return true;
}

function deleteKey(t) {
  const tol = 0.51 / fps();
  const next = state.keyframes.filter((key) => Math.abs(key.t - t) >= tol);
  if (next.length === state.keyframes.length) return;
  pushUndo();
  state.keyframes = next;
  state.previewStale = true;
  refresh();
  draw();
  saveProject();
}

function projectBody() {
  return {
    version: 1,
    aspect_w: state.aspectW,
    aspect_h: state.aspectH,
    start: state.start,
    end: state.end,
    preview_step: Math.max(1, Math.round(Number(els.previewStep.value) || 1)),
    pdf_step: Math.max(1, Math.round(Number(els.pdfStep.value) || 1)),
    crosshair: els.crosshair.checked,
    keyframes: state.keyframes,
  };
}

function saveProject() {
  if (!state.meta || state.hydrating) return;
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    api("/api/project", { method: "PUT", body: JSON.stringify(projectBody()) }).catch((error) => {
      setStatus(error.message, "error");
    });
  }, 400);
}

function flushEdit() {
  clearTimeout(state.nudgeTimer);
  if (state.override) commitBox(state.override);
  state.editing = false;
}

function syncPresetSelect() {
  const found = PRESETS.find(
    (preset) => Math.abs(preset[1] - state.aspectW) < 1e-6 && Math.abs(preset[2] - state.aspectH) < 1e-6,
  );
  els.preset.value = found ? found[0] : "custom";
}

function syncAspectFields() {
  if (document.activeElement !== els.aspectW) els.aspectW.value = trimNum(state.aspectW);
  if (document.activeElement !== els.aspectH) els.aspectH.value = trimNum(state.aspectH);
  syncPresetSelect();
}

function setAspect(w, h, options = {}) {
  const record = options.record !== false;
  const rescale = options.rescale !== false;
  w = Number(w);
  h = Number(h);
  if (!(w > 0) || !(h > 0)) return;
  if (Math.abs(w - state.aspectW) < 1e-9 && Math.abs(h - state.aspectH) < 1e-9) {
    syncAspectFields();
    return;
  }
  if (record) pushUndo();
  let ratios = null;
  if (rescale && state.meta) {
    const oldMax = maxWidthFrac();
    ratios = state.keyframes.map((key) => key.w / oldMax);
    if (state.override) ratios.override = state.override.w / oldMax;
  }
  state.aspectW = w;
  state.aspectH = h;
  if (ratios && state.meta) {
    const maxW = maxWidthFrac();
    state.keyframes = state.keyframes.map((key, index) => ({
      ...key,
      w: clamp(ratios[index] * maxW, maxW / MAX_ZOOM, maxW),
    }));
    if (state.override) {
      state.override = clampBox({ ...state.override, w: ratios.override * maxW });
    }
  }
  state.previewStale = true;
  syncAspectFields();
  refresh();
  draw();
  saveProject();
}

function applyProject(project) {
  if (!project || typeof project !== "object") return;
  state.aspectW = Number(project.aspect_w) || 16;
  state.aspectH = Number(project.aspect_h) || 9;
  state.start = clamp(Number(project.start) || 0, 0, duration());
  state.end = clamp(Number(project.end) || duration(), 0, duration());
  if (state.end <= state.start) state.end = duration();
  state.keyframes = Array.isArray(project.keyframes)
    ? project.keyframes
        .map((key) => ({
          t: Number(key.t),
          cx: Number(key.cx),
          cy: Number(key.cy),
          w: Number(key.w),
          rot: Number.isFinite(Number(key.rot)) ? Number(key.rot) : 0,
        }))
        .filter((key) => Number.isFinite(key.t) && Number.isFinite(key.w))
        .sort((a, b) => a.t - b.t)
    : [];
  if (project.preview_step) els.previewStep.value = project.preview_step;
  if (project.pdf_step) els.pdfStep.value = project.pdf_step;
  if (typeof project.crosshair === "boolean") els.crosshair.checked = project.crosshair;
}

function applyLoaded(data) {
  state.hydrating = true;
  state.meta = data.meta;
  state.keyframes = [];
  state.undo = [];
  state.redo = [];
  state.override = null;
  state.editing = false;
  state.start = 0;
  state.end = data.meta.duration;
  state.aspectW = 16;
  state.aspectH = 9;
  state.preview = null;
  state.previewStale = true;
  state.pdfJob = null;
  state.view = { scale: 1, panX: 0, panY: 0, baseW: 0, baseH: 0 };
  state.reviewView = { scale: 1, panX: 0, panY: 0 };
  state.timeline = { start: 0, span: 0 };
  applyReviewView();
  els.review.removeAttribute("src");
  els.review.load();
  els.results.hidden = true;
  els.stale.hidden = true;
  if (data.project) applyProject(data.project);
  syncAspectFields();
  state.hydrating = false;
  state.mode = "edit";
  document.body.dataset.mode = "edit";
  syncModeButtons();
  els.proxy.hidden = !!data.meta.browser_safe;
  els.empty.hidden = true;
  els.loading.hidden = false;
  els.video.src = `/api/media?which=source&t=${Date.now()}`;
  els.video.load();
  applyView();
  layoutFrame();
  refresh();
  const meta = data.meta;
  setStatus(
    meta.browser_safe
      ? `${meta.name} · ${meta.width}×${meta.height} · ${meta.fps.toFixed(3)} fps`
      : `${meta.name} may not play here. Make a playable preview to scrub it. Export still uses the original.`,
  );
}

async function openTyped() {
  const path = els.path.value.trim();
  if (!path) {
    setStatus("Enter a video path or use Browse.", "error");
    return;
  }
  setStatus("Opening video…");
  try {
    const data = await api("/api/open", { method: "POST", body: JSON.stringify({ path }) });
    els.path.value = data.meta.path;
    applyLoaded(data);
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function browse() {
  setStatus("Choose a video in the file dialog.");
  try {
    const data = await api("/api/browse", { method: "POST" });
    if (data.cancelled) {
      setStatus("No video selected.");
      return;
    }
    els.path.value = data.meta.path;
    applyLoaded(data);
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function seek(t, options = {}) {
  if (!state.meta) return;
  t = clamp(t, 0, duration());
  if (!options.fromTimeline) revealTime(t, 0.35);
  if (state.mode === "review" && state.preview) {
    const offset = t - state.preview.start;
    const limit = Number.isFinite(els.review.duration) ? els.review.duration : Math.max(0, state.end - state.preview.start);
    els.review.currentTime = clamp(offset, 0, limit);
    paintTime(t);
    return;
  }
  paintTime(t);
  if (Math.abs((els.video.currentTime || 0) - t) < 1e-4) {
    onTime();
    return;
  }
  els.video.currentTime = t;
}

function setMode(mode) {
  if (mode === "review") {
    if (!state.preview) {
      setStatus("Render a review to watch the cropped frames.");
      syncModeButtons();
      return;
    }
    flushEdit();
    state.mode = "review";
    document.body.dataset.mode = "review";
    els.video.pause();
    const offset = Math.max(0, (els.video.currentTime || 0) - state.preview.start);
    const applyOffset = () => {
      if (Number.isFinite(els.review.duration)) {
        els.review.currentTime = Math.min(offset, Math.max(0, els.review.duration));
      }
    };
    if (els.review.readyState >= 1) applyOffset();
    else els.review.addEventListener("loadedmetadata", applyOffset, { once: true });
  } else {
    const t = state.mode === "review" && state.preview
      ? state.preview.start + (els.review.currentTime || 0)
      : els.video.currentTime;
    state.mode = "edit";
    document.body.dataset.mode = "edit";
    els.review.pause();
    layoutFrame();
    seek(clamp(t || 0, 0, duration() || 0));
  }
  if (mode === "review") layoutReview();
  syncModeButtons();
  onTime();
}

function syncModeButtons() {
  els.modeEdit.setAttribute("aria-selected", state.mode === "edit" ? "true" : "false");
  els.modeReview.setAttribute("aria-selected", state.mode === "review" ? "true" : "false");
}

function togglePlay() {
  const video = activeVideo();
  if (!video.getAttribute("src") && !video.currentSrc) return;
  if (video.paused) video.play();
  else video.pause();
}

function syncPlayButton() {
  els.play.textContent = activeVideo().paused ? "Play" : "Pause";
}

function stepFrame(dir, big) {
  const video = activeVideo();
  video.pause();
  const delta = big ? dir : dir / activeFps();
  const limit = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : duration();
  const next = clamp((video.currentTime || 0) + delta, 0, limit);
  video.currentTime = next;
  const source = state.mode === "review" && state.preview ? state.preview.start + next : next;
  const t = clamp(source, 0, duration());
  revealTime(t, 0.35);
  paintTime(t);
}

function stepKeyframe(dir) {
  if (!state.meta || !state.keyframes.length) return;
  const t = currentSourceTime();
  const tol = 0.51 / fps();
  let target = null;
  if (dir > 0) target = state.keyframes.find((key) => key.t > t + tol) || null;
  else {
    for (let i = state.keyframes.length - 1; i >= 0; i -= 1) {
      if (state.keyframes[i].t < t - tol) {
        target = state.keyframes[i];
        break;
      }
    }
  }
  if (target) seek(target.t);
}

function setTrim(which, t) {
  const minGap = 1 / fps();
  if (which === "in") state.start = clamp(t, 0, state.end - minGap);
  else state.end = clamp(t, state.start + minGap, duration());
  state.previewStale = true;
  paintTrim();
  paintEstimates();
  updateReviewNote();
}

function setInOut(which) {
  if (!state.meta) return;
  pushUndo();
  setTrim(which, currentSourceTime());
  saveProject();
}

function nudge(dx, dy) {
  if (!state.meta || state.mode !== "edit") return;
  els.video.pause();
  const box = state.override || displayedBox();
  state.override = clampBox({
    cx: box.cx + dx / state.meta.width,
    cy: box.cy + dy / state.meta.height,
    w: box.w,
    rot: boxAngle(box),
  });
  state.editing = true;
  draw();
  syncBoxControls(state.override);
  clearTimeout(state.nudgeTimer);
  state.nudgeTimer = setTimeout(() => {
    if (state.override) commitBox(state.override);
    state.editing = false;
  }, 280);
}

function keyframeThisMoment() {
  if (state.mode !== "review" || !state.preview) return;
  const t = clamp(state.preview.start + (els.review.currentTime || 0), 0, duration());
  const box = interpolate(snap(t), state.keyframes, defaultBox());
  els.review.pause();
  state.mode = "edit";
  document.body.dataset.mode = "edit";
  syncModeButtons();
  const pin = () => {
    commitBox(clampBox(box));
    layoutFrame();
    onTime();
    setStatus("Pinned a keyframe here. Drag the box if the subject is off the crosshair, then render again.");
  };
  if (Math.abs((els.video.currentTime || 0) - t) < 0.03) pin();
  else {
    els.video.addEventListener("seeked", pin, { once: true });
    els.video.currentTime = t;
  }
}

function timelineWindow() {
  const dur = duration();
  if (!(dur > 0)) return { start: 0, end: 0, span: 1 };
  const minSpan = Math.max(8 / fps(), 0.05);
  let span = state.timeline.span;
  if (!span || span >= dur - 1e-4) return { start: 0, end: dur, span: dur };
  span = clamp(span, minSpan, dur);
  const start = clamp(state.timeline.start, 0, Math.max(0, dur - span));
  return { start, end: start + span, span };
}

function revealTime(t, edge) {
  const dur = duration();
  if (!(dur > 0)) return;
  const win = timelineWindow();
  if (win.span >= dur - 1e-4) return;
  const margin = win.span * edge;
  if (t >= win.start + margin && t <= win.end - margin) return;
  state.timeline.span = win.span;
  state.timeline.start = clamp(t - win.span * 0.35, 0, dur - win.span);
}

function zoomTimelineAt(clientX, factor) {
  const dur = duration();
  if (!(dur > 0)) return;
  const rect = els.timeline.getBoundingClientRect();
  if (rect.width < 2) return;
  const frac = clamp((clientX - rect.left) / rect.width, 0, 1);
  const win = timelineWindow();
  const anchor = win.start + frac * win.span;
  const minSpan = Math.max(8 / fps(), 0.05);
  let span = win.span / factor;
  if (span >= dur - 1e-3) {
    state.timeline.start = 0;
    state.timeline.span = 0;
  } else {
    span = Math.max(span, minSpan);
    state.timeline.span = span;
    state.timeline.start = clamp(anchor - frac * span, 0, dur - span);
  }
  layoutTimeline(currentSourceTime());
}

function panTimelineByPixels(dx) {
  const dur = duration();
  const rect = els.timeline.getBoundingClientRect();
  if (!(dur > 0) || rect.width < 2) return;
  const win = timelineWindow();
  if (win.span >= dur - 1e-4) return;
  state.timeline.span = win.span;
  state.timeline.start = clamp(win.start - (dx / rect.width) * win.span, 0, dur - win.span);
  layoutTimeline(currentSourceTime());
}

function fitTimeline() {
  state.timeline.start = 0;
  state.timeline.span = 0;
  layoutTimeline(state.meta ? currentSourceTime() : 0);
}

function zoomTimelineToTrim() {
  const dur = duration();
  if (!(dur > 0)) return;
  const trimSpan = Math.max(0, state.end - state.start);
  if (trimSpan >= dur - 1e-3) {
    fitTimeline();
    return;
  }
  const minSpan = Math.max(8 / fps(), 0.05);
  const pad = Math.max(trimSpan * 0.08, 0.25 / fps());
  const span = Math.max(trimSpan + pad * 2, minSpan);
  if (span >= dur - 1e-3) {
    fitTimeline();
    return;
  }
  const mid = (state.start + state.end) / 2;
  state.timeline.span = span;
  state.timeline.start = clamp(mid - span / 2, 0, dur - span);
  layoutTimeline(currentSourceTime());
}

function layoutTimeline(t) {
  const win = timelineWindow();
  const dur = duration();
  const zoomed = dur > 0 && win.span < dur - 1e-3;
  els.timelineRange.textContent = zoomed ? `${formatTime(win.start)} – ${formatTime(win.end)}` : "Full clip";
  els.timelineTrim.disabled = !(dur > 0);
  els.timelineFit.disabled = !zoomed;
  if (!(dur > 0)) return;
  const pct = (time) => ((time - win.start) / win.span) * 100;
  const startPct = clamp(pct(state.start), 0, 100);
  const endPct = clamp(pct(state.end), 0, 100);
  els.shadeL.style.width = state.start >= win.end ? "100%" : state.start <= win.start ? "0%" : `${startPct}%`;
  els.shadeR.style.left = state.end <= win.start ? "0%" : state.end >= win.end ? "100%" : `${endPct}%`;
  els.trimIn.style.left = `${startPct}%`;
  els.trimOut.style.left = `${endPct}%`;
  els.trimIn.classList.toggle("pinned", state.start < win.start - 1e-4 || state.start > win.end + 1e-4);
  els.trimOut.classList.toggle("pinned", state.end < win.start - 1e-4 || state.end > win.end + 1e-4);
  const play = pct(t);
  els.playhead.style.left = `${play}%`;
  els.playhead.style.visibility = play < -2 || play > 102 ? "hidden" : "visible";
  for (const marker of els.keys.children) {
    const p = pct(Number(marker.dataset.t));
    marker.style.left = `${p}%`;
    marker.hidden = p < -2 || p > 102;
  }
}

function paintTime(t) {
  if (!state.meta || !(duration() > 0)) {
    els.timecode.textContent = "00:00.000";
    els.frameLabel.textContent = "frame 0";
    return;
  }
  els.timecode.textContent = formatTime(t);
  const frame = Math.round(t * fps());
  const total = Math.round(duration() * fps());
  els.frameLabel.textContent = `frame ${frame} / ${total}`;
  layoutTimeline(t);
  highlightKey(t);
  els.deleteKey.disabled = !keyAt(t);
}

function paintTrim() {
  if (!state.meta || !(duration() > 0)) return;
  if (document.activeElement !== els.start) els.start.value = formatTime(state.start);
  if (document.activeElement !== els.end) els.end.value = formatTime(state.end);
  layoutTimeline(currentSourceTime());
}

function paintMeta() {
  if (!state.meta) {
    els.meta.textContent = "No video open";
    return;
  }
  const meta = state.meta;
  els.meta.textContent = `${meta.width}×${meta.height} · ${meta.fps.toFixed(3)} fps · ${formatTime(meta.duration)} · ${meta.codec || "video"}`;
}

function estimateFrames(span, step) {
  if (!state.meta) return 0;
  return Math.max(1, Math.round((span * fps()) / step));
}

function paintEstimates() {
  if (!state.meta) {
    els.estimates.textContent = "";
    return;
  }
  const span = Math.max(0, state.end - state.start);
  const previewStep = Math.max(1, Math.round(Number(els.previewStep.value) || 1));
  const pdfStep = Math.max(1, Math.round(Number(els.pdfStep.value) || 1));
  els.estimates.textContent = `Review about ${estimateFrames(span, previewStep)} frames · PDF about ${estimateFrames(span, pdfStep)} pages`;
}

function gapNote() {
  const keys = state.keyframes;
  if (!keys.length) return "No keyframes yet. The box stays where you put it until you set one.";
  if (keys.length === 1) return "One keyframe: the crop holds still. Add another where the subject has moved.";
  let maxGap = 0;
  for (let i = 1; i < keys.length; i += 1) maxGap = Math.max(maxGap, keys[i].t - keys[i - 1].t);
  if (maxGap >= 2) {
    return `Largest gap between keyframes is ${maxGap.toFixed(1)}s. If the review drifts, pin a keyframe there.`;
  }
  return "Frames between keyframes move in a straight line.";
}

function renderKeyList() {
  els.keyList.replaceChildren();
  els.keyEmpty.hidden = state.keyframes.length > 0;
  const maxW = state.meta ? maxWidthFrac() : 1;
  for (const key of state.keyframes) {
    const item = document.createElement("li");
    item.dataset.t = String(key.t);
    const jump = document.createElement("button");
    jump.type = "button";
    jump.className = "jump";
    const deg = boxAngle(key) * 180 / Math.PI;
    const turn = Math.abs(deg) >= 0.5 ? `  ${deg.toFixed(0)}°` : "";
    jump.textContent = `${formatTime(key.t)}   ${(maxW / key.w).toFixed(2)}×${turn}`;
    jump.addEventListener("click", () => {
      setMode("edit");
      seek(key.t);
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => deleteKey(key.t));
    item.append(jump, remove);
    els.keyList.appendChild(item);
  }
  renderKeyMarkers();
}

function renderKeyMarkers() {
  els.keys.replaceChildren();
  if (!state.meta || !(duration() > 0)) return;
  for (const key of state.keyframes) {
    const marker = document.createElement("button");
    marker.type = "button";
    marker.className = "key";
    marker.dataset.key = "1";
    marker.dataset.t = String(key.t);
    marker.title = formatTime(key.t);
    els.keys.appendChild(marker);
  }
  layoutTimeline(currentSourceTime());
}

function highlightKey(t) {
  const tol = 0.51 / fps();
  for (const item of els.keyList.children) {
    item.classList.toggle("current", Math.abs(Number(item.dataset.t) - t) <= tol);
  }
  for (const marker of els.keys.children) {
    marker.classList.toggle("current", Math.abs(Number(marker.dataset.t) - t) <= tol);
  }
}

function syncBoxControls(box, options = {}) {
  if (!state.meta) return;
  const zoom = maxWidthFrac() / box.w;
  if (document.activeElement !== els.cx) els.cx.value = (box.cx * 100).toFixed(2);
  if (document.activeElement !== els.cy) els.cy.value = (box.cy * 100).toFixed(2);
  if (document.activeElement !== els.zoom) els.zoom.value = zoom.toFixed(2);
  if (document.activeElement !== els.rot) els.rot.value = (boxAngle(box) * 180 / Math.PI).toFixed(1);
  if (!options.skipSlider && document.activeElement !== els.zoomSlider) {
    els.zoomSlider.value = String(zoomToSlider(zoom));
  }
  const pxW = box.w * state.meta.width;
  const pxH = pxW / aspect();
  els.cropPx.value = `${Math.round(pxW)} × ${Math.round(pxH)} px`;
  paintHud(box);
}

function paintHud(box) {
  if (!state.meta) return;
  const keyed = !!keyAt(currentSourceTime());
  let kind = "hold";
  let label = state.keyframes.length ? "Hold" : "No keyframes";
  if (state.override || state.drag) {
    kind = "editing";
    label = "Editing";
  } else if (keyed) {
    kind = "keyframe";
    label = "Keyframe";
  } else if (state.keyframes.length) {
    kind = "interpolated";
    label = "Interpolated";
  }
  els.hudMode.textContent = label;
  els.hudMode.dataset.kind = kind;
  const preset = PRESETS.find((item) => item[0] === els.preset.value);
  const ratio = preset && preset[0] !== "custom" ? preset[0] : `${trimNum(state.aspectW)}:${trimNum(state.aspectH)}`;
  const viewBit = state.view.scale > 1.01 ? ` · view ${state.view.scale.toFixed(1)}×` : "";
  const deg = boxAngle(box) * 180 / Math.PI;
  els.hudZoom.textContent = `${ratio} · ${(maxWidthFrac() / box.w).toFixed(2)}× · ${deg.toFixed(0)}°${viewBit}`;
}

function paintActions() {
  const open = !!state.meta;
  const running = state.job && (state.job.status === "running" || state.job.status === "queued");
  els.render.disabled = !open || !!running;
  els.exportBtn.disabled = !open || !!running;
  els.render.textContent = state.preview && state.previewStale ? "Render again" : "Render review";
}

function paintJob(job) {
  const running = job && (job.status === "running" || job.status === "queued");
  els.job.hidden = !running;
  if (!running) return;
  els.jobLabel.textContent = job.message || "Working";
  els.jobBar.style.width = `${Math.round((job.progress || 0) * 100)}%`;
}

function updateReviewNote() {
  els.stale.hidden = !(state.preview && state.previewStale);
}

function refresh() {
  paintMeta();
  paintTrim();
  renderKeyList();
  paintEstimates();
  paintActions();
  updateReviewNote();
  els.gap.textContent = state.meta ? gapNote() : "";
  if (state.meta) {
    paintTime(currentSourceTime());
    if (!state.editing) syncBoxControls(displayedBox());
  }
}

function onTime() {
  if (!state.meta) return;
  const t = currentSourceTime();
  if (!activeVideo().paused) revealTime(t, 0.18);
  paintTime(t);
  if (!state.editing) syncBoxControls(displayedBox());
  if (state.mode === "edit") draw();
}

function layoutFrame() {
  if (!state.meta || state.mode !== "edit") return;
  const rect = els.editor.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return;
  const fit = Math.min(rect.width / state.meta.width, rect.height / state.meta.height);
  const baseW = Math.max(2, Math.floor(state.meta.width * fit));
  const baseH = Math.max(2, Math.floor(state.meta.height * fit));
  state.view.baseW = baseW;
  state.view.baseH = baseH;
  els.layer.style.width = `${baseW}px`;
  els.layer.style.height = `${baseH}px`;
  applyView();
  requestAnimationFrame(draw);
}

function layoutReview() {
  if (!els.review.videoWidth || !els.review.videoHeight) return;
  const rect = els.reviewStage.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return;
  const fit = Math.min(rect.width / els.review.videoWidth, rect.height / els.review.videoHeight);
  els.review.style.width = `${Math.max(2, Math.floor(els.review.videoWidth * fit))}px`;
  els.review.style.height = `${Math.max(2, Math.floor(els.review.videoHeight * fit))}px`;
}

function applyView() {
  const view = state.view;
  els.layer.style.transform = `translate(${view.panX}px, ${view.panY}px) scale(${view.scale})`;
  if (state.meta) paintHud(displayedBox());
}

function applyReviewView() {
  const view = state.reviewView;
  els.review.style.transform = `translate(${view.panX}px, ${view.panY}px) scale(${view.scale})`;
  const zoomed = view.scale > 1.01;
  els.reviewZoom.hidden = !zoomed;
  if (zoomed) els.reviewZoom.textContent = `View ${view.scale.toFixed(1)}×`;
}

function activeView() {
  return state.mode === "review" ? state.reviewView : state.view;
}

function resetView() {
  const view = activeView();
  view.scale = 1;
  view.panX = 0;
  view.panY = 0;
  if (state.mode === "review") applyReviewView();
  else applyView();
}

function zoomViewAt(clientX, clientY, factor) {
  const reviewing = state.mode === "review";
  const stage = reviewing ? els.reviewStage : els.editor;
  const layer = reviewing ? els.review : els.layer;
  const view = activeView();
  const baseW = layer.clientWidth;
  const baseH = layer.clientHeight;
  if (baseW < 2 || baseH < 2) return;
  const stageRect = stage.getBoundingClientRect();
  const stageCenterX = stageRect.left + stageRect.width / 2;
  const stageCenterY = stageRect.top + stageRect.height / 2;
  const visualX = stageCenterX + view.panX;
  const visualY = stageCenterY + view.panY;
  const s = view.scale;
  const nx = 0.5 + (clientX - visualX) / (baseW * s);
  const ny = 0.5 + (clientY - visualY) / (baseH * s);
  const next = clamp(s * factor, 1, 16);
  if (next <= 1.001) {
    resetView();
    return;
  }
  view.scale = next;
  const centerX = clientX - (nx - 0.5) * baseW * next;
  const centerY = clientY - (ny - 0.5) * baseH * next;
  view.panX = centerX - stageCenterX;
  view.panY = centerY - stageCenterY;
  if (reviewing) applyReviewView();
  else applyView();
}

function zoomActive(factor) {
  const stage = (state.mode === "review" ? els.reviewStage : els.editor).getBoundingClientRect();
  zoomViewAt(stage.left + stage.width / 2, stage.top + stage.height / 2, factor);
}

function boxGeometry(box, viewW, viewH) {
  const heightFrac = (box.w * state.meta.width) / (aspect() * state.meta.height);
  const hw = (box.w * viewW) / 2;
  const hh = (heightFrac * viewH) / 2;
  const cx = box.cx * viewW;
  const cy = box.cy * viewH;
  const rot = boxAngle(box);
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([lx, ly]) => ({
    x: cx + lx * cos - ly * sin,
    y: cy + lx * sin + ly * cos,
  }));
  const point = (lx, ly) => ({
    x: cx + lx * cos - ly * sin,
    y: cy + lx * sin + ly * cos,
  });
  return { cx, cy, hw, hh, rot, cos, sin, corners, point };
}

function stroke(ctx, x1, y1, x2, y2, color, width) {
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "butt";
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function draw() {
  const canvas = els.overlay;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w < 2 || h < 2 || !state.meta) return;
  const pixelW = Math.round(w * dpr);
  const pixelH = Math.round(h * dpr);
  if (canvas.width !== pixelW || canvas.height !== pixelH) {
    canvas.width = pixelW;
    canvas.height = pixelH;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const box = displayedBox();
  const geo = boxGeometry(box, w, h);
  const [topLeft, topRight, bottomRight, bottomLeft] = geo.corners;
  ctx.fillStyle = "rgba(0, 0, 0, 0.42)";
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.moveTo(topLeft.x, topLeft.y);
  ctx.lineTo(topRight.x, topRight.y);
  ctx.lineTo(bottomRight.x, bottomRight.y);
  ctx.lineTo(bottomLeft.x, bottomLeft.y);
  ctx.closePath();
  ctx.fill("evenodd");

  stroke(ctx, geo.cx, 0, geo.cx, h, "rgba(255, 214, 90, 0.35)", 1);
  stroke(ctx, 0, geo.cy, w, geo.cy, "rgba(255, 214, 90, 0.35)", 1);

  const keyed = !!keyAt(currentSourceTime()) || state.override || state.drag;
  const color = state.keyframes.length && !keyed ? "#8ecae6" : "#ffd56a";
  ctx.beginPath();
  ctx.moveTo(topLeft.x, topLeft.y);
  ctx.lineTo(topRight.x, topRight.y);
  ctx.lineTo(bottomRight.x, bottomRight.y);
  ctx.lineTo(bottomLeft.x, bottomLeft.y);
  ctx.closePath();
  ctx.save();
  if (state.keyframes.length && !keyed) ctx.setLineDash([6, 4]);
  ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.75;
  ctx.stroke();
  ctx.restore();
  stroke(ctx, topLeft.x, topLeft.y, topRight.x, topRight.y, "#111", 6);
  stroke(ctx, topLeft.x, topLeft.y, topRight.x, topRight.y, "#fff4c8", 3);

  const gap = 8;
  const up = geo.point(0, -geo.hh);
  const down = geo.point(0, geo.hh);
  const left = geo.point(-geo.hw, 0);
  const right = geo.point(geo.hw, 0);
  for (const [mark, width] of [["#111", 3], ["#ffd56a", 1.5]]) {
    stroke(ctx, left.x, left.y, geo.point(-gap, 0).x, geo.point(-gap, 0).y, mark, width);
    stroke(ctx, geo.point(gap, 0).x, geo.point(gap, 0).y, right.x, right.y, mark, width);
    stroke(ctx, up.x, up.y, geo.point(0, -gap).x, geo.point(0, -gap).y, mark, width);
    stroke(ctx, geo.point(0, gap).x, geo.point(0, gap).y, down.x, down.y, mark, width);
  }

  const tip = geo.point(0, -geo.hh - 16);
  const wingL = geo.point(-10, -geo.hh - 3);
  const wingR = geo.point(10, -geo.hh - 3);
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(wingL.x, wingL.y);
  ctx.lineTo(wingR.x, wingR.y);
  ctx.closePath();
  ctx.fillStyle = "#fff4c8";
  ctx.strokeStyle = "#111";
  ctx.lineWidth = 1.5;
  ctx.fill();
  ctx.stroke();

  if (geo.hh * 2 > 36) {
    const label = geo.point(0, -geo.hh);
    ctx.save();
    ctx.translate(label.x, label.y);
    ctx.rotate(geo.rot);
    ctx.font = "700 12px Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#111";
    ctx.fillStyle = "#fff4c8";
    ctx.strokeText("TOP", 0, 5);
    ctx.fillText("TOP", 0, 5);
    ctx.restore();
  }

  ctx.fillStyle = "#ffd56a";
  ctx.strokeStyle = "#111";
  ctx.lineWidth = 1;
  geo.corners.forEach((corner, index) => {
    if (index < 2) {
      ctx.beginPath();
      ctx.arc(corner.x, corner.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillRect(corner.x - 4, corner.y - 4, 8, 8);
      ctx.strokeRect(corner.x - 4, corner.y - 4, 8, 8);
    }
  });
  paintHud(box);
}

function normFromEvent(event) {
  const rect = els.overlay.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return null;
  return {
    x: (event.clientX - rect.left) / rect.width,
    y: (event.clientY - rect.top) / rect.height,
  };
}

function hitTest(event) {
  if (!state.meta) return null;
  const rect = els.overlay.getBoundingClientRect();
  if (rect.width < 2) return null;
  const geo = boxGeometry(displayedBox(), rect.width, rect.height);
  const px = event.clientX - rect.left;
  const py = event.clientY - rect.top;
  for (let i = 0; i < geo.corners.length; i += 1) {
    const corner = geo.corners[i];
    if (Math.hypot(px - corner.x, py - corner.y) <= 14) return { mode: "turn", corner: i };
  }
  const dx = px - geo.cx;
  const dy = py - geo.cy;
  const lx = dx * geo.cos + dy * geo.sin;
  const ly = -dx * geo.sin + dy * geo.cos;
  if (Math.abs(lx) <= geo.hw && Math.abs(ly) <= geo.hh) return { mode: "move" };
  if (Math.hypot(dx, dy) <= 10) return { mode: "move" };
  return null;
}

function boxFromCorner(nx, ny, corner, startBox) {
  const signs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const [sx, sy] = signs[corner];
  const cx = startBox.cx * state.meta.width;
  const cy = startBox.cy * state.meta.height;
  const px = nx * state.meta.width - cx;
  const py = ny * state.meta.height - cy;
  const boxW = startBox.w * state.meta.width;
  const boxH = boxW / aspect();
  const lx = sx * boxW / 2;
  const ly = sy * boxH / 2;
  const dist = Math.hypot(px, py);
  let rot = boxAngle(startBox);
  if (dist >= 8 && (lx !== 0 || ly !== 0)) rot = Math.atan2(py, px) - Math.atan2(ly, lx);
  return clampBox({
    cx: startBox.cx,
    cy: startBox.cy,
    w: startBox.w,
    rot,
  });
}

function onPointerDown(event) {
  if (!state.meta) return;
  const onReview = event.currentTarget === els.reviewStage;
  if (onReview && state.mode !== "review") return;
  if (!onReview && state.mode !== "edit") return;
  if (event.button === 1 || event.button === 2 || (event.button === 0 && event.altKey)) {
    event.preventDefault();
    state.panning = {
      x: event.clientX,
      y: event.clientY,
      view: onReview ? state.reviewView : state.view,
      stage: event.currentTarget,
    };
    event.currentTarget.classList.add("grabbing");
    if (!onReview) els.overlay.style.cursor = "grabbing";
    return;
  }
  if (onReview || event.button !== 0) return;
  const hit = hitTest(event);
  if (!hit) return;
  event.preventDefault();
  els.video.pause();
  const point = normFromEvent(event);
  state.editing = true;
  state.drag = {
    mode: hit.mode,
    corner: hit.corner,
    nx: point.x,
    ny: point.y,
    clientX: event.clientX,
    clientY: event.clientY,
    box: copyBox(displayedBox()),
    moved: false,
  };
}

function onPointerMove(event) {
  if (state.panning) {
    const view = state.panning.view;
    view.panX += event.clientX - state.panning.x;
    view.panY += event.clientY - state.panning.y;
    state.panning.x = event.clientX;
    state.panning.y = event.clientY;
    if (view === state.reviewView) applyReviewView();
    else applyView();
    return;
  }
  if (state.drag) {
    const point = normFromEvent(event);
    if (!point) return;
    if (Math.hypot(event.clientX - state.drag.clientX, event.clientY - state.drag.clientY) > 2) {
      state.drag.moved = true;
    }
    if (state.drag.mode === "move") {
      state.override = clampBox({
        cx: state.drag.box.cx + (point.x - state.drag.nx),
        cy: state.drag.box.cy + (point.y - state.drag.ny),
        w: state.drag.box.w,
        rot: boxAngle(state.drag.box),
      });
    } else {
      state.override = boxFromCorner(point.x, point.y, state.drag.corner, state.drag.box);
    }
    draw();
    syncBoxControls(state.override);
    els.overlay.style.cursor = state.drag.mode === "turn" ? "grabbing" : "move";
    return;
  }
  const hit = hitTest(event);
  els.overlay.style.cursor = hit && hit.mode === "turn" ? "grab" : hit ? "move" : "crosshair";
}

function onPointerUp() {
  if (state.panning) {
    state.panning.stage.classList.remove("grabbing");
    state.panning = null;
    els.overlay.style.cursor = "crosshair";
  }
  if (!state.drag) return;
  const moved = state.drag.moved;
  const box = state.override;
  state.drag = null;
  if (moved && box) commitBox(box);
  else {
    state.override = null;
    state.editing = false;
    draw();
  }
}

function boxFromFields() {
  if (!state.meta) return displayedBox();
  const zoom = clamp(Number(els.zoom.value) || DEFAULT_ZOOM, 1, MAX_ZOOM);
  const cx = Number(els.cx.value);
  const cy = Number(els.cy.value);
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return displayedBox();
  const rot = Number(els.rot.value);
  return clampBox({
    cx: cx / 100,
    cy: cy / 100,
    w: maxWidthFrac() / zoom,
    rot: (Number.isFinite(rot) ? rot : 0) * Math.PI / 180,
  });
}

function onBoxFieldChange() {
  if (!state.meta) return;
  els.video.pause();
  commitBox(boxFromFields());
}

function beginSliderEdit() {
  if (!state.meta) return;
  els.video.pause();
  state.editing = true;
  if (!state.override) state.override = { ...displayedBox() };
}

function payload(step) {
  flushEdit();
  return {
    aspect_w: state.aspectW,
    aspect_h: state.aspectH,
    start: state.start,
    end: state.end,
    step,
    crosshair: els.crosshair.checked,
    keyframes: state.keyframes,
  };
}

async function watchJob(job) {
  state.job = job;
  paintJob(job);
  paintActions();
  while (state.job && state.job.id === job.id) {
    await sleep(400);
    let next;
    try {
      next = await api(`/api/jobs/${job.id}`);
    } catch (error) {
      setStatus(error.message, "error");
      break;
    }
    if (!state.job || state.job.id !== job.id) return;
    state.job = next;
    paintJob(next);
    if (next.status === "done") {
      if (next.kind === "preview") applyPreview(next);
      else if (next.kind === "pdf") applyPdf(next);
      else if (next.kind === "proxy") applyProxy(next);
      break;
    }
    if (next.status === "error") {
      setStatus(next.error || "Render failed", "error");
      break;
    }
    if (next.status === "cancelled") {
      setStatus("Render cancelled.");
      break;
    }
  }
  paintActions();
}

function applyPreview(job) {
  state.preview = {
    url: job.file,
    start: job.meta.start,
    fps: job.meta.fps,
    frames: job.meta.frames,
  };
  state.previewStale = false;
  els.review.src = job.file;
  els.review.load();
  setMode("review");
  updateReviewNote();
  setStatus(`Review ready, ${job.meta.frames} frames. Pause where the subject drifts and pin another keyframe.`);
}

function applyPdf(job) {
  state.pdfJob = job.id;
  els.results.hidden = false;
  els.pdfLink.href = job.file;
  els.pdfLink.download = job.meta.download_name || "zoom.pdf";
  setStatus(`PDF ready, ${job.meta.frames} pages.`);
}

function applyProxy() {
  els.proxy.hidden = true;
  els.loading.hidden = false;
  els.video.src = `/api/media?which=proxy&t=${Date.now()}`;
  els.video.load();
  setStatus("Playable preview ready. Export still uses the original file.");
}

async function renderReview() {
  if (!state.meta) return;
  const step = Math.max(1, Math.round(Number(els.previewStep.value) || 1));
  els.render.disabled = true;
  els.exportBtn.disabled = true;
  try {
    const job = await api("/api/preview", { method: "POST", body: JSON.stringify(payload(step)) });
    watchJob(job);
  } catch (error) {
    setStatus(error.message, "error");
    paintActions();
  }
}

async function exportPdf() {
  if (!state.meta) return;
  const step = Math.max(1, Math.round(Number(els.pdfStep.value) || 1));
  const pages = estimateFrames(state.end - state.start, step);
  if (pages > 800 && !window.confirm(`This writes about ${pages} PDF pages. Continue?`)) return;
  els.render.disabled = true;
  els.exportBtn.disabled = true;
  try {
    const job = await api("/api/export", { method: "POST", body: JSON.stringify(payload(step)) });
    watchJob(job);
  } catch (error) {
    setStatus(error.message, "error");
    paintActions();
  }
}

function timeFromEvent(event) {
  const rect = els.timeline.getBoundingClientRect();
  const frac = clamp((event.clientX - rect.left) / rect.width, 0, 1);
  const win = timelineWindow();
  return win.start + frac * win.span;
}

function bindTimeline() {
  let drag = null;
  let before = null;
  let panX = 0;
  els.timeline.addEventListener("pointerdown", (event) => {
    if (!state.meta) return;
    if (event.button === 1 || event.button === 2 || (event.button === 0 && event.altKey)) {
      event.preventDefault();
      drag = "pan";
      panX = event.clientX;
      els.timeline.classList.add("grabbing");
      els.timeline.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button !== 0) return;
    const trim = event.target.closest("[data-trim]");
    const key = event.target.closest("[data-key]");
    if (key) {
      seek(Number(key.dataset.t));
      return;
    }
    if (trim) {
      before = snapshot();
      drag = trim.dataset.trim;
    } else {
      drag = "play";
      seek(timeFromEvent(event), { fromTimeline: true });
    }
    els.timeline.setPointerCapture(event.pointerId);
  });
  els.timeline.addEventListener("pointermove", (event) => {
    if (!drag) return;
    if (drag === "pan") {
      panTimelineByPixels(event.clientX - panX);
      panX = event.clientX;
      return;
    }
    const t = timeFromEvent(event);
    if (drag === "play") seek(t, { fromTimeline: true });
    else setTrim(drag, t);
  });
  const finish = () => {
    els.timeline.classList.remove("grabbing");
    if ((drag === "in" || drag === "out") && before && before !== snapshot()) {
      state.undo.push(before);
      if (state.undo.length > 100) state.undo.shift();
      state.redo.length = 0;
      saveProject();
    }
    drag = null;
    before = null;
  };
  els.timeline.addEventListener("pointerup", finish);
  els.timeline.addEventListener("pointercancel", finish);
}

function typing(event) {
  const tag = event.target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || event.target.isContentEditable;
}

function onKey(event) {
  if (typing(event)) return;
  if (event.code === "Space") {
    if (event.target.closest("button, a")) return;
    event.preventDefault();
    togglePlay();
    return;
  }
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    if (event.altKey) {
      event.preventDefault();
      const amount = event.shiftKey ? 10 : 1;
      nudge(event.key === "ArrowLeft" ? -amount : amount, 0);
      return;
    }
    event.preventDefault();
    stepFrame(event.key === "ArrowLeft" ? -1 : 1, event.shiftKey);
    return;
  }
  if (event.code === "Comma" || event.code === "Period") {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    const dir = event.code === "Comma" ? -1 : 1;
    if (event.shiftKey) stepKeyframe(dir);
    else stepFrame(dir, false);
    return;
  }
  if (!event.ctrlKey && !event.metaKey && !event.altKey && (event.key === "=" || event.key === "+" || event.code === "NumpadAdd")) {
    event.preventDefault();
    zoomActive(1.2);
    return;
  }
  if (!event.ctrlKey && !event.metaKey && !event.altKey && (event.key === "-" || event.key === "_" || event.code === "NumpadSubtract")) {
    event.preventDefault();
    zoomActive(1 / 1.2);
    return;
  }
  if (event.key === "\\" && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    fitTimeline();
    return;
  }
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    if (!event.altKey) return;
    event.preventDefault();
    const amount = event.shiftKey ? 10 : 1;
    nudge(0, event.key === "ArrowUp" ? -amount : amount);
    return;
  }
  if (event.key === "[") {
    event.preventDefault();
    setInOut("in");
  } else if (event.key === "]") {
    event.preventDefault();
    setInOut("out");
  } else if (event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (state.mode === "review") keyframeThisMoment();
    else commitBox(boxFromFields());
  } else if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault();
    const key = keyAt(currentSourceTime());
    if (key) deleteKey(key.t);
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
    event.preventDefault();
    redo();
  } else if (event.key === "0") {
    resetView();
  } else if (event.key === "Escape") {
    state.override = null;
    state.drag = null;
    if (state.panning) state.panning.stage.classList.remove("grabbing");
    state.panning = null;
    els.overlay.style.cursor = "crosshair";
    els.timeline.classList.remove("grabbing");
    state.editing = false;
    draw();
    if (state.meta) syncBoxControls(displayedBox());
  }
}

function fillPresets() {
  for (const [label] of PRESETS) {
    const option = document.createElement("option");
    option.value = label;
    option.textContent = label;
    els.preset.appendChild(option);
  }
  const custom = document.createElement("option");
  custom.value = "custom";
  custom.textContent = "Custom";
  els.preset.appendChild(custom);
  syncPresetSelect();
}

function bind() {
  fillPresets();
  els.browse.addEventListener("click", browse);
  els.open.addEventListener("click", openTyped);
  els.path.addEventListener("keydown", (event) => {
    if (event.key === "Enter") openTyped();
  });
  els.proxy.addEventListener("click", async () => {
    try {
      const job = await api("/api/proxy", { method: "POST" });
      watchJob(job);
    } catch (error) {
      setStatus(error.message, "error");
    }
  });
  els.modeEdit.addEventListener("click", () => setMode("edit"));
  els.modeReview.addEventListener("click", () => setMode("review"));
  els.play.addEventListener("click", togglePlay);
  els.stepBack.addEventListener("click", () => stepFrame(-1, false));
  els.stepFwd.addEventListener("click", () => stepFrame(1, false));
  els.setIn.addEventListener("click", () => setInOut("in"));
  els.setOut.addEventListener("click", () => setInOut("out"));
  els.resetView.addEventListener("click", resetView);
  els.level.addEventListener("click", () => {
    if (!state.meta) return;
    els.video.pause();
    commitBox(clampBox({ ...displayedBox(), rot: 0 }));
  });
  els.setKey.addEventListener("click", () => {
    if (state.mode === "review") keyframeThisMoment();
    else commitBox(boxFromFields());
  });
  els.deleteKey.addEventListener("click", () => {
    const key = keyAt(currentSourceTime());
    if (key) deleteKey(key.t);
  });
  els.keyThis.addEventListener("click", keyframeThisMoment);
  els.render.addEventListener("click", renderReview);
  els.exportBtn.addEventListener("click", exportPdf);
  els.jobCancel.addEventListener("click", () => {
    if (!state.job) return;
    api(`/api/jobs/${state.job.id}/cancel`, { method: "POST" }).catch((error) => setStatus(error.message, "error"));
  });
  els.reveal.addEventListener("click", () => {
    if (!state.pdfJob) return;
    api(`/api/jobs/${state.pdfJob}/reveal`, { method: "POST" }).catch((error) => setStatus(error.message, "error"));
  });
  els.preset.addEventListener("change", () => {
    if (els.preset.value === "custom") {
      els.aspectW.focus();
      return;
    }
    const preset = PRESETS.find((item) => item[0] === els.preset.value);
    if (preset) setAspect(preset[1], preset[2]);
  });
  const onAspectNumbers = () => {
    const w = Number(els.aspectW.value);
    const h = Number(els.aspectH.value);
    if (w > 0 && h > 0) setAspect(w, h);
  };
  els.aspectW.addEventListener("change", onAspectNumbers);
  els.aspectH.addEventListener("change", onAspectNumbers);
  const onTrimFields = () => {
    const start = parseTime(els.start.value);
    const end = parseTime(els.end.value);
    if (start == null || end == null || !state.meta) {
      paintTrim();
      return;
    }
    pushUndo();
    state.start = clamp(start, 0, duration());
    state.end = clamp(end, 0, duration());
    if (state.end < state.start + 1 / fps()) state.end = Math.min(duration(), state.start + 1 / fps());
    state.previewStale = true;
    paintTrim();
    paintEstimates();
    updateReviewNote();
    saveProject();
  };
  els.start.addEventListener("change", onTrimFields);
  els.end.addEventListener("change", onTrimFields);
  for (const input of [els.cx, els.cy, els.zoom, els.rot]) {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") event.target.blur();
    });
    input.addEventListener("change", onBoxFieldChange);
  }
  els.zoomSlider.addEventListener("pointerdown", beginSliderEdit);
  els.zoomSlider.addEventListener("input", () => {
    if (!state.meta) return;
    beginSliderEdit();
    const box = state.override || displayedBox();
    state.override = clampBox({ ...box, w: maxWidthFrac() / sliderToZoom(els.zoomSlider.value) });
    draw();
    syncBoxControls(state.override, { skipSlider: true });
  });
  els.zoomSlider.addEventListener("change", () => {
    if (state.override) commitBox(state.override);
    state.editing = false;
  });
  els.previewStep.addEventListener("change", () => {
    state.previewStale = true;
    updateReviewNote();
    paintEstimates();
    saveProject();
  });
  els.pdfStep.addEventListener("change", () => {
    paintEstimates();
    saveProject();
  });
  els.crosshair.addEventListener("change", () => {
    state.previewStale = true;
    updateReviewNote();
    saveProject();
  });
  els.rate.addEventListener("change", () => {
    const rate = Number(els.rate.value);
    els.video.playbackRate = rate;
    els.review.playbackRate = rate;
  });
  els.video.addEventListener("timeupdate", () => {
    if (state.mode === "edit") onTime();
  });
  els.video.addEventListener("seeked", () => {
    if (state.mode === "edit") onTime();
  });
  els.review.addEventListener("timeupdate", () => {
    if (state.mode === "review") onTime();
  });
  els.video.addEventListener("loadeddata", () => {
    els.loading.hidden = true;
    els.empty.hidden = true;
    layoutFrame();
    draw();
  });
  els.video.addEventListener("error", () => {
    if (!state.meta) return;
    els.loading.hidden = true;
    els.proxy.hidden = false;
    setStatus("The browser could not play this file. Make a playable preview to scrub it. Export still uses the original.", "error");
  });
  for (const video of [els.video, els.review]) {
    video.addEventListener("play", syncPlayButton);
    video.addEventListener("pause", syncPlayButton);
  }
  els.review.addEventListener("loadedmetadata", layoutReview);
  if (els.video.requestVideoFrameCallback) {
    const loop = () => {
      if (state.mode === "edit" && state.meta && !els.video.paused) draw();
      els.video.requestVideoFrameCallback(loop);
    };
    els.video.requestVideoFrameCallback(loop);
  }
  els.editor.addEventListener("pointerdown", onPointerDown);
  els.reviewStage.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  const swallowAux = (event) => {
    if (event.button === 1 || event.button === 2) event.preventDefault();
  };
  els.editor.addEventListener("mousedown", swallowAux);
  els.reviewStage.addEventListener("mousedown", swallowAux);
  const blockMenu = (event) => event.preventDefault();
  els.editor.addEventListener("contextmenu", blockMenu);
  els.reviewStage.addEventListener("contextmenu", blockMenu);
  els.timeline.addEventListener("contextmenu", blockMenu);
  const onViewWheel = (event) => {
    if (!state.meta) return;
    event.preventDefault();
    zoomViewAt(event.clientX, event.clientY, event.deltaY < 0 ? 1.12 : 1 / 1.12);
  };
  els.editor.addEventListener("wheel", onViewWheel, { passive: false });
  els.reviewStage.addEventListener("wheel", onViewWheel, { passive: false });
  els.timelineTrim.addEventListener("click", zoomTimelineToTrim);
  els.timelineFit.addEventListener("click", fitTimeline);
  els.timeline.addEventListener("wheel", (event) => {
    if (!state.meta) return;
    event.preventDefault();
    const horizontal = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);
    if (horizontal) panTimelineByPixels(-(event.deltaX || event.deltaY));
    else zoomTimelineAt(event.clientX, event.deltaY < 0 ? 1.25 : 1 / 1.25);
  }, { passive: false });
  bindTimeline();
  document.addEventListener("keydown", onKey);
  new ResizeObserver(() => layoutFrame()).observe(els.editor);
  new ResizeObserver(() => layoutReview()).observe(els.reviewStage);
}

bind();
api("/api/health")
  .then((health) => {
    if (!health.ok) setStatus(health.error || "ffmpeg is missing", "error");
  })
  .catch((error) => setStatus(error.message, "error"));
refresh();
