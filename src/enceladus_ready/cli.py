"""Command line entry point: python -m enceladus_ready.cli <step>."""

from __future__ import annotations

import argparse

from . import ancillary, globe, inset, release, serve, sources, tile, validate, viewer


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("step", choices=["fetch", "cog", "tile", "ephem", "inset", "viewer", "globe", "photos", "release", "all"])
    step = parser.parse_args().step

    if step in ("fetch", "all"):
        sources.fetch()
    if step in ("cog", "all"):
        serve.write_stac(serve.make_cogs())
    if step in ("ephem", "all"):
        ancillary.write_ephemeris()
    if step in ("tile", "all"):
        dem, mosaic = tile.load_sources()
        print(f"invalid fractions south of 45 S: DEM {dem.invalid_fraction:.5f}, mosaic {mosaic.invalid_fraction:.5f}")
        tile.build(dem, mosaic)
        ancillary.write_vents(dem)
        validate.run(dem)
    if step == "inset":
        inset.build()
    if step == "viewer":
        viewer.build()
    if step == "globe":
        globe.build_all()
    if step == "photos":
        from . import globe_photos  # optional: real Cassini photos for the globe
        globe_photos.build()
    if step == "release":
        release.build()


if __name__ == "__main__":
    main()
