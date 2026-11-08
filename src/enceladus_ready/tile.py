"""Build the south-polar Unreal Engine terrain kit.

Two versions of the same ground:

relief      Polar stereographic plane, height above the reference ellipsoid.
            Gravity straight down works, so use this for walking and driving.
true_shape  Real 3D shape in a plane tangent at the pole. Curvature is included,
            so use this for horizons, orbital cameras and line-of-sight checks.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter

from . import body
from .sources import CITATION, DEM, MOSAIC, OUT, RAW, EquirectRaster

TILE_ID = "south_polar_201km"
SECTION_QUADS = 63
SECTIONS_PER_COMPONENT = 1
COMPONENTS = 16
SPACING_M = 200.0
QUADS = COMPONENTS * SECTION_QUADS * SECTIONS_PER_COMPONENT
HALF_M = QUADS * SPACING_M / 2.0
TEXTURE_NODES = 2017

# Provenance classes, stored in provenance.png
PROV_NO_SOURCE, PROV_SPECKLED, PROV_CLEAN = 0, 128, 255


def grid(nodes: int):
    axis = np.linspace(-HALF_M, HALF_M, nodes)
    x, y = np.meshgrid(axis, axis, indexing="xy")  # row = +Y, column = +X
    return x, y


def surface(product: str, nodes: int, dem: EquirectRaster, order: int = 3):
    """Return lat_deg, lon_deg, height_km and tile Z (metres) on a node grid."""
    x, y = grid(nodes)
    if product == "relief":
        lat, lon = body.stereographic_to_latlon(x, y)
        lat_deg, lon_deg = np.degrees(lat), np.degrees(lon)
        h_km = dem.sample(lat_deg, lon_deg, order=order)
        return lat_deg, lon_deg, h_km, h_km * 1000.0
    if product == "true_shape":
        lat, lon, r, z_body = body.solve_true_shape(x, y, lambda a, b: dem.sample(a, b, order=1))
        lat_deg, lon_deg = np.degrees(lat), np.degrees(lon)
        return lat_deg, lon_deg, dem.sample(lat_deg, lon_deg, order=1), -z_body - body.C_M
    raise ValueError(product)


def encode_height(z_m: np.ndarray):
    """Map metres to 16-bit Landscape values. Returns values, Z scale, actor Z (cm)."""
    low, high = float(z_m.min()), float(z_m.max())
    middle = (low + high) / 2.0
    span_cm = max(high - low, 1.0) * 100.0 * 1.01
    z_scale = span_cm * 128.0 / 65535.0
    values = np.rint((z_m - middle) * 100.0 * 128.0 / z_scale + 32768.0)
    return np.clip(values, 0, 65535).astype(np.uint16), z_scale, middle * 100.0


def decode_height(values: np.ndarray, z_scale: float, actor_z_cm: float) -> np.ndarray:
    """Unreal's own rule, returned in metres. Used to prove the export is right."""
    return ((values.astype(np.float64) - 32768.0) * z_scale / 128.0 + actor_z_cm) / 100.0


def flatten_albedo(raw: np.ndarray) -> np.ndarray:
    """Remove broad brightness trends. This is NOT photometric correction."""
    trend = gaussian_filter(raw, sigma=150.0, mode="nearest")
    ratio = raw / np.maximum(trend, np.percentile(trend, 1) * 0.1)
    low, high = np.percentile(ratio, [0.1, 99.9])
    return np.clip((ratio - low) / (high - low), 0.0, 1.0) * 0.9 + 0.05


def otsu_threshold(values: np.ndarray, bins: int = 256) -> float:
    """Threshold that best separates a two-population histogram."""
    counts, edges = np.histogram(values, bins=bins)
    centers = (edges[:-1] + edges[1:]) / 2.0
    weight = np.cumsum(counts).astype(np.float64)
    total = weight[-1]
    cumulative = np.cumsum(counts * centers)
    with np.errstate(divide="ignore", invalid="ignore"):
        between = (cumulative[-1] * weight / total - cumulative) ** 2 / (weight * (total - weight))
    return float(centers[int(np.nanargmax(between))])


def speckle_rms(height_m: np.ndarray) -> np.ndarray:
    """Local strength of short-wavelength relief, in metres."""
    band = gaussian_filter(height_m, 1.0, mode="nearest") - gaussian_filter(height_m, 4.0, mode="nearest")
    return np.sqrt(gaussian_filter(band * band, 10.0, mode="nearest"))


def provenance(height_m: np.ndarray, has_source: np.ndarray):
    """Heuristic per-node class: is the DEM speckled here?

    The DEM is a patchwork of stereo solutions with visibly different noise. The
    USGS product does not map which patch is which, so patches are separated by
    the strength of their short-wavelength relief.
    """
    rms = speckle_rms(height_m)
    threshold = float(np.exp(otsu_threshold(np.log(np.maximum(rms[has_source], 1e-3)))))
    out = np.full(height_m.shape, PROV_CLEAN, dtype=np.uint8)
    out[rms >= threshold] = PROV_SPECKLED
    out[~has_source] = PROV_NO_SOURCE
    return out, threshold


def denoise(height_m: np.ndarray, prov: np.ndarray, sigma: float = 2.5, feather: float = 5.0) -> np.ndarray:
    """Smooth only the speckled patches, with a feathered edge. Clean areas stay as measured."""
    weight = gaussian_filter((prov == PROV_SPECKLED).astype(np.float64), feather, mode="nearest")
    return weight * gaussian_filter(height_m, sigma, mode="nearest") + (1.0 - weight) * height_m


def save_png(path: Path, array: np.ndarray) -> None:
    Image.fromarray(array).save(path, optimize=False, compress_level=6)


def build_product(product: str, dem: EquirectRaster, mosaic: EquirectRaster) -> dict:
    folder = OUT / "unreal" / TILE_ID / product
    folder.mkdir(parents=True, exist_ok=True)
    nodes = QUADS + 1

    lat, lon, h_km, z_m = surface(product, nodes, dem)
    values, z_scale, actor_z = encode_height(z_m)
    values.astype("<u2").tofile(folder / "heightmap.r16")
    save_png(folder / "heightmap.png", values)

    tex_lat, tex_lon, _, _ = surface(product, TEXTURE_NODES, dem, order=1)
    albedo = flatten_albedo(mosaic.sample(tex_lat, tex_lon, order=1).astype(np.float64))
    save_png(folder / "albedo_flattened_linear.png", np.rint(albedo * 65535).astype(np.uint16))

    has_source = dem.sample_valid(lat, lon)
    prov, speckle_threshold = provenance(h_km * 1000.0, has_source)
    save_png(folder / "provenance.png", prov)

    denoised_note = None
    if product == "relief":
        cleaned = denoise(z_m, prov)
        cleaned_values = np.clip(
            np.rint((cleaned - actor_z / 100.0) * 100.0 * 128.0 / z_scale + 32768.0), 0, 65535
        ).astype(np.uint16)
        cleaned_values.astype("<u2").tofile(folder / "heightmap_denoised.r16")
        save_png(folder / "heightmap_denoised.png", cleaned_values)
        change = cleaned - z_m
        denoised_note = {
            "files": ["heightmap_denoised.r16", "heightmap_denoised.png"],
            "method": "Gaussian smoothing (500 m sigma) applied only in speckled patches, feathered over about 1 km. Clean patches are unchanged. Uses the same Landscape location and scale as heightmap.r16.",
            "change_rms_m": float(np.sqrt(np.mean(change**2))),
            "change_p99_abs_m": float(np.percentile(np.abs(change), 99)),
            "change_max_abs_m": float(np.abs(change).max()),
            "warning": "This is a derived product. Use heightmap.r16 for anything quantitative.",
        }

    classes, counts = np.unique(prov, return_counts=True)
    meta = {
        "tile": TILE_ID,
        "product": product,
        "generator": "enceladus-ready 0.1.0",
        "use": {
            "relief": "Ground work: walking, driving, framing. Flat plane with height above the ellipsoid. Horizontal scale error reaches about 4% at the tile edges and 8% at the corners.",
            "true_shape": "Real 3D curvature: horizons, orbital cameras, line of sight. The surface tilts about 24 degrees from Unreal's Z axis at the tile edges and 35 degrees at the corners.",
        }[product],
        "denoised_heightmap": denoised_note,
        "landscape": {
            "section_size_quads": SECTION_QUADS,
            "sections_per_component": SECTIONS_PER_COMPONENT,
            "component_count_xy": COMPONENTS,
            "resolution": [nodes, nodes],
            "heightmap_r16": "heightmap.r16",
            "heightmap_png": "heightmap.png",
            "location_cm": [-HALF_M * 100.0, -HALF_M * 100.0, actor_z],
            "scale": [SPACING_M * 100.0, SPACING_M * 100.0, z_scale],
            "height_rule": "z_cm = (value - 32768) * scale_z / 128 + location_z",
            "height_step_cm": z_scale / 128.0,
        },
        "frame": {
            "origin": "South pole, on the projection axis, at world (0, 0)",
            "x": "Body +X, toward longitude 0 (Saturn-facing)",
            "y": "Body +Y, toward 90 E",
            "z": "Up, away from the moon's centre at the pole (body -Z)",
            "heightmap_layout": "Row increases with +Y and column with +X, starting at (-X, -Y)",
        },
        "height_range_m": [float(z_m.min()), float(z_m.max())],
        "dem_range_km": [float(h_km.min()), float(h_km.max())],
        "textures": {
            "albedo_flattened_linear.png": "16-bit, linear, turn sRGB off. Broad brightness trends removed. Shadows from the original Cassini lighting are still present at small scale, so this is not true reflectance.",
            "provenance.png": {
                "meaning": "Heuristic. See limits.",
                "speckle_threshold_m": speckle_threshold,
                "classes": {
                    str(PROV_NO_SOURCE): "No DEM value at this node",
                    str(PROV_SPECKLED): "Speckled DEM patch. Short-wavelength relief is probably stereo noise.",
                    str(PROV_CLEAN): "Cleaner DEM patch. Short-wavelength relief is more likely to be terrain.",
                },
                "fractions": {str(int(c)): float(n) / float(prov.size) for c, n in zip(classes, counts)},
            },
        },
        "limits": [
            "DEM horizontal post spacing is about 400 m on a 200 m grid. Vertical precision is about 25 to 100 m.",
            "Nothing below that scale is measured. Any boulder, crack or surface texture added in Unreal is invented.",
            "No dataset here supports lander-scale hazard assessment.",
            "The provenance layer is an inference from the DEM's texture, because the USGS product has no per-pixel source map.",
            "The DEM is a patchwork, with visible seams between stereo solutions. Height offsets at those seams are in both heightmaps.",
            "Heights are treated as radial distance from the reference ellipsoid.",
        ],
        "reference_ellipsoid_m": [body.A_M, body.B_M, body.C_M],
        "sources": {"dem": DEM, "mosaic": MOSAIC, "citation": CITATION},
    }
    (folder / "tile.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(f"{product}: height {z_m.min():.0f} to {z_m.max():.0f} m, z_scale {z_scale:.3f}")
    return meta


def load_sources():
    return EquirectRaster(RAW / DEM), EquirectRaster(RAW / MOSAIC)


def build(dem=None, mosaic=None) -> None:
    if dem is None:
        dem, mosaic = load_sources()
    for product in ("relief", "true_shape"):
        build_product(product, dem, mosaic)
