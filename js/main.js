// Wiring: the frame loop, the controls, the input, and the frame-rate work.
//
// The loop is deliberately plain — one requestAnimationFrame, no timers, no
// throttling — because the point of the piece is what the machine can actually
// do. Everything that could make a frame allocate has been hoisted out: the
// metrics live in ring buffers, the sim writes into pre-sized arrays, and the
// HUD is text-poked at 10 Hz rather than rebuilt per frame.

import { ObjectCell, PALETTES } from './cell.js';
import { Renderer, TUBES } from './renderer.js';

const MAX_SHARDS = 2400;
const CELL_SIZES = [256, 384, 512, 768, 1024];
const STORE_KEY = 'lab980.kaleidoscope.v1';

const $ = (id) => document.getElementById(id);

const S = {
  tube: '333',
  sectors: 8,
  zoom: 1.15,
  rollRate: 0.14,
  reflect: 0.955,
  aberration: 0.004,
  seam: 0.12,
  eyepiece: false,
  palette: 0,
  count: 130,
  alpha: 0.8,
  size: 1.7,
  gravity: 0.9,
  agitation: 0.06,
  scale: 1.0,
  cellIdx: 3,
  auto: true,
  target: 120,
  glints: true,
  paused: false,
};

export function start(build) {
  const canvas = $('gl');
  const renderer = new Renderer(canvas, MAX_SHARDS);
  const cell = new ObjectCell(MAX_SHARDS);

  load();
  cell.setPalette(S.palette);
  cell.setCount(S.count);
  cell.setDensity(S.alpha);
  cell.setSize(S.size);

  let saveTimer = 0;      // declared up here: bind() writes settings during setup
  const view = { roll: 0, dragging: false, pointers: new Map(), pinch: 0 };
  const perf = {
    frames: new Float32Array(600),   // frame times, ms
    scratch: new Float32Array(240),  // percentile workspace, reused
    n: 0,
    fps: 0,
    simMs: 0,
    lastHud: 0,
    lastAdapt: 0,
  };

  // ---- controls -----------------------------------------------------------
  const palSel = $('c-palette');
  PALETTES.forEach((p, i) => {
    const o = document.createElement('option');
    o.value = String(i); o.textContent = p.name;
    palSel.appendChild(o);
  });

  const bind = (id, key, fmt, onChange) => {
    const el = $(id);
    const out = $(id.replace(/^c-/, 'o-'));
    const push = () => {
      const v = el.type === 'checkbox' ? el.checked
        : (el.tagName === 'SELECT' ? el.value : parseFloat(el.value));
      S[key] = v;
      if (out && fmt) out.textContent = fmt(v);
      if (onChange) onChange(v);
      save();
    };
    if (el.type === 'checkbox') el.checked = S[key];
    else el.value = S[key];
    el.addEventListener('input', push);
    push();
    return el;
  };

  const n1 = (v) => v.toFixed(1);
  const n2 = (v) => v.toFixed(2);
  const pct = (v) => Math.round(v * 100) + '%';

  bind('c-tube', 'tube', null, syncRows);
  bind('c-seg', 'sectors', (v) => String(v), syncRows);
  bind('c-zoom', 'zoom', (v) => n2(v) + '×');
  bind('c-roll', 'rollRate', (v) => n2(v) + ' rad/s');
  bind('c-refl', 'reflect', (v) => (v * 100).toFixed(1) + '%');
  bind('c-aberr', 'aberration', (v) => (v * 1000).toFixed(1) + '‰');
  bind('c-seam', 'seam', pct);
  bind('c-eyepiece', 'eyepiece');
  bind('c-palette', 'palette', null, (v) => cell.setPalette(parseInt(v, 10)));
  bind('c-count', 'count', (v) => String(v), (v) => setCount(v));
  bind('c-alpha', 'alpha', n2, (v) => cell.setDensity(v));
  bind('c-size', 'size', n2, (v) => cell.setSize(v));
  bind('c-grav', 'gravity', n2);
  bind('c-agit', 'agitation', pct);
  bind('c-scale', 'scale', (v) => n2(v) + '×');
  bind('c-cellres', 'cellIdx', (v) => CELL_SIZES[v] + '²', (v) => renderer.setCellResolution(CELL_SIZES[v]));
  bind('c-auto', 'auto', null, syncRows);
  bind('c-target', 'target', (v) => String(v));
  bind('c-glint', 'glints');
  bind('c-pause', 'paused');

  function setCount(v) {
    const n = v | 0;
    if (n < cell.count) { cell.count = n; cell.styleDirty = true; }
    else cell.setCount(n);
  }

  function syncRows() {
    $('row-seg').classList.toggle('disabled', S.tube !== 'rosette');
    $('row-target').classList.toggle('disabled', !S.auto);
    $('m-tube').textContent = S.tube === 'rosette'
      ? `V ×${S.sectors}` : TUBES[S.tube].tri.angles.join('·');
  }
  syncRows();

  $('b-shake').addEventListener('click', () => cell.shake(2.2));
  $('b-refill').addEventListener('click', () => cell.refill());

  // ---- input --------------------------------------------------------------
  let downAt = 0, moved = 0;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    view.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    view.dragging = true;
    canvas.classList.add('dragging');
    downAt = performance.now();
    moved = 0;
    view.pinch = 0;
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = view.pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    moved += Math.abs(dx) + Math.abs(dy);
    if (view.pointers.size === 1) {
      view.roll += dx * 0.006;
    } else if (view.pointers.size === 2) {
      const [a, b] = [...view.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (view.pinch) setZoom(S.zoom * (view.pinch / d));
      view.pinch = d;
    }
  });
  const release = (e) => {
    if (!view.pointers.has(e.pointerId)) return;
    view.pointers.delete(e.pointerId);
    if (view.pointers.size === 0) {
      view.dragging = false;
      canvas.classList.remove('dragging');
      if (moved < 6 && performance.now() - downAt < 350) cell.shake(2.2);
    }
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    setZoom(S.zoom * Math.exp(e.deltaY * 0.0012));
  }, { passive: false });

  function setZoom(z) {
    S.zoom = Math.min(3, Math.max(0.15, z));
    $('c-zoom').value = S.zoom;
    $('o-zoom').textContent = n2(S.zoom);
    save();
  }

  const tubeKeys = ['rosette', '333', '236', '244'];
  addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    const k = e.key.toLowerCase();
    if (k === ' ') { e.preventDefault(); cell.shake(2.4); }
    else if (k === 'h') document.body.classList.toggle('chrome-off');
    else if (k === 'p') { $('c-pause').checked = !$('c-pause').checked; $('c-pause').dispatchEvent(new Event('input')); }
    else if (k === 'r') cell.refill();
    else if (k === 'f') {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen?.();
    } else if (k >= '1' && k <= '4') {
      $('c-tube').value = tubeKeys[+k - 1];
      $('c-tube').dispatchEvent(new Event('input'));
    }
  });

  // ---- persistence --------------------------------------------------------
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (_) { /* private mode */ }
    }, 400);
  }
  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      for (const k of Object.keys(S)) if (k in saved) S[k] = saved[k];
    } catch (_) { /* ignore a corrupt or unreadable store */ }
  }

  // ---- sparkline ----------------------------------------------------------
  const spark = $('spark');
  const sctx = spark.getContext('2d');
  const history = new Float32Array(spark.width);
  let hIdx = 0;

  function drawSpark(budgetMs) {
    const w = spark.width, h = spark.height;
    sctx.clearRect(0, 0, w, h);
    sctx.fillStyle = '#151515';
    sctx.fillRect(0, 0, w, h);
    // The budget line is the frame time the current target allows.
    const top = Math.max(budgetMs * 2.2, 8);
    sctx.strokeStyle = '#2A2A2A';
    sctx.beginPath();
    const by = h - (budgetMs / top) * h;
    sctx.moveTo(0, by); sctx.lineTo(w, by); sctx.stroke();
    sctx.beginPath();
    for (let i = 0; i < w; i++) {
      const v = history[(hIdx + i) % w];
      const y = h - Math.min(1, v / top) * h;
      if (i === 0) sctx.moveTo(i, y); else sctx.lineTo(i, y);
    }
    sctx.strokeStyle = '#4A9EFF';
    sctx.lineWidth = 1;
    sctx.stroke();
  }

  // ---- frame loop ---------------------------------------------------------
  const backWarm = new Float32Array([1.0, 0.98, 0.94]);
  const backCool = new Float32Array([0.16, 0.18, 0.24]);
  const noTri = new Float32Array(6);
  const simOpts = { gravity: 0, roll: 0, rollRate: 0, agitation: 0 };
  const tubeOpts = {
    zoom: 1, roll: 0, mode: 0, sectors: 8, origins: noTri, normals: noTri,
    triScale: 1, reflect: 1, aberration: 0, seam: 0, aperture: 0, vignette: 0.35,
  };
  const cellOpts = { warm: backWarm, cool: backCool, glints: true };

  let last = performance.now();
  let booted = false;

  function frame(now) {
    requestAnimationFrame(frame);
    const dtMs = Math.min(now - last, 100);
    last = now;
    const dt = dtMs / 1000;

    perf.frames[perf.n++ % perf.frames.length] = dtMs;
    history[hIdx] = dtMs;
    hIdx = (hIdx + 1) % history.length;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.resize(canvas.clientWidth, canvas.clientHeight, dpr * S.scale);

    if (!view.dragging) view.roll += S.rollRate * dt;

    let substeps = 0;
    const t0 = performance.now();
    if (!S.paused) {
      simOpts.gravity = S.gravity * 4.0;
      simOpts.roll = view.roll;
      simOpts.rollRate = view.dragging ? 0 : S.rollRate;
      simOpts.agitation = S.agitation;
      substeps = cell.update(dt, simOpts);
    }
    const simMs = performance.now() - t0;
    perf.simMs += (simMs - perf.simMs) * 0.05;

    renderer.beginTiming();
    renderer.uploadCell(cell);
    cellOpts.glints = S.glints;
    renderer.drawCell(cell, cellOpts);

    const tube = TUBES[S.tube];
    tubeOpts.zoom = S.zoom;
    tubeOpts.roll = view.roll;
    tubeOpts.mode = tube.mode;
    tubeOpts.sectors = S.sectors;
    tubeOpts.origins = tube.tri ? tube.tri.origins : noTri;
    tubeOpts.normals = tube.tri ? tube.tri.normals : noTri;
    tubeOpts.triScale = tube.tri ? tube.tri.scale : 1;
    tubeOpts.reflect = S.reflect;
    tubeOpts.aberration = S.aberration;
    tubeOpts.seam = S.seam;
    tubeOpts.aperture = S.eyepiece ? 1 : 0;
    renderer.drawTube(tubeOpts);
    renderer.endTiming();

    if (!booted) { booted = true; $('boot').classList.add('gone'); }

    if (now - perf.lastHud > 100) { updateHud(now, substeps); perf.lastHud = now; }
    if (S.auto && now - perf.lastAdapt > 500) { adapt(); perf.lastAdapt = now; }
  }

  const stats = { fps: 0, mean: 0, low: 0 };
  function recentStats() {
    const buf = perf.frames;
    const have = Math.min(perf.n, buf.length);
    if (have < 8) { stats.fps = 0; stats.mean = 0; stats.low = 0; return stats; }
    const take = Math.min(have, perf.scratch.length);
    const startIdx = perf.n - take;
    const tmp = perf.scratch;
    let sum = 0;
    for (let i = 0; i < take; i++) {
      const v = buf[(startIdx + i) % buf.length];
      tmp[i] = v; sum += v;
    }
    // 99th-percentile frame time — the stutters, which a mean hides entirely.
    // Sorted in place in the scratch buffer; the sum is already taken.
    const slice = tmp.subarray(0, take);
    slice.sort();
    stats.mean = sum / take;
    stats.fps = 1000 / stats.mean;
    stats.low = 1000 / slice[Math.min(take - 1, Math.floor(take * 0.99))];
    return stats;
  }

  function updateHud(now, substeps) {
    const st = recentStats();
    perf.fps = st.fps;
    const fpsEl = $('fps');
    fpsEl.textContent = st.fps ? Math.round(st.fps) : '—';
    fpsEl.className = st.fps >= S.target * 0.92 ? 'is-good'
      : (st.fps >= S.target * 0.6 ? 'is-warn' : 'is-bad');
    $('m-frame').textContent = st.mean.toFixed(2) + ' ms';
    $('m-low').textContent = st.low ? Math.round(st.low) + ' fps' : '—';
    $('m-gpu').textContent = renderer.gpuMs == null ? 'n/a' : renderer.gpuMs.toFixed(2) + ' ms';
    $('m-sim').textContent = perf.simMs.toFixed(2) + ' ms /' + substeps;
    $('m-res').textContent = `${canvas.width}×${canvas.height} · ${renderer.cellRes}²`;
    $('m-shards').textContent = String(cell.count);
    drawSpark(1000 / S.target);
  }

  // Adaptive render scale. It moves in small steps and only on a sustained
  // miss, because a scale that chases every dip is more distracting than the
  // dip: the resolution visibly breathes.
  function adapt() {
    const fps = perf.fps;
    if (!fps) return;
    if (fps < S.target * 0.9 && S.scale > 0.4) applyScale(Math.max(0.4, S.scale - 0.1));
    else if (fps > S.target * 1.12 && S.scale < 2) applyScale(Math.min(2, S.scale + 0.05));
  }
  function applyScale(v) {
    S.scale = Math.round(v * 100) / 100;
    $('c-scale').value = S.scale;
    $('o-scale').textContent = n2(S.scale) + '×';
  }

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    $('boot').classList.remove('gone');
    $('boot-msg').textContent = 'WebGL context lost — reload the page.';
  });

  $('build-tag').textContent = build;
  requestAnimationFrame(frame);
}
