"""What gets downloaded, from where, and how to read the rasters."""

from __future__ import annotations

import hashlib
import shutil
import urllib.request
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import Window
from scipy.ndimage import distance_transform_edt, map_coordinates

from .body import MAP_SPHERE_M

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw"
ANCILLARY = ROOT / "data" / "ancillary"
OUT = ROOT / "out"

USGS = "https://asc-astropedia.s3.us-west-2.amazonaws.com/Enceladus/Cassini"
DEM = "Enceladus_Cassini_DEM_global_200m_schenk2024.tif"
MOSAIC = "Enceladus_Cassini_mosaic_global_100m_schenk2024.tif"
CITATION = (
    "Schenk, P.M. and McKinnon, W.B. (2024). New global topography of Enceladus. "
    "Icarus 408, 115827. doi:10.1016/j.icarus.2023.115827"
)
SOURCE_RECORDS = {
    DEM: "https://astrogeology.usgs.gov/search/map/enceladus-cassini-global-dem-200m-schenk",
    MOSAIC: "https://astrogeology.usgs.gov/search/map/enceladus-cassini-global-mosaic-100m-schenk",
}
CREDIT = "Schenk and McKinnon (2024), Lunar and Planetary Institute / USRA"
JETS_CITATION = "Porco, C., DiNino, D. and Nimmo, F. (2014). Astronomical Journal 148, 45, Table 2."

DOWNLOADS = [
    (RAW / DEM, f"{USGS}/{DEM}", "7c08c46238cde6528c9143f0c667d42cd3bc6ac60c572595a7e6cad2d6775f91"),
    (RAW / MOSAIC, f"{USGS}/{MOSAIC}", "1738c5cf8e856c7ae262d858261af0fbb32503a68a524884d36194afb23afcc5"),
    (
        ANCILLARY / "porco2014_table2.txt",
        "https://iopscience.iop.org/1538-3881/148/3/45/suppdata/aj497840t2_ascii.txt"
        "?doi=10.1088/0004-6256/148/3/45",
        None,
    ),
]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def fetch() -> None:
    """Download anything missing and check pinned checksums."""
    for path, url, expected in DOWNLOADS:
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            print(f"downloading {path.name}")
            request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 enceladus-ready/0.1"})
            with urllib.request.urlopen(request, timeout=120) as response, open(path, "wb") as out:
                shutil.copyfileobj(response, out)
        if expected:
            actual = sha256(path)
            if actual != expected:
                raise RuntimeError(f"{path.name}: checksum {actual} does not match pinned {expected}")
        print(f"ok {path.name}")


class EquirectRaster:
    """Southern part of a USGS global raster, ready for lat/lon sampling."""

    PAD = 6

    def __init__(self, path: Path, north_limit_deg: float = -45.0):
        with rasterio.open(path) as src:
            t = src.transform
            self.dx, self.dy, self.x0, self.y0 = t.a, -t.e, t.c, t.f
            start = int((self.y0 - MAP_SPHERE_M * np.radians(north_limit_deg)) / self.dy)
            self.row0 = max(0, start)
            data = src.read(1, window=Window(0, self.row0, src.width, src.height - self.row0)).astype(np.float64)
            nodata = src.nodata
        invalid = ~np.isfinite(data) | (data <= nodata * 0.5 if nodata is not None and nodata < 0 else False)
        # The USGS grid is slightly wider than 360 degrees and its last column is empty.
        if invalid[:, -1].all():
            data, invalid = data[:, :-1], invalid[:, :-1]
        self.invalid_fraction = float(invalid.mean())
        if invalid.any():
            nearest = distance_transform_edt(invalid, return_distances=False, return_indices=True)
            data = data[tuple(nearest)]
        pad = self.PAD
        self.data = np.concatenate([data[:, -pad:], data, data[:, :pad]], axis=1).astype(np.float32)
        self.valid = np.concatenate([~invalid[:, -pad:], ~invalid, ~invalid[:, :pad]], axis=1)

    def _coords(self, lat_deg, lon_east_deg):
        lon = np.mod(lon_east_deg, 360.0)
        x = MAP_SPHERE_M * np.radians(lon - 180.0)
        y = MAP_SPHERE_M * np.radians(lat_deg)
        col = (x - self.x0) / self.dx - 0.5 + self.PAD
        row = (self.y0 - y) / self.dy - 0.5 - self.row0
        return np.stack([np.ravel(row), np.ravel(col)])

    def sample(self, lat_deg, lon_east_deg, order: int = 1):
        lat_deg, lon_east_deg = np.asarray(lat_deg), np.asarray(lon_east_deg)
        out = map_coordinates(self.data, self._coords(lat_deg, lon_east_deg), order=order, mode="nearest")
        return out.reshape(lat_deg.shape)

    def sample_valid(self, lat_deg, lon_east_deg):
        lat_deg, lon_east_deg = np.asarray(lat_deg), np.asarray(lon_east_deg)
        out = map_coordinates(self.valid.astype(np.uint8), self._coords(lat_deg, lon_east_deg), order=0, mode="nearest")
        return out.reshape(lat_deg.shape).astype(bool)
