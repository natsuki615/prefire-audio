"""
Export PREFIRE 1B-RAD granules into a compact JSON track for the spectral player.

Usage:
    # download the first granule on a date (needs a free NASA Earthdata login)
    python prepare_data.py --download --sat 1 --date 2025-01-01

    # or convert granules you already have: one file, several, or a folder of them.
    # Orbits are merged in time order; --stride keeps it a listenable length.
    python prepare_data.py --file data/PREFIRE_SAT1_1B-RAD_R01_....nc
    python prepare_data.py --file data/my_orbits/ --stride 10

Output: player/data/track.json (the player auto-loads it when served over http).

File layout (PREFIRE 1B-RAD user guide, R01):
    Geometry/latitude, longitude, land_fraction, solar_zenith_angle   (atrack, xtrack)
    Geometry/ctime, time_UTC_values                                   (atrack[, 7])
    Radiance/spectral_radiance          W/(sr m2 um)                  (atrack, xtrack, spectral)
    Radiance/radiance_quality_flag      0 good / 1 uncategorized / 2 bad
    Radiance/wavelength                 um, SRF-weighted channel centers
    Radiance/detector_quality_flag      per detector (xtrack, spectral): 0 good / 1 low confidence / 2 masked
    Radiance/detector_bitflags          why: b0 masked, b1 extreme noise, b2 greater noise,
                                        b3 stray light, b4 thermal effects, b5 filter edge

    atrack = snapshots along the orbit (one every 0.707 s)
    xtrack = the 8 side-by-side spots ("scenes") across the satellite's path
    spectral = the 63 channels
"""
import argparse
import base64
import json
import warnings
from pathlib import Path

import h5py
import numpy as np

MISSING = 255  # uint8 sentinel for fill / bad-quality samples


# ---------------------------------------------------------------- getting files

def download(sat, date, version, out_dir, count):
    """Log in to NASA Earthdata and download `count` 1B-RAD orbit files from one day.

    Asks for your Earthdata username/password the first time (then remembers it),
    searches for PREFIRE_SAT{sat}_1B-RAD granules on `date`, saves them into `out_dir`,
    and returns the local file paths.
    """
    import earthaccess

    earthaccess.login(strategy="interactive", persist=True)
    results = earthaccess.search_data(
        short_name=f"PREFIRE_SAT{sat}_1B-RAD",
        version=version,
        cloud_hosted=True,
        temporal=(date, date),
    )
    if not results:
        raise SystemExit(f"No PREFIRE_SAT{sat}_1B-RAD {version} granules found on {date}")
    print(f"Found {len(results)} granules, downloading {min(count, len(results))}")
    return [Path(p) for p in earthaccess.download(results[:count], local_path=str(out_dir))]


def expand(paths):
    """Turn the paths given on the command line into a list of .nc files.

    A folder becomes every .nc file inside it (sorted by name); a file stays as-is.
    Stops with an error if nothing is found.
    """
    files = []
    for p in paths:
        files += sorted(p.glob("*.nc")) if p.is_dir() else [p]
    if not files:
        raise SystemExit("No .nc files found")
    return files



def read_var(f, path, dtype=np.float64):
    """Read one variable (e.g. "Geometry/latitude") from an open file as numbers.

    NASA marks missing values with a placeholder (-9999); this replaces them with
    NaN ("not a number") so later math simply skips them.
    """
    ds = f[path]
    arr = ds[()].astype(dtype)
    fill = ds.attrs.get("_FillValue")
    if fill is not None:
        arr[arr == np.asarray(fill).item()] = np.nan
    arr[arr < -9000] = np.nan
    return arr


def to_channels_last(arr, n_channels):
    """Reorder an array so the 63-channel dimension comes last.

    The user guide documents wavelength as (atrack, spectral), but real files store it
    as (8 scenes, 63 channels); this finds the 63-long axis and moves it to the end.
    """
    axis = [i for i, n in enumerate(arr.shape) if n == n_channels][-1]
    return np.moveaxis(arr, axis, -1)


def read_granule(path, stride, good_only, keep_empty):
    """Read one orbit file and return just the pieces the player needs.

    Steps:
      1. Load the 63-channel radiances, keeping every `stride`-th snapshot.
      2. Blank out readings NASA flagged as bad (or, with good_only, anything not "good").
      3. Load location, land fraction, sun angle and time for the same snapshots.
      4. Drop snapshots where every channel in every scene is blank (unless keep_empty).

    Returns a dict: path, rad (snapshots x 8 x 63), wl (channel wavelengths),
    geo (lat/lon/land/sun), ctime (seconds), utc0 (time of the first kept snapshot).
    """
    with h5py.File(path, "r") as f:
        # 1. radiances, thinned to every Nth snapshot
        rad = read_var(f, "Radiance/spectral_radiance", np.float32)[::stride]  # (atrack, xtrack, spectral)
        n_channels = rad.shape[2]

        # 2. quality filter: flag 2 = bad (always dropped), flag 1 = uncategorized (dropped with --good-only)
        if "Radiance/radiance_quality_flag" in f:
            q = f["Radiance/radiance_quality_flag"][::stride]
            rad[q >= (1 if good_only else 2)] = np.nan

        # 3. where and when each snapshot was taken
        geo = {
            name: read_var(f, f"Geometry/{name}")[::stride]
            for name in ("latitude", "longitude", "land_fraction", "solar_zenith_angle")
            if f"Geometry/{name}" in f
        }
        ctime = read_var(f, "Geometry/ctime")[::stride]
        utc = f["Geometry/time_UTC_values"][::stride]
        wl = to_channels_last(read_var(f, "Radiance/wavelength"), n_channels).reshape(-1, n_channels)
        # how far NASA trusts each detector (one per scene x channel), and the reason
        det_q = f["Radiance/detector_quality_flag"][()] if "Radiance/detector_quality_flag" in f else None
        det_bits = f["Radiance/detector_bitflags"][()] if "Radiance/detector_bitflags" in f else None

    # 4. Frames with no usable channel in any scene are silence. In R01 these are mostly the
    # instrument's thermal disturbance near eclipse entrance (observation_bitflags bit 2).
    keep = slice(None) if keep_empty else ~np.isnan(rad).all(axis=(1, 2))
    return {
        "path": Path(path),
        "rad": rad[keep],
        "wl": wl,
        "geo": {k: v[keep] for k, v in geo.items()},
        "ctime": ctime[keep],
        "utc0": utc[keep][0],
        "det_q": det_q,
        "det_bits": det_bits,
    }


# ---------------------------------------------------------------- building the track

def export(paths, out_path, stride, max_frames, good_only, keep_empty):
    """Merge one or more orbit files into a single track and write it as JSON.

    Steps:
      1. Read every file and sort them by time.
      2. Join them end to end into one long sequence of snapshots.
      3. Record where each orbit starts (so the player can show "orbit 3 / 13").
      4. Optionally cut to --max-frames.
      5. Scale each channel to 0-254 using its own 1st-99th percentile range
         (this is what the player's "Relative" mode plays).
      6. Combine NASA's per-detector confidence across files (worst case wins).
      7. Write everything to track.json and print a summary.
    """
    # 1-2. read all files, sort by start time, and join them
    granules = sorted((read_granule(p, stride, good_only, keep_empty) for p in expand(paths)), key=lambda g: g["ctime"][0])
    rad = np.concatenate([g["rad"] for g in granules])
    ctime = np.concatenate([g["ctime"] for g in granules])
    geo = {k: np.concatenate([g["geo"][k] for g in granules]) for k in granules[0]["geo"]}
    n_scenes, n_channels = rad.shape[1:]
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # masked channels have no wavelength
        wl = np.nanmean(np.concatenate([g["wl"] for g in granules]), axis=0)
    start_iso = "{:04d}-{:02d}-{:02d}T{:02d}:{:02d}:{:02d}.{:03d}Z".format(*map(int, granules[0]["utc0"]))

    # 3. where each orbit file starts in the merged track (orbits can be missing, so time may jump)
    starts = np.cumsum([0] + [len(g["ctime"]) for g in granules[:-1]])
    orbits = [{"file": g["path"].name, "start_frame": int(s)} for g, s in zip(granules, starts)]

    # 4. optional length cap
    if max_frames:
        rad, ctime = rad[:max_frames], ctime[:max_frames]
        geo = {k: v[:max_frames] for k, v in geo.items()}
        orbits = [o for o in orbits if o["start_frame"] < max_frames]
    n_frames = rad.shape[0]
    source = granules[0]["path"].name if len(granules) == 1 else \
        f"{granules[0]['path'].name.split('_R01')[0]} · {len(granules)} orbits from {start_iso[:10]} · every {stride} frame(s)"

    # 5. Per (scene, channel) robust range, so every channel uses the full 0-254 range
    # and the player hears relative spikes/dips; lo/hi let it rebuild physical units.
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # masked channels are all-NaN
        lo = np.nanpercentile(rad, 1, axis=0)
        hi = np.nanpercentile(rad, 99, axis=0)
    span = np.where(hi - lo > 0, hi - lo, 1)
    q8 = np.clip(np.round((rad - lo) / span * 254), 0, 254)
    q8 = np.where(np.isnan(rad), MISSING, q8).astype(np.uint8)

    # 6. detector confidence: if any file flags a detector, treat it as flagged
    det_q = [g["det_q"] for g in granules if g["det_q"] is not None]
    det_bits = [g["det_bits"] for g in granules if g["det_bits"] is not None]
    det_q = np.maximum.reduce(det_q) if det_q else None
    det_bits = np.bitwise_or.reduce(det_bits) if det_bits else None

    def rounded(a, nd):
        """2-D array -> nested lists with `nd` decimals, NaN -> null (keeps the JSON small)."""
        return [[None if np.isnan(x) else round(float(x), nd) for x in row] for row in a]

    # 7. the JSON the player reads (see normalizeTrack in player/app.js)
    track = {
        "source": source,
        "start_utc": start_iso,
        "n_frames": n_frames,
        "n_scenes": n_scenes,
        "n_channels": n_channels,
        "frame_seconds": [round(float(t - ctime[0]), 2) for t in ctime],
        "wavelength_um": [None if np.isnan(w) else round(float(w), 3) for w in wl],
        "lo": rounded(lo, 5),
        "hi": rounded(hi, 5),
        "orbits": orbits,
        "radiance_u8_b64": base64.b64encode(q8.tobytes()).decode("ascii"),
        "lat": rounded(geo["latitude"], 3),
        "lon": rounded(geo["longitude"], 3),
    }
    if "land_fraction" in geo:
        track["land_fraction"] = rounded(geo["land_fraction"], 2)
    if "solar_zenith_angle" in geo:
        track["solar_zenith"] = rounded(geo["solar_zenith_angle"], 1)
    if det_q is not None:
        track["detector_quality"] = det_q.astype(int).tolist()     # [scene][channel]
    if det_bits is not None:
        track["detector_bitflags"] = det_bits.astype(int).tolist()  # [scene][channel]

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(track, separators=(",", ":")))
    valid = np.mean(q8 != MISSING) * 100
    print(f"Merged {len(granules)} file(s). Wrote {out_path}: {n_frames} frames x {n_scenes} scenes x {n_channels} channels "
          f"({valid:.0f}% valid, {out_path.stat().st_size / 1e6:.1f} MB)")
    if det_q is not None:
        print(f"Low-confidence detectors (quality flag 1): {int((det_q == 1).sum())} of {det_q.size}")


# ---------------------------------------------------------------- command line

def main():
    """Read the command-line options, get the files (download or local), and run export()."""
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--file", "--files", dest="files", type=Path, nargs="+",
                     help="existing 1B-RAD .nc granule(s), or folder(s) of them")
    src.add_argument("--download", action="store_true", help="fetch granules with earthaccess")
    p.add_argument("--sat", choices=["1", "2"], default="1")
    p.add_argument("--date", default="2025-01-01", help="YYYY-MM-DD (with --download)")
    p.add_argument("--version", default="R01")
    p.add_argument("--count", type=int, default=1, help="how many granules to download (with --download)")
    p.add_argument("--stride", type=int, default=1, help="keep every Nth along-track frame")
    p.add_argument("--max-frames", type=int, default=0, help="cap frames after striding (0 = all)")
    p.add_argument("--good-only", action="store_true",
                   help="also drop quality flag 1 (uncategorized); flag 2 (bad) is always dropped")
    p.add_argument("--keep-empty", action="store_true",
                   help="keep frames where every channel is missing (dropped by default)")
    p.add_argument("--out", type=Path, default=Path(__file__).parent / "player/data/track.json")
    args = p.parse_args()

    paths = download(args.sat, args.date, args.version, Path("data"), args.count) if args.download else args.files
    export(paths, args.out, args.stride, args.max_frames, args.good_only, args.keep_empty)


if __name__ == "__main__":
    main()
