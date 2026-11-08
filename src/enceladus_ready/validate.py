"""Checks against the source data, plus preview images."""

from __future__ import annotations

import json

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter, map_coordinates

from . import body
from .ancillary import parse_jets
from .sources import OUT
from .tile import HALF_M, QUADS, SPACING_M, TILE_ID, decode_height, surface


def tile_folder(product):
    return OUT / "unreal" / TILE_ID / product


def read_height(product):
    folder = tile_folder(product)
    meta = json.loads((folder / "tile.json").read_text(encoding="utf-8"))
    nodes = QUADS + 1
    values = np.fromfile(folder / "heightmap.r16", dtype="<u2").reshape(nodes, nodes)
    land = meta["landscape"]
    return decode_height(values, land["scale"][2], land["location_cm"][2]), meta


def check_roundtrip(dem) -> dict:
    """Rebuild moon coordinates from the exported files alone and compare with the DEM."""
    results = {}
    nodes = QUADS + 1
    axis = np.linspace(-HALF_M, HALF_M, nodes)
    x, y = np.meshgrid(axis, axis, indexing="xy")

    z, _ = read_height("relief")
    lat, lon = body.stereographic_to_latlon(x, y)
    expected = dem.sample(np.degrees(lat), np.degrees(lon), order=3) * 1000.0
    results["relief_rmse_m"] = float(np.sqrt(np.mean((z - expected) ** 2)))

    z, _ = read_height("true_shape")
    lat, lon, r = body.latlon_from_body(x, y, -(z + body.C_M))
    h = (r - body.ellipsoid_radius(lat, lon)) / 1000.0
    expected = dem.sample(np.degrees(lat), np.degrees(lon), order=1)
    results["true_shape_rmse_m"] = float(np.sqrt(np.mean(((h - expected) * 1000.0) ** 2)))
    return results


def check_registration() -> dict:
    """Do Porco's jets land on the tiger stripes, and only with the right sign?

    Score is mean mosaic contrast at the jets, using brightness swings over a
    few kilometres, which are strongest along the stripes. The null spins the
    jet pattern around the pole in 1-degree steps.
    """
    jets = [j for j in parse_jets() if j["confidence_group"] == "multiple_observation_sets"]
    lat = np.array([j["lat"] for j in jets])
    lon = np.array([j["lon_east"] for j in jets])
    west = np.array([j["lon_west"] for j in jets])

    albedo = np.asarray(Image.open(tile_folder("relief") / "albedo_flattened_linear.png"), dtype=np.float64) / 65535
    fine = gaussian_filter(albedo, 3.0, mode="nearest") - gaussian_filter(albedo, 20.0, mode="nearest")
    contrast = np.sqrt(gaussian_filter(fine * fine, 8.0, mode="nearest"))
    step = 2.0 * HALF_M / (albedo.shape[0] - 1)

    def score(lat_deg, lon_deg):
        x, y = body.latlon_to_stereographic(np.radians(lat_deg), np.radians(lon_deg))
        coords = [(y + HALF_M) / step, (x + HALF_M) / step]
        return float(map_coordinates(contrast, coords, order=1, mode="nearest").mean())

    correct = score(lat, lon)
    spins = np.array([score(lat, lon + k) for k in range(5, 356)])
    return {
        "jets_used": len(jets),
        "mean_mosaic_contrast_at_jets": correct,
        "same_with_longitude_sign_wrong": score(lat, west),
        "rotated_null_mean": float(spins.mean()),
        "rotated_null_max": float(spins.max()),
        "fraction_of_rotations_scoring_higher": float((spins > correct).mean()),
    }


def previews(dem) -> None:
    folder = OUT / "previews"
    folder.mkdir(parents=True, exist_ok=True)
    jets = parse_jets()
    extent = [-HALF_M / 1000, HALF_M / 1000, HALF_M / 1000, -HALF_M / 1000]

    def hillshade(z):
        grad_y, grad_x = np.gradient(z, SPACING_M)
        return np.clip(0.75 - (0.7 * grad_x + 0.5 * grad_y) * 2.2, 0, 1)

    z, meta = read_height("relief")
    land = meta["landscape"]
    nodes = QUADS + 1
    raw_values = np.fromfile(tile_folder("relief") / "heightmap_denoised.r16", dtype="<u2").reshape(nodes, nodes)
    cleaned = decode_height(raw_values, land["scale"][2], land["location_cm"][2])
    albedo = np.asarray(Image.open(tile_folder("relief") / "albedo_flattened_linear.png"), dtype=np.float64) / 65535
    prov = np.asarray(Image.open(tile_folder("relief") / "provenance.png"))

    fig, axes = plt.subplots(1, 4, figsize=(26, 7.2), facecolor="#0c1118")
    panels = [
        (albedo, "Cassini mosaic with published jets (orange)"),
        (hillshade(z), "DEM as published: seams and speckle"),
        (hillshade(cleaned), "Denoised heightmap"),
        (prov, "Provenance: grey speckled, white cleaner"),
    ]
    jx, jy = body.latlon_to_stereographic(
        np.radians([j["lat"] for j in jets]), np.radians([j["lon_east"] for j in jets])
    )
    for ax, (image, title) in zip(axes, panels):
        ax.imshow(image, cmap="gray", extent=extent, interpolation="bilinear", vmin=0, vmax=255 if image is prov else 1)
        ax.set_title(title, color="white", fontsize=14)
        ax.tick_params(colors="#9fb0c3")
        ax.set_xlabel("km toward longitude 0", color="#9fb0c3")
        ax.set_ylabel("km toward longitude 90 E", color="#9fb0c3")
    axes[0].scatter(np.array(jx) / 1000, np.array(jy) / 1000, s=14, c="#ff7a59", edgecolors="none")
    fig.suptitle(
        "Enceladus south polar terrain as exported for Unreal, viewed from outside the moon",
        color="white", fontsize=17,
    )
    fig.tight_layout()
    fig.savefig(folder / "south_polar_overview.png", dpi=110, facecolor=fig.get_facecolor())
    plt.close(fig)


def run(dem) -> dict:
    results = {"roundtrip": check_roundtrip(dem), "registration": check_registration()}
    (OUT / "validation.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(json.dumps(results, indent=2))
    previews(dem)
    return results
