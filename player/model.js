// Shared physics + demo-orbit model, used by the player (app.js) and the explainer (guide.html).

const MISSING = 255;
const C1 = 1.191042e8;   // W µm^4 m^-2 sr^-1  (2hc^2)
const C2 = 1.4387752e4;  // µm K               (hc/k)

const clamp01 = (x) => Math.min(1, Math.max(0, x));

const planck = (wl, T) => C1 / (wl ** 5 * (Math.exp(C2 / (wl * T)) - 1));
const brightnessTemp = (wl, L) => (L > 0 ? C2 / (wl * Math.log(1 + C1 / (wl ** 5 * L))) : NaN);

const DEMO_WL = Array.from({ length: 63 }, (_, c) => 0.84 * (c + 1));
const DEMO_MASKED = new Set([0, 1, 28]); // a few masked detectors, as in real granules

// wavenumber (1/λ) on a log scale: shorter wavelength = higher pitch
function chorusPitch(wl, allWl, fLow = 90, fHigh = 2400) {
  const nus = allWl.map((w) => 1 / w);
  const lnMin = Math.log(Math.min(...nus)), lnMax = Math.log(Math.max(...nus));
  const x = (Math.log(1 / wl) - lnMin) / (lnMax - lnMin);
  return fLow * (fHigh / fLow) ** x;
}

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeField(rand, terms) {
  const waves = Array.from({ length: terms }, () => ({
    a: (rand() - 0.5) * 0.25, b: (rand() - 0.5) * 0.25, p: rand() * 6.28, w: 0.5 + rand(),
  }));
  const norm = waves.reduce((s, w) => s + w.w, 0);
  return (lat, lon) => waves.reduce((s, w) => s + w.w * Math.sin(w.a * lat + w.b * lon + w.p), 0) / norm;
}

// optical depth per channel: gas bands plus water vapor continuum/rotation band
function absorb(w, wv) {
  let k = 0.05;
  k += 4.5 * Math.exp(-(((w - 15) / 1.4) ** 2));          // CO2 ν2 band
  k += 1.2 * Math.exp(-(((w - 9.6) / 0.35) ** 2));        // O3
  k += wv * 2.2 * Math.exp(-(((w - 6.3) / 0.9) ** 2));    // H2O ν2
  if (w > 17) k += wv * 0.12 * (w - 17) ** 1.1;           // H2O rotation band (far-IR)
  k += wv * 0.08;                                         // continuum
  return k;
}

// Planck emission from the surface or cloud tops, seen through an atmosphere whose
// temperature and water vapor depend on latitude. Returns 63 radiances (NaN = masked).
function sceneRadiance({ lat, land = 0, ice = false, day = true, cloud = 0, cloudTop = 230 }, rand = null) {
  const coslat = Math.cos((lat * Math.PI) / 180);
  let Ts = 222 + 78 * coslat ** 1.4 + (rand ? (rand() - 0.5) * 2 : 0);
  if (land > 0.5 && !ice) Ts += day ? 12 * land : -8 * land;
  const wv = 0.15 + 2.4 * coslat ** 3;                  // column water vapor, roughly cm
  const Tatm = Ts - 30 - 15 * coslat;                  // effective emitting T of absorbers
  const Tbot = (1 - cloud) * Ts + cloud * cloudTop;
  return DEMO_WL.map((w, c) => {
    const tau = Math.exp(-absorb(w, wv));
    const tAtm = w > 13.5 && w < 17 ? 205 + 22 * coslat : Tatm;   // stratosphere-ish for CO2 core
    let L = tau * planck(w, Tbot) + (1 - tau) * planck(w, tAtm);
    if (day && w < 4.5) L += 0.6 * (1 + 2 * cloud) * Math.exp(-(w - 0.84) / 0.9);   // reflected sunlight
    if (rand) L *= 1 + (rand() - 0.5) * 0.01;
    return DEMO_MASKED.has(c) ? NaN : L;
  });
}

function demoTrack() {
  const rand = mulberry32(615);
  const N = 1600, S = 8, C = 63;
  const landField = makeField(rand, 7);
  const cloudField = makeField(rand, 11);
  const incl = (97.9 * Math.PI) / 180;

  const rad = new Float32Array(N * S * C);
  const lat = [], lon = [], landFrac = [], sza = [];
  for (let i = 0; i < N; i++) {
    const phi = (2 * Math.PI * i) / N;
    const latC = (Math.asin(Math.sin(incl) * Math.sin(phi)) * 180) / Math.PI;
    const lonC = ((Math.atan2(Math.cos(incl) * Math.sin(phi), Math.cos(phi)) * 180) / Math.PI) - 20 - (i / N) * 24;
    const rowLat = [], rowLon = [], rowLand = [], rowSza = [];
    const day = Math.cos(phi) > -0.1; // ascending half of the orbit is on the sunlit side
    for (let s = 0; s < S; s++) {
      const la = latC, lo = ((lonC + (s - 3.5) * 0.9 / Math.max(0.2, Math.cos((la * Math.PI) / 180)) + 540) % 360) - 180;
      const ice = la < -66 || la > 72;
      const land = ice ? 1 : clamp01((landField(la, lo) - 0.12) * 6);
      const coslat = Math.cos((la * Math.PI) / 180);
      const cloud = clamp01((cloudField(la * 1.7, lo * 1.3 + i * 0.05) - 0.05) * 3);
      const cloudTop = 215 + 35 * coslat + 10 * cloudField(lo, la);
      rad.set(sceneRadiance({ lat: la, land, ice, day, cloud, cloudTop }, rand), (i * S + s) * C);
      rowLat.push(+la.toFixed(3)); rowLon.push(+lo.toFixed(3));
      rowLand.push(+land.toFixed(2)); rowSza.push(day ? 40 + 40 * (1 - coslat) : 120);
    }
    lat.push(rowLat); lon.push(rowLon); landFrac.push(rowLand); sza.push(rowSza);
  }

  const lo = [], hi = [], q8 = new Uint8Array(N * S * C);
  for (let s = 0; s < S; s++) {
    lo.push([]); hi.push([]);
    for (let c = 0; c < C; c++) {
      let a = Infinity, b = -Infinity;
      for (let i = 0; i < N; i++) {
        const v = rad[(i * S + s) * C + c];
        if (v < a) a = v;
        if (v > b) b = v;
      }
      lo[s].push(Number.isFinite(a) ? a : null);
      hi[s].push(Number.isFinite(b) ? b : null);
      for (let i = 0; i < N; i++) {
        const k = (i * S + s) * C + c;
        const v = rad[k];
        q8[k] = Number.isNaN(v) ? MISSING : Math.round(((v - a) / (b - a || 1)) * 254);
      }
    }
  }

  return {
    source: "DEMO ORBIT · synthetic, modeled on PREFIRE_SAT1_1B-RAD layout (load a real track.json to replace)",
    start_utc: "2025-01-01T00:00:00.000Z",
    n_frames: N, n_scenes: S, n_channels: C,
    frame_seconds: Array.from({ length: N }, (_, i) => +(i * 3.56).toFixed(2)),
    wavelength_um: DEMO_WL, lo, hi, q8, lat, lon, land_fraction: landFrac, solar_zenith: sza,
  };
}
