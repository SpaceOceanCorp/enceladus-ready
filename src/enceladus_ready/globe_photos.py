"""Real Cassini photos for the browser globe: plume shots and south-polar close-ups.

This does the job of tools such as kmgill/cassini_processing without needing USGS ISIS3:
the PDS Ring-Moon Systems node already publishes every Cassini ISS frame calibrated
with the mission's own pipeline (CISSCAL, I/F units), so this module only has to find
frames, download them and turn them into pictures. Plain Python, numpy and Pillow.

1. Search OPUS (https://opus.pds-rings.seti.org) for narrow-angle, clear-filter frames:
   * plumes: Enceladus seen nearly against the Sun (phase angle >= 145 deg), where the
     plumes light up, from within 400,000 km so the moon is more than a speck;
   * close-ups: looking down on the south polar region (sub-spacecraft latitude <= 60 S)
     at 250 m per pixel or finer, Sun not behind.
   One frame per day, the best of that day, so each pick is a different flyby or sequence.
2. Download the calibrated frame (``*_CALIB.IMG``, cached under ``data/frames/photos``).
3. Stretch for viewing: an asinh stretch for plumes (they are faint next to the lit limb),
   a percentile stretch for surface frames. No other processing; the pictures stay true
   to the calibrated data, only brightened.
4. Write ``out/globe/photos/<id>.jpg`` (full) and ``<id>_t.jpg`` (thumbnail) and
   ``out/globe/photos.js`` with where each frame looked, when, and how.

Cassini images are NASA data and free to use (credit NASA/JPL-Caltech/Space Science Institute).
Run with ``pixi run photos``; the globe works without it.
"""

from __future__ import annotations

import json
import math
import urllib.parse
import urllib.request
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from .globe import OUT
from .inset import OPUS, read_vicar
from .sources import ROOT

SEARCH = "https://opus.pds-rings.seti.org/opus/api/data.json"
CACHE = ROOT / "data" / "frames" / "photos"
PHOTO_DIR = OUT / "photos"
HEADERS = {"User-Agent": "enceladus-ready/0.1"}
G = "SURFACEGEOenceladus_"
COLS = ["opusid", "time1", G + "centerphaseangle1", G + "finestresolution1", G + "subobserverplanetocentriclatitude1",
        G + "subobserverIAUeastlongitude1", G + "planetocentriclatitude1", G + "planetocentriclatitude2",
        G + "IAUeastlongitude1", G + "IAUeastlongitude2", G + "centerdistance1", "COISSfilter"]
PER_KIND = 6

# The frames used, checked by eye from the search results (the search alone also returns ring shots and
# limb views with no plume). Notes are added to each photo's caption.
PICKS = {
    "plume": {
        "n1511803932": "From the November 2005 sequence in which Cassini's cameras first showed the plumes clearly.",
        "n1637461416": "Close flyby, November 2009: separate jets stand out along the limb.",
        "n1660431139": "August 2010 flyby, just above the south polar terrain.",
        "n1669801856": "November 2010: the jets fan out above the tiger stripes.",
        "n1671583412": "December 2010, nearly opposite the Sun (165 degree phase).",
        "n1711553974": "March 2012: the night side is dark and only the plumes and a thin crescent catch the light.",
    },
    "surface": {
        "n1660432760": "August 2010, about 17 m per pixel: ridges and blocks near the tiger stripes.",
        "n1597182735": "August 2008 flyby over the tiger stripes.",
        "n1604167409": "October 2008: fractured terrain beside the stripes.",
        "n1602274088": "October 2008: the edge of the south polar terrain, old cratered plains on one side.",
        "n1584043337": "March 2008, the first of the close south polar flybys.",
    },
}

KINDS = {
    "plume": {
        "title": "Plumes over the south pole",
        "query": {G + "centerphaseangle1": "145", G + "centerdistance2": "400000"},
        "best": lambda r: r["range_km"],        # closest first (bigger moon, more plume detail)
        "caption": "Cassini looking back toward the Sun, so the ice grains in the plumes scatter light forward and glow. "
                   "The jets rise from the tiger stripes at the south pole.",
    },
    "surface": {
        "title": "South polar close-up",
        "query": {G + "subobserverplanetocentriclatitude2": "-55", G + "finestresolution2": "0.25", G + "phase2": "110"},
        "best": lambda r: r["res_m"],           # finest first
        "caption": "Cassini looking down on the south polar terrain during a close flyby.",
    },
}


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def search(kind: str) -> list[dict]:
    """Candidate frames from OPUS, one per UTC day, best first."""
    params = {"instrument": "Cassini ISS", "target": "Enceladus", "COISScamera": "Narrow Angle", "COISSfilter": "CLEAR",
              "cols": ",".join(COLS), "limit": "1000", **KINDS[kind]["query"]}
    url = SEARCH + "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=120) as r:
        page = json.load(r)["page"]
    rows = []
    for p in page:
        d = dict(zip(COLS, p))
        if d["COISSfilter"] != "CLEAR":
            continue
        res = _num(d[G + "finestresolution1"])
        rows.append({
            "id": d["opusid"], "time": d["time1"], "day": d["time1"][:10], "phase": _num(d[G + "centerphaseangle1"]),
            "res_m": None if res is None else res * 1000.0,
            "sub_lat": _num(d[G + "subobserverplanetocentriclatitude1"]), "sub_lon": _num(d[G + "subobserverIAUeastlongitude1"]),
            "lat": [_num(d[G + "planetocentriclatitude1"]), _num(d[G + "planetocentriclatitude2"])],
            "lon": [_num(d[G + "IAUeastlongitude1"]), _num(d[G + "IAUeastlongitude2"])],
            "range_km": _num(d[G + "centerdistance1"]),
        })
    best = KINDS[kind]["best"]
    by_day: dict[str, dict] = {}
    for r in rows:
        if r["phase"] is None or (kind == "surface" and r["res_m"] is None):
            continue
        if r["day"] not in by_day or best(r) < best(by_day[r["day"]]):
            by_day[r["day"]] = r
    return sorted(by_day.values(), key=best)


def download(opus_id: str) -> Path | None:
    CACHE.mkdir(parents=True, exist_ok=True)
    found = list(CACHE.glob(f"{opus_id.split('-')[-1].upper()}_*_CALIB.IMG"))
    if found:
        return found[0]
    with urllib.request.urlopen(urllib.request.Request(f"{OPUS}/{opus_id}.json", headers=HEADERS), timeout=120) as r:
        urls = json.load(r)["data"][opus_id].get("coiss_calib", [])
    img = None
    for url in urls:
        target = CACHE / url.rsplit("/", 1)[1]
        if not target.exists():
            with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=180) as r:
                target.write_bytes(r.read())
        if target.suffix.upper() == ".IMG":
            img = target
    return img


def picture(path: Path, kind: str) -> np.ndarray:
    """Calibrated I/F frame to an 8-bit picture."""
    a = np.nan_to_num(read_vicar(path), nan=0.0, posinf=0.0, neginf=0.0)
    a = np.maximum(a, 0.0)
    med = cv2.medianBlur(a, 3)
    spread = np.median(np.abs(a - med)) * 1.4826
    hot = np.abs(a - med) > max(6.0 * spread, 0.02)
    a[hot] = med[hot]
    if kind == "plume":
        lo, hi = np.percentile(a, 1.0), np.percentile(a, 99.95)
        soft = max((hi - lo) * 0.02, 1e-6)          # asinh: lifts faint plumes, keeps the bright limb
        v = np.arcsinh((a - lo).clip(0) / soft) / np.arcsinh((hi - lo) / soft)
    else:
        lo, hi = np.percentile(a, 0.5), np.percentile(a, 99.8)
        v = ((a - lo) / max(hi - lo, 1e-9)).clip(0, 1) ** 0.85
    return (v.clip(0, 1) * 255).astype(np.uint8)


def _centre(r: dict) -> tuple[float, float]:
    """Where the frame looked: middle of the observed latitudes and longitudes (east, -180..180)."""
    la = [x for x in r["lat"] if x is not None]
    lat = sum(la) / len(la) if la else r["sub_lat"]
    lo = [x for x in r["lon"] if x is not None]
    if len(lo) == 2:
        a, b = lo
        span = (b - a) % 360.0
        lon = (a + span / 2.0) % 360.0
    else:
        lon = r["sub_lon"] or 0.0
    lon = ((lon + 180.0) % 360.0) - 180.0
    return round(lat, 3), round(lon, 3)


def build(per_kind: int = PER_KIND) -> None:
    PHOTO_DIR.mkdir(parents=True, exist_ok=True)
    photos = []
    for kind, spec in KINDS.items():
        made = 0
        picks = PICKS.get(kind, {})
        for r in search(kind):
            name = r["id"].replace("co-iss-", "")
            if picks and name not in picks:
                continue
            if made >= per_kind:
                break
            try:
                path = download(r["id"])
            except Exception as err:  # a frame without a calibrated product is skipped
                print(f"skip {r['id']}: {err}")
                continue
            if path is None:
                print(f"skip {r['id']}: no calibrated frame")
                continue
            pic = picture(path, kind)
            if pic.std() < 4:                      # blank or nearly blank frame
                print(f"skip {r['id']}: almost blank")
                continue
            Image.fromarray(pic).save(PHOTO_DIR / f"{name}.jpg", quality=90, optimize=True)
            t = Image.fromarray(pic); t.thumbnail((240, 240)); t.save(PHOTO_DIR / f"{name}_t.jpg", quality=85, optimize=True)
            # Plume shots look at the limb from far away, so they are pinned by the south pole where the jets rise.
            lat, lon = (-82.0, -150.0 + 60.0 * made) if kind == "plume" else _centre(r)
            photos.append({
                "id": name, "kind": kind, "title": spec["title"], "caption": spec["caption"] + (" " + picks[name] if name in picks else ""),
                "time": r["time"][:19].replace("T", " ") + " UTC", "phase": round(r["phase"], 1),
                "res_m": None if r["res_m"] is None else round(r["res_m"], 1),
                "range_km": None if r["range_km"] is None else round(r["range_km"]),
                "lat": lat, "lon": lon, "size": list(pic.shape[::-1]),
                "opus": f"https://opus.pds-rings.seti.org/opus/#/view=detail&detail={r['id']}",
                "file": path.name,
            })
            made += 1
            print(f"{kind}: {name} {r['time'][:10]} phase {r['phase']:.0f} res {r['res_m'] or 0:.0f} m at {lat}, {lon}")
    (OUT / "photos.js").write_text("window.ENC_PHOTOS=" + json.dumps(photos, ensure_ascii=False) + ";\n", encoding="utf8")
    print(f"{len(photos)} photos written to {PHOTO_DIR}")


if __name__ == "__main__":
    build()
