"""Ice-shell thickness models and interior data for the browser globe.

Nobody has measured the shell directly. Published models infer it from
Cassini gravity, shape and libration, assuming the ice floats on the ocean
(isostasy): where the surface sits lower than a fluid body's natural shape,
the ice above the ocean must be thinner. Only long wavelengths are
compensated that way, and the models resolve features a few hundred km
across.

This module applies the same idea to the Schenk & McKinnon (2024) shape:

1. True radius = reference ellipsoid + DEM height, on a 1 degree grid.
2. Subtract the hydrostatic figure: the ellipsoid a fluid Enceladus would
   take under Saturn's tide and its own spin (Darwin-Radau, C/MR^2 = 0.335,
   long axis toward Saturn at longitude 0).
3. Keep spherical-harmonic degrees 1 to 8 (features larger than about
   200 km). This is the non-hydrostatic shape N.
4. Shell thickness t = mean + k * N, with the mean and amplitude k set per
   model (see MODELS). Clipped to at least 1 km.

Writes ``out/globe/interior.js`` (grids and model notes) and colored tiles
``out/globe/tiles/ice/<model>/{z}/{x}/{y}.png`` at levels 0-3.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from scipy.special import sph_harm_y

from .body import ellipsoid_radius
from .globe import DEM, OUT, TILE, _tile_bounds

LMAX = 8
RHO_ICE, RHO_WATER = 925.0, 1030.0
AIRY = RHO_WATER / (RHO_WATER - RHO_ICE)  # surface relief to shell-thickness change, about 9.8
GM = 7.2103e9          # m^3 s^-2
PERIOD_S = 1.370218 * 86400.0
MOI = 0.335            # normalized moment of inertia (Iess et al. 2014)
MIN_ICE_KM = 1.0


def _sh_basis(lat, lon):
    """Real, 4pi-normalized spherical harmonics up to LMAX at points (radians)."""
    theta, phi = np.pi / 2 - lat, lon
    cols, names = [], []
    for l in range(0, LMAX + 1):
        for m in range(0, l + 1):
            y = sph_harm_y(l, m, theta, phi)
            if m == 0:
                cols.append(y.real); names.append((l, 0))
            else:
                cols.append(np.sqrt(2) * y.real); names.append((l, m))
                cols.append(np.sqrt(2) * y.imag); names.append((l, -m))
    return np.stack(cols, -1), names


def _hydrostatic_radius(lat, lon, r_mean):
    """Radius of the hydrostatic triaxial figure, metres."""
    omega = 2 * math.pi / PERIOD_S
    q = omega ** 2 * r_mean ** 3 / GM
    h_f = 5.0 / (2.0 * (1.0 + 6.25 * (1.0 - 1.5 * MOI) ** 2))  # Darwin-Radau fluid Love number
    a_c = 2.0 * h_f * q * r_mean
    b_c = 0.5 * h_f * q * r_mean
    c = r_mean - (a_c + b_c) / 3.0
    a, b = c + a_c, c + b_c
    cl = np.cos(lat)
    r = 1.0 / np.sqrt((cl * np.cos(lon) / a) ** 2 + (cl * np.sin(lon) / b) ** 2 + (np.sin(lat) / c) ** 2)
    return r, {"a_minus_c_km": a_c / 1000, "b_minus_c_km": b_c / 1000, "q": q, "h_f": h_f}


def surface_grid(step=1.0):
    """Lat/lon node grid and the true surface radius (m) from ellipsoid + DEM."""
    ds = rasterio.open(DEM)
    lats = np.arange(-90.0, 90.0 + 1e-9, step)
    lons = np.arange(-180.0, 180.0 + 1e-9, step)
    # Read the DEM averaged to about the grid spacing, then sample at nodes.
    nrow, ncol = int(180 / step) * 2, int(360 / step) * 2
    h = ds.read(1, out_shape=(nrow, ncol), resampling=Resampling.average, masked=True).filled(0).astype(np.float64)
    from scipy.ndimage import map_coordinates
    la, lo = np.meshgrid(lats, lons, indexing="ij")
    rows = (90.0 - la) / 180.0 * nrow - 0.5
    cols = (lo + 180.0) / 360.0 * ncol - 0.5
    hk = map_coordinates(h, [rows.clip(0, nrow - 1), np.mod(cols, ncol)], order=1, mode="wrap")
    r = ellipsoid_radius(np.radians(la), np.radians(lo)) + hk * 1000.0
    return lats, lons, r


def nonhydrostatic_shape():
    lats, lons, r = surface_grid(1.0)
    la, lo = np.meshgrid(np.radians(lats), np.radians(lons), indexing="ij")
    w = np.cos(la).clip(1e-3)
    r_mean = float((r * w).sum() / w.sum())
    rh, hyd = _hydrostatic_radius(la, lo, r_mean)
    n = r - rh
    Y, names = _sh_basis(la.ravel(), lo.ravel())
    # On an even 1 degree grid with cos(lat) area weights the harmonics are orthogonal to well
    # past degree 8, so each coefficient is a weighted projection. (numpy's lstsq also crashes
    # in this environment's LAPACK build, which this avoids.)
    wv = w.ravel()
    coef = (Y * (n.ravel() * wv)[:, None]).sum(0) / (Y * Y * wv[:, None]).sum(0)
    keep = np.array([l >= 1 for l, _ in names])
    n8 = (Y[:, keep] @ coef[keep]).reshape(n.shape)
    return lats, lons, r, n8, r_mean, hyd, Y, names, coef, keep


def _value_at(lats, lons, grid, lat, lon):
    i = int(round((lat + 90.0)))
    j = int(round((lon + 180.0)))
    return float(grid[i, j])


def build_models(lats, lons, n8):
    """Each model: mean thickness, amplitude, core radius. Notes say where each number comes from."""
    la = np.radians(lats)[:, None] * np.ones((1, lons.size))
    w = np.cos(la).clip(1e-3)
    n_sp = _value_at(lats, lons, n8, -90.0, 0.0)
    mean_n = float((n8 * w).sum() / w.sum())

    def make(key, name, mean_km, k, core_km, notes, cite):
        t = mean_km + k * (n8 - mean_n) / 1000.0
        t = np.maximum(t, MIN_ICE_KM)
        # The page recomputes t = max(mean + k * (n_km - n_mean_km), floor) from the shared n grid.
        return {"key": key, "name": name, "mean_km": mean_km, "k": round(k, 4), "n_mean_km": round(mean_n / 1000.0, 5),
                "floor_km": MIN_ICE_KM, "core_km": core_km, "notes": notes, "cite": cite, "t": t}

    # Cadek et al. 2016: mean 18-22 km, under 5 km at the south pole, core 180-185 km.
    # Their two numbers fix the amplitude k; the other averages reuse that pattern.
    k_cadek = (4.0 - 20.0) / ((n_sp - mean_n) / 1000.0)
    pattern_note = ("Pattern: our floating-ice calculation on the Schenk & McKinnon (2024) shape "
                    "(features larger than about 200 km), scaled to the Čadek et al. 2016 south-pole value.")
    models = [
        make("cadek2016", "Čadek et al. 2016", 20.0, k_cadek, 182.5, [
            "From the paper: average shell 18–22 km (20 used), under 5 km at the south pole (4 used), rocky core 180–185 km (182.5 used).",
            pattern_note,
        ], "Čadek, O. et al. (2016), Geophys. Res. Lett. 43, 5653–5660. doi:10.1002/2016GL068634"),
        make("hemingway2019", "Hemingway & Mittal 2019 average", 21.0, k_cadek, 185.0, [
            "From the paper: average shell about 21 km.",
            pattern_note + " The paper's own map is not reproduced here.",
            "Core radius 185 km is a typical value, not taken from this paper.",
        ], "Hemingway, D. J. & Mittal, T. (2019), Icarus 332, 111–131. doi:10.1016/j.icarus.2019.03.011"),
        make("park2024", "Park et al. 2024 average", 30.0, k_cadek, 252.0 - 30.0 - 23.5, [
            "From the paper: average shell 27–33 km (30 used) and ocean 21–26 km (23.5 used), so a rocky core of about 198.5 km.",
            pattern_note + " The paper's own map is not reproduced here.",
        ], "Park, R. S. et al. (2024), J. Geophys. Res. Planets: The global shape, gravity field, and libration of Enceladus."),
        _planetprofile(make),
        make("airy", "Plain floating ice", 20.0, AIRY, 182.5, [
            f"Physics only, no calibration: every metre of missing relief means about {AIRY:.1f} m less ice (ice {RHO_ICE:.0f}, ocean {RHO_WATER:.0f} kg/m³).",
            "This ignores the stiffness of the ice and overstates the contrasts. The ice pinches to the 1 km floor near the south pole.",
            "Average 20 km and core 182.5 km as in Čadek et al. 2016.",
        ], "Our calculation from the Schenk & McKinnon (2024) topography."),
    ]
    return models


PLANETPROFILE = Path(__file__).resolve().parents[2] / "docs" / "planetprofile" / \
    "EnceladusProfile_Seawater_10.0ppt_Tb272.4578K_PorousRock_phi0.32_Pc3.50e+02.txt"


def planetprofile_header(path=PLANETPROFILE):
    """Numbers from the header of a PlanetProfile output file (see docs/planetprofile/README.md)."""
    out = {}
    for line in path.read_text(encoding="utf8").splitlines()[:90]:
        if " = " in line:
            k, v = line.strip().split(" = ", 1)
            try:
                out[k.strip()] = float(v)
            except ValueError:
                out[k.strip()] = v.strip()
    return out


def _planetprofile(make):
    """PlanetProfile's default Enceladus: one-dimensional, so the same shell thickness everywhere (k = 0)."""
    h = planetprofile_header()
    ice, ocean, core = h["zb_km"], h["D_km"], h["RsilMean_m"] / 1000.0
    return make("planetprofile", "PlanetProfile (JPL) default", round(ice, 1), 0.0, round(core, 1), [
        f"Run of PlanetProfile 3.1.2 with its default Enceladus settings: ice shell {ice:.1f} km, ocean {ocean:.1f} km, "
        f"porous rock core {core:.1f} km in radius with no iron core.",
        f"Ocean: seawater-like, 10 g of salt per kg, density {h['rhoOcean_kgm3']:.0f} kg/m³. Rock: {h['rhoSil_kgm3']:.0f} kg/m³ "
        f"with {100 * h['phiRockCalc_frac']:.0f}% pore space. Surface heat flow {1000 * h['qSurf_Wm2']:.1f} mW/m².",
        f"Its interior matches the measured moment of inertia ({h['CMR2mean']:.4f} vs 0.335). "
        "The model is one-dimensional, so the shell is the same thickness everywhere; the ocean depth still varies with the moon's shape.",
    ], "Vance, S. D. et al. (2018), J. Geophys. Res. Planets 123, 180–205; PlanetProfile (github.com/vancesteven/PlanetProfile, GPL-3). "
       "Output file and how to reproduce it: docs/planetprofile in enceladus-ready.")


def _ice_colors(t_km):
    """Thin ice warm and bright (ocean close), thick ice deep blue."""
    stops = np.array([
        [0, 255, 236, 140], [5, 255, 170, 70], [10, 236, 96, 84], [15, 190, 60, 120],
        [20, 120, 60, 160], [27, 60, 80, 170], [35, 30, 60, 130], [50, 15, 25, 70],
    ], dtype=float)
    out = np.empty(t_km.shape + (3,), np.float32)
    for i in range(3):
        out[..., i] = np.interp(t_km, stops[:, 0], stops[:, i + 1])
    return out, stops


def _tiles(model, Y_fn, max_z=3):
    from scipy.ndimage import map_coordinates
    t = model["t"]
    for z in range(max_z + 1):
        span = 180.0 / (1 << z)
        for y in range(1 << z):
            for x in range(2 << z):
                lat_n, lat_s, lon_w, lon_e = _tile_bounds(z, x, y)
                px = span / TILE
                la, lo = np.meshgrid(lat_n - (np.arange(TILE) + 0.5) * px, lon_w + (np.arange(TILE) + 0.5) * px, indexing="ij")
                v = map_coordinates(t, [la + 90.0, lo + 180.0], order=3, mode="nearest")
                col, _ = _ice_colors(v)
                # Contour lines every 5 km.
                band = np.floor(v / 5.0)
                edge = np.zeros_like(v, bool)
                edge[:, 1:] |= band[:, 1:] != band[:, :-1]
                edge[1:, :] |= band[1:, :] != band[:-1, :]
                col[edge] = col[edge] * 0.35 + 255 * 0.65
                rgba = np.concatenate([col, np.full(v.shape + (1,), 255, np.float32)], -1).astype(np.uint8)
                p = OUT / "tiles" / "ice" / model["key"] / str(z) / str(x) / f"{y}.png"
                p.parent.mkdir(parents=True, exist_ok=True)
                Image.fromarray(rgba, "RGBA").save(p, optimize=True)


def build():
    lats, lons, r, n8, r_mean, hyd, *_ = nonhydrostatic_shape()
    models = build_models(lats, lons, n8)
    for m in models:
        t = m["t"]
        print(f"{m['key']}: k={m['k']:.2f}  min {t.min():.1f}  max {t.max():.1f}  "
              f"south pole {_value_at(lats, lons, t, -90, 0):.1f}  north pole {_value_at(lats, lons, t, 90, 0):.1f} km")
        _tiles(m, None)
    _, stops = _ice_colors(np.zeros(1))
    payload = {
        "step": 1.0, "nlat": int(lats.size), "nlon": int(lons.size),
        # Surface radius in metres minus the display sphere, int16, row 0 = 90 S.
        "surface": np.round(r - 252_100.0).astype(int).ravel().tolist(),
        "r_mean_m": round(r_mean, 1), "hydrostatic": {k: round(v, 5) for k, v in hyd.items()},
        "lmax": LMAX, "colors": stops.tolist(),
        # Non-hydrostatic shape, degrees 1-8, in km (row 0 = 90 S, column 0 = 180 W).
        "n_km": np.round(n8 / 1000.0, 3).ravel().tolist(),
        "models": [{k: v for k, v in m.items() if k != "t"} for m in models],
    }
    (OUT / "interior.js").write_text("window.ENC_INTERIOR=" + json.dumps(payload, separators=(",", ":")) + ";\n", encoding="utf8")
    print(f"interior.js written ({(OUT / 'interior.js').stat().st_size / 1e6:.1f} MB); hydrostatic {hyd}")


if __name__ == "__main__":
    build()
