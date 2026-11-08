"""Enceladus shape and the frame conversions used everywhere else.

Conventions, stated once:

* Body frame: IAU_ENCELADUS, right-handed, +X toward longitude 0 (Saturn-facing),
  +Y toward 90 E, +Z toward the north pole. Metres.
* Longitude is positive EAST in this package. Sources that use west-positive
  longitude (Porco 2014, JPL Horizons) are converted on the way in.
* Latitude is planetocentric.
* South-pole tile frame (Unreal, left-handed, Z up): X = body X, Y = body Y,
  Z = -body Z. The sign flip on one axis is what turns right-handed into
  left-handed without mirroring the moon.
"""

from __future__ import annotations

import numpy as np

# Reference ellipsoid for the Schenk & McKinnon (2024) DEM, per the USGS record.
A_M = 256_200.0
B_M = 251_400.0
C_M = 248_600.0
MEAN_RADIUS_M = (A_M * B_M * C_M) ** (1.0 / 3.0)

# Radius of the sphere the USGS rasters are projected on. It sets the grid only.
# Heights are NOT relative to this sphere.
MAP_SPHERE_M = 256_200.0


def west_to_east(lon_west_deg):
    """Convert west-positive longitude to east-positive, 0 to 360."""
    return np.mod(-np.asarray(lon_west_deg, dtype=float), 360.0)


def ellipsoid_radius(lat_rad, lon_rad):
    """Radius of the reference ellipsoid along a planetocentric direction, metres."""
    cl = np.cos(lat_rad)
    return 1.0 / np.sqrt(
        (cl * np.cos(lon_rad) / A_M) ** 2
        + (cl * np.sin(lon_rad) / B_M) ** 2
        + (np.sin(lat_rad) / C_M) ** 2
    )


def body_from_latlon(lat_rad, lon_rad, r_m):
    """Body-frame XYZ in metres."""
    cl = np.cos(lat_rad)
    return r_m * cl * np.cos(lon_rad), r_m * cl * np.sin(lon_rad), r_m * np.sin(lat_rad)


def latlon_from_body(x, y, z):
    """Planetocentric latitude and east longitude (radians) and radius (metres)."""
    r = np.sqrt(x * x + y * y + z * z)
    return np.arcsin(z / r), np.mod(np.arctan2(y, x), 2.0 * np.pi), r


def body_to_unreal(vec):
    """Convert a body-frame vector to the south-pole Unreal frame."""
    x, y, z = vec
    return x, y, -z


def unit_from_latlon_deg(lat_deg, lon_east_deg):
    """Unit vector in the body frame."""
    lat, lon = np.radians(lat_deg), np.radians(lon_east_deg)
    return tuple(float(v) for v in body_from_latlon(lat, lon, 1.0))


def light_rotator(sun_unreal):
    """Pitch and yaw (degrees) for a DirectionalLight shining from the given direction.

    Unreal lights point along their forward vector, so forward = -sun.
    Forward is (cos p cos y, cos p sin y, sin p).
    """
    fx, fy, fz = (-sun_unreal[0], -sun_unreal[1], -sun_unreal[2])
    return float(np.degrees(np.arcsin(fz))), float(np.degrees(np.arctan2(fy, fx)))


def stereographic_to_latlon(x_m, y_m, radius_m=MEAN_RADIUS_M):
    """South-polar stereographic plane to planetocentric lat, east lon (radians)."""
    rho = np.hypot(x_m, y_m)
    colat = 2.0 * np.arctan2(rho, 2.0 * radius_m)
    return colat - np.pi / 2.0, np.mod(np.arctan2(y_m, x_m), 2.0 * np.pi)


def latlon_to_stereographic(lat_rad, lon_rad, radius_m=MEAN_RADIUS_M):
    """Inverse of stereographic_to_latlon."""
    colat = lat_rad + np.pi / 2.0
    rho = 2.0 * radius_m * np.tan(colat / 2.0)
    return rho * np.cos(lon_rad), rho * np.sin(lon_rad)


def solve_true_shape(x_m, y_m, height_km_fn, iterations=14):
    """Find the surface point whose body X and Y are the given values, southern side.

    height_km_fn(lat_deg, lon_east_deg) returns height above the ellipsoid in km.
    Returns lat (rad), lon (rad), r (m), body z (m).
    """
    rho = np.hypot(x_m, y_m)
    lon = np.mod(np.arctan2(y_m, x_m), 2.0 * np.pi)
    lat = -np.arccos(np.clip(rho / C_M, 0.0, 1.0))
    for _ in range(iterations):
        h_km = height_km_fn(np.degrees(lat), np.degrees(lon))
        r = ellipsoid_radius(lat, lon) + h_km * 1000.0
        lat = -np.arccos(np.clip(rho / r, 0.0, 1.0))
    h_km = height_km_fn(np.degrees(lat), np.degrees(lon))
    r = ellipsoid_radius(lat, lon) + h_km * 1000.0
    return lat, lon, r, r * np.sin(lat)
