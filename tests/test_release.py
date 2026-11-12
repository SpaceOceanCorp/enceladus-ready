import json
import zipfile

from enceladus_ready import release
from enceladus_ready.sources import SOURCE_RECORDS, USGS


def test_notice_names_every_original_and_the_changes():
    text = release.notice_text()
    for name, record in SOURCE_RECORDS.items():
        assert record in text
        assert f"{USGS}/{name}" in text
    assert "Lunar and Planetary Institute / USRA" in text
    assert "not endorsed" in text
    assert "What was changed" in text
    assert "—" not in text


def test_kit_zip_leaves_out_unconfirmed_layers(tmp_path, monkeypatch):
    kit = tmp_path / "kit"
    for rel in ["relief/tile.json", "relief/insets/cassini_iss/a.png", "true_shape/tile.json",
                "lighting/x.csv", "vents/porco2014_jets.csv"]:
        (kit / rel).parent.mkdir(parents=True, exist_ok=True)
        (kit / rel).write_text("x")
    monkeypatch.setattr(release, "KIT", kit)
    target = tmp_path / "kit.zip"
    release._kit_zip(target, "notice")
    names = zipfile.ZipFile(target).namelist()
    assert "south_polar_201km/DATA-NOTICE.md" in names
    assert "south_polar_201km/relief/tile.json" in names
    assert "south_polar_201km/lighting/x.csv" in names
    assert not any("insets" in n or "vents" in n for n in names)


def test_stac_assets_point_beside_the_catalog(tmp_path, monkeypatch):
    stac = tmp_path / "out" / "stac"
    stac.mkdir(parents=True)
    (stac / "item.json").write_text(json.dumps({"assets": {"data": {"href": "../cog/a_cog.tif"}}}))
    monkeypatch.setattr(release, "OUT", tmp_path / "out")
    target = tmp_path / "rel"
    target.mkdir()
    release._stac(target)
    assert json.loads((target / "item.json").read_text())["assets"]["data"]["href"] == "./a_cog.tif"
