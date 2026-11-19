"""Tile pyramid and data files for the browser globe in out/globe/.

Everything uses the geographic tiling scheme CesiumJS expects: level 0 is two
256 x 256 tiles covering 180 W..0 and 0..180 E, rows count from the north.

Layers written:

* ``tiles/mosaic/{z}/{x}/{y}.jpg``  Cassini ISS global mosaic, levels 0-5.
* ``tiles/relief/{z}/{x}/{y}.jpg``  DEM color relief with hillshade, levels 0-5.
* ``terrain/{z}/{x}/{y}.bin``       65 x 65 little-endian int16 heights, levels 0-5.

Terrain heights are the true radius (reference ellipsoid plus DEM height)
minus the radius of the display sphere, in metres. That puts the moon's real
triaxial shape on the globe, not just the local topography.
"""

from __future__ import annotations

import csv
import json
import math
import struct
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.windows import Window

from .body import ellipsoid_radius

ROOT = Path(__file__).resolve().parents[2]
COG = ROOT / "out" / "cog"
OUT = ROOT / "out" / "globe"
MOSAIC = COG / "Enceladus_Cassini_mosaic_global_100m_schenk2024_cog.tif"
DEM = COG / "Enceladus_Cassini_DEM_global_200m_schenk2024_cog.tif"
NOMEN = ROOT / "data" / "nomenclature" / "ENCELADUS_nomenclature_center_pts.dbf"
JETS = ROOT / "out" / "unreal" / "south_polar_201km" / "vents" / "porco2014_jets.csv"

DISPLAY_RADIUS_M = 252_100.0
TILE = 256
TERRAIN_N = 65


def _read_band(ds, lat_n, lat_s, lon_w, lon_e, rows, cols, resampling):
    """Read a lat/lon box from a simple-cylindrical raster, resampled to rows x cols.

    The rasters span roughly 180 W..180 E and 90 S..90 N with half-pixel
    slop, so pixel coordinates come from the transform and reads are boundless.
    """
    inv = ~ds.transform
    r = 256_200.0 * math.pi / 180.0  # metres per degree on the map sphere
    c0, r0 = inv * (lon_w * r, lat_n * r)
    c1, r1 = inv * (lon_e * r, lat_s * r)
    win = Window(c0, r0, c1 - c0, r1 - r0)
    a = ds.read(1, window=win, out_shape=(rows, cols), resampling=resampling,
                boundless=True, masked=True)
    return a


def _tile_bounds(z, x, y):
    span = 180.0 / (1 << z)
    lon_w = -180.0 + x * span
    lat_n = 90.0 - y * span
    return lat_n, lat_n - span, lon_w, lon_w + span


def _save_jpg(arr_rgb, path, quality=88):
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(arr_rgb).save(path, quality=quality, optimize=True)


def build_mosaic(max_z=5):
    ds = rasterio.open(MOSAIC)
    lo, hi = 8300.0, 12900.0  # about the 0.5 and 99.5 percentiles
    for z in range(max_z + 1):
        nx, ny = 2 << z, 1 << z
        for y in range(ny):
            lat_n, lat_s, _, _ = _tile_bounds(z, 0, y)
            strip = _read_band(ds, lat_n, lat_s, -180.0, 180.0, TILE, TILE * nx, Resampling.average if z < max_z else Resampling.bilinear)
            v = np.clip((strip.filled(lo) - lo) / (hi - lo), 0, 1) ** 0.85
            g = (v * 255).astype(np.uint8)
            rgb = np.stack([g, g, np.clip(g.astype(np.int16) + 4, 0, 255).astype(np.uint8)], -1)
            for x in range(nx):
                _save_jpg(rgb[:, x * TILE:(x + 1) * TILE], OUT / "tiles" / "mosaic" / str(z) / str(x) / f"{y}.jpg")
        print(f"mosaic level {z} done")


# Diverging-ish ramp for heights in km: deep blue lows, ice white, warm highs.
_RAMP = np.array([
    [-2.0, 30, 50, 120],
    [-1.0, 60, 110, 180],
    [-0.4, 120, 170, 210],
    [0.0, 205, 225, 235],
    [0.5, 235, 225, 190],
    [1.0, 225, 180, 120],
    [1.6, 190, 110, 70],
    [2.2, 140, 60, 50],
])


def _colorize(h_km):
    out = np.empty(h_km.shape + (3,), np.float32)
    for i in range(3):
        out[..., i] = np.interp(h_km, _RAMP[:, 0], _RAMP[:, i + 1])
    return out


def build_relief(max_z=5):
    ds = rasterio.open(DEM)
    for z in range(max_z + 1):
        nx, ny = 2 << z, 1 << z
        span = 180.0 / (1 << z)
        px_m = span / TILE * 256_200.0 * math.pi / 180.0
        for y in range(ny):
            lat_n, lat_s, _, _ = _tile_bounds(z, 0, y)
            pad = span / TILE  # one pixel each side for gradients
            h = _read_band(ds, lat_n + pad, lat_s - pad, -180.0 - pad, 180.0 + pad,
                           TILE + 2, TILE * nx + 2, Resampling.average if z < max_z else Resampling.bilinear).filled(0).astype(np.float32)
            lat = np.radians(np.linspace(lat_n + pad, lat_s - pad, TILE + 2))[:, None]
            dx = np.maximum(np.cos(lat), 0.02) * px_m
            gx = (h[1:-1, 2:] - h[1:-1, :-2]) * 1000.0 / (2 * dx[1:-1])
            gy = (h[:-2, 1:-1] - h[2:, 1:-1]) * 1000.0 / (2 * px_m)
            ex = 6.0  # hillshade exaggeration
            nxv, nyv, nzv = -gx * ex, -gy * ex, np.ones_like(gx)
            nrm = np.sqrt(nxv ** 2 + nyv ** 2 + nzv ** 2)
            az, alt = math.radians(315), math.radians(40)
            lx, ly, lz = math.cos(alt) * math.sin(az), math.cos(alt) * math.cos(az), math.sin(alt)
            shade = np.clip((nxv * lx + nyv * ly + nzv * lz) / nrm, 0, 1)
            col = _colorize(h[1:-1, 1:-1]) * (0.35 + 0.75 * shade[..., None])
            rgb = np.clip(col, 0, 255).astype(np.uint8)
            for x in range(nx):
                _save_jpg(rgb[:, x * TILE:(x + 1) * TILE], OUT / "tiles" / "relief" / str(z) / str(x) / f"{y}.jpg", 85)
        print(f"relief level {z} done")


def build_terrain(max_z=5):
    ds = rasterio.open(DEM)
    n = TERRAIN_N - 1
    for z in range(max_z + 1):
        nx, ny = 2 << z, 1 << z
        span = 180.0 / (1 << z)
        lons = np.linspace(-180.0, 180.0, nx * n + 1)
        for y in range(ny):
            lat_n, lat_s, _, _ = _tile_bounds(z, 0, y)
            # Sample at the grid nodes: read a box padded by half a node so pixel centres land on nodes.
            step = span / n
            h = _read_band(ds, lat_n + step / 2, lat_s - step / 2, -180.0 - step / 2, 180.0 + step / 2,
                           TERRAIN_N, nx * n + 1, Resampling.bilinear).filled(0).astype(np.float64)
            lats = np.linspace(lat_n, lat_s, TERRAIN_N)
            la, lo = np.meshgrid(np.radians(lats), np.radians(lons), indexing="ij")
            radius = ellipsoid_radius(la, lo) + h * 1000.0
            hm = np.clip(np.round(radius - DISPLAY_RADIUS_M), -32000, 32000).astype("<i2")
            for x in range(nx):
                p = OUT / "terrain" / str(z) / str(x) / f"{y}.bin"
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(hm[:, x * n:x * n + TERRAIN_N].tobytes())
        print(f"terrain level {z} done")


def _read_dbf(path):
    f = path.read_bytes()
    n, hl, rl = struct.unpack("<xxxxIHH", f[:12])
    fields, p = [], 32
    while f[p] != 0x0D:
        fields.append((f[p:p + 11].split(b"\0")[0].decode(), f[p + 16]))
        p += 32
    rows = []
    for i in range(n):
        r = f[hl + i * rl + 1: hl + (i + 1) * rl]
        o, d = 0, {}
        for nm, ln in fields:
            d[nm] = r[o:o + ln].decode("utf8", "replace").strip()
            o += ln
        rows.append(d)
    return rows


def build_features():
    feats = []
    for d in _read_dbf(NOMEN):
        lon = float(d["center_lon"])
        feats.append({
            "name": d["clean_name"] or d["name"],
            "type": d["type"].split(",")[0],
            "lat": float(d["center_lat"]),
            "lon": ((lon + 180.0) % 360.0) - 180.0,
            "diameter_km": float(d["diameter"] or 0),
            "origin": d["origin"],
            "link": d["link"].replace("http://", "https://"),
            "bbox": [float(d["min_lon"]), float(d["min_lat"]), float(d["max_lon"]), float(d["max_lat"])],
        })
    jets = []
    with open(JETS, newline="") as fh:
        for r in csv.DictReader(fh):
            lon = float(r["LonEast"])
            jets.append({"id": r["Name"], "sulcus": r["Sulcus"], "lat": float(r["Lat"]),
                         "lon": ((lon + 180.0) % 360.0) - 180.0, "tilt": (float(r["TiltZenithDeg"]) if r["TiltZenithDeg"] else None),
                         "sightings": float(r["NormalizedSightings"] or 0), "confidence": r["ConfidenceGroup"]})
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "features.js").write_text(
        "window.ENC_FEATURES=" + json.dumps(feats, ensure_ascii=False) + ";\n"
        "window.ENC_JETS=" + json.dumps(jets) + ";\n", encoding="utf8")
    print(f"{len(feats)} named features, {len(jets)} jets")


def build_page(mosaic_max=5, relief_max=5):
    html = (Path(__file__).with_name("globe_template.html").read_text(encoding="utf8")
            .replace("__MOSAIC_MAX__", str(mosaic_max)).replace("__RELIEF_MAX__", str(relief_max)))
    import time
    html = html.replace("__BUILD__", str(int(time.time())))  # cache-busts dive.js
    # surface mode (land, walk, rover, skim) lives in its own file and is inlined into the page script
    html = html.replace("/*__WALK__*/", Path(__file__).with_name("globe_walk.js").read_text(encoding="utf8"))
    # rover ops (plan and run a traverse with Earth contact windows) is inlined the same way
    html = html.replace("/*__ROVER__*/", Path(__file__).with_name("globe_rover.js").read_text(encoding="utf8"))
    # life detection (the Orbilander's proposed Life Detection Suite, model from sisl/LifeDetection)
    html = html.replace("/*__LIFE__*/", Path(__file__).with_name("globe_life.js").read_text(encoding="utf8"))
    # the guided tour through every mode
    html = html.replace("/*__TOUR__*/", Path(__file__).with_name("globe_tour.js").read_text(encoding="utf8"))
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "index.html").write_text(html, encoding="utf8")
    (OUT / "dive.js").write_text(Path(__file__).with_name("globe_dive.js").read_text(encoding="utf8"), encoding="utf8")
    for asset in [*(Path(__file__).parent / "assets").glob("*.png"), *(Path(__file__).parent / "assets").glob("*.jpg")]:
        (OUT / asset.name).write_bytes(asset.read_bytes())
    print(f"wrote {OUT / 'index.html'}")


def build_hires():
    from . import globe_hires  # imported here: it imports this module
    globe_hires.build()


def build_interior():
    from . import globe_interior  # imported here: it imports this module
    globe_interior.build()


def build_all():
    build_page()
    build_features()
    build_terrain()
    build_relief()
    build_mosaic()
    build_hires()
    build_interior()


if __name__ == "__main__":
    import sys
    steps = sys.argv[1:] or ["all"]
    for s in steps:
        {"all": build_all, "features": build_features, "terrain": build_terrain,
         "relief": build_relief, "mosaic": build_mosaic, "page": build_page, "hires": build_hires, "interior": build_interior}[s]()
