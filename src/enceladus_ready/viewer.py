"""Build a local zoomable viewer from the finished inset outputs."""

from __future__ import annotations

import csv
import json
import shutil
from pathlib import Path

import numpy as np
from PIL import Image

from . import body
from . import inset as insets
from .sources import OUT
from .tile import HALF_M, TILE_ID

TEMPLATE = Path(__file__).resolve().parent / "viewer_template.html"
SITE = OUT / "viewer"
TILE_PIXELS = 2048
RELIEF = OUT / "unreal" / TILE_ID / "relief"
INSET = RELIEF / "insets" / "cassini_iss"
Image.MAX_IMAGE_PIXELS = None


def stretch(path: Path) -> np.ndarray:
    data = np.asarray(Image.open(path), dtype=np.float32) / 65535.0
    return np.uint8(np.clip((data - 0.1) / 0.85, 0.0, 1.0) * 255)


def cut(data: np.ndarray, name: str, x0_km: float, y0_km: float, spacing_km: float, quality: int, folder: Path, size: int = TILE_PIXELS) -> list[dict]:
    """Split an image into JPEG tiles with world bounds. Pixel centers sit on the grid."""
    tiles = []
    ny, nx = data.shape
    for j in range(0, max(ny - 1, 1), size):
        for i in range(0, max(nx - 1, 1), size):
            j1, i1 = min(j + size + 2, ny), min(i + size + 2, nx)
            file = f"{name}_{j // size}_{i // size}.jpg"
            Image.fromarray(data[j:j1, i:i1]).save(folder / file, quality=quality, optimize=True)
            tiles.append({
                "src": f"img/{file}",
                "x0": x0_km + (i - 0.5) * spacing_km, "y0": y0_km + (j - 0.5) * spacing_km,
                "x1": x0_km + (i1 - 0.5) * spacing_km, "y1": y0_km + (j1 - 0.5) * spacing_km,
            })
    return tiles


def build(quality: int = 90, notice: str = "") -> Path:
    """Write out/viewer. Open enceladus-viewer.html in a browser."""
    if SITE.exists():
        shutil.rmtree(SITE)
    images = SITE / "img"
    images.mkdir(parents=True)
    meta = json.loads((INSET / "inset.json").read_text(encoding="utf-8"))
    half = HALF_M / 1000.0

    base = stretch(RELIEF / "albedo_flattened_linear.png")
    base_tiles = cut(base, "base", -half, -half, 2 * half / (base.shape[0] - 1), quality, images)

    inset_tiles, places = [], [{"label": "Whole tile", "whole": True}]
    for tier in meta["tiers"]:
        data = stretch(INSET / f"albedo_{tier['name']}_linear.png")
        x0, y0 = tier["world_min_cm"][0] / 1e5, tier["world_min_cm"][1] / 1e5
        x1, y1 = tier["world_max_cm"][0] / 1e5, tier["world_max_cm"][1] / 1e5
        inset_tiles += cut(data, tier["name"], x0, y0, tier["pixel_spacing_m"] / 1000.0, quality, images)
        if tier["name"].startswith("detail"):
            finest = min(insets.SPECS[f].scale_m for f in tier["frames"])
            flybys = sorted({insets.SPECS[f].flyby[:4] for f in tier["frames"]})
            places.append({
                "label": f"{finest:g} m detail, {', '.join(flybys)}",
                "x": (x0 + x1) / 2, "y": (y0 + y1) / 2, "span": max(x1 - x0, y1 - y0) * 1.1, "finest": finest,
            })

    aligned, _ = insets.load_alignment()
    frames = []
    for item in aligned:
        spec = item["spec"]
        corners = (insets.footprint(item["H"]) * insets.CANVAS_M - insets.EXTENT_M) / 1000.0
        check = item["verify"]
        frames.append({
            "image": spec.image, "flyby": spec.flyby, "scale": spec.scale_m, "emission": spec.emission_deg,
            "corners": [[round(float(a), 3), round(float(b), 3)] for a, b in corners],
            "match": f"{check['mosaic_ncc']:.2f}",
            "offset": f"within {int(max(abs(check['best_offset_m'][0]), abs(check['best_offset_m'][1])))} m",
        })

    with open(OUT / "unreal" / TILE_ID / "vents" / "porco2014_jets.csv", encoding="utf-8", newline="") as handle:
        jets = [{"x": float(r["ReliefXcm"]) / 1e5, "y": float(r["ReliefYcm"]) / 1e5} for r in csv.DictReader(handle)]

    wide = next(t for t in meta["tiers"] if t["name"] == "wide")
    manifest = {
        "halfKm": half, "radiusKm": body.MEAN_RADIUS_M / 1000.0, "base": base_tiles, "insets": inset_tiles,
        "frames": frames, "jets": jets, "candidates": len(insets.FRAMES), "coveredKm2": round(wide["covered_km2"]),
        "finest": f"{min(f['scale'] for f in frames):g}",
        "places": sorted(places, key=lambda p: p.get("finest", -1)),
        "notice": notice,
    }
    page = TEMPLATE.read_text(encoding="utf-8").replace("__MANIFEST__", json.dumps(manifest, separators=(",", ":")))
    target = SITE / "enceladus-viewer.html"
    target.write_text(page, encoding="utf-8")
    print(f"{target}: {len(list(images.iterdir()))} images")
    return target
