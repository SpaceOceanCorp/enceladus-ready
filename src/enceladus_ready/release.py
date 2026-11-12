"""Assemble the files for public hosting, each with a statement of changes and the original source."""

from __future__ import annotations

import json
import shutil
import zipfile
from pathlib import Path

from .serve import PRODUCTS
from .sources import CITATION, CREDIT, OUT, SOURCE_RECORDS, USGS, sha256

RELEASE = OUT / "release"
KIT = OUT / "unreal" / "south_polar_201km"
KIT_ZIP = "enceladus_south_polar_201km_unreal_kit.zip"
# Only the Schenk and McKinnon (2024) products and Horizons geometry are hosted. The Porco et al. (2014)
# jet table and the Cassini ISS insets are left out: their reuse terms have not been confirmed.
KIT_PARTS = ("relief", "true_shape", "lighting")
KIT_EXCLUDE = ("insets",)

ENDORSEMENT = (
    "These files are not endorsed by the authors, the Lunar and Planetary Institute / USRA, NASA or USGS. "
    "Errors introduced by the conversion are Space Ocean Corp's, not the authors'."
)


def _sources_block() -> str:
    lines = []
    for product in PRODUCTS.values():
        name = product["source"]
        lines += [
            f"* `{name}`",
            f"  * Record: {SOURCE_RECORDS[name]}",
            f"  * File: {USGS}/{name}",
        ]
    return "\n".join(lines)


def notice_text() -> str:
    return f"""# Enceladus data from enceladus-ready: changes and sources

Credit: {CREDIT}.

Cite: {CITATION}

{ENDORSEMENT}

## Original data

These files are converted from the Schenk and McKinnon (2024) global products distributed by USGS Astrogeology and the Planetary Data System. The originals are here:

{_sources_block()}

Code that produced every file: https://github.com/SpaceOceanCorp/enceladus-ready (Apache-2.0). The license covers the code only. The data remains subject to the terms and citation requests of its original publishers.

## What was changed, file by file

### Cloud-optimized DEM and mosaic (`*_cog.tif`)

* Re-encoded as cloud-optimized GeoTIFF: DEFLATE compression with predictor, 512 pixel tiles, overviews by averaging.
* A units tag of km was added to the DEM band. The original file does not label its units.
* Citation, source and change tags were added to the file metadata.
* Pixel values, grid, projection and nodata are unchanged. The full-resolution data is lossless. Only the overviews are new, resampled values.

### Unreal terrain kit (`{KIT_ZIP}`)

A 201.6 km square tile centered on the south pole, in two versions. Everything in it is derived and resampled, so none of it is the original data.

* `relief/heightmap.r16` and `heightmap.png`: the DEM resampled (cubic) onto a 1009 x 1009 grid at 200 m spacing in a polar stereographic plane, converted from km to meters and quantized to 16 bits (about 3.3 cm steps). `tile.json` gives the exact scale and offset.
* `relief/heightmap_denoised.*`: Space Ocean Corp's own derivative, not the authors' data. Gaussian smoothing (500 m sigma) is applied only where the DEM looks speckled, feathered over about 1 km. It changes heights by about 49 m RMS and up to about 370 m. Use `heightmap.r16` for anything quantitative.
* `relief/provenance.png`: Space Ocean Corp's own inference from DEM texture, marking patches that look speckled. The source has no per-pixel record of its origin.
* `relief/albedo_flattened_linear.png`: the mosaic resampled (bilinear) onto the tile and divided by a heavily smoothed copy of itself to remove broad brightness trends, then stretched to 16 bits. It is not true reflectance.
* `true_shape/`: the same steps, with each node moved to its true 3D position on the reference ellipsoid plus DEM height, expressed in a plane tangent at the pole.
* `lighting/`: Sun and Saturn directions computed from NASA/JPL Horizons. No Schenk and McKinnon data is in these files.

### STAC catalog (`collection.json`, `enceladus-*-schenk2024.json`)

Machine-readable index of the two cloud-optimized files, with links back to the original records.

## Not included

The published plume jet table (Porco et al. 2014) and the high-resolution Cassini image insets are built by the code but are not hosted here.

## Limits

The DEM grid is 200 m, but the true post spacing is about 400 m. Vertical precision is about 25 to 100 m per USGS and about 50 to 250 m per the source paper. Nothing below that scale is measured, and no file here supports lander-scale hazard assessment.

Heights are relative to a 256.2 x 251.4 x 248.6 km ellipsoid with its long axis at 4.15 degrees west, while the rasters are projected on a 256.2 km sphere. DEM values are in km.

Checksums for every hosted file are in `SHA256SUMS.txt`.
"""


def _place(source: Path, target: Path) -> None:
    if target.exists():
        target.unlink()
    try:
        target.hardlink_to(source)
    except OSError:
        shutil.copyfile(source, target)


def _kit_zip(target: Path, notice: str) -> None:
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        # Fixed time stamp so rebuilding gives the same zip and checksum.
        info = zipfile.ZipInfo("south_polar_201km/DATA-NOTICE.md", date_time=(2024, 8, 12, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, notice, compresslevel=6)
        for part in KIT_PARTS:
            for path in sorted((KIT / part).rglob("*")):
                rel = path.relative_to(KIT)
                if path.is_file() and not any(p in KIT_EXCLUDE for p in rel.parts):
                    archive.write(path, Path("south_polar_201km") / rel)


def _stac(target_dir: Path) -> list[Path]:
    """Copy the catalog with asset links pointing at files beside it, so it works from any host."""
    written = []
    for path in sorted((OUT / "stac").glob("*.json")):
        doc = json.loads(path.read_text(encoding="utf-8"))
        for asset in doc.get("assets", {}).values():
            asset["href"] = "./" + Path(asset["href"]).name
        out = target_dir / path.name
        out.write_text(json.dumps(doc, indent=2), encoding="utf-8")
        written.append(out)
    return written


def build() -> Path:
    for product in PRODUCTS.values():
        cog = OUT / "cog" / product["source"].replace(".tif", "_cog.tif")
        if not cog.exists():
            raise FileNotFoundError(f"{cog} missing; run `pixi run all` first")
    if not (KIT / "relief" / "tile.json").exists():
        raise FileNotFoundError("Unreal kit missing; run `pixi run all` first")

    if RELEASE.exists():
        shutil.rmtree(RELEASE)
    RELEASE.mkdir(parents=True)
    notice = notice_text()
    files = []
    (RELEASE / "DATA-NOTICE.md").write_text(notice, encoding="utf-8")
    files.append(RELEASE / "DATA-NOTICE.md")
    for product in PRODUCTS.values():
        name = product["source"].replace(".tif", "_cog.tif")
        _place(OUT / "cog" / name, RELEASE / name)
        files.append(RELEASE / name)
    _kit_zip(RELEASE / KIT_ZIP, notice)
    files.append(RELEASE / KIT_ZIP)
    files += _stac(RELEASE)

    lines = [f"{sha256(path)}  {path.name}" for path in files]
    # Unix line endings, so `sha256sum -c` works on Linux and macOS.
    (RELEASE / "SHA256SUMS.txt").write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    for path in files:
        print(f"{path.stat().st_size / 1e6:9.1f} MB  {path.name}")
    return RELEASE
