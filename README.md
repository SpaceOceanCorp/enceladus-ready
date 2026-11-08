# enceladus-ready

Public Enceladus map data, converted into forms people can actually use: cloud-optimized rasters, a STAC catalog, and Unreal Engine terrain kits.

The Cassini-derived products are excellent and free, but they are built for measurement. This project does the conversion work once, in the open, and records every assumption.

## What it produces

| Output | Path | Use |
|---|---|---|
| Cloud-optimized DEM and mosaic | `out/cog/` | Stream into QGIS, TiTiler or a web map. Pixel values are identical to the USGS originals. |
| STAC catalog | `out/stac/` | Machine-readable index. The USGS planetary catalog had no Enceladus collection as of November 2026. |
| South-polar Unreal kit | `out/unreal/south_polar_201km/` | Terrain, textures, vents and lighting tables for a 201.6 km tile centered on the south pole. |
| Checks and previews | `out/validation.json`, `out/previews/` | Evidence that the export matches the source. |

## Run it

Install [pixi](https://pixi.sh), then from this folder in PowerShell:

```powershell
pixi run all
pixi run test
```

This downloads about 650 MB from USGS and takes under two minutes after that.

## Using the Unreal kit

There are two versions of the same ground. Each folder has a `tile.json` with every number you need.

| Folder | Geometry | Use it for |
|---|---|---|
| `relief/` | Flat plane, height above the reference ellipsoid | Walking, driving, framing. Gravity straight down works. |
| `true_shape/` | Real 3D curvature in a plane tangent at the pole | Horizons, orbital cameras, line of sight. |

**Import by hand:** Landscape mode, New, Import from File, choose `heightmap.png`. Set the component layout, location and scale from the `landscape` block of `tile.json`.

**Import by script:** [UnrealDEMLandscape](https://github.com/raulcastar/UnrealDEMLandscape) (UE 5.7) accepts `heightmap.r16` and the same numbers.

**Heightmaps:** `relief/heightmap.r16` is the published DEM. `relief/heightmap_denoised.r16` smooths only the speckled patches and is meant for visuals.

**Albedo:** `albedo_flattened_linear.png` is 16-bit linear, so turn sRGB off. Broad brightness trends are removed, but small-scale Cassini shadows remain. It is not true reflectance.

**Vents:** `vents/porco2014_jets.csv` imports as a DataTable. It holds 100 published jet sources with positions for both terrain versions. Published tilts are passed through, but no tilted direction is computed because the paper does not state its azimuth convention.

**Lighting:** `lighting/*.csv` gives Sun and Saturn directions and a ready DirectionalLight pitch and yaw at hourly steps from JPL Horizons.

## Frame

* Origin at the south pole. X is toward longitude 0 (Saturn-facing), Y is toward 90 E, Z is up.
* Longitude is positive east throughout. West-positive sources are converted on the way in.
* Unreal's left-handed frame is reached by negating one axis, so the moon is not mirrored.

## What the source data contains, and the traps

* The rasters are projected on a 256.2 km sphere, but heights are relative to a 256.2 x 251.4 x 248.6 km ellipsoid. Adding heights to the sphere is wrong by up to 7.6 km at the poles.
* That ellipsoid's long axis sits at 4.15 degrees west, not at longitude 0. The paper describes the shift, and a fit to the published DEM confirms it.
* DEM values are in kilometers. The GeoTIFF and its PDS4 label do not say so, only the USGS catalog page does.
* The DEM grid is 200 m, but the true post spacing is about 400 m. Vertical precision is given as 25 to 100 m by USGS and about 50 to 250 m by the source paper.
* The DEM combines 97 separate stereo DEMs, each fitted to a sparser control-point shape model. Sharp seams separate cleaner areas from speckled patches, and about 73% of this tile falls in speckled patches.

## Limits

Nothing below about 400 m horizontally is measured. Any boulder, crack or surface detail added in an engine is invented, and no data here supports lander-scale hazard assessment. The provenance layer is an inference from DEM texture, because the source has no per-pixel record of its origin.

Plume data here follows the discrete-jet reading (Porco et al. 2014). Spitale et al. (2015, 2025) interpret the same activity as curtain eruptions, and that layer is planned.

## Checks

* Rebuilding moon coordinates from the exported files alone matches the DEM to 0.01 m (relief) and 0.2 m (true shape) RMS.
* Published jets land on the tiger stripes in the exported mosaic. Only 1.4% of random rotations of the jet pattern score as well, and flipping the longitude sign scores below the random average.
* The kit has not yet been opened in Unreal Engine.

## Sources and credit

* Schenk, P.M. and McKinnon, W.B. (2024). New global topography of Enceladus. Icarus 408, 115827. doi:10.1016/j.icarus.2023.115827. Distributed by USGS Astrogeology and the Planetary Data System.
* Porco, C., DiNino, D. and Nimmo, F. (2014). Astronomical Journal 148, 45, Table 2.
* NASA/JPL Horizons for Sun and Saturn geometry.

Downloaded data and generated outputs are not stored in this repository. The pipeline fetches them from the original sources.

## License

The code is licensed under Apache-2.0, see [LICENSE](LICENSE). The source data is not covered by that license and remains subject to the terms and citation requests of its original publishers.

Maintained by Space Ocean Corp.
