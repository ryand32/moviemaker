'use strict';
/* ClipForge – browser video editor. No dependencies, no build step.
   Timeline model: every clip has a timeline position (start, dur) and a source
   position (in). Source time at timeline time t = in + (t - start) * speed. */

const $ = (s, r = document) => r.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

const TRACKS = [
  { id: 'v2', name: 'Video 2', kind: 'visual' },
  { id: 'v1', name: 'Video 1', kind: 'visual' },
  { id: 'a1', name: 'Audio 1', kind: 'audio' },
  { id: 'a2', name: 'Audio 2', kind: 'audio' },
];
const RULER_H = 28, TRACK_H = 44;
const MIN_PPS = 0.15, MAX_PPS = 400;
const ppsToSlider = pps => Math.round(100 * Math.log(clamp(pps, MIN_PPS, MAX_PPS) / MIN_PPS) / Math.log(MAX_PPS / MIN_PPS));
const sliderToPps = val => MIN_PPS * Math.pow(MAX_PPS / MIN_PPS, clamp(val, 0, 100) / 100);
const IMAGE_DUR = 5, TEXT_DUR = 4, MIN_DUR = 0.1;
const FONTS = ['Segoe UI, Arial, sans-serif', 'Georgia, serif', 'Consolas, monospace', 'Impact, sans-serif', '"Comic Sans MS", cursive'];

const state = {
  media: [], clips: [], time: 0, selected: null, pps: 80, playing: false, playRate: 1,
  settings: { w: 1280, h: 720 }, trackOff: {},
  rangeIn: null, rangeOut: null, rangeMode: 'cut', hoverCut: null, cutTool: false,
  cropMode: false, cropAspect: 'free', playStopAt: null,
};
const runtime = new Map(); // clipId -> { el, src, gain, pendingSeek, lastSeekAt }
let audioCtx = null, exportDest = null;
let anchor = { wall: 0, t: 0 }, playStartedWall = 0, seamSeekWall = 0, lastLeadId = null, playStartedBeforeCut = false;
let exp = null;
let lastTcText = '', lastOverlaySig = '';
const layoutCache = { scrollerW: 800, stageX: 0, stageY: 0, stageW: 0, stageH: 0 };

const stage = $('#stage');
const g = stage.getContext('2d', { alpha: false });
const content = $('#content');
const scroller = $('#scroll');

function refreshLayoutCache() {
  layoutCache.scrollerW = scroller.clientWidth || 800;
  if (stage && stage.parentElement) {
    const sr = stage.getBoundingClientRect();
    const wr = stage.parentElement.getBoundingClientRect();
    layoutCache.stageX = sr.left - wr.left;
    layoutCache.stageY = sr.top - wr.top;
    layoutCache.stageW = sr.width;
    layoutCache.stageH = sr.height;
  }
  lastOverlaySig = '';
}

/* ---------- helpers ---------- */
const mediaOf = c => state.media.find(m => m.id === c.mediaId);
const clipById = id => state.clips.find(c => c.id === id);
const selClip = () => clipById(state.selected);
const duration = () => state.clips.reduce((m, c) => Math.max(m, c.start + c.dur), 0);
const isTimed = c => c.type === 'video' || c.type === 'audio';
const isVisual = c => c.type !== 'audio';
const trackKind = c => (isVisual(c) ? 'visual' : 'audio');
const others = c => state.clips.filter(o => o !== c && o.track === c.track);

function fmt(t, frac = 2) {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60), s = t - h * 3600 - m * 60;
  const ms = `${String(m).padStart(2, '0')}:${s.toFixed(frac).padStart(frac ? 3 + frac : 2, '0')}`;
  return h > 0 ? `${String(h).padStart(2, '0')}:${ms}` : ms;
}

function fmtHMS(t) {
  t = Math.max(0, Math.round(t));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function parseHMS(str) {
  if (typeof str !== 'string') return NaN;
  const clean = str.trim();
  if (!clean) return NaN;
  if (!clean.includes(':')) return parseFloat(clean);
  const parts = clean.split(':').map(Number);
  if (parts.some(n => Number.isNaN(n) || n < 0)) return NaN;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return NaN;
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

function defaults(c) {
  return Object.assign({
    id: uid(), start: 0, in: 0, speed: 1, volume: 100, opacity: 100, fadeIn: 0, fadeOut: 0,
    x: 50, y: 50, scale: 100, rotation: 0, flipH: false, flipV: false,
    cropL: 0, cropT: 0, cropR: 0, cropB: 0, fit: 'contain',
    brightness: 100, contrast: 100, saturate: 100, grayscale: 0, blur: 0,
    text: 'Your text', size: 72, color: '#ffffff', font: FONTS[0], bold: true, outline: true,
  }, c);
}

/* ---------- undo / redo ---------- */
let undoStack = [], redoStack = [], lastSaved = '[]';
function updateHistoryButtons() {
  $('#b-undo').disabled = !undoStack.length;
  $('#b-redo').disabled = !redoStack.length;
}
function commit() {
  const now = JSON.stringify(state.clips);
  if (now === lastSaved) return;
  undoStack.push(lastSaved);
  if (undoStack.length > 100) undoStack.shift();
  redoStack = [];
  lastSaved = now;
  updateHistoryButtons();
}
function restore(json) {
  state.clips = JSON.parse(json);
  lastSaved = json;
  afterEdit();
}
function undo() { if (!undoStack.length) return; redoStack.push(lastSaved); restore(undoStack.pop()); updateHistoryButtons(); }
function redo() { if (!redoStack.length) return; undoStack.push(lastSaved); restore(redoStack.pop()); updateHistoryButtons(); }

function afterEdit() {
  if (state.selected && !selClip()) state.selected = null;
  if (state.cropMode && !cropTargetClip(false)) state.cropMode = false;
  pruneRuntime();
  renderTimeline();
  updateRangeUI();
  buildInspector();
  syncMedia();
  render();
  updateTime();
}

/* ---------- media import ---------- */
const once = (el, ev, ms = 10000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout waiting for ' + ev)), ms);
  el.addEventListener(ev, () => { clearTimeout(t); res(); }, { once: true });
  el.addEventListener('error', () => { clearTimeout(t); rej(new Error('media error')); }, { once: true });
});

function thumbFrom(src, w, h) {
  const tw = 160, th = Math.max(1, Math.round(tw * h / w));
  const cv = document.createElement('canvas');
  cv.width = tw; cv.height = th;
  cv.getContext('2d').drawImage(src, 0, 0, tw, th);
  return cv.toDataURL('image/jpeg', 0.7);
}

async function probe(m) {
  if (m.type === 'image') {
    const img = new Image();
    img.src = m.url;
    await img.decode();
    m.w = img.naturalWidth; m.h = img.naturalHeight;
    m.thumb = thumbFrom(img, m.w, m.h);
    return;
  }
  const el = document.createElement(m.type);
  el.preload = 'auto'; el.muted = true; el.src = m.url;
  await once(el, 'loadedmetadata');
  if (el.duration === Infinity) { // MediaRecorder output has no duration header
    el.currentTime = 1e101;
    await once(el, 'timeupdate');
    el.currentTime = 0;
  }
  m.duration = el.duration;
  if (m.type === 'video') {
    m.w = el.videoWidth; m.h = el.videoHeight;
    try {
      el.currentTime = Math.min(1, m.duration / 2);
      await once(el, 'seeked');
      m.thumb = thumbFrom(el, m.w, m.h);
    } catch { /* thumbnail is optional */ }
  }
  setTimeout(() => loadPeaks(m), 350);
}

async function loadPeaks(m) {
  if (m.file.size > 50e6) return;
  try {
    const buf = await m.file.arrayBuffer();
    const ab = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(buf);
    const data = ab.getChannelData(0);
    const N = Math.min(4000, Math.max(50, Math.ceil(ab.duration * 50)));
    const step = Math.max(1, Math.floor(data.length / N));
    const stride = Math.max(1, step >> 4);
    const peaks = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let max = 0;
      for (let j = i * step, e = Math.min(data.length, j + step); j < e; j += stride) max = Math.max(max, Math.abs(data[j]));
      peaks[i] = max;
    }
    m.peaks = peaks; m.peakDur = ab.duration;
    renderTimeline();
  } catch { /* no decodable audio track */ }
}

async function importFiles(files) {
  let added = 0;
  for (const f of files) {
    const type = f.type.split('/')[0];
    if (!['video', 'audio', 'image'].includes(type)) { toast(`Unsupported file: ${f.name}`); continue; }
    const m = { id: uid(), name: f.name, type, file: f, url: URL.createObjectURL(f), duration: IMAGE_DUR, thumb: null, peaks: null };
    try { await probe(m); } catch (e) {
      URL.revokeObjectURL(m.url);
      toast(`Could not read ${f.name} (${e.message})`);
      continue;
    }
    state.media.push(m);
    added++;
  }
  if (added) { relink(); renderLibrary(); afterEdit(); toast(`Imported ${added} file${added > 1 ? 's' : ''}`); }
}

function relink() {
  for (const c of state.clips) {
    if (c.type === 'text' || mediaOf(c)) continue;
    const m = state.media.find(m => m.name === c.mediaName && m.type === c.type);
    if (m) c.mediaId = m.id;
  }
}

function renderLibrary() {
  const lib = $('#library');
  lib.innerHTML = '';
  if (!state.media.length) {
    const p = document.createElement('p');
    p.className = 'hint'; p.style.gridColumn = '1/-1';
    p.textContent = 'No media yet. Click “+ Import” or drop files here.';
    lib.append(p);
  }
  for (const m of state.media) {
    const card = document.createElement('div');
    card.className = 'card'; card.draggable = true;
    const th = document.createElement('div');
    th.className = 'thumb';
    if (m.thumb) th.style.backgroundImage = `url("${m.thumb}")`;
    else th.textContent = m.type === 'audio' ? '🎵' : '🎞';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name'; name.textContent = m.name; name.title = m.name;
    const dur = document.createElement('div');
    dur.className = 'dur';
    dur.textContent = m.type === 'image' ? `Image ${m.w}×${m.h}` : `${fmt(m.duration, 1)}${m.type === 'video' ? ` · ${m.w}×${m.h}` : ''}`;
    meta.append(name, dur);
    const x = document.createElement('button');
    x.className = 'x'; x.textContent = '✕'; x.title = 'Remove from library';
    x.onclick = e => { e.stopPropagation(); removeMedia(m); };
    card.append(th, meta, x);
    card.addEventListener('dragstart', e => e.dataTransfer.setData('application/x-clip-media', m.id));
    card.addEventListener('dblclick', () => addMedia(m));
    lib.append(card);
  }
}

function removeMedia(m) {
  const used = state.clips.filter(c => c.mediaId === m.id);
  if (used.length && !confirm(`“${m.name}” is used by ${used.length} clip(s). Remove it and those clips?`)) return;
  state.clips = state.clips.filter(c => c.mediaId !== m.id);
  state.media = state.media.filter(x => x !== m);
  URL.revokeObjectURL(m.url);
  commit(); renderLibrary(); afterEdit();
}

/* ---------- clip creation & placement ---------- */
function fitPosition(c, want) {
  const os = others(c);
  const ok = s => s >= -1e-6 && os.every(o => s >= o.start + o.dur - 1e-6 || s + c.dur <= o.start + 1e-6);
  if (ok(want)) return Math.max(0, want);
  const cands = [];
  for (const o of os) cands.push(o.start + o.dur, o.start - c.dur);
  const valid = cands.filter(ok);
  if (!valid.length) return c.start;
  return Math.max(0, valid.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a)));
}

const trackEnd = id => state.clips.filter(c => c.track === id).reduce((m, c) => Math.max(m, c.start + c.dur), 0);

function addMedia(m, trackId, start) {
  const wasEmpty = state.clips.length === 0;
  const kind = m.type === 'audio' ? 'audio' : 'visual';
  const tr = TRACKS.find(t => t.id === trackId && t.kind === kind) || TRACKS.find(t => t.kind === kind);
  const c = defaults({ type: m.type, mediaId: m.id, mediaName: m.name, track: tr.id, dur: m.type === 'image' ? IMAGE_DUR : m.duration });
  c.start = fitPosition(c, start ?? trackEnd(tr.id));
  state.clips.push(c);
  state.selected = c.id;
  if (wasEmpty && c.dur > 25) {
    const avail = Math.max(400, (scroller.clientWidth || 900) - 60);
    state.pps = clamp(avail / c.dur, MIN_PPS, MAX_PPS);
    if ($('#zoom')) $('#zoom').value = ppsToSlider(state.pps);
  }
  commit(); afterEdit();
}

function addText() {
  const c = defaults({ type: 'text', track: 'v2', dur: TEXT_DUR });
  c.start = fitPosition(c, state.time);
  state.clips.push(c);
  state.selected = c.id;
  commit(); afterEdit();
}

function splitAt(t) {
  const targets = state.selected ? [selClip()] : state.clips.filter(c => t > c.start && t < c.start + c.dur);
  let did = false;
  for (const c of targets) {
    if (!c || t < c.start + 0.05 || t > c.start + c.dur - 0.05) continue;
    const right = defaults({ ...JSON.parse(JSON.stringify(c)), id: uid() });
    const left = t - c.start;
    right.start = t;
    right.in = c.in + left * c.speed;
    right.dur = c.dur - left;
    right.fadeIn = 0;
    c.dur = left;
    c.fadeOut = 0;
    state.clips.push(right);
    state.selected = right.id;
    did = true;
  }
  if (did) { commit(); afterEdit(); } else toast('Place the playhead inside a clip to split it');
}

function deleteSelected(ripple) {
  const c = selClip();
  if (!c) return;
  state.clips = state.clips.filter(x => x !== c);
  if (ripple) for (const o of state.clips) if (o.track === c.track && o.start >= c.start + c.dur - 1e-6) o.start = Math.max(0, o.start - c.dur);
  state.selected = null;
  commit(); afterEdit();
}

function duplicateSelected() {
  const c = selClip();
  if (!c) return;
  const copy = JSON.parse(JSON.stringify(c));
  copy.id = uid();
  copy.start = fitPosition(copy, c.start + c.dur);
  state.clips.push(copy);
  state.selected = copy.id;
  commit(); afterEdit();
}

function select(id) {
  if (state.selected === id) return;
  state.selected = id;
  if (state.cropMode) {
    const c = selClip();
    if (!c || (c.type !== 'video' && c.type !== 'image')) state.cropMode = false;
  }
  renderTimeline();
  buildInspector();
  render();
}

/* ---------- start-to-finish range & section cutting ---------- */
const hasRange = () => state.rangeIn !== null || state.rangeOut !== null;

function rangeBounds() {
  if (!hasRange()) return null;
  const total = Math.max(duration(), state.time, MIN_DUR);
  const a = state.rangeIn ?? 0;
  const b = state.rangeOut ?? total;
  const r0 = Math.max(0, Math.min(a, b));
  const r1 = Math.max(r0 + MIN_DUR, Math.max(a, b));
  return [r0, r1];
}

function setMarkIn(t = state.time, forceCut = false) {
  if (!state.clips.length) return toast('Add clips to the timeline first');
  const total = Math.max(duration(), MIN_DUR * 2);
  if (forceCut) state.rangeMode = 'cut';
  t = clamp(t, 0, Math.max(0, total - MIN_DUR));
  state.rangeIn = t;
  if (state.rangeOut === null || state.rangeOut <= t + MIN_DUR) {
    const span = Math.min(2, Math.max(MIN_DUR * 2, (total - t) * 0.2));
    state.rangeOut = clamp(t + span, t + MIN_DUR, total);
  }
  updateRangeUI();
  buildInspector();
}

function setMarkOut(t = state.time, forceCut = false) {
  if (!state.clips.length) return toast('Add clips to the timeline first');
  const total = Math.max(duration(), MIN_DUR * 2);
  if (forceCut) state.rangeMode = 'cut';
  t = clamp(t, 0, total);
  if (state.rangeIn !== null && t < state.rangeIn - MIN_DUR) {
    state.rangeOut = state.rangeIn;
    state.rangeIn = Math.max(0, t);
  } else {
    t = Math.max(MIN_DUR, t);
    state.rangeOut = t;
    if (state.rangeIn === null || state.rangeIn >= t - MIN_DUR) {
      const span = Math.min(2, Math.max(MIN_DUR * 2, t * 0.2));
      state.rangeIn = clamp(t - span, 0, t - MIN_DUR);
    }
  }
  updateRangeUI();
  buildInspector();
}

function clearRange() {
  state.rangeIn = null;
  state.rangeOut = null;
  state.hoverCut = null;
  state.playStopAt = null;
  updateRangeUI();
  buildInspector();
  render();
}

function setRangeMode(mode) {
  state.rangeMode = mode;
  updateRangeUI();
  buildInspector();
  render();
}

function setHoverCut(from, to, label = '') {
  if (from === null || to === null || to - from < 0.02) state.hoverCut = null;
  else state.hoverCut = { from: Math.max(0, from), to, label };
  updateRangeUI();
  updateStageCutOverlay();
}

function isTimeMarkedForCut(t) {
  if (state.hoverCut && t >= state.hoverCut.from - 1e-4 && t <= state.hoverCut.to + 1e-4) return true;
  const bounds = rangeBounds();
  if (!bounds) return false;
  const [r0, r1] = bounds;
  if (state.rangeMode === 'cut') return t >= r0 - 1e-4 && t <= r1 + 1e-4;
  return (r0 > 0.01 && t < r0 - 1e-4) || (duration() - r1 > 0.01 && t > r1 + 1e-4);
}

function totalCutSeconds() {
  const bounds = rangeBounds();
  if (!bounds) return 0;
  const [r0, r1] = bounds;
  if (state.rangeMode === 'cut') return Math.max(0, r1 - r0);
  return Math.max(0, r0) + Math.max(0, duration() - r1);
}

function updateStageCutOverlay() {
  const tint = $('#cut-stage-tint');
  const pill = $('#cut-preview-pill');
  if (!tint || !pill) return;
  if (exp || state.cropMode || (!hasRange() && !state.hoverCut)) {
    if (lastOverlaySig !== 'off') {
      tint.hidden = true;
      pill.hidden = true;
      lastOverlaySig = 'off';
    }
    return;
  }
  if (!layoutCache.stageW) refreshLayoutCache();
  const inCut = isTimeMarkedForCut(state.time);
  const sig = inCut ? `cut:${Math.round(layoutCache.stageW)}x${Math.round(layoutCache.stageH)}` : (hasRange() ? 'keep' : 'off');
  if (sig === lastOverlaySig) return;
  lastOverlaySig = sig;
  if (inCut && layoutCache.stageW && layoutCache.stageH) {
    tint.hidden = false;
    tint.style.left = layoutCache.stageX + 'px';
    tint.style.top = layoutCache.stageY + 'px';
    tint.style.width = layoutCache.stageW + 'px';
    tint.style.height = layoutCache.stageH + 'px';
    pill.hidden = false;
    pill.className = 'cut-preview-pill is-cut';
    pill.textContent = '✂ WILL BE REMOVED (CUT FROM VIDEO)';
  } else if (hasRange()) {
    tint.hidden = true;
    pill.hidden = false;
    pill.className = 'cut-preview-pill is-keep';
    pill.textContent = '✓ KEPT IN VIDEO';
  } else {
    tint.hidden = true;
    pill.hidden = true;
  }
}

function updateRangeUI() {
  const rb = $('#range-box');
  const cutL = $('#cut-left');
  const cutR = $('#cut-right');
  const cutH = $('#cut-hover');
  const badge = $('#range-badge');
  const clearBtn = $('#b-clear-range');
  const applyBtn = $('#b-apply-cut');
  const playRangeBtn = $('#t-play-range');
  const expRangeBtn = $('#btn-export-range');
  const pps = state.pps;

  if (cutH) {
    if (state.hoverCut && state.hoverCut.to - state.hoverCut.from >= 0.02) {
      cutH.hidden = false;
      cutH.style.left = (state.hoverCut.from * pps) + 'px';
      cutH.style.width = Math.max(3, (state.hoverCut.to - state.hoverCut.from) * pps) + 'px';
      const ht = cutH.querySelector('.cut-tag');
      if (ht) ht.textContent = state.hoverCut.label || `✂ WILL CUT -${fmt(state.hoverCut.to - state.hoverCut.from)}`;
    } else {
      cutH.hidden = true;
    }
  }

  const bounds = rangeBounds();
  if (!bounds) {
    if (rb) rb.hidden = true;
    if (cutL) cutL.hidden = true;
    if (cutR) cutR.hidden = true;
    if (badge) badge.hidden = true;
    if (clearBtn) clearBtn.hidden = true;
    if (applyBtn) applyBtn.hidden = true;
    if (playRangeBtn) playRangeBtn.hidden = true;
    if (expRangeBtn) expRangeBtn.hidden = true;
    updateStageCutOverlay();
    return;
  }

  const [r0, r1] = bounds;
  const total = duration();
  const isCut = state.rangeMode === 'cut';

  if (rb) {
    rb.hidden = false;
    rb.classList.toggle('cut-mode', isCut);
    rb.style.left = r0 * pps + 'px';
    rb.style.width = Math.max(2, (r1 - r0) * pps) + 'px';
    const tag = rb.querySelector('.range-tag');
    if (tag) {
      const durLbl = (r1 - r0) >= 1 ? fmtHMS(r1 - r0) : `${round(r1 - r0, 2)}s`;
      tag.textContent = isCut
        ? `✂ CUT A→B: ${fmtHMS(r0)} → ${fmtHMS(r1)} (-${durLbl})`
        : `✓ KEEP A→B: ${fmtHMS(r0)} → ${fmtHMS(r1)} (${durLbl})`;
    }
    const inlineCutBtn = rb.querySelector('.range-cut-btn');
    if (inlineCutBtn) {
      const cs = totalCutSeconds();
      const csLbl = cs >= 1 ? fmtHMS(cs) : `${round(cs, 2)}s`;
      inlineCutBtn.hidden = cs < MIN_DUR - 1e-4;
      inlineCutBtn.textContent = isCut ? `✂ Cut & Stitch (-${csLbl})` : `✂ Trim Outside (-${csLbl})`;
    }
  }

  if (cutL) {
    if (!isCut && r0 > 0.01) {
      cutL.hidden = false;
      cutL.style.left = '0px';
      cutL.style.width = (r0 * pps) + 'px';
      const lt = cutL.querySelector('.cut-tag');
      if (lt) lt.textContent = r0 * pps > 95 ? `✂ CUT START (-${fmt(r0)})` : `✂ -${fmt(r0)}`;
    } else {
      cutL.hidden = true;
    }
  }

  if (cutR) {
    const endLen = total - r1;
    if (!isCut && endLen > 0.01) {
      cutR.hidden = false;
      cutR.style.left = (r1 * pps) + 'px';
      cutR.style.width = (endLen * pps) + 'px';
      const rt = cutR.querySelector('.cut-tag');
      if (rt) rt.textContent = endLen * pps > 95 ? `✂ CUT END (-${fmt(endLen)})` : `✂ -${fmt(endLen)}`;
    } else {
      cutR.hidden = true;
    }
  }

  const cutSec = totalCutSeconds();
  const cutLbl = cutSec >= 1 ? fmtHMS(cutSec) : `${round(cutSec, 2)}s`;
  if (badge) {
    badge.hidden = false;
    badge.textContent = isCut
      ? `✂ A ${fmtHMS(r0)} → B ${fmtHMS(r1)} (-${cutLbl})`
      : `✓ Keep A ${fmtHMS(r0)} → B ${fmtHMS(r1)} · Cut -${cutLbl}`;
  }
  if (clearBtn) clearBtn.hidden = false;
  if (applyBtn) {
    applyBtn.hidden = cutSec < MIN_DUR - 1e-4;
    applyBtn.textContent = isCut
      ? `✂ Cut & Stitch (-${cutLbl})`
      : `✂ Trim Outside (-${cutLbl})`;
  }
  if (playRangeBtn) playRangeBtn.hidden = false;
  if (expRangeBtn) expRangeBtn.hidden = false;
  const hmsInputs = document.querySelectorAll('#inspector .hms-input');
  if (hmsInputs.length >= 2) {
    if (document.activeElement !== hmsInputs[0]) hmsInputs[0].value = fmtHMS(r0);
    if (document.activeElement !== hmsInputs[1]) hmsInputs[1].value = fmtHMS(r1);
  }
  updateStageCutOverlay();
}

function setCutTool(on) {
  state.cutTool = !!on;
  $('#b-cut-tool')?.classList.toggle('active', state.cutTool);
  $('#timeline')?.classList.toggle('cut-tool-on', state.cutTool);
  if (state.cutTool) toast('Drag-Cut Tool ON: click & drag from Point A to Point B right on any video clip');
}

function markTrimSide(side) {
  if (!state.clips.length) return toast('Add clips to the timeline first');
  const total = duration();
  if (total <= MIN_DUR * 2) return toast('Clip is too short to trim further');
  let t = state.time;
  state.rangeMode = 'cut';
  if (side === 'start') {
    if (t <= MIN_DUR || t >= total - MIN_DUR) {
      t = clamp(round(Math.min(2, total * 0.15), 2), MIN_DUR, total - MIN_DUR);
      seek(t);
    }
    state.rangeIn = 0;
    state.rangeOut = t;
    updateRangeUI();
    buildInspector();
    toast(`00:00 → ${fmt(t)} highlighted in RED. Click "✂ Cut & Stitch" to remove it`);
  } else {
    if (t <= MIN_DUR || t >= total - MIN_DUR) {
      t = clamp(round(total - Math.min(2, total * 0.15), 2), MIN_DUR, total - MIN_DUR);
      seek(t);
    }
    state.rangeIn = t;
    state.rangeOut = total;
    updateRangeUI();
    buildInspector();
    toast(`${fmt(t)} → ${fmt(total)} highlighted in RED. Click "✂ Cut & Stitch" to remove it`);
  }
}

function applyActiveCut() {
  const b = rangeBounds();
  if (!b) return;
  if (state.rangeMode === 'cut') cutRange(b[0], b[1], { ripple: true });
  else keepRange(b[0], b[1]);
}

function initRangeForAction(kind) {
  if (!state.clips.length) { toast('Add clips to the timeline first'); return null; }
  const total = duration();
  if (kind === 'keep') {
    if (hasRange() && state.rangeMode === 'trim' && totalCutSeconds() >= MIN_DUR - 1e-4) return rangeBounds();
    if (!hasRange() || totalCutSeconds() < MIN_DUR - 1e-4) {
      const c = selClip();
      if (c && (c.start > 0.01 || c.start + c.dur < total - 0.01)) {
        state.rangeIn = c.start;
        state.rangeOut = c.start + c.dur;
      } else {
        state.rangeIn = round(Math.max(MIN_DUR, total * 0.12), 2);
        state.rangeOut = round(Math.min(total - MIN_DUR, total * 0.88), 2);
      }
    }
    state.rangeMode = 'trim';
    updateRangeUI();
    buildInspector();
    toast('Outer RED sections will be removed — drag handles to adjust, then click "✂ Remove Highlighted"');
    return null;
  }
  if (hasRange() && state.rangeMode === 'cut') return rangeBounds();
  if (!hasRange()) {
    const span = Math.min(2, Math.max(MIN_DUR * 2, total * 0.25));
    const s = clamp(state.time - span / 2, 0, Math.max(0, total - span));
    state.rangeIn = s;
    state.rangeOut = Math.min(total, s + span);
  }
  state.rangeMode = 'cut';
  updateRangeUI();
  buildInspector();
  toast('RED middle section will be removed — drag handles to adjust, then click "✂ Remove Highlighted"');
  return null;
}

function keepRange(r0, r1, onlyClipId = null) {
  if (!state.clips.length) return toast('Add clips to the timeline first');
  if (r1 - r0 < MIN_DUR) return toast('Start-to-Finish range is too short');
  const target = onlyClipId ? clipById(onlyClipId) : null;
  const next = [];
  for (const orig of state.clips) {
    if (target && orig.id !== target.id) { next.push(JSON.parse(JSON.stringify(orig))); continue; }
    const cs = orig.start, ce = orig.start + orig.dur;
    if (ce <= r0 + 1e-6 || cs >= r1 - 1e-6) continue;
    const c = JSON.parse(JSON.stringify(orig));
    if (c.start < r0) {
      const d = r0 - c.start;
      c.start = r0;
      c.dur -= d;
      if (isTimed(c)) c.in += d * c.speed;
      c.fadeIn = Math.max(0, c.fadeIn - d);
    }
    if (c.start + c.dur > r1) {
      const over = (c.start + c.dur) - r1;
      c.dur = r1 - c.start;
      c.fadeOut = Math.max(0, c.fadeOut - over);
    }
    if (!target) c.start = Math.max(0, c.start - r0);
    if (c.dur >= MIN_DUR - 1e-6) {
      c.dur = Math.max(MIN_DUR, c.dur);
      next.push(c);
    }
  }
  if (!next.length) return toast('Nothing inside the selected Start → Finish range');
  state.clips = next;
  if (!target) {
    state.rangeIn = null;
    state.rangeOut = null;
    state.playStopAt = null;
    state.time = 0;
  } else {
    state.time = clamp(state.time, r0, r1);
  }
  commit();
  afterEdit();
  toast(target ? `Cropped clip to ${fmt(r0)} → ${fmt(r1)}` : `Cropped start-to-finish (${fmt(r1 - r0)} kept)`);
}

function cutRange(r0, r1, { ripple = true, onlyClipId = null } = {}) {
  if (!state.clips.length) return toast('Add clips to the timeline first');
  const cutLen = r1 - r0;
  if (cutLen < MIN_DUR) return toast('Section to cut is too short');
  const target = onlyClipId ? clipById(onlyClipId) : null;
  const next = [];
  let changed = false;
  for (const orig of state.clips) {
    if (target && orig.id !== target.id) {
      const copy = JSON.parse(JSON.stringify(orig));
      if (ripple && copy.track === target.track && copy.start >= r1 - 1e-6) {
        copy.start = Math.max(0, copy.start - cutLen);
        changed = true;
      }
      next.push(copy);
      continue;
    }
    const cs = orig.start, ce = orig.start + orig.dur;
    if (ce <= r0 + 1e-6) {
      next.push(JSON.parse(JSON.stringify(orig)));
      continue;
    }
    if (cs >= r1 - 1e-6) {
      const copy = JSON.parse(JSON.stringify(orig));
      if (ripple) { copy.start = Math.max(0, copy.start - cutLen); changed = true; }
      next.push(copy);
      continue;
    }
    changed = true;
    const hasLeft = cs < r0 - MIN_DUR + 1e-6;
    if (hasLeft) {
      const left = JSON.parse(JSON.stringify(orig));
      left.dur = Math.max(MIN_DUR, r0 - cs);
      left.fadeOut = 0;
      next.push(left);
    }
    if (ce > r1 + MIN_DUR - 1e-6) {
      const right = defaults({ ...JSON.parse(JSON.stringify(orig)), id: hasLeft ? uid() : orig.id });
      const trimLeft = r1 - cs;
      right.start = ripple ? r0 : r1;
      right.dur = Math.max(MIN_DUR, ce - r1);
      if (isTimed(right)) right.in = orig.in + trimLeft * orig.speed;
      right.fadeIn = 0;
      next.push(right);
    }
  }
  if (!changed) return toast('No clips inside the selected Start → Finish section');
  state.clips = next;
  state.rangeIn = null;
  state.rangeOut = null;
  state.cutTool = false;
  $('#b-cut-tool')?.classList.remove('active');
  $('#timeline')?.classList.remove('cut-tool-on');
  state.playStopAt = null;
  state.time = clamp(r0 > 0.2 ? Math.max(0, r0 - 1.0) : r0, 0, Math.max(0, duration()));
  commit();
  afterEdit();
  toast(`${ripple ? 'Deleted section & stitched video together' : 'Lifted section'} (${fmt(r0)} → ${fmt(r1)})`);
}

function trimClipToPlayhead(side, ripple = true) {
  const t = state.time;
  const sel = selClip();
  const targets = sel && t > sel.start + MIN_DUR && t < sel.start + sel.dur - MIN_DUR
    ? [sel]
    : state.clips.filter(c => t > c.start + MIN_DUR && t < c.start + c.dur - MIN_DUR);
  if (!targets.length) return toast(`Move the playhead inside a clip to trim its ${side}`);
  for (const c of targets) {
    if (side === 'start') {
      const d = t - c.start;
      if (isTimed(c)) c.in += d * c.speed;
      c.dur -= d;
      c.fadeIn = 0;
      if (ripple) {
        for (const o of state.clips) if (o !== c && o.track === c.track && o.start >= t - 1e-6) o.start = Math.max(0, o.start - d);
      } else {
        c.start = t;
      }
    } else {
      const oldEnd = c.start + c.dur;
      const d = oldEnd - t;
      c.dur = t - c.start;
      c.fadeOut = 0;
      if (ripple) {
        for (const o of state.clips) if (o !== c && o.track === c.track && o.start >= oldEnd - 1e-6) o.start = Math.max(0, o.start - d);
      }
    }
  }
  if (side === 'start' && ripple && targets.length === 1) state.time = targets[0].start;
  commit();
  afterEdit();
  toast(`Trimmed clip ${side} to playhead`);
}

function playRange() {
  const b = rangeBounds();
  if (!b) return;
  const [r0, r1] = b;
  setCropMode(false);
  state.time = r0;
  state.playStopAt = r1;
  syncMedia(); render(); updateTime();
  setPlaying(true);
}

/* ---------- interactive frame crop ---------- */
function cropTargetClip(autoSelect = true) {
  const cur = selClip();
  if (cur && (cur.type === 'video' || cur.type === 'image')) return cur;
  const atTime = state.clips.find(c => (c.type === 'video' || c.type === 'image') && !state.trackOff[c.track] && state.time >= c.start && state.time < c.start + c.dur);
  const pick = atTime || state.clips.find(c => c.type === 'video' || c.type === 'image') || null;
  if (pick && autoSelect) state.selected = pick.id;
  return pick;
}

function setCropMode(on) {
  if (on) {
    const c = cropTargetClip(true);
    if (!c) { toast('Add a video or image clip first to crop its frame'); return; }
    if (state.playing) setPlaying(false);
    if (state.time < c.start || state.time >= c.start + c.dur) state.time = c.start;
    state.cropMode = true;
    syncMedia();
  } else {
    state.cropMode = false;
  }
  $('#b-crop-mode')?.classList.toggle('active', state.cropMode);
  renderTimeline();
  buildInspector();
  render();
  updateTime();
}

function cropMetrics(c) {
  const r = getEl(c);
  const el = r?.el;
  const m = mediaOf(c);
  const sw = (c.type === 'video' ? el?.videoWidth : el?.naturalWidth) || m?.w || stage.width;
  const sh = (c.type === 'video' ? el?.videoHeight : el?.naturalHeight) || m?.h || stage.height;
  const W = stage.width, H = stage.height;
  const k = Math.min((W * 0.92) / sw, (H * 0.92) / sh);
  const fw = sw * k, fh = sh * k;
  const fx = (W - fw) / 2, fy = (H - fh) / 2;
  return { el, sw, sh, W, H, fx, fy, fw, fh };
}

function applyCropAspect(c, ratioStr) {
  state.cropAspect = ratioStr;
  if (!c || ratioStr === 'free') return;
  const [aw, ah] = ratioStr.split(':').map(Number);
  const target = aw / ah;
  const { sw, sh } = cropMetrics(c);
  const curW = (100 - c.cropL - c.cropR) / 100 * sw;
  const curH = (100 - c.cropT - c.cropB) / 100 * sh;
  const cx = c.cropL + (100 - c.cropL - c.cropR) / 2;
  const cy = c.cropT + (100 - c.cropT - c.cropB) / 2;
  let nw = curW, nh = curW / target;
  if (nh > sh) { nh = sh; nw = nh * target; }
  if (nw > sw) { nw = sw; nh = nw / target; }
  const wp = clamp((nw / sw) * 100, 5, 100);
  const hp = clamp((nh / sh) * 100, 5, 100);
  const l = clamp(cx - wp / 2, 0, 100 - wp);
  const t = clamp(cy - hp / 2, 0, 100 - hp);
  c.cropL = round(l, 2);
  c.cropR = round(100 - wp - l, 2);
  c.cropT = round(t, 2);
  c.cropB = round(100 - hp - t, 2);
}

function applyCropToAllClips(src) {
  if (!src) return;
  let n = 0;
  for (const c of state.clips) {
    if (c.type === 'video' || c.type === 'image') {
      c.cropL = src.cropL; c.cropR = src.cropR;
      c.cropT = src.cropT; c.cropB = src.cropB;
      c.fit = src.fit;
      n++;
    }
  }
  commit();
  afterEdit();
  toast(`Applied crop to ${n} clip${n === 1 ? '' : 's'} from start to finish`);
}

function renderCropMode(c) {
  const { el, sw, sh, W, H, fx, fy, fw, fh } = cropMetrics(c);
  g.save();
  g.fillStyle = '#0b0d12';
  g.fillRect(0, 0, W, H);
  const ready = el && sw && sh && !(c.type === 'video' && el.readyState < 2);
  const cl = clamp(c.cropL, 0, 95) / 100, cr = clamp(c.cropR, 0, 95 - c.cropL) / 100;
  const ct = clamp(c.cropT, 0, 95) / 100, cb = clamp(c.cropB, 0, 95 - c.cropT) / 100;
  const cx = fx + fw * cl, cy = fy + fh * ct;
  const cw = fw * (1 - cl - cr), ch = fh * (1 - ct - cb);
  if (ready) {
    g.globalAlpha = 0.28;
    g.filter = filterString(c);
    g.drawImage(el, 0, 0, sw, sh, fx, fy, fw, fh);
    g.globalAlpha = 1;
    g.drawImage(el, sw * cl, sh * ct, sw * (1 - cl - cr), sh * (1 - ct - cb), cx, cy, cw, ch);
  }
  g.strokeStyle = 'rgba(255,255,255,.22)';
  g.lineWidth = 2;
  g.strokeRect(fx, fy, fw, fh);
  g.restore();

  const layer = $('#crop-layer');
  const box = $('#crop-box');
  if (!layer || !box) return;
  const wrapEl = stage.parentElement;
  const sr = stage.getBoundingClientRect();
  const wr = wrapEl.getBoundingClientRect();
  if (!sr.width || !sr.height) return;
  layer.hidden = false;
  layer.style.left = (sr.left - wr.left) + 'px';
  layer.style.top = (sr.top - wr.top) + 'px';
  layer.style.width = sr.width + 'px';
  layer.style.height = sr.height + 'px';
  const sx = sr.width / W, sy = sr.height / H;
  box.style.left = (cx * sx) + 'px';
  box.style.top = (cy * sy) + 'px';
  box.style.width = Math.max(12, cw * sx) + 'px';
  box.style.height = Math.max(12, ch * sy) + 'px';
}

/* ---------- runtime media elements & audio graph ---------- */
function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new AudioContext();
    exportDest = audioCtx.createMediaStreamDestination();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  for (const r of runtime.values()) wireAudio(r);
}

function wireAudio(r) {
  if (!audioCtx || r.gain || !(r.el instanceof HTMLMediaElement)) return;
  r.src = audioCtx.createMediaElementSource(r.el);
  r.gain = audioCtx.createGain();
  r.src.connect(r.gain);
  r.gain.connect(audioCtx.destination);
  r.gain.connect(exportDest);
}

function getEl(c) {
  let r = runtime.get(c.id);
  if (r) return r;
  const m = mediaOf(c);
  if (!m || c.type === 'text') return null;
  let el;
  if (c.type === 'image') { el = new Image(); el.src = m.url; }
  else {
    el = document.createElement(c.type);
    el.preload = 'auto'; el.playsInline = true; el.src = m.url;
    if ('preservesPitch' in el) el.preservesPitch = true;
  }
  r = { el, src: null, gain: null, pendingSeek: null, lastSeekAt: 0 };
  if (el instanceof HTMLMediaElement) {
    el.addEventListener('loadedmetadata', () => {
      const cur = clipById(c.id);
      if (!cur) return;
      const want = r.pendingSeek !== null
        ? r.pendingSeek
        : (state.time >= cur.start && state.time < cur.start + cur.dur ? cur.in + (state.time - cur.start) * cur.speed : cur.in);
      r.pendingSeek = null;
      r.lastSeekAt = performance.now();
      el.currentTime = clamp(want, 0, Number.isFinite(el.duration) ? Math.max(0, el.duration - 0.001) : Math.max(0, want));
    });
    el.addEventListener('seeked', () => {
      if (r.pendingSeek !== null && !state.playing) {
        const nextT = r.pendingSeek;
        r.pendingSeek = null;
        r.lastSeekAt = performance.now();
        el.currentTime = clamp(nextT, 0, Number.isFinite(el.duration) ? Math.max(0, el.duration - 0.001) : nextT);
        return;
      }
      if (!state.playing) render();
    });
  }
  runtime.set(c.id, r);
  wireAudio(r);
  return r;
}

function seekElement(r, target) {
  const el = r.el;
  const clamped = clamp(target, 0, Number.isFinite(el.duration) ? Math.max(0, el.duration - 0.001) : Math.max(0, target));
  if (el.readyState < 1 || el.seeking) {
    r.pendingSeek = clamped;
    return;
  }
  if (Math.abs(el.currentTime - clamped) <= 0.025) return;
  r.pendingSeek = null;
  r.lastSeekAt = performance.now();
  el.currentTime = clamped;
}

function pruneRuntime() {
  for (const [id, r] of runtime) {
    const c = clipById(id);
    if (c && mediaOf(c)) continue;
    if (r.el.pause) r.el.pause();
    try { r.src?.disconnect(); r.gain?.disconnect(); } catch { /* already disconnected */ }
    runtime.delete(id);
  }
  for (const c of state.clips) getEl(c);
}

function fadeFactor(c, t) {
  const local = t - c.start, remain = c.start + c.dur - t;
  let a = 1;
  if (c.fadeIn > 0 && local < c.fadeIn) a *= clamp(local / c.fadeIn, 0, 1);
  if (c.fadeOut > 0 && remain < c.fadeOut) a *= clamp(remain / c.fadeOut, 0, 1);
  return a;
}

function setVolume(r, c, t) {
  const off = state.trackOff[c.track];
  const v = off ? 0 : (c.volume / 100) * fadeFactor(c, t);
  if (r.gain) { r.el.volume = 1; r.gain.gain.value = v; }
  else r.el.volume = clamp(v, 0, 1);
}

const effectivePlayMul = () => (exp ? 1 : state.playRate);

function setPlayRate(rate) {
  rate = clamp(parseFloat(rate) || 1, 0.25, 4);
  state.playRate = rate;
  for (const b of document.querySelectorAll('.speed-pills .spd')) {
    b.classList.toggle('active', Math.abs(parseFloat(b.dataset.rate) - rate) < 1e-3);
  }
  if (state.playing) {
    anchor = { wall: performance.now(), t: state.time };
    syncMedia();
  }
}

function syncMedia() {
  const t = state.time, playing = state.playing, playMul = effectivePlayMul();
  const now = performance.now();
  for (const c of state.clips) {
    if (!isTimed(c)) continue;
    const r = getEl(c);
    if (!r) continue;
    const el = r.el;
    const active = t >= c.start && t < c.start + c.dur;
    const target = c.in + (t - c.start) * c.speed;
    const wantRate = clamp(c.speed * playMul, 0.0625, 16);
    if (active) {
      setVolume(r, c, t);
      if (playing) {
        if (Math.abs(el.playbackRate - wantRate) > 1e-3) el.playbackRate = wantRate;
        if (el.readyState < 1) {
          r.pendingSeek = target;
        } else if (el.paused) {
          r.pendingSeek = null;
          if (!el.seeking && Math.abs(el.currentTime - target) > 0.06) {
            r.lastSeekAt = now;
            el.currentTime = clamp(target, 0, Number.isFinite(el.duration) ? Math.max(0, el.duration - 0.001) : target);
          }
          el.play().catch(() => {});
        } else if (!el.seeking && now - r.lastSeekAt > 600 && Math.abs(el.currentTime - target) > Math.max(0.45, 0.35 * wantRate)) {
          r.lastSeekAt = now;
          el.currentTime = clamp(target, 0, Number.isFinite(el.duration) ? Math.max(0, el.duration - 0.001) : target);
        }
      } else {
        if (!el.paused) el.pause();
        if (c.type === 'video') seekElement(r, target);
      }
    } else {
      if (!el.paused) el.pause();
      if (c.type === 'video' && c.start > t && c.start - t < 3.0 * playMul) {
        if (el.readyState < 1) r.pendingSeek = c.in;
        else if (!el.seeking && now - r.lastSeekAt > 800 && Math.abs(el.currentTime - c.in) > 0.06) {
          r.lastSeekAt = now;
          el.currentTime = c.in;
        }
      }
    }
  }
}

/* ---------- rendering the preview canvas ---------- */
function filterString(c) {
  const p = [];
  if (c.brightness !== 100) p.push(`brightness(${c.brightness}%)`);
  if (c.contrast !== 100) p.push(`contrast(${c.contrast}%)`);
  if (c.saturate !== 100) p.push(`saturate(${c.saturate}%)`);
  if (c.grayscale) p.push(`grayscale(${c.grayscale}%)`);
  if (c.blur) p.push(`blur(${c.blur}px)`);
  return p.length ? p.join(' ') : 'none';
}

function drawClip(c, t) {
  const W = stage.width, H = stage.height;
  const a = (c.opacity / 100) * fadeFactor(c, t);
  if (a <= 0) return;
  g.save();
  g.globalAlpha = a;
  g.translate(c.x / 100 * W, c.y / 100 * H);
  g.rotate(c.rotation * Math.PI / 180);
  g.scale(c.flipH ? -1 : 1, c.flipV ? -1 : 1);
  const s = c.scale / 100;

  if (c.type === 'text') {
    const px = c.size * s * H / 720;
    g.font = `${c.bold ? 700 : 400} ${px}px ${c.font}`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = c.color;
    g.lineJoin = 'round';
    const lines = String(c.text).split('\n'), lh = px * 1.2;
    lines.forEach((ln, i) => {
      const y = (i - (lines.length - 1) / 2) * lh;
      if (c.outline) { g.lineWidth = px / 8; g.strokeStyle = 'rgba(0,0,0,.85)'; g.strokeText(ln, 0, y); }
      g.fillText(ln, 0, y);
    });
  } else {
    const r = getEl(c);
    const el = r?.el;
    const sw = c.type === 'video' ? el?.videoWidth : el?.naturalWidth;
    const sh = c.type === 'video' ? el?.videoHeight : el?.naturalHeight;
    if (sw && sh && !(c.type === 'video' && el.readyState < 2)) {
      const cl = clamp(c.cropL, 0, 95) / 100, cr = clamp(c.cropR, 0, 95 - c.cropL) / 100;
      const ct = clamp(c.cropT, 0, 95) / 100, cb = clamp(c.cropB, 0, 95 - c.cropT) / 100;
      const sx = sw * cl, sy = sh * ct, cw = sw * (1 - cl - cr), ch = sh * (1 - ct - cb);
      let dw, dh;
      if (c.fit === 'stretch') { dw = W; dh = H; }
      else {
        const k = c.fit === 'cover' ? Math.max(W / cw, H / ch) : Math.min(W / cw, H / ch);
        dw = cw * k; dh = ch * k;
      }
      const fs = filterString(c);
      if (fs !== 'none') g.filter = fs;
      g.drawImage(el, sx, sy, cw, ch, -dw * s / 2, -dh * s / 2, dw * s, dh * s);
    }
  }
  g.restore();
}

function render() {
  const layer = $('#crop-layer');
  if (state.cropMode && !exp) {
    const tc = cropTargetClip(false);
    if (tc) { renderCropMode(tc); return; }
    state.cropMode = false;
    $('#b-crop-mode')?.classList.remove('active');
  }
  if (layer && !layer.hidden) layer.hidden = true;
  const W = stage.width, H = stage.height, t = state.time;
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  for (let i = TRACKS.length - 1; i >= 0; i--) {
    const tr = TRACKS[i];
    if (tr.kind !== 'visual' || state.trackOff[tr.id]) continue;
    for (const c of state.clips) if (c.track === tr.id && t >= c.start && t < c.start + c.dur) drawClip(c, t);
  }
}

/* ---------- transport ---------- */
let scrubbingSeekBar = false;

function updateTime() {
  const total = duration();
  const tcText = `${fmt(state.time)} / ${fmt(total)}`;
  if (tcText !== lastTcText) {
    $('#timecode').textContent = tcText;
    lastTcText = tcText;
  }
  const sb = $('#seek-bar');
  if (sb && !scrubbingSeekBar) {
    const maxV = Math.max(0.1, total);
    if (Math.abs(parseFloat(sb.max) - maxV) > 1e-3) sb.max = maxV;
    sb.value = state.time;
  }
  const x = state.time * state.pps;
  $('#playhead').style.transform = `translateX(${x}px)`;
  if (state.playing) {
    const sw = layoutCache.scrollerW || scroller.clientWidth;
    if (x > scroller.scrollLeft + sw - 40 || x < scroller.scrollLeft) scroller.scrollLeft = Math.max(0, x - 40);
  }
  if (exp) {
    const span = Math.max(0.001, exp.end - exp.start);
    $('#modal-bar').style.width = clamp(100 * (state.time - exp.start) / span, 0, 100) + '%';
  }
  updateStageCutOverlay();
}

function centerPlayhead() {
  const sw = scroller.clientWidth || 800;
  scroller.scrollLeft = Math.max(0, state.time * state.pps - sw * 0.35);
}

function fitTimeline() {
  const d = Math.max(5, duration());
  const avail = Math.max(300, (scroller.clientWidth || 900) - 60);
  state.pps = clamp(avail / d, MIN_PPS, MAX_PPS);
  if ($('#zoom')) $('#zoom').value = ppsToSlider(state.pps);
  scroller.scrollLeft = 0;
  renderTimeline();
  updateTime();
}

function scrollPage(dir) {
  const step = Math.max(120, (scroller.clientWidth || 800) * 0.85);
  scroller.scrollLeft = Math.max(0, scroller.scrollLeft + dir * step);
}

function seek(t, ensureVisible = false) {
  state.playStopAt = null;
  state.time = clamp(t, 0, Math.max(duration(), 0));
  if (state.playing) anchor = { wall: performance.now(), t: state.time };
  if (ensureVisible) {
    const sw = scroller.clientWidth || 800;
    const x = state.time * state.pps;
    if (x < scroller.scrollLeft + 20 || x > scroller.scrollLeft + sw - 20) {
      scroller.scrollLeft = Math.max(0, x - sw * 0.35);
    }
  }
  syncMedia(); render(); updateTime();
}

function setPlaying(p) {
  if (p && state.cropMode) setCropMode(false);
  if (!p) state.playStopAt = null;
  state.playing = p;
  $('#t-play').textContent = p ? '⏸' : '▶';
  if (p) {
    refreshLayoutCache();
    ensureAudio();
    if (!exp && state.playStopAt === null && state.time >= duration()) state.time = 0;
    const rb = rangeBounds();
    playStartedBeforeCut = !!(rb && state.rangeMode === 'cut' && state.playStopAt === null && state.time < rb[0] - 0.05);
    const now = performance.now();
    playStartedWall = now;
    seamSeekWall = now;
    lastLeadId = null;
    anchor = { wall: now, t: state.time };
    syncMedia();
    requestAnimationFrame(tick);
  } else {
    syncMedia();
  }
}

function findLeadClip(t) {
  for (const c of state.clips) {
    if (c.type === 'video' && !state.trackOff[c.track] && t >= c.start && t < c.start + c.dur) return c;
  }
  for (const c of state.clips) {
    if (c.type === 'audio' && !state.trackOff[c.track] && t >= c.start && t < c.start + c.dur) return c;
  }
  return null;
}

function tick() {
  if (!state.playing) return;
  const now = performance.now();
  const playMul = effectivePlayMul();
  const wallT = anchor.t + ((now - anchor.wall) / 1000) * playMul;
  const lead = findLeadClip(state.time);
  if (lead && lead.id !== lastLeadId) {
    lastLeadId = lead.id;
    seamSeekWall = now;
  } else if (!lead) {
    lastLeadId = null;
  }
  const leadR = lead ? runtime.get(lead.id) : null;
  const leadEl = leadR?.el;

  if (!exp && leadEl && (leadEl.seeking || (leadEl.readyState < 2 && !leadEl.error)) && (now - playStartedWall < 700 || now - seamSeekWall < 650)) {
    anchor = { wall: now, t: state.time };
  } else if (leadEl && !leadEl.paused && !leadEl.seeking && !leadEl.ended && leadEl.readyState >= 2) {
    const mediaT = lead.start + (leadEl.currentTime - lead.in) / lead.speed;
    if (mediaT >= state.time - 0.01 && Math.abs(mediaT - wallT) < 0.45 * playMul) {
      state.time = mediaT;
      anchor = { wall: now, t: mediaT };
    } else {
      state.time = wallT;
    }
  } else {
    state.time = wallT;
  }

  // Live preview skip over red Cut A->B zone when playback started before Point A
  if (!exp && playStartedBeforeCut && hasRange() && state.rangeMode === 'cut') {
    const [r0, r1] = rangeBounds();
    if (state.time >= r0 && state.time < r1) {
      state.time = r1;
      anchor = { wall: now, t: r1 };
      seamSeekWall = now;
      syncMedia();
    }
  }

  const stopAt = exp ? exp.end : (state.playStopAt ?? duration());
  if (state.time >= stopAt) {
    state.time = stopAt;
    setPlaying(false);
    render(); updateTime();
    if (exp) finishExport();
    return;
  }
  syncMedia(); render(); updateTime();
  requestAnimationFrame(tick);
}

const frameStep = () => 1 / 30;

/* ---------- timeline UI ---------- */
function buildTimelineSkeleton() {
  const heads = $('#heads');
  content.innerHTML = '<div id="ruler" title="Click or drag to move play pointer · Shift+drag to select Point A → Point B"></div><div id="tracks"></div><div id="cut-left" class="cut-zone" hidden><span class="cut-tag"></span></div><div id="cut-right" class="cut-zone" hidden><span class="cut-tag"></span></div><div id="cut-hover" class="cut-zone hover" hidden><span class="cut-tag"></span></div><div id="range-box" hidden><div class="rh rh-in" data-rh="in" title="Drag Point A (Cut Start)"></div><div class="range-tag" data-rh="move" title="Drag to slide selection"></div><button class="range-cut-btn" type="button">✂ Cut &amp; Stitch</button><div class="rh rh-out" data-rh="out" title="Drag Point B (Cut End)"></div></div><div id="playhead"><div class="ph-cap" title="Drag play pointer"></div><div class="ph-line" title="Drag play pointer"></div></div>';
  const tracks = $('#tracks');
  for (const tr of TRACKS) {
    const h = document.createElement('div');
    h.className = 'head'; h.dataset.track = tr.id;
    const n = document.createElement('span'); n.textContent = tr.name;
    const b = document.createElement('button');
    b.title = tr.kind === 'audio' ? 'Mute track' : 'Hide track';
    b.textContent = tr.kind === 'audio' ? '🔊' : '👁';
    b.onclick = () => {
      state.trackOff[tr.id] = !state.trackOff[tr.id];
      h.classList.toggle('off', !!state.trackOff[tr.id]);
      $(`.track[data-track="${tr.id}"]`).classList.toggle('off', !!state.trackOff[tr.id]);
      b.textContent = state.trackOff[tr.id] ? (tr.kind === 'audio' ? '🔇' : '🚫') : (tr.kind === 'audio' ? '🔊' : '👁');
      syncMedia(); render();
    };
    h.append(n, b);
    heads.append(h);
    const row = document.createElement('div');
    row.className = 'track'; row.dataset.track = tr.id;
    row.addEventListener('pointerdown', e => {
      if (e.target !== row) return;
      if (state.cutTool || e.shiftKey) return sweepRange(e);
      select(null);
      scrub(e);
    });
    tracks.append(row);
  }
  $('#ruler').addEventListener('pointerdown', e => {
    if (e.shiftKey) return sweepRange(e);
    scrub(e);
  });
  $('#playhead').addEventListener('pointerdown', e => {
    e.stopPropagation();
    scrub(e);
  });
  $('#range-box').addEventListener('pointerdown', e => {
    if (e.target.classList.contains('range-cut-btn')) return;
    const side = e.target.dataset.rh;
    if (!side) return;
    e.preventDefault(); e.stopPropagation();
    dragRangeHandle(side, e.clientX);
  });
  $('#range-box .range-cut-btn')?.addEventListener('click', e => {
    e.stopPropagation();
    applyActiveCut();
  });
}

function timeFromClientX(clientX) {
  return Math.max(0, (clientX - content.getBoundingClientRect().left) / state.pps);
}

function startEdgeAutoScroll(onStep) {
  let lastX = null, active = true, raf = 0;
  const loop = () => {
    if (!active) return;
    if (lastX !== null) {
      const sr = scroller.getBoundingClientRect();
      const edge = 48;
      let delta = 0;
      if (lastX > sr.right - edge) delta = Math.min(28, (lastX - (sr.right - edge)) * 0.45);
      else if (lastX < sr.left + edge) delta = -Math.min(28, ((sr.left + edge) - lastX) * 0.45);
      if (delta !== 0) {
        const before = scroller.scrollLeft;
        scroller.scrollLeft = Math.max(0, scroller.scrollLeft + delta);
        if (scroller.scrollLeft !== before) onStep(lastX);
      }
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  return {
    setX(x) { lastX = x; },
    stop() { active = false; cancelAnimationFrame(raf); },
  };
}

function sweepRange(e) {
  e.preventDefault();
  state.rangeMode = 'cut';
  const t0 = timeFromClientX(e.clientX);
  state.rangeIn = t0;
  state.rangeOut = t0 + MIN_DUR;
  seek(t0);
  updateRangeUI();
  const applyAtX = clientX => {
    const t = timeFromClientX(clientX);
    state.rangeIn = Math.min(t0, t);
    state.rangeOut = Math.max(state.rangeIn + MIN_DUR, Math.max(t0, t));
    seek(t);
    updateRangeUI();
  };
  const edge = startEdgeAutoScroll(applyAtX);
  const move = ev => { edge.setX(ev.clientX); applyAtX(ev.clientX); };
  const up = () => {
    edge.stop();
    window.removeEventListener('pointermove', move);
    buildInspector();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up, { once: true });
}

function dragRangeHandle(side, startClientX = 0) {
  const [origIn, origOut] = rangeBounds() || [0, Math.max(1, duration())];
  const span = origOut - origIn;
  const total = Math.max(duration(), origOut);
  const startScroll = scroller.scrollLeft;
  state.rangeIn = origIn;
  state.rangeOut = origOut;
  const pts = [0, duration(), ...state.clips.flatMap(c => [c.start, c.start + c.dur])];
  const applyAtX = clientX => {
    if (side === 'move') {
      const dt = ((clientX - startClientX) + (scroller.scrollLeft - startScroll)) / state.pps;
      const ni = clamp(origIn + dt, 0, Math.max(0, total - span));
      state.rangeIn = ni;
      state.rangeOut = ni + span;
      seek(state.rangeIn);
      updateRangeUI();
      return;
    }
    let t = timeFromClientX(clientX);
    const sn = nearestSnap(pts, t);
    if (sn !== null) t = sn;
    if (side === 'in') {
      state.rangeIn = clamp(t, 0, state.rangeOut - MIN_DUR);
      seek(state.rangeIn);
    } else {
      state.rangeOut = Math.max(state.rangeIn + MIN_DUR, t);
      seek(state.rangeOut);
    }
    updateRangeUI();
  };
  const edge = startEdgeAutoScroll(applyAtX);
  const move = ev => { edge.setX(ev.clientX); applyAtX(ev.clientX); };
  const up = () => {
    edge.stop();
    window.removeEventListener('pointermove', move);
    buildInspector();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up, { once: true });
}

function scrub(e) {
  e.preventDefault();
  const applyAtX = clientX => seek(timeFromClientX(clientX));
  const edge = startEdgeAutoScroll(applyAtX);
  edge.setX(e.clientX);
  applyAtX(e.clientX);
  const move = ev => { edge.setX(ev.clientX); applyAtX(ev.clientX); };
  const up = () => {
    edge.stop();
    window.removeEventListener('pointermove', move);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up, { once: true });
}

let currentTimelineWidth = 1000;

function renderRuler(width = currentTimelineWidth) {
  currentTimelineWidth = width;
  const pps = state.pps, ruler = $('#ruler');
  if (!ruler) return;
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const step = steps.find(s => s * pps >= 80) || 3600;
  const minor = step / 5;
  ruler.style.backgroundImage = 'linear-gradient(90deg,#666 1px,transparent 1px),linear-gradient(90deg,#aaa 1px,transparent 1px)';
  ruler.style.backgroundSize = `${minor * pps}px 6px,${step * pps}px 14px`;
  ruler.style.backgroundPosition = '0 100%,0 100%';
  ruler.style.backgroundRepeat = 'repeat-x';
  ruler.innerHTML = '';
  const viewL = Math.max(0, scroller.scrollLeft - 300);
  const viewR = Math.min(width, scroller.scrollLeft + (scroller.clientWidth || 1200) + 300);
  const firstIdx = Math.max(0, Math.floor(viewL / (step * pps)));
  const frag = document.createDocumentFragment();
  for (let idx = firstIdx; idx * step * pps <= viewR; idx++) {
    const t = idx * step;
    const l = document.createElement('div');
    l.className = 'lbl'; l.style.left = t * pps + 'px';
    l.textContent = step >= 60 ? fmtHMS(t) : fmt(t, step < 1 ? 1 : 0).replace(/^0/, '');
    frag.append(l);
  }
  ruler.append(frag);
}

function drawWave(canvas, c, m) {
  const cw = canvas.width, ch = canvas.height, cx = canvas.getContext('2d');
  cx.fillStyle = 'rgba(255,255,255,.75)';
  const N = m.peaks.length;
  for (let x = 0; x < cw; x++) {
    const t0 = c.in + (x / cw) * c.dur * c.speed, t1 = c.in + ((x + 1) / cw) * c.dur * c.speed;
    const i0 = clamp(Math.floor(t0 / m.peakDur * N), 0, N - 1), i1 = clamp(Math.ceil(t1 / m.peakDur * N), i0 + 1, N);
    let pk = 0;
    for (let i = i0; i < i1; i++) pk = Math.max(pk, m.peaks[i]);
    const h = Math.max(1, pk * ch);
    cx.fillRect(x, (ch - h) / 2, 1, h);
  }
}

function renderTimeline() {
  const pps = state.pps;
  const padSec = Math.max(2, Math.min(15, duration() * 0.05 || 10));
  const width = Math.min(600000, Math.max(scroller.clientWidth, (duration() + padSec) * pps));
  content.style.width = width + 'px';
  renderRuler(width);
  for (const row of content.querySelectorAll('.track')) row.innerHTML = '';
  for (const c of state.clips) {
    const row = $(`.track[data-track="${c.track}"]`);
    if (!row) continue;
    const m = mediaOf(c);
    const el = document.createElement('div');
    const isStitched = isTimed(c) && c.in > 0.05 && c.start > 0.05;
    el.className = `clip ${c.type}` + (c.id === state.selected ? ' selected' : '') + (isStitched ? ' stitched' : '') + (c.type !== 'text' && !m ? ' missing' : '');
    el.style.left = c.start * pps + 'px';
    el.style.width = Math.max(3, c.dur * pps) + 'px';
    if (m?.thumb && isVisual(c)) el.style.backgroundImage = `url("${m.thumb}")`;
    const hl = document.createElement('span'); hl.className = 'h h-l'; hl.dataset.h = 'l';
    const hr = document.createElement('span'); hr.className = 'h h-r'; hr.dataset.h = 'r';
    const label = document.createElement('span');
    label.className = 'label';
    if (c.type === 'text') label.textContent = c.text;
    else if (!m) label.textContent = `Missing: ${c.mediaName}`;
    else if (isTimed(c) && (c.in > 0.05 || c.dur * c.speed < m.duration - 0.08)) {
      const srcEnd = c.in + c.dur * c.speed;
      label.textContent = `${isStitched ? '✂ ' : ''}${c.mediaName} [${fmt(c.in, 1)}–${fmt(srcEnd, 1)}]`;
    } else label.textContent = c.mediaName;
    el.append(hl, label, hr);
    if (m?.peaks && isTimed(c)) {
      const cv = document.createElement('canvas');
      cv.className = 'wave';
      cv.width = Math.min(2000, Math.max(1, Math.ceil(c.dur * pps))); cv.height = 40;
      drawWave(cv, c, m);
      el.append(cv);
    }
    el.addEventListener('pointerdown', e => {
      e.stopPropagation();
      if (state.cutTool || e.shiftKey) return sweepRange(e);
      startDrag(e, c, e.target.dataset.h || 'move');
    });
    row.append(el);
  }
  $('#playhead').style.transform = `translateX(${state.time * pps}px)`;
  refreshLayoutCache();
  updateRangeUI();
}

/* ---------- clip dragging, trimming, snapping ---------- */
function snapPoints(c) {
  const pts = [0, state.time];
  const rb = rangeBounds();
  if (rb) pts.push(rb[0], rb[1]);
  for (const o of state.clips) if (o !== c) pts.push(o.start, o.start + o.dur);
  return pts;
}
function nearestSnap(pts, t) {
  const th = 8 / state.pps;
  let best = null;
  for (const p of pts) if (Math.abs(p - t) <= th && (best === null || Math.abs(p - t) < Math.abs(best - t))) best = p;
  return best;
}
const nextStart = c => others(c).filter(o => o.start >= c.start).reduce((m, o) => Math.min(m, o.start), Infinity);
const prevEnd = c => others(c).filter(o => o.start < c.start + c.dur - 1e-6 && o.start + o.dur <= c.start + 1e-6).reduce((m, o) => Math.max(m, o.start + o.dur), 0);

function startDrag(e, c, mode) {
  e.preventDefault();
  select(c.id);
  const x0 = e.clientX;
  const orig = { start: c.start, in: c.in, dur: c.dur, track: c.track };
  const m = mediaOf(c);
  const pts = snapPoints(c);
  const prevE = prevEnd(c), nextS = nextStart(c);
  const srcLimit = isTimed(c) && m ? (m.duration - orig.in) / c.speed : Infinity;

  const onMove = ev => {
    const dt = (ev.clientX - x0) / state.pps;
    if (mode === 'move') {
      let s = orig.start + dt;
      const a = nearestSnap(pts, s), b = nearestSnap(pts, s + c.dur);
      const da = a === null ? Infinity : Math.abs(a - s), db = b === null ? Infinity : Math.abs(b - (s + c.dur));
      if (da <= db && a !== null) s = a; else if (b !== null) s = b - c.dur;
      const rect = content.getBoundingClientRect();
      const row = Math.floor((ev.clientY - rect.top - RULER_H) / TRACK_H);
      const tr = TRACKS[row];
      if (tr && tr.kind === trackKind(c)) c.track = tr.id;
      c.start = fitPosition(c, Math.max(0, s));
    } else if (mode === 'l') {
      let ns = orig.start + dt;
      const sn = nearestSnap(pts, ns);
      if (sn !== null) ns = sn;
      const minStart = Math.max(prevE, isTimed(c) ? orig.start - orig.in / c.speed : 0);
      ns = clamp(ns, minStart, orig.start + orig.dur - MIN_DUR);
      const d = ns - orig.start;
      c.start = ns;
      c.dur = orig.dur - d;
      if (isTimed(c)) c.in = orig.in + d * c.speed;
      state.hoverCut = d > 0.02 ? { from: orig.start, to: ns, label: `✂ TRIM START -${fmt(d)}` } : null;
      state.time = ns;
    } else {
      let ne = orig.start + orig.dur + dt;
      const sn = nearestSnap(pts, ne);
      if (sn !== null) ne = sn;
      const maxEnd = Math.min(nextS, isTimed(c) ? orig.start + srcLimit : Infinity);
      c.dur = clamp(ne, orig.start + MIN_DUR, Math.max(orig.start + MIN_DUR, maxEnd)) - orig.start;
      const cutEnd = (orig.start + orig.dur) - (c.start + c.dur);
      state.hoverCut = cutEnd > 0.02 ? { from: c.start + c.dur, to: orig.start + orig.dur, label: `✂ TRIM END -${fmt(cutEnd)}` } : null;
      state.time = c.start + c.dur;
    }
    renderTimeline();
    syncMedia(); render(); updateTime();
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    state.hoverCut = null;
    updateRangeUI();
    commit();
    buildInspector();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp, { once: true });
}

/* ---------- inspector ---------- */
function refresh() { render(); renderTimeline(); }

function row(label, ...els) {
  const d = document.createElement('div');
  d.className = els.length === 1 ? 'row wide' : 'row';
  const l = document.createElement('label');
  l.textContent = label;
  d.append(l, ...els);
  return d;
}

function slider(c, label, prop, min, max, step, apply) {
  const r = document.createElement('input');
  r.type = 'range'; r.min = min; r.max = max; r.step = step; r.value = c[prop];
  r.setAttribute('aria-label', label);
  const n = document.createElement('input');
  n.type = 'number'; n.min = min; n.max = max; n.step = step; n.value = round(c[prop]);
  n.setAttribute('aria-label', label + ' value');
  const set = v => {
    v = parseFloat(v);
    if (Number.isNaN(v)) return;
    v = clamp(v, min, max);
    if (apply) apply(c, v); else c[prop] = v;
    r.value = c[prop]; n.value = round(c[prop]);
    refresh(); updateTime();
  };
  r.oninput = () => set(r.value);
  n.onchange = () => { set(n.value); commit(); };
  r.onchange = () => commit();
  return row(label, r, n);
}

function choice(c, label, prop, options) {
  const s = document.createElement('select');
  for (const [v, t] of options) {
    const o = document.createElement('option');
    o.value = v; o.textContent = t; s.append(o);
  }
  s.value = c[prop];
  s.onchange = () => { c[prop] = s.value; refresh(); commit(); };
  return row(label, s);
}

function toggle(c, label, prop) {
  const i = document.createElement('input');
  i.type = 'checkbox'; i.checked = !!c[prop];
  i.onchange = () => { c[prop] = i.checked; refresh(); commit(); };
  return row(label, i);
}

function setSpeed(c, v) {
  const span = c.dur * c.speed;
  c.speed = v;
  c.dur = clamp(span / v, MIN_DUR, nextStart(c) - c.start);
}
function setDur(c, v) { c.dur = clamp(v, MIN_DUR, nextStart(c) - c.start); }

function buildRangeCard(box) {
  const card = document.createElement('div');
  card.className = 'range-card';
  const title = document.createElement('h3');
  title.textContent = 'Cut Point A → B / Trim Ends';
  card.append(title);

  const sw = document.createElement('div');
  sw.className = 'mode-switch';
  const bCutMode = document.createElement('button');
  bCutMode.textContent = 'Cut A → B (Inside)';
  bCutMode.title = 'Highlights ONLY Point A → Point B in RED to slice out';
  if (state.rangeMode === 'cut') bCutMode.className = 'active-cut';
  bCutMode.onclick = () => setRangeMode('cut');
  const bTrimMode = document.createElement('button');
  bTrimMode.textContent = 'Keep A → B (Outside)';
  bTrimMode.title = 'Keeps Point A → Point B and highlights everything before A & after B in RED';
  if (state.rangeMode === 'trim') bTrimMode.className = 'active-trim';
  bTrimMode.onclick = () => setRangeMode('trim');
  sw.append(bCutMode, bTrimMode);
  card.append(sw);

  const bounds = rangeBounds();
  const total = duration();
  const curIn = bounds ? bounds[0] : 0;
  const curOut = bounds ? bounds[1] : total;

  const inInput = document.createElement('input');
  inInput.type = 'text'; inInput.className = 'hms-input';
  inInput.placeholder = '00:00:00'; inInput.value = fmtHMS(curIn);
  inInput.title = 'HH:MM:SS (e.g. 00:01:30)';
  inInput.setAttribute('aria-label', 'Point A timestamp HH:MM:SS');
  const inBtn = document.createElement('button');
  inBtn.textContent = '[ Set A'; inBtn.title = 'Set Point A at playhead (I or [)';
  inBtn.onclick = () => setMarkIn(state.time, true);
  inInput.onchange = () => {
    const v = parseHMS(inInput.value);
    if (Number.isNaN(v)) { inInput.value = fmtHMS(curIn); toast('Enter Point A as HH:MM:SS (e.g. 00:01:30)'); return; }
    seek(v);
    setMarkIn(v);
  };
  card.append(row('Point A', inInput, inBtn));

  const outInput = document.createElement('input');
  outInput.type = 'text'; outInput.className = 'hms-input';
  outInput.placeholder = '00:00:00'; outInput.value = fmtHMS(curOut);
  outInput.title = 'HH:MM:SS (e.g. 00:02:45)';
  outInput.setAttribute('aria-label', 'Point B timestamp HH:MM:SS');
  const outBtn = document.createElement('button');
  outBtn.textContent = 'Set B ]'; outBtn.title = 'Set Point B at playhead (O or ])';
  outBtn.onclick = () => setMarkOut(state.time, true);
  outInput.onchange = () => {
    const v = parseHMS(outInput.value);
    if (Number.isNaN(v)) { outInput.value = fmtHMS(curOut); toast('Enter Point B as HH:MM:SS (e.g. 00:02:45)'); return; }
    seek(v);
    setMarkOut(Math.max(MIN_DUR, v));
  };
  card.append(row('Point B', outInput, outBtn));

  const btns = document.createElement('div');
  btns.className = 'btns';
  const mkBtn = (label, cls, fn, tip = '') => {
    const b = document.createElement('button');
    if (cls) b.className = cls;
    b.textContent = label;
    if (tip) b.title = tip;
    b.onclick = fn;
    btns.append(b);
  };
  const cutSec = totalCutSeconds();
  if (bounds && cutSec >= MIN_DUR - 1e-4) {
    const csLbl = cutSec >= 1 ? fmtHMS(cutSec) : `${round(cutSec, 2)}s`;
    mkBtn(`✂ Cut & Stitch (-${csLbl})`, 'danger-solid', applyActiveCut, 'Cut all RED-highlighted regions from the video');
  }
  mkBtn('✂ Cut A→B', 'danger-outline', () => {
    const a = parseHMS(inInput.value), bVal = parseHMS(outInput.value);
    const b = rangeBounds() || (!Number.isNaN(a) && !Number.isNaN(bVal) && bVal > a + MIN_DUR ? [a, bVal] : initRangeForAction('cut'));
    if (b) cutRange(b[0], b[1], { ripple: true });
  }, 'Slice out Point A → Point B and close the gap');
  mkBtn('✂ Keep Only A→B', 'accent-outline', () => {
    const a = parseHMS(inInput.value), bVal = parseHMS(outInput.value);
    const b = (hasRange() && state.rangeMode === 'trim') ? rangeBounds() : (!Number.isNaN(a) && !Number.isNaN(bVal) && bVal > a + MIN_DUR && (a > 0 || bVal < total) ? [a, bVal] : initRangeForAction('keep'));
    if (b) keepRange(b[0], b[1]);
  }, 'Keep ONLY Point A → Point B and remove outside ends');
  mkBtn('Lift A→B (keep gap)', '', () => {
    const b = rangeBounds() || initRangeForAction('cut');
    if (b) cutRange(b[0], b[1], { ripple: false });
  }, 'Remove Point A → Point B without shifting later clips');
  if (bounds) mkBtn('✕ Clear marks', '', clearRange);
  card.append(btns);

  const tip = document.createElement('p');
  tip.className = 'hint'; tip.style.padding = '6px 0 0';
  tip.textContent = 'Format: HH:MM:SS (e.g. 00:01:15). Type timestamps directly or use [ Cut Start (A) and Cut End (B) ].';
  card.append(tip);
  box.append(card);
}

function buildInspector() {
  const box = $('#inspector');
  box.innerHTML = '';
  buildRangeCard(box);
  const c = selClip();
  if (!c) {
    const p = document.createElement('p');
    p.className = 'hint'; p.textContent = 'Select a clip on the timeline to edit its properties.';
    box.append(p);
    return;
  }
  const h = document.createElement('h3');
  h.textContent = c.type === 'text' ? 'Text clip' : `${c.type[0].toUpperCase()}${c.type.slice(1)} clip`;
  box.append(h);
  const info = document.createElement('p');
  info.className = 'hint'; info.style.padding = '0 0 6px';
  info.textContent = `Start ${fmt(c.start)} · End ${fmt(c.start + c.dur)} · Length ${fmt(c.dur)}`;
  box.append(info);

  const quickTrim = document.createElement('div');
  quickTrim.className = 'mini-btns';
  for (const [lbl, tip, fn] of [
    ['[ Cut Start (A)', 'Set Point A (start of slice) at playhead', () => setMarkIn(state.time, true)],
    ['Cut End (B) ]', 'Set Point B (end of slice) at playhead', () => setMarkOut(state.time, true)],
    ['⇥ Cut 0:00→Here', 'Select from 0:00 up to playhead to remove', () => markTrimSide('start')],
    ['⇤ Cut Here→End', 'Select from playhead to end to remove', () => markTrimSide('end')],
  ]) {
    const b = document.createElement('button');
    b.textContent = lbl; b.title = tip; b.onclick = fn;
    quickTrim.append(b);
  }
  if (hasRange()) {
    const [r0, r1] = rangeBounds();
    const bCutClip = document.createElement('button');
    bCutClip.className = 'danger-outline';
    bCutClip.textContent = '✂ Cut Range (Clip)';
    bCutClip.title = 'Cut marked Start→Finish from this clip only';
    bCutClip.onclick = () => cutRange(r0, r1, { ripple: true, onlyClipId: c.id });
    quickTrim.append(bCutClip);
  }
  box.append(quickTrim);

  const group = t => { const d = document.createElement('div'); d.className = 'group'; d.textContent = t; box.append(d); };

  if (c.type === 'text') {
    group('Text');
    const ta = document.createElement('textarea');
    ta.value = c.text; ta.setAttribute('aria-label', 'Text');
    ta.oninput = () => { c.text = ta.value; refresh(); };
    ta.onchange = () => commit();
    box.append(ta);
    box.append(slider(c, 'Size', 'size', 8, 300, 1));
    const col = document.createElement('input');
    col.type = 'color'; col.value = c.color;
    col.oninput = () => { c.color = col.value; render(); };
    col.onchange = () => commit();
    box.append(row('Color', col));
    box.append(choice(c, 'Font', 'font', FONTS.map(f => [f, f.split(',')[0].replace(/"/g, '')])));
    box.append(toggle(c, 'Bold', 'bold'), toggle(c, 'Outline', 'outline'));
  }
  if (!isTimed(c)) box.append(slider(c, 'Duration', 'dur', MIN_DUR, 120, 0.1, setDur));

  if (isVisual(c)) {
    group('Transform');
    box.append(slider(c, 'X %', 'x', -50, 150, 0.5), slider(c, 'Y %', 'y', -50, 150, 0.5));
    box.append(slider(c, 'Scale %', 'scale', 5, 400, 1), slider(c, 'Rotate °', 'rotation', -180, 180, 1));
    box.append(toggle(c, 'Flip H', 'flipH'), toggle(c, 'Flip V', 'flipV'));
    if (c.type !== 'text') box.append(choice(c, 'Fit', 'fit', [['contain', 'Fit'], ['cover', 'Fill'], ['stretch', 'Stretch']]));
    box.append(slider(c, 'Opacity %', 'opacity', 0, 100, 1));
  }
  if (c.type === 'video' || c.type === 'image') {
    group('Crop (% of source)');
    const cropActions = document.createElement('div');
    cropActions.className = 'mini-btns';
    const bInteractive = document.createElement('button');
    bInteractive.className = state.cropMode ? 'active' : 'accent-outline';
    bInteractive.textContent = state.cropMode ? '✓ Finish Frame Crop' : '⌗ Interactive Crop';
    bInteractive.onclick = () => setCropMode(!state.cropMode);
    cropActions.append(bInteractive);
    for (const rStr of ['16:9', '9:16', '1:1', '4:3']) {
      const b = document.createElement('button');
      b.textContent = rStr;
      b.onclick = () => { applyCropAspect(c, rStr); commit(); refresh(); buildInspector(); };
      cropActions.append(b);
    }
    const bResetCrop = document.createElement('button');
    bResetCrop.textContent = 'Reset';
    bResetCrop.onclick = () => { c.cropL = c.cropR = c.cropT = c.cropB = 0; commit(); refresh(); buildInspector(); };
    const bAllCrop = document.createElement('button');
    bAllCrop.textContent = 'Apply Start→Finish';
    bAllCrop.title = 'Copy this crop to every video/image clip in the timeline';
    bAllCrop.onclick = () => applyCropToAllClips(c);
    cropActions.append(bResetCrop, bAllCrop);
    box.append(cropActions);
    box.append(slider(c, 'Left', 'cropL', 0, 90, 0.5), slider(c, 'Right', 'cropR', 0, 90, 0.5));
    box.append(slider(c, 'Top', 'cropT', 0, 90, 0.5), slider(c, 'Bottom', 'cropB', 0, 90, 0.5));
    group('Color');
    box.append(slider(c, 'Brightness', 'brightness', 0, 200, 1), slider(c, 'Contrast', 'contrast', 0, 200, 1));
    box.append(slider(c, 'Saturation', 'saturate', 0, 200, 1), slider(c, 'Grayscale', 'grayscale', 0, 100, 1));
    box.append(slider(c, 'Blur px', 'blur', 0, 20, 0.5));
  }
  if (isTimed(c)) {
    group('Audio & speed');
    if (c.type === 'audio' || mediaOf(c)) box.append(slider(c, 'Volume %', 'volume', 0, 200, 1));
    const spdBtns = document.createElement('div');
    spdBtns.className = 'mini-btns';
    for (const sp of [0.5, 1, 1.5, 2, 2.5]) {
      const b = document.createElement('button');
      b.textContent = `${sp}×`;
      if (Math.abs(c.speed - sp) < 1e-2) b.className = 'active';
      b.onclick = () => { setSpeed(c, sp); commit(); afterEdit(); };
      spdBtns.append(b);
    }
    const bAllSpd = document.createElement('button');
    bAllSpd.textContent = 'Apply to all';
    bAllSpd.title = 'Apply this clip speed to all video/audio clips and close gaps';
    bAllSpd.onclick = () => applySpeedToAllClips(c.speed);
    spdBtns.append(bAllSpd);
    box.append(spdBtns);
    box.append(slider(c, 'Speed ×', 'speed', 0.25, 4, 0.05, setSpeed));
  }
  group('Fades (seconds)');
  box.append(slider(c, 'Fade in', 'fadeIn', 0, 10, 0.1), slider(c, 'Fade out', 'fadeOut', 0, 10, 0.1));

  const btns = document.createElement('div');
  btns.className = 'btns';
  for (const [t, f] of [['✂ Split', () => splitAt(state.time)], ['⧉ Duplicate', duplicateSelected], ['🗑 Delete', () => deleteSelected(false)]]) {
    const b = document.createElement('button');
    b.textContent = t; b.onclick = f; btns.append(b);
  }
  box.append(btns);
}

/* ---------- project save / load ---------- */
function saveProject() {
  const data = {
    app: 'clipforge', version: 1, settings: state.settings,
    media: state.media.map(m => ({ name: m.name, type: m.type, duration: m.duration })),
    clips: state.clips,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: 'project.clipforge.json' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Project saved. Media files are not embedded – re-import them to relink.');
}

async function openProject(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'clipforge' || !Array.isArray(data.clips)) throw new Error('not a ClipForge project');
    setPlaying(false);
    const clips = data.clips
      .filter(c => c && TRACKS.some(t => t.id === c.track) && ['video', 'audio', 'image', 'text'].includes(c.type) && Number.isFinite(c.start) && Number.isFinite(c.dur) && c.dur > 0)
      .map(c => defaults(c));
    state.clips = clips;
    if (data.settings && Number.isFinite(data.settings.w) && Number.isFinite(data.settings.h)) applyResolution(data.settings.w, data.settings.h);
    state.selected = null; state.time = 0;
    relink();
    commit(); afterEdit();
    const missing = clips.filter(c => c.type !== 'text' && !mediaOf(c)).length;
    toast(missing ? `Opened. ${missing} clip(s) need their media re-imported.` : 'Project opened');
  } catch (e) { toast('Could not open project: ' + e.message); }
}

function applySpeedToAllClips(v) {
  v = clamp(v, 0.25, 4);
  for (const tr of TRACKS) {
    const trClips = state.clips.filter(c => c.track === tr.id).sort((a, b) => a.start - b.start);
    let shift = 0;
    for (const c of trClips) {
      c.start = Math.max(0, c.start + shift);
      if (isTimed(c)) {
        const oldDur = c.dur;
        const srcSpan = c.dur * c.speed;
        c.speed = v;
        c.dur = Math.max(MIN_DUR, srcSpan / v);
        shift += (c.dur - oldDur);
      }
    }
  }
  state.time = clamp(state.time, 0, Math.max(0, duration()));
  commit();
  afterEdit();
  toast(`Applied ${v}× clip speed across timeline`);
}

function applyResolution(w, h) {
  state.settings = { w, h };
  stage.width = w; stage.height = h;
  const sel = $('#res');
  if ([...sel.options].some(o => o.value === `${w}x${h}`)) sel.value = `${w}x${h}`;
  requestAnimationFrame(() => { refreshLayoutCache(); updateStageCutOverlay(); });
  render();
}

/* ---------- export (real-time render to MP4 / WebM) ---------- */
let lastExportResult = null;

function revokeLastExport() {
  if (lastExportResult?.url) URL.revokeObjectURL(lastExportResult.url);
  lastExportResult = null;
}

function defaultExportFilename(ext) {
  const first = state.clips.slice().sort((a, b) => a.start - b.start).find(c => c.mediaName);
  const base = first ? first.mediaName.replace(/\.[^.]+$/, '') : 'clipforge';
  return `${base}-edited.${ext}`;
}

async function startExport(rangeOnly = false) {
  if (!state.clips.length) return toast('Add some clips first');
  if (typeof MediaRecorder === 'undefined') return toast('Export is not supported in this browser');
  if (state.cropMode) setCropMode(false);
  setPlaying(false);
  const bounds = rangeOnly ? rangeBounds() : null;
  const expStart = bounds ? bounds[0] : 0;
  const expEnd = bounds ? bounds[1] : duration();
  if (expEnd - expStart < MIN_DUR) return toast('Nothing to export in range');
  ensureAudio();
  const wantFmt = $('#export-fmt')?.value || 'mp4';
  const mp4Types = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4;codecs=avc1,opus',
    'video/mp4',
  ];
  const webmTypes = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  const candidates = wantFmt === 'webm' ? [...webmTypes, ...mp4Types] : [...mp4Types, ...webmTypes];
  const mime = candidates.find(t => MediaRecorder.isTypeSupported(t));
  if (!mime) return toast('No supported recording format in this browser');
  const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
  revokeLastExport();

  const stream = new MediaStream([...stage.captureStream(30).getVideoTracks(), ...exportDest.stream.getAudioTracks()]);
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8e6 });
  const chunks = [];
  exp = { recorder, cancelled: false, mime, ext, start: expStart, end: expEnd };
  recorder.ondataavailable = e => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    const e = exp || {};
    exp = null;
    if (e.cancelled) {
      $('#modal').hidden = true;
      return toast('Export cancelled');
    }
    const blob = new Blob(chunks, { type: mime });
    const url = URL.createObjectURL(blob);
    const filename = defaultExportFilename(ext);
    lastExportResult = { blob, url, filename, ext, mime };
    Object.assign(document.createElement('a'), { href: url, download: filename }).click();

    $('#modal-title').textContent = `Export ready (.${ext.toUpperCase()})`;
    $('#modal-text').textContent = `Saved "${filename}" (${(blob.size / 1e6).toFixed(1)} MB) to your browser's Downloads folder, or click "Save As…" to choose any folder.`;
    $('#modal-bar').style.width = '100%';
    $('#modal-cancel').hidden = true;
    const doneBtns = $('#modal-done-btns');
    if (doneBtns) {
      doneBtns.hidden = false;
      $('#modal-download').textContent = `⬇ Download .${ext}`;
    } else {
      $('#modal').hidden = true;
    }
    toast(`Exported ${filename} to Downloads`);
  };
  $('#modal-title').textContent = `Exporting .${ext.toUpperCase()}…`;
  $('#modal-text').textContent = 'Rendering in real time. Keep this tab in the foreground.';
  $('#modal-bar').style.width = '0';
  $('#modal-cancel').hidden = false;
  if ($('#modal-done-btns')) $('#modal-done-btns').hidden = true;
  $('#modal').hidden = false;
  state.time = expStart;
  syncMedia(); render(); updateTime();
  await new Promise(r => setTimeout(r, 400)); // let the first frames seek/decode
  if (!exp) return;
  recorder.start(500);
  setPlaying(true);
}

function finishExport() {
  const e = exp;
  if (!e) return;
  setTimeout(() => { if (e.recorder.state !== 'inactive') e.recorder.stop(); }, 300);
}

function cancelExport() {
  if (!exp) return;
  exp.cancelled = true;
  setPlaying(false);
  if (exp.recorder.state !== 'inactive') exp.recorder.stop();
}

/* ---------- wiring ---------- */
buildTimelineSkeleton();
renderLibrary();
buildInspector();
updateHistoryButtons();

$('#btn-import').onclick = () => $('#file-media').click();
$('#file-media').onchange = e => { importFiles([...e.target.files]); e.target.value = ''; };
$('#btn-text').onclick = addText;
$('#btn-save').onclick = saveProject;
$('#btn-open').onclick = () => $('#file-project').click();
$('#file-project').onchange = e => { if (e.target.files[0]) openProject(e.target.files[0]); e.target.value = ''; };
$('#btn-export').onclick = () => startExport(false);
if ($('#btn-export-range')) $('#btn-export-range').onclick = () => startExport(true);
if ($('#export-fmt')) $('#export-fmt').onchange = e => {
  $('#btn-export').textContent = e.target.value === 'webm' ? 'Export WebM' : 'Export MP4';
};
$('#modal-cancel').onclick = cancelExport;
if ($('#modal-download')) $('#modal-download').onclick = () => {
  if (!lastExportResult) return;
  Object.assign(document.createElement('a'), { href: lastExportResult.url, download: lastExportResult.filename }).click();
};
if ($('#modal-save-as')) $('#modal-save-as').onclick = async () => {
  if (!lastExportResult) return;
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: lastExportResult.filename,
        types: [{
          description: lastExportResult.ext === 'mp4' ? 'MP4 Video' : 'WebM Video',
          accept: { [lastExportResult.ext === 'mp4' ? 'video/mp4' : 'video/webm']: ['.' + lastExportResult.ext] },
        }],
      });
      const writable = await handle.createWritable();
      await writable.write(lastExportResult.blob);
      await writable.close();
      toast('Saved ' + handle.name);
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return;
    }
  }
  Object.assign(document.createElement('a'), { href: lastExportResult.url, download: lastExportResult.filename }).click();
};
if ($('#modal-close')) $('#modal-close').onclick = () => {
  $('#modal').hidden = true;
  revokeLastExport();
};
$('#res').onchange = e => { const [w, h] = e.target.value.split('x').map(Number); applyResolution(w, h); };

$('#t-play').onclick = () => setPlaying(!state.playing);
$('#t-start').onclick = () => seek(0, true);
$('#t-end').onclick = () => seek(duration(), true);
$('#t-back').onclick = () => seek(state.time - frameStep(), true);
$('#t-fwd').onclick = () => seek(state.time + frameStep(), true);
if ($('#t-play-range')) $('#t-play-range').onclick = playRange;
if ($('#seek-bar')) {
  const sb = $('#seek-bar');
  sb.addEventListener('pointerdown', () => { scrubbingSeekBar = true; });
  window.addEventListener('pointerup', () => { scrubbingSeekBar = false; });
  sb.oninput = () => seek(parseFloat(sb.value) || 0, true);
}
if ($('#b-page-prev')) $('#b-page-prev').onclick = () => scrollPage(-1);
if ($('#b-page-next')) $('#b-page-next').onclick = () => scrollPage(1);
if ($('#b-center-ph')) $('#b-center-ph').onclick = centerPlayhead;
if ($('#b-fit')) $('#b-fit').onclick = fitTimeline;

$('#b-undo').onclick = undo;
$('#b-redo').onclick = redo;
if ($('#b-cut-tool')) $('#b-cut-tool').onclick = () => setCutTool(!state.cutTool);
$('#b-split').onclick = () => splitAt(state.time);
if ($('#b-trim-start')) {
  $('#b-trim-start').onclick = () => { setHoverCut(null); markTrimSide('start'); };
  $('#b-trim-start').onpointerenter = () => {
    if (!state.clips.length) return;
    const t = state.time > MIN_DUR && state.time < duration() - MIN_DUR ? state.time : Math.min(2, duration() * 0.15);
    setHoverCut(0, t, `✂ WILL CUT START (-${fmt(t)})`);
  };
  $('#b-trim-start').onpointerleave = () => setHoverCut(null);
}
if ($('#b-trim-end')) {
  $('#b-trim-end').onclick = () => { setHoverCut(null); markTrimSide('end'); };
  $('#b-trim-end').onpointerenter = () => {
    if (!state.clips.length) return;
    const total = duration();
    const t = state.time > MIN_DUR && state.time < total - MIN_DUR ? state.time : total - Math.min(2, total * 0.15);
    setHoverCut(t, total, `✂ WILL CUT END (-${fmt(total - t)})`);
  };
  $('#b-trim-end').onpointerleave = () => setHoverCut(null);
}
$('#b-dup').onclick = duplicateSelected;
$('#b-del').onclick = () => deleteSelected(false);
$('#b-ripple').onclick = () => deleteSelected(true);
if ($('#b-in')) $('#b-in').onclick = () => setMarkIn(state.time, true);
if ($('#b-out')) $('#b-out').onclick = () => setMarkOut(state.time, true);
if ($('#b-apply-cut')) $('#b-apply-cut').onclick = applyActiveCut;
if ($('#b-clear-range')) $('#b-clear-range').onclick = clearRange;
if ($('#b-keep-range')) $('#b-keep-range').onclick = () => {
  const b = initRangeForAction('keep');
  if (b) keepRange(b[0], b[1]);
};
if ($('#b-cut-range')) $('#b-cut-range').onclick = () => {
  const b = initRangeForAction('cut');
  if (b) cutRange(b[0], b[1], { ripple: true });
};
if ($('#b-crop-mode')) $('#b-crop-mode').onclick = () => setCropMode(!state.cropMode);

if ($('#crop-box')) {
  $('#crop-box').addEventListener('pointerdown', e => {
    const c = cropTargetClip(false);
    if (!c) return;
    e.preventDefault(); e.stopPropagation();
    const handle = e.target.dataset.ch || 'move';
    const x0 = e.clientX, y0 = e.clientY;
    const orig = { l: c.cropL, r: c.cropR, t: c.cropT, b: c.cropB };
    const { sw, sh, W, H, fw, fh } = cropMetrics(c);
    const sr = stage.getBoundingClientRect();
    const dfw = fw * (sr.width / W), dfh = fh * (sr.height / H);
    const move = ev => {
      const dx = ((ev.clientX - x0) / Math.max(1, dfw)) * 100;
      const dy = ((ev.clientY - y0) / Math.max(1, dfh)) * 100;
      if (handle === 'move') {
        const spanX = 100 - orig.l - orig.r, spanY = 100 - orig.t - orig.b;
        c.cropL = round(clamp(orig.l + dx, 0, 100 - spanX), 2);
        c.cropR = round(100 - spanX - c.cropL, 2);
        c.cropT = round(clamp(orig.t + dy, 0, 100 - spanY), 2);
        c.cropB = round(100 - spanY - c.cropT, 2);
      } else {
        if (handle.includes('w')) c.cropL = round(clamp(orig.l + dx, 0, 95 - orig.r), 2);
        if (handle.includes('e')) c.cropR = round(clamp(orig.r - dx, 0, 95 - orig.l), 2);
        if (handle.includes('n')) c.cropT = round(clamp(orig.t + dy, 0, 95 - orig.b), 2);
        if (handle.includes('s')) c.cropB = round(clamp(orig.b - dy, 0, 95 - orig.t), 2);
        if (state.cropAspect !== 'free') {
          const [aw, ah] = state.cropAspect.split(':').map(Number);
          const ratio = aw / ah;
          const visW = (100 - c.cropL - c.cropR) / 100 * sw;
          const wantH = clamp((visW / ratio / sh) * 100, 5, 100 - c.cropT);
          if (handle.includes('n') && !handle.includes('s')) {
            c.cropT = round(clamp(100 - c.cropB - wantH, 0, 95 - c.cropB), 2);
          } else {
            c.cropB = round(clamp(100 - c.cropT - wantH, 0, 95 - c.cropT), 2);
          }
        }
      }
      render();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      commit();
      buildInspector();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  });
}
if ($('#crop-ratio')) $('#crop-ratio').onchange = e => {
  const c = cropTargetClip(false);
  applyCropAspect(c, e.target.value);
  if (c) { commit(); render(); buildInspector(); }
};
if ($('#crop-all')) $('#crop-all').onclick = () => applyCropToAllClips(cropTargetClip(false));
if ($('#crop-reset')) $('#crop-reset').onclick = () => {
  const c = cropTargetClip(false);
  if (!c) return;
  c.cropL = c.cropR = c.cropT = c.cropB = 0;
  commit(); render(); buildInspector();
};
if ($('#crop-done')) $('#crop-done').onclick = () => setCropMode(false);
for (const b of document.querySelectorAll('.speed-pills .spd')) {
  b.onclick = () => setPlayRate(parseFloat(b.dataset.rate));
}
if (typeof ResizeObserver !== 'undefined') {
  const ro = new ResizeObserver(() => { refreshLayoutCache(); updateStageCutOverlay(); if (state.cropMode) render(); });
  if (stage.parentElement) ro.observe(stage.parentElement);
  ro.observe(scroller);
}

$('#zoom').oninput = e => {
  state.pps = sliderToPps(+e.target.value);
  renderTimeline();
  centerPlayhead();
  updateTime();
};
let rulerScrollRaf = 0;
scroller.addEventListener('scroll', () => {
  if (rulerScrollRaf) return;
  rulerScrollRaf = requestAnimationFrame(() => {
    rulerScrollRaf = 0;
    renderRuler();
  });
}, { passive: true });
scroller.addEventListener('wheel', e => {
  e.preventDefault();
  if (e.ctrlKey) {
    state.pps = clamp(state.pps * (e.deltaY < 0 ? 1.18 : 1 / 1.18), MIN_PPS, MAX_PPS);
    $('#zoom').value = ppsToSlider(state.pps);
    renderTimeline();
    centerPlayhead();
    updateTime();
  } else {
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    scroller.scrollLeft = Math.max(0, scroller.scrollLeft + delta);
  }
}, { passive: false });

content.addEventListener('dragover', e => e.preventDefault());
content.addEventListener('drop', e => {
  e.preventDefault(); e.stopPropagation();
  const id = e.dataTransfer.getData('application/x-clip-media');
  if (!id) return importFiles([...e.dataTransfer.files]);
  const m = state.media.find(x => x.id === id);
  if (!m) return;
  const rect = content.getBoundingClientRect();
  const start = Math.max(0, (e.clientX - rect.left) / state.pps);
  const tr = TRACKS[Math.floor((e.clientY - rect.top - RULER_H) / TRACK_H)];
  addMedia(m, tr?.id ?? 'none', start);
});
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault();
  if (e.dataTransfer.files.length) importFiles([...e.dataTransfer.files]);
});

window.addEventListener('keydown', e => {
  if (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(e.target.tagName)) return;
  if (exp) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); }
  else if (mod) return;
  else if (e.code === 'Space') { e.preventDefault(); setPlaying(!state.playing); }
  else if (e.key === 's' || e.key === 'S') splitAt(state.time);
  else if (e.key === 'i' || e.key === 'I' || e.key === '[') setMarkIn(state.time, true);
  else if (e.key === 'o' || e.key === 'O' || e.key === ']') setMarkOut(state.time, true);
  else if (e.key === 'x' || e.key === 'X') {
    const b = initRangeForAction('cut');
    if (b) cutRange(b[0], b[1], { ripple: !e.shiftKey });
  }
  else if (e.key === 'r' || e.key === 'R') setCutTool(!state.cutTool);
  else if (e.key === 'c' || e.key === 'C') setCropMode(!state.cropMode);
  else if (e.key === 'Escape') {
    if (state.cropMode) setCropMode(false);
    else if (state.cutTool) setCutTool(false);
    else if (hasRange()) clearRange();
  }
  else if (e.key === 'Enter') {
    if (state.cropMode) setCropMode(false);
    else if (hasRange() && totalCutSeconds() >= MIN_DUR - 1e-4) applyActiveCut();
  }
  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(e.shiftKey); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(state.time - (e.shiftKey ? 1 : frameStep()), true); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); seek(state.time + (e.shiftKey ? 1 : frameStep()), true); }
  else if (e.key === 'PageUp') { e.preventDefault(); scrollPage(-1); }
  else if (e.key === 'PageDown') { e.preventDefault(); scrollPage(1); }
  else if (e.key === 'Home') seek(0, true);
  else if (e.key === 'End') seek(duration(), true);
});
window.addEventListener('resize', () => { renderTimeline(); if (state.cropMode) render(); });

render();
updateTime();
