"""High-resolution Cassini insets (built by ``pixi run inset``) as extra globe zoom levels.

The insets live in the south-polar stereographic plane of the Unreal tile.
For each geographic tile at levels 6-8 that touches an inset, every pixel is
mapped to that plane and the inset's fine detail (structure below about
150 m) is multiplied onto the 100 m global mosaic. The global mosaic keeps
setting the brightness, so the insets blend in without seams. Tiles are WebP
with alpha, so the plain mosaic shows wherever no inset covers.

Writes ``out/globe/tiles/hires/{z}/{x}/{y}.webp`` and ``out/globe/hires.js``
(tile list plus coverage outlines with dates, for the map).
"""

from __future__ import annotations

import datetime as dt
import json
import math

import cv2
import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling

from .body import ellipsoid_radius, latlon_to_stereographic, stereographic_to_latlon
from .globe import DEM, DISPLAY_RADIUS_M, MOSAIC, OUT, ROOT, TILE, _read_band, _tile_bounds

INSETS = ROOT / "out" / "unreal" / "south_polar_201km" / "relief" / "insets" / "cassini_iss"
FRAMES = ROOT / "data" / "frames" / "iss"
# Level 7 is about 24 m per pixel north-south, level 8 about 12 m.
LEVELS = {"wide": (6, 7), "detail_01": (6, 8), "detail_02": (6, 8)}
DETAIL_SIGMA_M = 150.0
STRETCH = (8300.0, 12900.0)  # same as the global mosaic tiles
# The insets' low-Sun shadows give far more contrast than the 100 m mosaic. A power
# below 1 tones the detail down so it sits inside the mosaic's tone range.
DETAIL_GAMMA = 0.35


def available() -> bool:
    return (INSETS / "inset.json").exists()


def _frame_date(image_id):
    for lbl in sorted(FRAMES.glob(f"N{image_id}_*_CALIB.LBL")):
        for line in lbl.read_text(errors="replace").splitlines():
            if line.strip().startswith("IMAGE_TIME"):
                t = line.split("=", 1)[1].strip().strip('"')
                year, rest = t.split("-", 1)
                return (dt.date(int(year), 1, 1) + dt.timedelta(days=int(rest[:3]) - 1)).isoformat()
    return None


def _stripe_mask(a):
    """0..1 where a Cassini frame shows readout striping (energy at 1-2 px far above 2-8 px).

    A few frames carry line artifacts near their edges. Those patches are faded out
    so the next coarser layer (or the global mosaic) shows through instead.
    """
    b1 = cv2.GaussianBlur(a, (0, 0), 1.0)
    b4 = cv2.GaussianBlur(a, (0, 0), 4.0)
    fine = cv2.GaussianBlur((a - b1) ** 2, (0, 0), 12)
    mid = cv2.GaussianBlur((b1 - b4) ** 2, (0, 0), 12)
    e = fine / np.maximum(mid, 1e-7)
    s = np.clip((e - 0.3) / 0.4, 0.0, 1.0).astype(np.float32)
    s = cv2.dilate(s, np.ones((15, 15), np.uint8))
    return cv2.GaussianBlur(s, (0, 0), 8)


def _load():
    meta = json.loads((INSETS / "inset.json").read_text())
    tiers = []
    for t in meta["tiers"]:
        name, s = t["name"], float(t["pixel_spacing_m"])
        a = np.asarray(Image.open(INSETS / f"albedo_{name}_linear.png"), dtype=np.float32) / 65535.0
        m = np.asarray(Image.open(INSETS / f"mask_{name}.png"), dtype=np.float32) / 255.0
        m = m * (1.0 - _stripe_mask(a))
        valid = (m > 0.02).astype(np.float32)
        sig = DETAIL_SIGMA_M / s
        broad = cv2.GaussianBlur(a * valid, (0, 0), sig) / np.maximum(cv2.GaussianBlur(valid, (0, 0), sig), 1e-4)
        ratio = (np.clip(a / np.maximum(broad, 1e-3), 0.25, 2.5) ** DETAIL_GAMMA).astype(np.float32)
        ratio[valid == 0] = 1.0
        del a, broad, valid
        dates = sorted({d for d in (_frame_date(f) for f in t["frames"]) if d})
        tiers.append({
            "name": name, "spacing": s, "ratio": ratio, "mask": m,
            "x0": t["world_min_cm"][0] / 100.0, "y0": t["world_min_cm"][1] / 100.0,
            "x1": t["world_max_cm"][0] / 100.0, "y1": t["world_max_cm"][1] / 100.0,
            "frames": t["frames"], "dates": dates, "km2": t["covered_km2"], "levels": LEVELS.get(name, (6, 8)),
        })
        print(f"inset {name}: {ratio.shape[1]} x {ratio.shape[0]} px at {s:.0f} m, flybys {dates}")
    return tiers


def _stereo(lat_deg, lon_deg):
    return latlon_to_stereographic(np.radians(lat_deg), np.radians(lon_deg))


def _write_tiles(tiers):
    ds = rasterio.open(MOSAIC)
    lo, hi = STRETCH
    out_dir = OUT / "tiles" / "hires"
    avail = []
    for z in range(min(t["levels"][0] for t in tiers), max(t["levels"][1] for t in tiers) + 1):
        active = [t for t in tiers if t["levels"][0] <= z <= t["levels"][1]]
        span = 180.0 / (1 << z)
        written = 0
        for y in range(1 << z):
            lat_n, lat_s, _, _ = _tile_bounds(z, 0, y)
            if lat_n > -60.0:
                continue
            for x in range(2 << z):
                _, _, lon_w, lon_e = _tile_bounds(z, x, y)
                la, lo_ = np.meshgrid(np.linspace(lat_n, lat_s, 9), np.linspace(lon_w, lon_e, 9), indexing="ij")
                X, Y = _stereo(la, lo_)
                hit = [t for t in active if ((X >= t["x0"]) & (X <= t["x1"]) & (Y >= t["y0"]) & (Y <= t["y1"])).any()]
                if not hit:
                    continue
                px = span / TILE
                la, lo_ = np.meshgrid(lat_n - (np.arange(TILE) + 0.5) * px, lon_w + (np.arange(TILE) + 0.5) * px, indexing="ij")
                X, Y = _stereo(la, lo_)
                ratio = np.ones((TILE, TILE), np.float32)
                alpha = np.zeros((TILE, TILE), np.float32)
                for t in sorted(hit, key=lambda t: -t["spacing"]):  # coarse first, finest on top
                    mx = ((X - t["x0"]) / t["spacing"]).astype(np.float32)
                    my = ((Y - t["y0"]) / t["spacing"]).astype(np.float32)
                    m = cv2.remap(t["mask"], mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
                    if m.max() < 0.01:
                        continue
                    r = cv2.remap(t["ratio"], mx, my, cv2.INTER_CUBIC, borderMode=cv2.BORDER_CONSTANT, borderValue=1)
                    ratio = ratio * (1 - m) + r * m
                    alpha = np.maximum(alpha, m)
                if alpha.max() < 0.01:
                    continue
                base = _read_band(ds, lat_n, lat_s, lon_w, lon_e, TILE, TILE, Resampling.bilinear).filled(lo)
                v = np.clip((base - lo) / (hi - lo), 0, 1) ** 0.85 * ratio
                # Soft shoulder: sunlit ridges roll off instead of clipping to white.
                knee = 0.82
                v = np.where(v > knee, knee + (1 - knee) * np.tanh((v - knee) / (1 - knee)), v)
                v = np.clip(v, 0, 1)
                g = (v * 255).astype(np.uint8)
                b = np.clip(g.astype(np.int16) + 4, 0, 255).astype(np.uint8)
                rgba = np.stack([g, g, b, (np.clip(alpha, 0, 1) * 255).astype(np.uint8)], -1)
                p = out_dir / str(z) / str(x) / f"{y}.webp"
                p.parent.mkdir(parents=True, exist_ok=True)
                Image.fromarray(rgba, "RGBA").save(p, quality=82, method=4)
                avail.append(f"{z}/{x}/{y}")
                written += 1
        print(f"hires level {z}: {written} tiles")
    return avail


def _outlines(tiers):
    dem = rasterio.open(DEM)
    k = math.pi / 180.0 * 256_200.0  # map-sphere metres per degree
    areas = []
    for t in tiers:
        f = 0.1
        small = cv2.resize((t["mask"] > 0.5).astype(np.uint8), None, fx=f, fy=f, interpolation=cv2.INTER_NEAREST)
        contours, _ = cv2.findContours(small, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        rings = []
        for c in contours:
            if cv2.contourArea(c) < 20:
                continue
            c = cv2.approxPolyDP(c, 1.0, True)[:, 0, :].astype(float)
            lat, lon = stereographic_to_latlon(t["x0"] + c[:, 0] / f * t["spacing"], t["y0"] + c[:, 1] / f * t["spacing"])
            lat, lon = np.degrees(lat), ((np.degrees(lon) + 180.0) % 360.0) - 180.0
            hk = np.array([v[0] for v in dem.sample(list(zip(lon * k, lat * k)))], dtype=float)
            h = ellipsoid_radius(np.radians(lat), np.radians(lon)) + hk * 1000.0 - DISPLAY_RADIUS_M
            ring = [[round(float(a), 4), round(float(b), 4), int(round(float(c_)))] for a, b, c_ in zip(lat, lon, h)]
            rings.append(ring + ring[:1])
        cy, cx = np.argwhere(t["mask"] > 0.5).mean(0)
        clat, clon = stereographic_to_latlon(t["x0"] + cx * t["spacing"], t["y0"] + cy * t["spacing"])
        areas.append({
            "name": t["name"], "spacing_m": t["spacing"], "km2": round(t["km2"]), "frames": t["frames"],
            "dates": t["dates"], "lat": round(float(np.degrees(clat)), 3),
            "lon": round(float(((np.degrees(clon) + 180.0) % 360.0) - 180.0), 3), "rings": rings,
        })
    return areas


def build():
    if not available():
        print("no insets found; run `pixi run inset` first")
        return
    tiers = _load()
    avail = _write_tiles(tiers)
    areas = _outlines(tiers)
    (OUT / "hires.js").write_text(
        "window.ENC_HIRES=" + json.dumps({"version": int(dt.datetime.now().timestamp()), "tiles": avail, "areas": areas}) + ";\n", encoding="utf8")
    print(f"hires: {len(avail)} tiles, {len(areas)} coverage areas")


if __name__ == "__main__":
    build()
