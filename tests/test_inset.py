import numpy as np
import pytest

cv2 = pytest.importorskip("cv2")

from enceladus_ready import inset


def write_vicar(path, image, record_prefix=4):
    header = (
        f"LBLSIZE=256 FORMAT='REAL' RECSIZE={record_prefix + image.shape[1] * 4} "
        f"NL={image.shape[0]} NS={image.shape[1]} NBB={record_prefix} NLB=1 "
        "INTFMT='HIGH' REALFMT='RIEEE' "
    ).ljust(256).encode("latin1")
    binary_label = b"\0" * (record_prefix + image.shape[1] * 4)
    rows = b"".join(b"\0" * record_prefix + row.astype("<f4").tobytes() for row in image)
    path.write_bytes(header + binary_label + rows)


def test_read_vicar_skips_binary_prefix_and_label(tmp_path):
    image = np.arange(12, dtype=np.float32).reshape(3, 4)
    target = tmp_path / "frame.IMG"
    write_vicar(target, image)
    assert inset.read_vicar(target) == pytest.approx(image)


def test_jacobian_scale_measures_homography():
    H = np.diag([2.0, 2.0, 1.0])
    assert inset.jacobian_scale(H) == pytest.approx(2.0)


def test_ncc_finds_identical_and_inverted():
    rng = np.random.default_rng(3)
    a = rng.normal(size=(64, 64))
    mask = np.ones(a.shape, dtype=bool)
    assert inset.ncc(a, a, mask) == pytest.approx(1.0)
    assert inset.ncc(a, -a, mask) == pytest.approx(-1.0)


def test_rotated_crop_matrix_maps_center_to_crop_center():
    frame = np.zeros((1024, 1024), np.float32)
    _, matrix = inset.rotated_crop(frame, (500.0, 400.0), 30.0, 200)
    center = matrix @ np.array([500.0, 400.0, 1.0])
    assert center[:2] == pytest.approx([100.0, 100.0])


def test_soften_shadows_keeps_lit_ground():
    image = np.full((128, 128), 1.0, np.float32)
    rng = np.random.default_rng(5)
    shadow = (slice(0, 26), slice(0, 128))
    image[shadow] = rng.uniform(0.04, 0.08, (26, 128)).astype(np.float32)
    softened = inset.soften_shadows(image, np.ones(image.shape, dtype=bool), sigma_px=4.0)
    assert softened[120, 64] == pytest.approx(1.0)
    assert softened[4:20, 8:120].std() < image[4:20, 8:120].std() * 0.5
    assert softened[4:20, 8:120].max() < 0.2
