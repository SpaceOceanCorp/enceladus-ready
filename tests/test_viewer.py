import numpy as np
import pytest

pytest.importorskip("cv2")

from enceladus_ready import viewer


def test_cut_bounds_cover_the_image_on_pixel_centers(tmp_path):
    data = np.zeros((5, 9), np.uint8)
    tiles = viewer.cut(data, "t", 10.0, 20.0, 0.5, 80, tmp_path, size=4)
    assert min(t["x0"] for t in tiles) == pytest.approx(9.75)
    assert min(t["y0"] for t in tiles) == pytest.approx(19.75)
    assert max(t["x1"] for t in tiles) == pytest.approx(14.25)
    assert max(t["y1"] for t in tiles) == pytest.approx(22.25)
    assert all((tmp_path / t["src"].split("/")[1]).exists() for t in tiles)
