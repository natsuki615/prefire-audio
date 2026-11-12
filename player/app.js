// PREFIRE spectral player: each tick reads one 63-channel radiance spectrum and plays it.

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- data

let track = null;
let scene = 0;
let frame = 0;
let anomalyBase = null; // trailing moving average per scene, built lazily

function normalizeTrack(raw) {
  const t = { ...raw };
  if (raw.radiance_u8_b64) {
    const bin = atob(raw.radiance_u8_b64);
    t.q8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) t.q8[i] = bin.charCodeAt(i);
  }
  t.wl = raw.wavelength_um.map((w, c) => w ?? 0.84 * (c + 1));
  t.maxHi = raw.hi.map((row) => Math.max(...row.filter((v) => v != null)));
  t.windowChannels = t.wl.map((w, c) => c).filter((c) => t.wl[c] >= 10 && t.wl[c] <= 12);
  return t;
}

function q(i, c) {
  return track.q8[(i * track.n_scenes + scene) * track.n_channels + c];
}

function physical(i, c) {
  const v = q(i, c);
  if (v === MISSING) return NaN;
  const lo = track.lo[scene][c], hi = track.hi[scene][c];
  return lo + (v / 254) * (hi - lo);
}

// NASA's per-detector confidence (detector_quality_flag): 0 good, 1 low confidence, 2 masked.
// Absent from older track files, where every channel counts as good.
const LOW_CONF_REASONS = { 1: "extreme noise", 2: "greater noise", 3: "stray light", 4: "thermal drift", 5: "filter edge" };

function lowConfidence(c) {
  return track.detector_quality?.[scene]?.[c] === 1;
}

function confidenceReason(c) {
  const bits = track.detector_bitflags?.[scene]?.[c] ?? 0;
  return Object.entries(LOW_CONF_REASONS).filter(([b]) => (bits >> b) & 1).map(([, why]) => why).join(", ");
}

// loudness and opacity for low-confidence channels, set by the "Low-confidence channels" control
const LOW_CONF_GAIN = { quiet: 0.35, full: 1, mute: 0 };
const LOW_CONF_ALPHA = { quiet: 0.4, full: 1, mute: 0.15 };
const confidenceGain = (c) => (lowConfidence(c) ? LOW_CONF_GAIN[$("lowConf").value] : 1);
const confidenceAlpha = (c) => (lowConfidence(c) ? LOW_CONF_ALPHA[$("lowConf").value] : 1);

function buildAnomalyBase() {
  const { n_frames: N, n_channels: C } = track;
  const W = 30;
  const base = new Float32Array(N * C);
  for (let c = 0; c < C; c++) {
    let sum = 0, n = 0;
    const hist = [];
    for (let i = 0; i < N; i++) {
      const v = q(i, c);
      base[i * C + c] = n ? sum / n : v / 254;
      if (v !== MISSING) { hist.push(v / 254); sum += v / 254; n++; }
      else hist.push(null);
      if (hist.length > W) {
        const old = hist.shift();
        if (old != null) { sum -= old; n--; }
      }
    }
  }
  return base;
}

// one tick: 63 values in 0..1, NaN where the channel is masked or flagged bad
function frameValues(i, norm) {
  const C = track.n_channels;
  const out = new Float32Array(C);
  for (let c = 0; c < C; c++) {
    const v = q(i, c);
    if (v === MISSING) { out[c] = NaN; continue; }
    if (norm === "relative") out[c] = v / 254;
    else if (norm === "spectrum") out[c] = Math.pow(clamp01(physical(i, c) / track.maxHi[scene]), 0.6);
    else {
      anomalyBase ??= buildAnomalyBase();
      out[c] = clamp01(0.5 + (v / 254 - anomalyBase[i * C + c]) * 2.5);
    }
  }
  return out;
}

function windowBT(i) {
  let sum = 0, n = 0;
  for (const c of track.windowChannels) {
    const T = brightnessTemp(track.wl[c], physical(i, c));
    if (Number.isFinite(T)) { sum += T; n++; }
  }
  return n ? sum / n : NaN;
}

// ---------------------------------------------------------------- audio

let ctx = null, bus = null, master = null;
let voices = [];      // [{osc, gain, c}]
let prevVals = null;

function initAudio() {
  ctx = new AudioContext();
  master = ctx.createGain();
  master.gain.value = $("vol").value / 100;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.ratio.value = 4;
  bus = ctx.createGain();

  // short generated reverb tail so the sine cloud reads as a space rather than a test tone
  const len = ctx.sampleRate * 2.5;
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
  }
  const verb = ctx.createConvolver();
  verb.buffer = ir;
  const wet = ctx.createGain();
  wet.gain.value = 0.3;

  bus.connect(comp);
  bus.connect(verb).connect(wet).connect(comp);
  comp.connect(master).connect(ctx.destination);
  buildVoices();
}

function chorusFreq(c) {
  return chorusPitch(track.wl[c], track.wl, +$("fLow").value, +$("fHigh").value);
}

function harmonicNumber(c) {
  // longest wavelength = fundamental, each step toward shorter wavelength is the next partial
  return track.n_channels - c;
}

function harmonicRoot(i) {
  const bt = windowBT(i);
  return 41.2 * 2 ** (clamp01(((Number.isFinite(bt) ? bt : 260) - 210) / 100) * 1.5); // E1..~A#2
}

const PENTA = [0, 2, 4, 7, 9];
function pluckFreq(c) {
  const degree = Math.floor(((track.n_channels - 1 - c) / track.n_channels) * 20); // 4 octaves
  return 110 * 2 ** ((Math.floor(degree / 5) * 12 + PENTA[degree % 5]) / 12);
}

function buildVoices() {
  if (!ctx) return;
  for (const v of voices) { v.osc.stop(); v.osc.disconnect(); }
  voices = [];
  prevVals = null;
  const mode = $("mode").value;
  if (mode === "pluck") {
    const osc = ctx.createOscillator(), gain = ctx.createGain();   // low drone follows window BT
    osc.type = "triangle";
    gain.gain.value = 0;
    osc.connect(gain).connect(bus);
    osc.start();
    voices.push({ osc, gain, c: -1 });
    return;
  }
  for (let c = 0; c < track.n_channels; c++) {
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = mode === "chorus" ? chorusFreq(c) : harmonicRoot(frame) * harmonicNumber(c);
    gain.gain.value = 0;
    osc.connect(gain).connect(bus);
    osc.start();
    voices.push({ osc, gain, c });
  }
}

function pluck(freq, vel, type, when) {
  const osc = ctx.createOscillator(), g = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(vel, when + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, when + 1.4);
  osc.connect(g).connect(bus);
  osc.start(when);
  osc.stop(when + 1.5);
}

function sonify(i, vals) {
  if (!ctx || ctx.state !== "running") return;
  const now = ctx.currentTime;
  const tau = 0.35 / +$("rate").value;
  const mode = $("mode").value;

  if (mode === "pluck") {
    const drone = voices[0];
    drone.osc.frequency.setTargetAtTime(harmonicRoot(i), now, 0.3);
    drone.gain.gain.setTargetAtTime(0.08, now, 0.3);
    if (prevVals) {
      const deltas = [];
      for (let c = 0; c < vals.length; c++) {
        const d = vals[c] - prevVals[c];
        const w = confidenceGain(c);
        if (Number.isFinite(d) && Math.abs(d) > 0.04 && w > 0) deltas.push({ c, d, w });
      }
      deltas.sort((a, b) => Math.abs(b.d) * b.w - Math.abs(a.d) * a.w); // low-confidence changes rank lower
      for (const { c, d, w } of deltas.slice(0, 6)) {
        const vel = Math.min(0.35, Math.abs(d) * 1.5) * w;
        if (d > 0) pluck(pluckFreq(c), vel, "sine", now);            // warming: bright pluck
        else pluck(pluckFreq(c) / 2, vel * 0.8, "triangle", now);    // cooling: an octave down
      }
    }
    prevVals = vals;
    return;
  }

  const scale = 0.55 / Math.sqrt(track.n_channels);
  const root = mode === "harmonic" ? harmonicRoot(i) : 0;
  for (const v of voices) {
    const x = vals[v.c];
    let g = Number.isFinite(x) ? x * x * scale * confidenceGain(v.c) : 0;
    if (mode === "harmonic") {
      const n = harmonicNumber(v.c);
      g *= 1.6 / Math.sqrt(n);
      v.osc.frequency.setTargetAtTime(root * n, now, tau * 2);
    }
    v.gain.gain.setTargetAtTime(g, now, tau);
  }
}

// ---------------------------------------------------------------- visuals

const INFERNO = ["#000004", "#1b0c41", "#4a0c6b", "#781c6d", "#a52c60", "#cf4446", "#ed6925", "#fb9b06", "#fcffa4"];
const COOLWARM = ["#3b4cc0", "#7b9ff9", "#c0d4f5", "#f2cbb7", "#ee8468", "#b40426"];

function makeLut(stops) {
  const rgb = stops.map((h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16)));
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * (rgb.length - 1), k = Math.min(rgb.length - 2, Math.floor(x)), f = x - k;
    for (let j = 0; j < 3; j++) lut[i * 3 + j] = rgb[k][j] + (rgb[k + 1][j] - rgb[k][j]) * f;
  }
  return lut;
}
const LUT = makeLut(INFERNO);
const BT_LUT = makeLut(COOLWARM);
const lutColor = (lut, x) => {
  const k = Math.round(clamp01(x) * 255) * 3;
  return `rgb(${lut[k]},${lut[k + 1]},${lut[k + 2]})`;
};

function fitCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = cv.getBoundingClientRect();
  if (cv.width !== Math.round(width * dpr) || cv.height !== Math.round(height * dpr)) {
    cv.width = Math.round(width * dpr);
    cv.height = Math.round(height * dpr);
  }
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w: width, h: height };
}

const BANDS = [
  { from: 5.5, to: 7.5, label: "H₂O" },
  { from: 8, to: 12.5, label: "window" },
  { from: 9.3, to: 9.9, label: "O₃" },
  { from: 13.5, to: 17, label: "CO₂" },
  { from: 17, to: 60, label: "far-IR" },
];

function wlToX(wl, w) {
  const a = track.wl[0], b = track.wl[track.n_channels - 1];
  return ((wl - a) / (b - a)) * w;
}

function drawSpectrum(vals) {
  const { g, w, h } = fitCanvas($("spectrum"));
  const C = track.n_channels, pad = 18, bh = h - pad - 14;
  g.clearRect(0, 0, w, h);

  g.font = "10px -apple-system, sans-serif";
  for (const b of BANDS) {
    const x0 = Math.max(0, wlToX(b.from, w)), x1 = Math.min(w, wlToX(b.to, w));
    if (x1 <= x0) continue;
    g.fillStyle = b.label === "O₃" ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.03)";
    g.fillRect(x0, pad, x1 - x0, bh);
    g.fillStyle = "#8a8d98";
    g.fillText(b.label, x0 + 3, b.label === "O₃" ? pad + 11 : pad - 5);
  }

  const cw = w / C;
  for (let c = 0; c < C; c++) {
    const v = vals[c];
    if (!Number.isFinite(v)) {
      g.fillStyle = "#1d1f26";
      g.fillRect(c * cw + 1, pad, cw - 2, bh);
      continue;
    }
    g.globalAlpha = confidenceAlpha(c);
    g.fillStyle = lutColor(LUT, 0.15 + v * 0.85);
    g.fillRect(c * cw + 1, pad + bh * (1 - v), cw - 2, bh * v);
    g.globalAlpha = 1;
  }

  if (track.detector_quality && $("lowConf").value !== "full") {
    g.fillStyle = "#8a8d98";
    g.textAlign = "right";
    g.fillText("faded = low-confidence calibration (NASA flag)", w - 6, pad - 5);
    g.textAlign = "left";
  }

  g.fillStyle = "#8a8d98";
  for (const tick of [5, 10, 15, 20, 30, 40, 50]) {
    const x = wlToX(tick, w);
    if (x > 0 && x < w - 20) g.fillText(`${tick} µm`, x - 10, h - 3);
  }
}

const cascadeImg = { cv: document.createElement("canvas"), rows: 0 };
const ROW_PX = 3;

function drawCascade(norm) {
  const { g, w, h } = fitCanvas($("cascade"));
  const C = track.n_channels, rows = Math.ceil(h / ROW_PX);
  const off = cascadeImg.cv;
  if (off.width !== C || off.height !== rows) { off.width = C; off.height = rows; }
  const og = off.getContext("2d");
  const img = og.createImageData(C, rows);
  const alpha = Array.from({ length: C }, (_, c) => confidenceAlpha(c));
  for (let r = 0; r < rows; r++) {
    const i = frame - r;
    if (i < 0) break;
    const vals = frameValues(i, norm);
    for (let c = 0; c < C; c++) {
      const p = (r * C + c) * 4, v = vals[c];
      if (Number.isFinite(v)) {
        // low-confidence columns are blended toward the background so they read as faded
        const k = Math.round(v * 255) * 3, a = alpha[c];
        img.data[p] = 21 + (LUT[k] - 21) * a; img.data[p + 1] = 22 + (LUT[k + 1] - 22) * a; img.data[p + 2] = 26 + (LUT[k + 2] - 26) * a;
      } else {
        img.data[p] = 21; img.data[p + 1] = 22; img.data[p + 2] = 26;
      }
      img.data[p + 3] = 255;
    }
  }
  og.putImageData(img, 0, 0);
  g.imageSmoothingEnabled = false;
  g.clearRect(0, 0, w, h);
  g.drawImage(off, 0, 0, C, rows, 0, 0, w, rows * ROW_PX);
}

let mapBase = null; // cached ground track for the current scene

function drawMap() {
  const { g, w, h } = fitCanvas($("map"));
  const px = (lon) => ((lon + 180) / 360) * w, py = (lat) => ((90 - lat) / 180) * h;

  if (!mapBase || mapBase.w !== w || mapBase.scene !== scene || mapBase.track !== track) {
    const cv = document.createElement("canvas");
    const dpr = window.devicePixelRatio || 1;
    cv.width = w * dpr; cv.height = h * dpr;
    const mg = cv.getContext("2d");
    mg.scale(dpr, dpr);
    mg.fillStyle = "#0e1016";
    mg.fillRect(0, 0, w, h);
    mg.strokeStyle = "#1e2129";
    for (let lon = -180; lon <= 180; lon += 30) { mg.beginPath(); mg.moveTo(px(lon), 0); mg.lineTo(px(lon), h); mg.stroke(); }
    for (let lat = -60; lat <= 60; lat += 30) { mg.beginPath(); mg.moveTo(0, py(lat)); mg.lineTo(w, py(lat)); mg.stroke(); }
    const step = Math.max(1, Math.floor(track.n_frames / 2500));
    for (let i = 0; i < track.n_frames; i += step) {
      const la = track.lat[i][scene], lo = track.lon[i][scene];
      if (la == null || lo == null) continue;
      const bt = windowBT(i);
      mg.fillStyle = Number.isFinite(bt) ? lutColor(BT_LUT, (bt - 210) / 100) : "#444";
      mg.fillRect(px(lo) - 1, py(la) - 1, 2.2, 2.2);
    }
    mapBase = { cv, w, scene, track };
  }

  g.clearRect(0, 0, w, h);
  g.drawImage(mapBase.cv, 0, 0, w, h);
  const la = track.lat[frame][scene], lo = track.lon[frame][scene];
  if (la != null && lo != null) {
    g.strokeStyle = "#fff";
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(px(lo), py(la), 6, 0, Math.PI * 2);
    g.stroke();
  }
  g.fillStyle = "#8a8d98";
  g.font = "10px -apple-system, sans-serif";
  g.fillText("ground track, colored by window BT (210–310 K)", 6, h - 6);
}

function updateReadouts() {
  const secs = track.frame_seconds[frame] ?? 0;
  const t = new Date(Date.parse(track.start_utc) + secs * 1000);
  $("rTime").textContent = t.toISOString().replace("T", " ").slice(0, 21);
  const la = track.lat[frame][scene], lo = track.lon[frame][scene];
  $("rPos").textContent = la == null ? "–" : `${la.toFixed(2)}°, ${lo.toFixed(2)}°`;
  const bt = windowBT(frame);
  $("rBT").textContent = Number.isFinite(bt) ? `${bt.toFixed(1)} K, ${(bt - 273.15).toFixed(1)} °C` : "–";
  const lf = track.land_fraction?.[frame]?.[scene];
  const sz = track.solar_zenith?.[frame]?.[scene];
  const surf = lf == null ? "" : lf > 0.5 ? "land" : "ocean";
  const light = sz == null ? "" : sz < 90 ? "day" : "night";
  $("rSurf").textContent = [surf, light].filter(Boolean).join(" , ") || "–";
  $("rFrame").textContent = `${frame + 1} / ${track.n_frames}`;
  const orbits = track.orbits ?? [{ start_frame: 0 }];
  const k = orbits.findLastIndex((o) => o.start_frame <= frame);
  const into = (secs - (track.frame_seconds[orbits[k].start_frame] ?? 0)) / 60;
  $("tOut").textContent = orbits.length > 1
    ? `orbit ${k + 1} / ${orbits.length} · ${into.toFixed(1)} min in`
    : `${into.toFixed(1)} min into orbit`;
  $("scrub").value = frame;
}

function render() {
  const norm = $("norm").value;
  const vals = frameValues(frame, norm);
  drawSpectrum(vals);
  drawCascade(norm);
  drawMap();
  updateReadouts();
  return vals;
}

// ---------------------------------------------------------------- transport

let playing = false, lastTick = 0;

function tick(now) {
  if (playing) {
    const period = 1000 / +$("rate").value;
    if (now - lastTick >= period) {
      lastTick = now - ((now - lastTick) % period);
      frame = (frame + 1) % track.n_frames;
      if (frame === 0) prevVals = null;
      sonify(frame, render());
    }
  }
  requestAnimationFrame(tick);
}

async function setPlaying(on) {
  if (!track) return;
  if (on && !ctx) initAudio();
  if (on && ctx.state === "suspended") await ctx.resume();
  playing = on;
  $("playBtn").textContent = on ? "❚❚" : "▶";
  $("playBtn").setAttribute("aria-label", on ? "Pause" : "Play");
  if (!on && ctx) for (const v of voices) v.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
}

function seek(i) {
  frame = Math.max(0, Math.min(track.n_frames - 1, i));
  prevVals = null;
  const vals = render();
  if (playing) sonify(frame, vals);
}

function loadTrack(raw) {
  track = normalizeTrack(raw);
  anomalyBase = null;
  mapBase = null;
  frame = 0;
  scene = Math.min(scene, track.n_scenes - 1);
  $("source").textContent = track.source;
  $("scene").innerHTML = Array.from({ length: track.n_scenes }, (_, s) =>
    `<option value="${s}">Scene ${s + 1}${s === 0 ? "(swath edge)" : s === track.n_scenes - 1 ? "(swath edge)" : ""}</option>`).join("");
  $("scene").value = scene;
  $("scrub").max = track.n_frames - 1;
  buildVoices();
  render();
}

function updatePitchLabel() {
  $("pitchOut").textContent = `${$("fLow").value}–${$("fHigh").value} Hz`;
}

$("playBtn").onclick = () => setPlaying(!playing);
$("scrub").oninput = (e) => seek(+e.target.value);
$("rate").oninput = (e) => { $("rateOut").textContent = e.target.value; };
$("vol").oninput = (e) => master && master.gain.setTargetAtTime(e.target.value / 100, ctx.currentTime, 0.05);
$("mode").onchange = () => buildVoices();
$("norm").onchange = () => { prevVals = null; render(); };
$("lowConf").onchange = () => render();
$("scene").onchange = (e) => { scene = +e.target.value; anomalyBase = null; prevVals = null; render(); };
for (const id of ["fLow", "fHigh"]) {
  $(id).oninput = () => {
    updatePitchLabel();
    if (ctx && $("mode").value === "chorus") voices.forEach((v) => v.osc.frequency.setTargetAtTime(chorusFreq(v.c), ctx.currentTime, 0.05));
  };
}

async function readFile(file) {
  try {
    loadTrack(JSON.parse(await file.text()));
  } catch (err) {
    $("source").textContent = `Could not read ${file.name}: ${err.message}`;
  }
}
$("fileInput").onchange = (e) => e.target.files[0] && readFile(e.target.files[0]);
document.addEventListener("dragover", (e) => { e.preventDefault(); document.body.classList.add("dragging"); });
document.addEventListener("dragleave", () => document.body.classList.remove("dragging"));
document.addEventListener("drop", (e) => {
  e.preventDefault();
  document.body.classList.remove("dragging");
  if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]);
});

document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "SELECT" || !track) return;
  if (e.code === "Space") { e.preventDefault(); setPlaying(!playing); }
  if (e.code === "ArrowRight") seek(frame + (e.shiftKey ? 50 : 1));
  if (e.code === "ArrowLeft") seek(frame - (e.shiftKey ? 50 : 1));
});

const cascadeEl = $("cascade");
cascadeEl.addEventListener("mousemove", (e) => {
  if (!track) return;
  const r = cascadeEl.getBoundingClientRect();
  const c = Math.floor(((e.clientX - r.left) / r.width) * track.n_channels);
  const i = frame - Math.floor((e.clientY - r.top) / ROW_PX);
  const tip = $("hover");
  if (i < 0 || c < 0 || c >= track.n_channels) { tip.hidden = true; return; }
  const L = physical(i, c);
  const bt = brightnessTemp(track.wl[c], L);
  tip.hidden = false;
  tip.innerHTML = `ch ${c + 1}, ${track.wl[c].toFixed(2)} µm<br>` +
    (Number.isFinite(L) ? `${L.toFixed(3)} W/(m² sr µm)<br>BT ${bt.toFixed(1)} K` : "masked / flagged") +
    (lowConfidence(c) ? `<br>⚠ low confidence: ${confidenceReason(c) || "NASA flag"}` : "") +
    `<br>${frame - i} ticks ago`;
  tip.style.left = `${Math.min(e.clientX - r.left + 12, r.width - 170)}px`;
  tip.style.top = `${e.clientY - r.top + 12}px`;
});
cascadeEl.addEventListener("mouseleave", () => { $("hover").hidden = true; });
window.addEventListener("resize", () => { mapBase = null; track && render(); });

// load the exported orbits; the path is relative to index.html in the project root (served over http)
updatePitchLabel();
fetch("player/data/track.json")
  .then((r) => (r.ok ? r.json() : Promise.reject()))
  .then(loadTrack)
  .catch(() => {
    $("source").textContent = "No data loaded: run prepare_data.py to create player/data/track.json, serve the project folder, or use Load track.json";
  });
requestAnimationFrame(tick);
