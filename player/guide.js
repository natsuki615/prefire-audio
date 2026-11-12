// "What am I hearing?" explainer: example spectra from the demo model, each playable.

const $ = (id) => document.getElementById(id);
const INK = { primary: "#e6e6ea", secondary: "#c3c2b7", muted: "#8a8d98", grid: "#24262d", axis: "#383835", surface: "#13151b" };
const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500"]; // validated dark categorical slots 1–4
const INFERNO = ["#000004", "#1b0c41", "#4a0c6b", "#781c6d", "#a52c60", "#cf4446", "#ed6925", "#fb9b06", "#fcffa4"];

const track = demoTrack();
const WL = DEMO_WL;
const C = WL.length;
const lo = track.lo[0], hi = track.hi[0];

// relative loudness, exactly as the player's default "Relative" mode hears it
const relative = (L) => L.map((x, c) => (Number.isFinite(x) ? clamp01((x - lo[c]) / (hi[c] - lo[c])) : NaN));
const toBT = (L) => L.map((x, c) => brightnessTemp(WL[c], x));
const pitch = (c) => chorusPitch(WL[c], WL);

const BANDS = [
  { key: "sun", from: 0, to: 4.5, short: "Sun", name: "Sunlight", sees: "Reflected sunlight, not heat. Only active in daytime, brightest over clouds and ice." },
  { key: "h2o", from: 5.5, to: 7.6, short: "H₂O", name: "Water vapour (6.3 µm)", sees: "Blocked by water vapour, so it sees the middle of the atmosphere (cold)." },
  { key: "win", from: 8, to: 12.5, short: "Window", name: "Window (8–12 µm)", sees: "Air is nearly transparent here, so these channels see the ground or cloud tops. Biggest swings." },
  { key: "co2", from: 13.5, to: 17, short: "CO₂", name: "CO₂ (15 µm)", sees: "Blocked by CO₂, so it sees the cold upper atmosphere. Mostly ignores clouds and ground; it drifts slowly with latitude." },
  { key: "fir", from: 17, to: 54, short: "Far-infrared", name: "Far-infrared (>17 µm)", sees: "Water vapour's rotation band. Humid air hides the ground; dry polar air lets it through. PREFIRE's main target." },
];
const bandOf = (w) => BANDS.find((b) => w >= b.from && w < b.to) ?? null;

const PLACES = [
  { name: "Tropical ocean, clear", scene: { lat: 5, day: true }, note: "Warm, humid. Loud window, deep CO₂ notch, far-IR held back by water vapour." },
  { name: "Thunderstorm top", scene: { lat: 5, day: true, cloud: 1, cloudTop: 212 }, note: "The cloud top is ~60 K colder than the sea, so the window channels collapse. Far-IR barely notices: it was already looking at humid air above the cloud." },
  { name: "Sahara at noon", scene: { lat: 23, land: 1, day: true }, note: "The hottest ground of the four. The window channels are at their loudest." },
  { name: "Arctic sea ice, night", scene: { lat: 80, ice: true, land: 1, day: false }, note: "Everything is cold and quiet. But the window and far-IR now read within ~10 K of each other (vs ~30 K in the tropics), because dry air hides little." },
].map((p, i) => ({ ...p, color: SERIES[i], L: sceneRadiance(p.scene) }));

// ---------------------------------------------------------------- audio

let actx = null, out = null;

function playSpectrum(vals, seconds = 2.4) {
  actx ??= new AudioContext();
  if (!out) {
    const comp = actx.createDynamicsCompressor();
    comp.threshold.value = -18;
    out = actx.createGain();
    out.gain.value = 0.7;
    out.connect(comp).connect(actx.destination);
  }
  actx.resume();
  const now = actx.currentTime, scale = 0.55 / Math.sqrt(C);
  vals.forEach((v, c) => {
    if (!Number.isFinite(v) || v < 0.02) return;
    const osc = actx.createOscillator(), g = actx.createGain();
    osc.frequency.value = pitch(c);
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(v * v * scale, now + 0.15);
    g.gain.setTargetAtTime(0, now + seconds - 0.5, 0.18);
    osc.connect(g).connect(out);
    osc.start(now);
    osc.stop(now + seconds + 0.6);
  });
}

// ---------------------------------------------------------------- svg helpers

const lin = (d0, d1, r0, r1) => (v) => r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);

function linePath(xs, ys) {
  let d = "", pen = false;
  xs.forEach((x, i) => {
    if (!Number.isFinite(ys[i])) { pen = false; return; }
    d += `${pen ? "L" : "M"}${x.toFixed(1)},${ys[i].toFixed(1)}`;
    pen = true;
  });
  return d;
}

function tooltip(chartEl) {
  let tip = chartEl.querySelector(".tip");
  if (!tip) { tip = document.createElement("div"); tip.className = "tip"; tip.hidden = true; chartEl.append(tip); }
  return {
    show(html, x, y) {
      tip.innerHTML = html;
      tip.hidden = false;
      const w = tip.offsetWidth, maxX = chartEl.clientWidth - w - 6;
      tip.style.left = `${Math.max(6, Math.min(x + 14, maxX))}px`;
      tip.style.top = `${y + 14}px`;
    },
    hide() { tip.hidden = true; },
  };
}

// ---------------------------------------------------------------- spectrum charts (sections 1 + 2)

function spectrumChart(el, series, { height = 300, labelBands = true, surface = null } = {}) {
  const svg = el.querySelector("svg");
  const W = svg.clientWidth || el.clientWidth - 28, H = height;
  const m = { l: 52, r: series.length > 1 ? 150 : 16, t: labelBands ? 22 : 8, b: 46 };
  const bts = series.map((s) => toBT(s.L));
  const all = bts.flat().filter(Number.isFinite);
  const yMin = Math.floor(Math.min(...all) / 20) * 20, yMax = Math.ceil(Math.max(...all) / 20) * 20;
  const x = lin(0, 54, m.l, W - m.r), y = lin(yMin, yMax, H - m.b, m.t);
  const xs = WL.map(x);

  let s = "";
  for (const b of BANDS) {
    const x0 = x(Math.max(b.from, WL[2])), x1 = x(b.to);
    s += `<rect x="${x0}" y="${m.t}" width="${x1 - x0}" height="${H - m.b - m.t}" fill="#fff" opacity="${b.key === "win" ? 0.05 : 0.025}"/>`;
    if (labelBands) s += `<text x="${x0 + 3}" y="${m.t - 8}" fill="${INK.muted}" font-size="11">${b.short}</text>`;
  }
  for (let t = yMin; t <= yMax; t += 20) {
    s += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}" stroke="${INK.grid}"/>`;
    s += `<text x="${m.l - 8}" y="${y(t) + 4}" fill="${INK.muted}" font-size="11" text-anchor="end">${t}${t === yMax ? " K" : ""}</text>`;
  }
  if (surface) {
    s += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(surface.T)}" y2="${y(surface.T)}" stroke="${INK.secondary}" opacity="0.6"/>`;
    s += `<text x="${W - m.r - 4}" y="${y(surface.T) - 6}" fill="${INK.secondary}" font-size="11" text-anchor="end">${surface.label} ≈ ${Math.round(surface.T)} K · anything below this line is seeing colder air above it</text>`;
  }
  s += `<line x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}" stroke="${INK.axis}"/>`;
  for (const t of [5, 10, 15, 20, 30, 40, 50]) {
    const c = WL.findIndex((w) => w >= t);
    s += `<text x="${x(t)}" y="${H - m.b + 16}" fill="${INK.muted}" font-size="11" text-anchor="middle">${t} µm</text>`;
    s += `<text x="${x(t)}" y="${H - m.b + 32}" fill="${INK.muted}" font-size="10" text-anchor="middle" opacity="0.8">${Math.round(pitch(c))} Hz</text>`;
  }
  s += `<text x="${m.l}" y="${H - 2}" fill="${INK.muted}" font-size="10">wavelength · and the pitch it plays in chorus mode</text>`;

  bts.forEach((bt, i) => {
    s += `<path d="${linePath(xs, bt.map(y))}" fill="none" stroke="${series[i].color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  });

  if (series.length > 1) {
    // direct end labels, nudged apart so they never overlap
    const ends = bts.map((bt, i) => ({ i, y: y(bt[C - 1]) })).sort((a, b) => a.y - b.y);
    for (let k = 1; k < ends.length; k++) ends[k].y = Math.max(ends[k].y, ends[k - 1].y + 14);
    for (const e of ends) {
      s += `<text x="${x(54) + 8}" y="${e.y + 4}" fill="${INK.secondary}" font-size="11">${series[e.i].name}</text>`;
    }
  }
  s += `<g class="hover"></g><rect class="hit" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.b - m.t}" fill="transparent"/>`;

  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("height", H);
  svg.innerHTML = s;

  const tip = tooltip(el), hover = svg.querySelector(".hover");
  const hit = svg.querySelector(".hit");
  hit.onmousemove = (e) => {
    const r = svg.getBoundingClientRect();
    const px = e.clientX - r.left;
    let c = 0;
    xs.forEach((xx, k) => { if (Math.abs(xx - px) < Math.abs(xs[c] - px)) c = k; });
    const band = bandOf(WL[c]);
    let g = `<line x1="${xs[c]}" x2="${xs[c]}" y1="${m.t}" y2="${H - m.b}" stroke="${INK.muted}"/>`;
    let rows = "";
    bts.forEach((bt, i) => {
      if (!Number.isFinite(bt[c])) return;
      g += `<circle cx="${xs[c]}" cy="${y(bt[c])}" r="4" fill="${series[i].color}" stroke="${INK.surface}" stroke-width="2"/>`;
      rows += `<div class="row"><span class="swatch" style="background:${series[i].color}"></span>${series.length > 1 ? series[i].name : "sees"}<span class="num">${bt[c].toFixed(0)} K</span></div>`;
    });
    hover.innerHTML = g;
    tip.show(
      `<b>Channel ${c + 1}</b> · ${WL[c].toFixed(1)} µm · ${Math.round(pitch(c))} Hz` +
      `<div class="k">${band ? band.name : "between bands"}</div>` +
      (rows || `<div class="k">masked detector, silent</div>`),
      e.clientX - el.getBoundingClientRect().left, e.clientY - el.getBoundingClientRect().top);
  };
  hit.onmouseleave = () => { hover.innerHTML = ""; tip.hide(); };
}

function bandCards() {
  const tropics = toBT(PLACES[0].L);
  $("bandCards").innerHTML = BANDS.map((b) => {
    const cs = WL.map((w, c) => c).filter((c) => WL[c] >= b.from && WL[c] < b.to && Number.isFinite(tropics[c]));
    const hz = cs.map(pitch);
    const bt = cs.map((c) => tropics[c]);
    return `<div class="panel card"><h4>${b.name}</h4><p>${b.sees}</p>
      <div class="hz">${cs.length} channels · ${Math.round(Math.min(...hz))}–${Math.round(Math.max(...hz))} Hz · sees ${Math.round(Math.min(...bt))}–${Math.round(Math.max(...bt))} K here</div></div>`;
  }).join("");
}

function placesExtras() {
  $("placesLegend").innerHTML = PLACES.map((p, i) =>
    `<button data-i="${i}"><span class="swatch" style="background:${p.color}"></span>${p.name}<span class="play-mini">▶</span></button>`).join("");
  $("placesLegend").onclick = (e) => {
    const b = e.target.closest("button");
    if (b) playSpectrum(relative(PLACES[+b.dataset.i].L));
  };
  $("placeCards").innerHTML = PLACES.map((p, i) =>
    `<div class="panel card"><h4><span class="swatch" style="background:${p.color}"></span>${p.name}</h4><p>${p.note}</p></div>`).join("");

  const picks = [3, 6, 10, 15, 25, 40].map((t) => WL.findIndex((w) => w >= t));
  const bts = PLACES.map((p) => toBT(p.L));
  $("placesTable").innerHTML =
    `<tr><th>Scene</th>${picks.map((c) => `<th>${WL[c].toFixed(1)} µm</th>`).join("")}</tr>` +
    PLACES.map((p, i) => `<tr><td>${p.name}</td>${picks.map((c) => `<td>${bts[i][c].toFixed(0)} K</td>`).join("")}</tr>`).join("");
}

// ---------------------------------------------------------------- pitch strip (section 3)

function pitchChart() {
  const el = $("pitchChart"), svg = el.querySelector("svg");
  const W = svg.clientWidth || el.clientWidth - 28;
  const rows = BANDS.length, rowH = 26, m = { l: 150, r: 16, t: 10, b: 30 }, H = m.t + rows * rowH + m.b;
  const fx = (f) => m.l + (Math.log(f / 80) / Math.log(2600 / 80)) * (W - m.l - m.r);
  let s = "";
  for (const [f, n] of [[110, "A2"], [220, "A3"], [440, "A4"], [880, "A5"], [1760, "A6"]]) {
    s += `<line x1="${fx(f)}" x2="${fx(f)}" y1="${m.t}" y2="${H - m.b}" stroke="${INK.grid}"/>`;
    s += `<text x="${fx(f)}" y="${H - m.b + 16}" fill="${INK.muted}" font-size="11" text-anchor="middle">${n} · ${f} Hz</text>`;
  }
  BANDS.forEach((b, r) => {
    const cy = m.t + r * rowH + rowH / 2;
    s += `<text x="${m.l - 12}" y="${cy + 4}" fill="${INK.secondary}" font-size="11" text-anchor="end">${b.name.replace(/ \(.*\)/, "")}</text>`;
    WL.forEach((w, c) => {
      if (bandOf(w) !== b || DEMO_MASKED.has(c)) return;
      s += `<circle cx="${fx(pitch(c))}" cy="${cy}" r="4" fill="${SERIES[0]}" stroke="${INK.surface}" stroke-width="2"><title>ch ${c + 1} · ${w.toFixed(1)} µm · ${Math.round(pitch(c))} Hz</title></circle>`;
    });
  });
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("height", H);
  svg.innerHTML = s;

  const fir = WL.filter((w, c) => w >= 17 && !DEMO_MASKED.has(c)).length;
  $("farIrCount").innerHTML = `Because pitch follows <em>wavenumber</em>, <strong>${fir} of the 63 channels</strong> (the whole far-infrared) are packed into
    the lowest octave and a half (${Math.round(pitch(C - 1))}–${Math.round(pitch(WL.findIndex((w) => w >= 17)))} Hz). That's the thick
    bass you hear, and it carries PREFIRE's signature measurement.`;
}

// ---------------------------------------------------------------- orbit (section 4)

const MAX_Q = 254;
function trackL(i, c) {
  const q = track.q8[(i * track.n_scenes) * C + c];
  return q === MISSING ? NaN : lo[c] + (q / MAX_Q) * (hi[c] - lo[c]);
}
const winCh = WL.map((w, c) => c).filter((c) => WL[c] >= 10 && WL[c] <= 12);
const orbitBT = Array.from({ length: track.n_frames }, (_, i) =>
  winCh.reduce((s, c) => s + brightnessTemp(WL[c], trackL(i, c)), 0) / winCh.length);

function makeLut(stops) {
  const rgb = stops.map((h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16)));
  return (v) => {
    const xx = clamp01(v) * (rgb.length - 1), k = Math.min(rgb.length - 2, Math.floor(xx)), f = xx - k;
    return rgb[k].map((a, j) => a + (rgb[k + 1][j] - a) * f);
  };
}
const inferno = makeLut(INFERNO);

let heatURL = null;
function heatmapImage() {
  if (heatURL) return heatURL;
  const N = track.n_frames, cv = document.createElement("canvas");
  cv.width = N; cv.height = C;
  const g = cv.getContext("2d"), img = g.createImageData(N, C);
  for (let i = 0; i < N; i++) {
    for (let c = 0; c < C; c++) {
      const q = track.q8[(i * track.n_scenes) * C + c], p = (c * N + i) * 4;
      const [r, gg, b] = q === MISSING ? [21, 22, 26] : inferno(q / MAX_Q);
      img.data[p] = r; img.data[p + 1] = gg; img.data[p + 2] = b; img.data[p + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return (heatURL = cv.toDataURL());
}

function orbitChart() {
  const el = $("orbitChart"), svg = el.querySelector("svg");
  const N = track.n_frames;
  const W = svg.clientWidth || el.clientWidth - 28;
  const ROW = 5, m = { l: 120, r: 16, t: 34 }, lineH = 130, gap = 14, heatH = C * ROW, H = m.t + lineH + gap + heatH + 30;
  const x = lin(0, N - 1, m.l, W - m.r);
  const btMin = 200, btMax = 320, y = lin(btMin, btMax, m.t + lineH, m.t);
  const heatTop = m.t + lineH + gap;
  const lat = track.lat.map((r) => r[0]);
  const day = track.solar_zenith.map((r) => r[0] < 90);

  let s = "";
  // day / night strip
  let start = 0;
  for (let i = 1; i <= N; i++) {
    if (i === N || day[i] !== day[start]) {
      s += `<rect x="${x(start)}" y="${m.t - 12}" width="${x(i - 1) - x(start)}" height="5" rx="2" fill="${day[start] ? "#c9c6b8" : "#2c2f3a"}"/>`;
      if (x(i - 1) - x(start) > 60) s += `<text x="${x(start) + 4}" y="${m.t - 16}" fill="${INK.muted}" font-size="10">${day[start] ? "day side" : "night side"}</text>`;
      start = i;
    }
  }
  for (let t = btMin; t <= btMax; t += 40) {
    s += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}" stroke="${INK.grid}"/>`;
    s += `<text x="${m.l - 8}" y="${y(t) + 4}" fill="${INK.muted}" font-size="11" text-anchor="end">${t} K</text>`;
  }
  s += `<text x="${m.l + 4}" y="${y(btMin) - 6}" fill="${INK.secondary}" font-size="11">window temperature</text>`;

  // where the orbit is: poles and equator crossings
  const events = [];
  for (let i = 1; i < N; i++) if (Math.sign(lat[i]) !== Math.sign(lat[i - 1]) && lat[i] !== 0) events.push([i, "equator"]);
  events.push([lat.indexOf(Math.max(...lat)), "Arctic"], [lat.indexOf(Math.min(...lat)), "Antarctic"]);
  const tropics = orbitBT.map((bt, i) => (Math.abs(lat[i]) < 25 ? bt : Infinity));
  const storm = tropics.indexOf(Math.min(...tropics));
  for (const [i, label] of events) {
    s += `<line x1="${x(i)}" x2="${x(i)}" y1="${m.t}" y2="${heatTop + heatH}" stroke="${INK.axis}"/>`;
    s += `<text x="${x(i) + 4}" y="${m.t + 12}" fill="${INK.muted}" font-size="11">${label}</text>`;
  }
  s += `<path d="${linePath(orbitBT.map((_, i) => x(i)), orbitBT.map(y))}" fill="none" stroke="${SERIES[0]}" stroke-width="2" stroke-linejoin="round"/>`;
  s += `<circle cx="${x(storm)}" cy="${y(orbitBT[storm])}" r="4" fill="${SERIES[0]}" stroke="${INK.surface}" stroke-width="2"/>`;
  const flip = x(storm) > W - 260;
  s += `<text x="${x(storm) + (flip ? -10 : 10)}" y="${y(orbitBT[storm]) + 18}" text-anchor="${flip ? "end" : "start"}" fill="${INK.secondary}" font-size="11">cloud tops: window drops ${Math.round(Math.max(...orbitBT.slice(Math.max(0, storm - 40), storm + 40)) - orbitBT[storm])} K</text>`;

  // heatmap of every channel, short wavelength (high pitch) on top
  s += `<image href="${heatmapImage()}" x="${m.l}" y="${heatTop}" width="${W - m.l - m.r}" height="${heatH}" preserveAspectRatio="none"/>`;
  for (const b of BANDS) {
    const cs = WL.map((w, c) => c).filter((c) => WL[c] >= b.from && WL[c] < b.to);
    const y0 = heatTop + cs[0] * ROW, y1 = heatTop + (cs[cs.length - 1] + 1) * ROW;
    s += `<line x1="${m.l - 6}" x2="${m.l - 6}" y1="${y0 + 1}" y2="${y1 - 1}" stroke="${INK.muted}"/>`;
    s += `<text x="${m.l - 12}" y="${(y0 + y1) / 2 + 4}" fill="${INK.secondary}" font-size="11" text-anchor="end">${b.short}</text>`;
  }
  s += `<text x="${m.l}" y="${H - 8}" fill="${INK.muted}" font-size="11">0 min</text>`;
  s += `<text x="${W - m.r}" y="${H - 8}" fill="${INK.muted}" font-size="11" text-anchor="end">${Math.round(track.frame_seconds[N - 1] / 60)} min · one full orbit</text>`;
  s += `<text x="${(m.l + W - m.r) / 2}" y="${H - 8}" fill="${INK.muted}" font-size="11" text-anchor="middle">dark = cold for that channel · bright = warm</text>`;
  s += `<g class="hover"></g><rect class="hit" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${heatTop + heatH - m.t}" fill="transparent" style="cursor:pointer"/>`;

  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("height", H);
  svg.innerHTML = s;

  const tip = tooltip(el), hover = svg.querySelector(".hover"), hit = svg.querySelector(".hit");
  const frameAt = (e) => {
    const r = svg.getBoundingClientRect();
    return Math.round(((e.clientX - r.left - m.l) / (W - m.l - m.r)) * (N - 1));
  };
  hit.onmousemove = (e) => {
    const i = Math.max(0, Math.min(N - 1, frameAt(e)));
    const r = svg.getBoundingClientRect();
    const c = Math.floor((e.clientY - r.top - heatTop) / ROW);
    hover.innerHTML = `<line x1="${x(i)}" x2="${x(i)}" y1="${m.t}" y2="${heatTop + heatH}" stroke="${INK.primary}" opacity="0.6"/>` +
      `<circle cx="${x(i)}" cy="${y(orbitBT[i])}" r="4" fill="${SERIES[0]}" stroke="${INK.surface}" stroke-width="2"/>`;
    const land = track.land_fraction[i][0] > 0.5 ? (Math.abs(lat[i]) > 66 ? "ice" : "land") : "ocean";
    let chan = "";
    if (c >= 0 && c < C) {
      const L = trackL(i, c);
      chan = `<div class="k">ch ${c + 1} · ${WL[c].toFixed(1)} µm · ${Number.isFinite(L) ? brightnessTemp(WL[c], L).toFixed(0) + " K" : "masked"}</div>`;
    }
    tip.show(`<b>${(track.frame_seconds[i] / 60).toFixed(1)} min</b> · ${lat[i].toFixed(1)}° · ${land} · ${day[i] ? "day" : "night"}` +
      `<div class="row">window temperature<span class="num">${orbitBT[i].toFixed(0)} K</span></div>${chan}<div class="k">click to hear</div>`,
      e.clientX - el.getBoundingClientRect().left, e.clientY - el.getBoundingClientRect().top);
  };
  hit.onmouseleave = () => { hover.innerHTML = ""; tip.hide(); };
  hit.onclick = (e) => {
    const i = Math.max(0, Math.min(N - 1, frameAt(e)));
    playSpectrum(relative(WL.map((_, c) => trackL(i, c))), 1.6);
  };
}

// ---------------------------------------------------------------- render

function renderAll() {
  spectrumChart($("tickChart"), [{ name: PLACES[0].name, color: SERIES[0], L: PLACES[0].L }], { surface: { T: 222 + 78 * Math.cos((5 * Math.PI) / 180) ** 1.4, label: "sea surface" } });
  spectrumChart($("placesChart"), PLACES, { height: 340, labelBands: false });
  pitchChart();
  orbitChart();
}

$("playTick").onclick = () => playSpectrum(relative(PLACES[0].L));
bandCards();
placesExtras();
renderAll();
let resizeTimer;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderAll, 120); });
