"""Vents, and Sun and Saturn directions."""

from __future__ import annotations

import csv
import json
import urllib.parse
import urllib.request

import numpy as np

from . import body
from .sources import ANCILLARY, JETS_CITATION, OUT
from .tile import TILE_ID

HORIZONS = "https://ssd.jpl.nasa.gov/api/horizons.api"

# Named moments for lighting. Add your own with add_epoch-style entries here.
EPOCHS = {
    "cassini_e5_flyby_2008": ("2008-10-09 19:00", "2008-10-11 04:00"),
    "generated_2026": ("2026-11-08 00:00", "2026-11-09 09:00"),
}


def parse_jets(path=ANCILLARY / "porco2014_table2.txt"):
    """Parse Porco et al. Table 2. Source longitude is WEST-positive."""
    def number(text):
        text = text.replace("^*", "").strip()
        return None if text in ("N/A", "") else float(text)

    jets, group = [], "multiple_observation_sets"
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.startswith("Jets whose locations and tilts"):
            group = "single_observation_set"
        elif line.startswith("Jets whose locations were"):
            group = "single_image_and_shadow_height"
        parts = [p.strip() for p in line.split("\t")]
        if len(parts) < 12 or not parts[0].isdigit():
            continue
        lon_west = number(parts[2])
        jets.append({
            "id": int(parts[0]),
            "sulcus": parts[11],
            "lat": number(parts[1]),
            "lon_west": lon_west,
            "lon_east": float(body.west_to_east(lon_west)),
            "position_error_deg": number(parts[3]),
            "tilt_zenith_deg": number(parts[4]),
            "tilt_azimuth_deg_as_published": number(parts[5]),
            "normalized_sightings": number(parts[12]) if len(parts) > 12 else None,
            "confidence_group": group,
        })
    return jets


def write_vents(dem) -> list:
    """Write vent positions as a CSV that Unreal can import as a DataTable."""
    jets = parse_jets()
    folder = OUT / "unreal" / TILE_ID / "vents"
    folder.mkdir(parents=True, exist_ok=True)
    fields = [
        "Name", "JetId", "Sulcus", "Lat", "LonEast", "LonWestAsPublished", "HeightKm",
        "ReliefXcm", "ReliefYcm", "ReliefZcm", "TrueXcm", "TrueYcm", "TrueZcm",
        "SurfaceNormalTrueX", "SurfaceNormalTrueY", "SurfaceNormalTrueZ",
        "TiltZenithDeg", "TiltAzimuthDegAsPublished", "NormalizedSightings", "ConfidenceGroup",
    ]
    with open(folder / "porco2014_jets.csv", "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(fields)
        for jet in jets:
            lat, lon = np.radians(jet["lat"]), np.radians(jet["lon_east"])
            h_km = float(dem.sample(np.array([jet["lat"]]), np.array([jet["lon_east"]]), order=1)[0])
            rx, ry = body.latlon_to_stereographic(lat, lon)
            r = float(body.ellipsoid_radius(lat, lon)) + h_km * 1000.0
            bx, by, bz = body.body_from_latlon(lat, lon, r)
            nx, ny, nz = body.body_to_unreal(body.body_from_latlon(lat, lon, 1.0))
            writer.writerow([
                f"Jet{jet['id']:03d}", jet["id"], jet["sulcus"], jet["lat"], round(jet["lon_east"], 3), jet["lon_west"],
                round(h_km, 4), round(float(rx) * 100), round(float(ry) * 100), round(h_km * 100000),
                round(float(bx) * 100), round(float(by) * 100), round((-float(bz) - body.C_M) * 100),
                round(float(nx), 5), round(float(ny), 5), round(float(nz), 5),
                "" if jet["tilt_zenith_deg"] is None else jet["tilt_zenith_deg"],
                "" if jet["tilt_azimuth_deg_as_published"] is None else jet["tilt_azimuth_deg_as_published"],
                "" if jet["normalized_sightings"] is None else jet["normalized_sightings"],
                jet["confidence_group"],
            ])
    (folder / "README.json").write_text(json.dumps({
        "citation": JETS_CITATION,
        "scope": "Discrete-jet interpretation only. Spitale et al. (2015, 2025) read the same activity as curtains along the fractures, and that layer is not included yet.",
        "tilts": "Published zenith and azimuth are passed through unchanged. The paper does not state the azimuth reference direction or rotation sense, so no tilted direction vector is computed. Emit along the surface normal unless the convention is confirmed.",
        "longitude": "Published values are west-positive. LonEast is converted and matches the DEM.",
    }, indent=2), encoding="utf-8")
    print(f"vents: {len(jets)} jets")
    return jets


def horizons_rows(start: str, stop: str):
    """Sub-Saturn and sub-solar points from JPL Horizons (west-positive longitude)."""
    params = {
        "format": "text", "COMMAND": "'602'", "OBJ_DATA": "'NO'", "MAKE_EPHEM": "'YES'",
        "EPHEM_TYPE": "'OBSERVER'", "CENTER": "'500@699'", "START_TIME": f"'{start}'",
        "STOP_TIME": f"'{stop}'", "STEP_SIZE": "'1 h'", "QUANTITIES": "'14,15'", "ANG_FORMAT": "'DEG'",
    }
    url = HORIZONS + "?" + urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
    request = urllib.request.Request(url, headers={"User-Agent": "enceladus-ready/0.1"})
    with urllib.request.urlopen(request, timeout=90) as response:
        text = response.read().decode("utf-8", errors="replace")
    block = text.split("$$SOE")[1].split("$$EOE")[0]
    rows = []
    for line in block.strip().splitlines():
        parts = line.split()
        rows.append((" ".join(parts[:2]), *[float(v) for v in parts[2:6]]))
    return rows


def write_ephemeris() -> dict:
    folder = OUT / "unreal" / TILE_ID / "lighting"
    folder.mkdir(parents=True, exist_ok=True)
    summary = {}
    for name, (start, stop) in EPOCHS.items():
        rows = horizons_rows(start, stop)
        with open(folder / f"{name}.csv", "w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            writer.writerow([
                "Name", "UTC", "SubSolarLat", "SubSolarLonEast", "SubSaturnLat", "SubSaturnLonEast",
                "SunX", "SunY", "SunZ", "LightPitchDeg", "LightYawDeg", "SaturnX", "SaturnY", "SaturnZ",
                "SunElevationAtPoleDeg",
            ])
            elevations = []
            for i, (utc, sat_lon_w, sat_lat, sun_lon_w, sun_lat) in enumerate(rows):
                sun_lon, sat_lon = float(body.west_to_east(sun_lon_w)), float(body.west_to_east(sat_lon_w))
                sun = body.body_to_unreal(body.unit_from_latlon_deg(sun_lat, sun_lon))
                saturn = body.body_to_unreal(body.unit_from_latlon_deg(sat_lat, sat_lon))
                pitch, yaw = body.light_rotator(sun)
                elevation = float(np.degrees(np.arcsin(sun[2])))
                elevations.append(elevation)
                writer.writerow([
                    f"T{i:03d}", utc, sun_lat, round(sun_lon, 4), sat_lat, round(sat_lon, 4),
                    *[round(v, 6) for v in sun], round(pitch, 4), round(yaw, 4),
                    *[round(v, 6) for v in saturn], round(elevation, 4),
                ])
        summary[name] = {"samples": len(rows), "sun_elevation_at_pole_deg": [min(elevations), max(elevations)]}
        print(name, summary[name])
    (folder / "README.json").write_text(json.dumps({
        "source": "NASA/JPL Horizons, Enceladus observed from Saturn's centre, ephemeris sat441l",
        "note": "Sub-points use Horizons' planetodetic latitude on an oblate spheroid, which differs from planetocentric by a small amount. Directions are in the south-pole tile frame.",
        "epochs": summary,
    }, indent=2), encoding="utf-8")
    return summary
