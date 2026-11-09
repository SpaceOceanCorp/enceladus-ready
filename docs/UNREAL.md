# Using the Enceladus kit in Unreal Engine

How to build the south-polar terrain kit, import it into Unreal Engine, confirm it landed correctly, and use its vent and lighting data.

> **Status:** the kit has been checked against its source data, but this workflow has not yet been confirmed in Unreal Engine. Run the checks in step 3 before building on it, and please [open an issue](https://github.com/SpaceOceanCorp/enceladus-ready/issues) with what you find.

The numbers below are for the kit produced by commit `3fe307c`. If you change the pipeline, use the values in each terrain's `tile.json`.

## 1. Build the kit

Install [pixi](https://pixi.sh), then run these in PowerShell or a shell:

```powershell
git clone https://github.com/SpaceOceanCorp/enceladus-ready.git
cd enceladus-ready
pixi run all
```

This downloads about 650 MB from the original sources. The kit appears in `out/unreal/south_polar_201km`.

| File | What it is |
|---|---|
| `relief/heightmap.r16` and `.png` | Published DEM on a flat plane. 1009 x 1009, 16-bit. |
| `relief/heightmap_denoised.r16` and `.png` | Same tile with noisy patches smoothed. For visuals only. |
| `true_shape/heightmap.r16` and `.png` | Same ground with the moon's real curvature. |
| `*/albedo_flattened_linear.png` | Cassini surface image. 2017 x 2017, 16-bit linear. |
| `*/provenance.png` | Noise map. 1009 x 1009, 8-bit. White 255 is cleaner DEM, grey 128 is speckled, black 0 has no source. |
| `*/tile.json` | Every import number for that terrain, plus its limits and sources. |
| `vents/porco2014_jets.csv` | 100 published jet sources. |
| `lighting/*.csv` | Hourly Sun and Saturn directions for two dates. |

A reference image is written to `out/previews/south_polar_overview.png`.

## 2. Pick a terrain

Both cover the same 201.6 x 201.6 km centered on the south pole, with one vertex every 200 m. Import them as separate levels because they share the same origin.

| Terrain | Use it for | Trade-off |
|---|---|---|
| `relief` | Walking, driving, vehicle work, most shots | Flat world, so gravity straight down works. Distances stretch by about 4% at the tile edges and 8% at the corners, and there is no real horizon curve. |
| `true_shape` | Horizons, orbital cameras, line of sight | Real curvature drops about 20 km at the edges and 43 km at the corners. The ground tilts about 24 degrees at the edges and 35 at the corners, so gravity straight down is wrong away from the pole. |

For good-looking ground, start with `relief/heightmap_denoised`. For anything measured, use `relief/heightmap`.

## 3. Import and check

Start in a plain level without World Partition for a first test. The grid is the same for both terrains: section size 63 x 63 quads, 1 section per component, 16 x 16 components, overall resolution 1009 x 1009.

| Setting | relief and denoised | true_shape |
|---|---|---|
| Scale X, Y | 20000, 20000 | 20000, 20000 |
| Scale Z | 419.054978 | 8422.711237 |
| Final actor location X, Y (cm) | -10080000, -10080000 | -10080000, -10080000 |
| Final actor location Z (cm) | -13663.464 | -2149117.501 |

### By hand, any UE5 version

1. Switch to Landscape mode, open Manage, and choose New, then Import from File.
2. Select `heightmap.png` and enter the grid and scale values above. Leave the panel's Location at zero.
3. Click Import.
4. Select the Landscape actor and type the final actor location into its Details panel. The New Landscape panel may treat Location as the center of the terrain, while these values are its corner, so setting them afterward removes any doubt.

### By script, UE 5.7

Install the [UnrealDEMLandscape](https://github.com/raulcastar/UnrealDEMLandscape) plugin from its Releases page, enable the Python Editor Script Plugin, and run this in the editor's Python console. Change the path to your kit. The plugin uses these values directly as the corner location.

```python
import unreal

KIT = "C:/Path/To/south_polar_201km"

# relief. For the denoised version, use heightmap_denoised.r16.
relief = unreal.DEMLandscapeLibrary.create_landscape(
    unreal.Transform(
        location=[-10080000.0, -10080000.0, -13663.46435546875],
        rotation=[0, 0, 0],
        scale=[20000.0, 20000.0, 419.05497777904935]),
    section_size=63, sections_per_component=1,
    component_count_x=16, component_count_y=16,
    heightmap_file=KIT + "/relief/heightmap.r16")
```

```python
# true_shape, in its own level.
true_shape = unreal.DEMLandscapeLibrary.create_landscape(
    unreal.Transform(
        location=[-10080000.0, -10080000.0, -2149117.500701388],
        rotation=[0, 0, 0],
        scale=[20000.0, 20000.0, 8422.71123716117]),
    section_size=63, sections_per_component=1,
    component_count_x=16, component_count_y=16,
    heightmap_file=KIT + "/true_shape/heightmap.r16")
```

### Confirm it landed correctly

Run a downward line trace at each world position. These points are exact vertices, so results should match to within 1 m on relief and 2 m on true_shape. World Z is in centimeters.

| Point | World X, Y (cm) | relief Z | denoised Z | true_shape Z |
|---|---|---|---|---|
| South pole | 0, 0 | -29,490 | -40,010 | -29,490 |
| +X edge | 10,080,000, 0 | -26,310 | -26,310 | -2,019,950 |
| +Y edge | 0, 10,080,000 | -23,000 | -24,080 | -2,133,850 |
| -X, -Y corner | -10,080,000, -10,080,000 | 33,430 | 33,430 | -4,283,090 |
| +X, +Y corner | 10,080,000, 10,080,000 | 19,150 | 21,170 | -4,279,730 |

**Orientation check:** rotate `out/previews/south_polar_overview.png` 90 degrees counterclockwise to match Unreal's Top view, where +X points up and +Y points right. Confirm those directions on the viewport's axis widget. The four long fractures should not appear mirrored.

## 4. Textures

| Texture | sRGB | Compression | Filter |
|---|---|---|---|
| `albedo_flattened_linear` | Off | Grayscale | Default |
| `provenance` | Off | Masks | Nearest |

Map textures from world position so they stay locked to the terrain. Using Absolute World Position in centimeters:

```text
UV            = (WorldPosition.XY + 10080000) / 20160000
Albedo UV     = (UV * 2016 + 0.5) / 2017
Provenance UV = (UV * 1008 + 0.5) / 1009
```

No V flip is needed. Row 0 is the -Y edge and column 0 is the -X edge.

The albedo has Cassini's shadows built in at small scale, so lit slopes can look double-shaded. Reduce its contrast if that shows, and multiply it to a bright base color, since the real surface is very reflective.

Vertices are 200 m apart, so the ground will look faceted up close. Any detail added to fix that is invented. See step 7.

### Optional: high-resolution Cassini insets, relief terrain only

Run `pixi run inset` after `pixi run all`. It adds real Cassini imagery from 31 October 2008 over patches of the tile, as fine as about 9 m per pixel, in `relief/insets/e5_2008/`. Each tier has an albedo, a blend mask and a source map, and `inset.json` records the bounds and alignment results.

| Tier | Pixels | World min X, Y (cm) | World max X, Y (cm) | Real coverage |
|---|---|---|---|---|
| `wide_20m` | 3532 x 4939 | -1702000, 204000 | 5360000, 10080000 | 2,234 km² |
| `detail_10m` | 1918 x 1551 | -29000, 205000 | 1888000, 1755000 | 152 km² |

```text
UV        = (WorldPosition.XY - WorldMin) / (WorldMax - WorldMin)
TextureUV = (UV * (Size - 1) + 0.5) / Size
Color     = lerp(BaseAlbedo, Wide20Albedo,   Wide20Mask)
Color     = lerp(Color,      Detail10Albedo, Detail10Mask)
```

* Use the same texture settings as the base albedo, with Masks compression for the masks. Outside each tier's bounds, treat its mask as zero.
* These textures are not power-of-two, so use Never Stream or a Power of Two padding mode, and confirm that they display at full resolution.
* This is sharper imagery on the same terrain. Height remains about 400 m, so the ridges you see are 2D until someone adds real geometry.
* Contrast is reduced for display and deep shadows are smoothed to hide Cassini's compression blocks. Do not use these pixels as reflectance values.
* Six of twelve candidate frames met the match threshold. Accepted frames sit within about 100 m of the base mosaic.
* Credit inset imagery to NASA/JPL-Caltech/Space Science Institute, along with the credits in step 7.

## 5. Vents

Import `vents/porco2014_jets.csv` as a DataTable using a row struct with these fields. The first CSV column, `Name`, becomes the row name.

```cpp
USTRUCT(BlueprintType)
struct FEnceladusJetRow : public FTableRowBase
{
    GENERATED_BODY()
    UPROPERTY(EditAnywhere) int32 JetId = 0;
    UPROPERTY(EditAnywhere) FString Sulcus;
    UPROPERTY(EditAnywhere) double Lat = 0, LonEast = 0, LonWestAsPublished = 0, HeightKm = 0;
    UPROPERTY(EditAnywhere) double ReliefXcm = 0, ReliefYcm = 0, ReliefZcm = 0;
    UPROPERTY(EditAnywhere) double TrueXcm = 0, TrueYcm = 0, TrueZcm = 0;
    UPROPERTY(EditAnywhere) double SurfaceNormalTrueX = 0, SurfaceNormalTrueY = 0, SurfaceNormalTrueZ = 1;
    UPROPERTY(EditAnywhere) double TiltZenithDeg = 0, TiltAzimuthDegAsPublished = 0, NormalizedSightings = 0;
    UPROPERTY(EditAnywhere) FString ConfidenceGroup;
};
```

* **Placement:** use the `Relief` columns on relief and the `True` columns on true_shape. All positions are world centimeters. Expect a vent to sit within roughly 50 m of the surface, because vents sit between vertices.
* **Direction:** emit straight up (+Z) on relief, and along `SurfaceNormalTrue` on true_shape. Do not apply the tilt columns yet, because the source paper does not define its azimuth direction.
* **Blanks:** jets 99 and 100 have empty tilt and sightings values, so the import may warn on those two rows.
* **Confidence:** 93 jets have `multiple_observation_sets`. The other 7 are weaker. `NormalizedSightings` is a reasonable starting point for relative emission strength, though it is not a measured flow rate.
* **Quick test:** Jet001 on relief is at X 3,434,994, Y -5,245,224, Z -44,376. Spawn a marker at every row and check that they trace the four fractures in the albedo.

Scientists disagree on whether the plumes are discrete jets or continuous curtains along the fractures. This table is the jet interpretation, so avoid describing it as the settled picture.

## 6. Lighting and scene

Each file in `lighting/` has 34 hourly rows, a little more than one 32.9-hour Enceladus day. Import it with a row struct containing `FString UTC` and a `double` for each other column, or read the values you need directly.

| Column | Use |
|---|---|
| `LightPitchDeg`, `LightYawDeg` | Set directly on the Directional Light rotation, with roll 0. Interpolate between rows for smooth motion. |
| `SaturnX`, `SaturnY`, `SaturnZ` | Unit vector from the scene toward Saturn. Place a far-away Saturn mesh along it. |
| `SunElevationAtPoleDeg` | Sun height above the horizon at the pole: about 5 degrees in 2008 and 8.8 degrees in November 2026. |

Row T000 of `cassini_e5_flyby_2008.csv` should give pitch -5.0274 and yaw -161.0984. The Sun stays low all day at the pole, so expect long shadows.

These starting values are general physics estimates, separate from the kit:

| Setting | Value | Why |
|---|---|---|
| World gravity Z | -11.3 cm/s² | Surface gravity is about 0.113 m/s². Character jump and walk tuning will need adjusting to match. |
| Sky Atmosphere and fog | Remove | Enceladus has no meaningful atmosphere, so the sky is black. |
| Directional Light | about 1,300 lux | Sunlight at Saturn is about 1/90 of Earth's. Use manual exposure. |
| Light Source Angle | about 0.056 degrees | The Sun's apparent size at Saturn, which gives sharp shadows. |
| Saturn apparent width | about 29 degrees | Seen from Enceladus. At the pole it sits on the horizon, so roughly half is visible. |

## 7. Data limits and credit

* Heights are measured only down to about 400 m horizontally. Vertical precision is 25 to 100 m according to USGS and about 50 to 250 m according to the source paper.
* Any boulder, crack, or surface texture added in Unreal is invented. That is fine for visuals, but it cannot be used for landing-site or hazard conclusions.
* About 73% of this tile is speckled, as shown in `provenance.png`. Treat bumps smaller than about 2 km in grey areas as likely noise. Straight seams between patches come from the source data.
* The denoised heightmap is a derivative made by this project and changes heights by about 49 m RMS. Label it that way in technical material.
* Do not imply that NASA, JPL, USGS or the data's authors endorse your work.

Include this credit wherever the terrain or data appears:

```text
Terrain and imagery: Schenk and McKinnon (2024), Icarus 408, 115827,
from NASA Cassini data, distributed by USGS and the NASA Planetary Data System.
Jet locations: Porco, DiNino and Nimmo (2014), Astronomical Journal 148, 45.
Ephemeris: NASA/JPL Horizons.
```

## 8. Tell us how it went

Please [open an issue](https://github.com/SpaceOceanCorp/enceladus-ready/issues) with:

1. The Unreal version, and whether you imported by hand or by script.
2. The actor location shown right after import, before you changed it.
3. Line trace results for the five check points, on each terrain you imported.
4. Whether the orientation matched the preview and the vents traced the fractures.
5. Anything that was confusing, wrong or missing here.
