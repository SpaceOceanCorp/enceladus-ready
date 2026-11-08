"""Cloud-optimized copies of the USGS rasters and a static STAC catalog."""

from __future__ import annotations

import json
import shutil

import rasterio
import rasterio.shutil as rio_shutil

from .sources import CITATION, DEM, MOSAIC, OUT, RAW, sha256

PRODUCTS = {
    "dem": {
        "source": DEM,
        "title": "Enceladus global DEM, cloud-optimized",
        "unit": "km",
        "description": "Height above the ellipsoid 256.2 x 251.4 x 248.6 km. 200 m grid, about 400 m true post spacing, 25 to 100 m vertical precision.",
        "gsd": 200.0,
    },
    "mosaic": {
        "source": MOSAIC,
        "title": "Enceladus global image mosaic, cloud-optimized",
        "unit": None,
        "description": "Cassini ISS clear-filter mosaic at 100 m per pixel on the map grid.",
        "gsd": 100.0,
    },
}


def make_cogs() -> dict:
    folder = OUT / "cog"
    folder.mkdir(parents=True, exist_ok=True)
    results = {}
    for key, product in PRODUCTS.items():
        source, target = RAW / product["source"], folder / product["source"].replace(".tif", "_cog.tif")
        working = folder / (product["source"] + ".working.tif")
        shutil.copyfile(source, working)
        with rasterio.open(working, "r+") as dst:
            if product["unit"]:
                dst.units = (product["unit"],)
            dst.update_tags(CITATION=CITATION, DERIVED_BY="enceladus-ready 0.1.0, lossless re-encoding")
        rio_shutil.copy(
            working, target, driver="COG", compress="DEFLATE", predictor="YES",
            blocksize=512, overview_resampling="average", num_threads="ALL_CPUS", bigtiff="IF_SAFER",
        )
        working.unlink()
        results[key] = {"path": target, "bytes": target.stat().st_size, "source_bytes": source.stat().st_size}
        print(key, f"{results[key]['source_bytes'] / 1e6:.0f} MB -> {results[key]['bytes'] / 1e6:.0f} MB")
    return results


def write_stac(cogs: dict) -> None:
    root = OUT / "stac"
    root.mkdir(parents=True, exist_ok=True)
    bbox = [-180.0, -90.0, 180.0, 90.0]
    geometry = {"type": "Polygon", "coordinates": [[[-180, -90], [180, -90], [180, 90], [-180, 90], [-180, -90]]]}
    links = [{"rel": "root", "href": "./collection.json", "type": "application/json"}]
    for key, product in PRODUCTS.items():
        with rasterio.open(cogs[key]["path"]) as src:
            wkt = src.crs.to_wkt()
            shape = [src.height, src.width]
            transform = list(src.transform)[:6]
        band = {"nodata": "-3.40282265508890445e+38"}
        if product["unit"]:
            band["unit"] = product["unit"]
        item = {
            "type": "Feature", "stac_version": "1.0.0", "id": f"enceladus-{key}-schenk2024",
            "stac_extensions": [
                "https://stac-extensions.github.io/projection/v1.1.0/schema.json",
                "https://stac-extensions.github.io/raster/v1.1.0/schema.json",
            ],
            "geometry": geometry, "bbox": bbox,
            "properties": {
                "title": product["title"], "description": product["description"],
                "datetime": "2024-08-12T00:00:00Z", "gsd": product["gsd"], "ssys:targets": ["Enceladus"],
                "proj:wkt2": wkt, "proj:shape": shape, "proj:transform": transform,
                "sci:citation": CITATION,
            },
            "assets": {"data": {
                "href": f"../cog/{cogs[key]['path'].name}",
                "type": "image/tiff; application=geotiff; profile=cloud-optimized",
                "roles": ["data"], "raster:bands": [band],
                "file:checksum_sha256": sha256(cogs[key]["path"]),
            }},
            "links": [
                {"rel": "root", "href": "./collection.json", "type": "application/json"},
                {"rel": "parent", "href": "./collection.json", "type": "application/json"},
            ],
            "collection": "enceladus-ready",
        }
        (root / f"{item['id']}.json").write_text(json.dumps(item, indent=2), encoding="utf-8")
        links.append({"rel": "item", "href": f"./{item['id']}.json", "type": "application/geo+json"})
    collection = {
        "type": "Collection", "stac_version": "1.0.0", "id": "enceladus-ready",
        "title": "Enceladus analysis-ready map products",
        "description": "Lossless cloud-optimized versions of the USGS and PDS Schenk & McKinnon (2024) global Enceladus products.",
        "license": "various",
        "extent": {"spatial": {"bbox": [bbox]}, "temporal": {"interval": [["2004-07-01T00:00:00Z", "2017-09-15T00:00:00Z"]]}},
        "summaries": {"ssys:targets": ["Enceladus"]},
        "links": links,
    }
    (root / "collection.json").write_text(json.dumps(collection, indent=2), encoding="utf-8")
