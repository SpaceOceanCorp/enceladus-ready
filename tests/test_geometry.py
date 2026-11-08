import numpy as np
import pytest

from enceladus_ready import body
from enceladus_ready.ancillary import parse_jets
from enceladus_ready.sources import ANCILLARY
from enceladus_ready.tile import PROV_CLEAN, PROV_SPECKLED, decode_height, denoise, encode_height, provenance


def test_ellipsoid_axes():
    assert body.ellipsoid_radius(0.0, 0.0) == pytest.approx(body.A_M)
    assert body.ellipsoid_radius(0.0, np.pi / 2) == pytest.approx(body.B_M)
    assert body.ellipsoid_radius(-np.pi / 2, 0.3) == pytest.approx(body.C_M)


def test_west_to_east():
    assert body.west_to_east(90.0) == pytest.approx(270.0)
    assert body.west_to_east(0.0) == pytest.approx(0.0)


def test_body_to_unreal_flips_handedness_once():
    matrix = np.column_stack([body.body_to_unreal(v) for v in np.eye(3)])
    assert np.linalg.det(matrix) == pytest.approx(-1.0)


def test_south_pole_is_up_in_tile_frame():
    assert body.body_to_unreal(body.unit_from_latlon_deg(-90.0, 0.0))[2] == pytest.approx(1.0)


def test_stereographic_round_trip():
    lat, lon = np.radians([-75.0, -88.0]), np.radians([33.0, 300.0])
    x, y = body.latlon_to_stereographic(lat, lon)
    lat2, lon2 = body.stereographic_to_latlon(x, y)
    assert lat2 == pytest.approx(lat)
    assert lon2 == pytest.approx(lon)


def test_true_shape_solver_returns_the_requested_xy():
    x, y = np.array([0.0, 40_000.0, -90_000.0]), np.array([0.0, 25_000.0, 60_000.0])
    lat, lon, r, z = body.solve_true_shape(x, y, lambda a, b: np.full_like(a, -0.5, dtype=float))
    bx, by, bz = body.body_from_latlon(lat, lon, r)
    assert bx == pytest.approx(x, abs=0.01)
    assert by == pytest.approx(y, abs=0.01)
    assert np.all(bz < 0)
    assert r[0] == pytest.approx(body.C_M - 500.0)


def test_height_encoding_follows_unreals_rule():
    z = np.array([[-21_000.0, -450.0], [1200.5, 300.0]])
    values, scale, actor = encode_height(z)
    assert values.dtype == np.uint16
    assert decode_height(values, scale, actor) == pytest.approx(z, abs=scale / 128 / 100)


def test_provenance_finds_speckled_patch_and_denoise_leaves_clean_ground():
    rng = np.random.default_rng(7)
    height = np.zeros((300, 300))
    height[:, 150:] = rng.normal(0.0, 80.0, (300, 150))
    prov, _ = provenance(height, np.ones(height.shape, dtype=bool))
    assert (prov[:, 200:] == PROV_SPECKLED).mean() > 0.95
    assert (prov[:, :100] == PROV_CLEAN).mean() > 0.95
    cleaned = denoise(height, prov)
    assert cleaned[:, 200:].std() < height[:, 200:].std() * 0.5
    assert np.abs(cleaned[:, :100]).max() < 1e-6


def test_light_points_away_from_the_sun():
    sun = (0.0, 0.0, 1.0)
    pitch, _ = body.light_rotator(sun)
    assert pitch == pytest.approx(-90.0)


@pytest.mark.skipif(not (ANCILLARY / "porco2014_table2.txt").exists(), reason="run fetch first")
def test_jet_table_converts_west_longitudes():
    jets = parse_jets()
    assert len(jets) == 100
    assert jets[0]["lon_east"] == pytest.approx(360.0 - 56.78)
    assert {j["sulcus"] for j in jets} == {"Alexandria", "Baghdad", "Cairo", "Damascus"}
