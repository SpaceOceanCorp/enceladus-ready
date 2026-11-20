"""Build the globe's Saturn ring texture (assets/saturn-ring.png) from Cassini data.

    python -m enceladus_ready.saturn_rings

The texture is a strip 8192 px wide running from 74,500 km (left) to 140,220 km (right) from Saturn's centre,
8.02 km per pixel, matching the ring mesh in globe_walk.js.

Transparency (alpha) comes from a Cassini UVIS stellar occultation: Beta Centauri, 2008 day 202, ingress, binned to
10 km (PDS volume COUVIS_8001, file UVIS_HSP_2008_202_BETCEN_I_TAU10KM; Colwell et al. 2010). It covers the whole
system (73,271 to 144,876 km) and sees through optical depth up to ~6.5, so it resolves the dense B ring. Normal
optical depth tau becomes alpha = 1 - exp(-tau), the fraction of light blocked looking straight through.

Colour and brightness come from Cassini's natural-colour ISS mosaic PIA06175 ("Panoramic Rings", Dec 2004, lit
side, 74,565 to 136,780 km). That mosaic is curved, so a row through it is not exactly radial; it is used only for
the smooth colour and reflectivity of each region (smoothed over 400 km), pinned to ring boundaries seen in both
datasets. The fine structure all comes from the occultation. Over black space the texture shows
albedo x alpha, which reproduces the mosaic's brightness. Outside the mosaic (the F ring) the outer A ring's colour
is used. Finally the B and A rings' brightness and colour are calibrated against the planet using Cassini's
true-colour portrait PIA06193, where both share one exposure (see build()).
"""
import csv
import io
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

UVIS = "https://pds-rings.seti.org/holdings/volumes/COUVIS_8xxx/COUVIS_8001/data/UVIS_HSP_2008_202_BETCEN_I_TAU10KM.TAB"
ISS = "https://assets.science.nasa.gov/content/dam/science/psd/photojournal/pia/pia06/pia06175/PIA06175.tif"
OUT = Path(__file__).with_name("assets") / "saturn-ring.png"
N, R0, R1 = 8192, 74500.0, 140220.0
# PIA06175, row 649 (through the tip of the outer A ring), image x of ring boundaries -> radius in km:
# C ring inner edge, Maxwell gap, C/B boundary, B ring outer edge, A ring inner edge, Encke gap, A ring outer edge
ANCHOR_X = [2, 650, 940, 3615, 3902, 5169, 5481]
ANCHOR_R = [74490, 87480, 91980, 117580, 122050, 133589, 136775]
ROW = 649


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "enceladus-ready/1.0"})   # NASA's asset server refuses Python's default
    with urllib.request.urlopen(req, timeout=120) as f:
        return f.read()


def smooth(v, km):
    w = max(1, int(km / ((R1 - R0) / N)))
    k = np.ones(w) / w
    cols = v if v.ndim == 2 else v[:, None]
    out = np.stack([np.convolve(np.pad(cols[:, c], (w, w), "edge"), k, "same")[w:-w] for c in range(cols.shape[1])], 1)
    return out if v.ndim == 2 else out[:, 0]


def build():
    rows = list(csv.reader(io.StringIO(fetch(UVIS).decode("ascii"))))
    r = np.array([float(x[0]) for x in rows])
    tau = np.array([float(x[4]) for x in rows])
    tmax = np.array([float(x[5]) for x in rows])            # the deepest optical depth this occultation could measure
    o = np.argsort(r)
    r, tau = r[o], np.clip(np.minimum(tau, tmax)[o], 0, None)
    R = R0 + (np.arange(N) + 0.5) * (R1 - R0) / N
    alpha = 1 - np.exp(-np.interp(R, r, tau))

    img = np.asarray(Image.open(io.BytesIO(fetch(ISS))).convert("RGB")).astype(float)
    band = img[ROW - 2:ROW + 3].mean(0)
    x = np.clip(np.interp(R, ANCHOR_R, ANCHOR_X), 0, ANCHOR_X[-1])
    col = np.stack([np.interp(x, np.arange(len(band)), band[:, c]) for c in range(3)], 1)
    albedo = smooth(col, 400) / np.maximum(smooth(alpha, 400), 0.06)[:, None]
    outer = R > ANCHOR_R[-1]
    albedo[outer] = albedo[~outer][-40:].mean(0)
    white = np.percentile(albedo[(R > 99000) & (R < 116000)].mean(1), 95)
    rgb = np.clip(albedo / white, 0, 1)
    # brightness and colour relative to the planet: PIA06175 has no planet in frame, so calibrate against Cassini's
    # true-colour portrait PIA06193 (Oct 2004), where rings and planet share one exposure. Measured there (0-255):
    # B ring (x 580-660, y 1000-1040) and A ring (x 330-440, same rows) on the lit left arm, and the disk centre
    # (x 1900-2300, y 1250-1450). Targets scale those to the planet texture's brightness (its mean over 60 S - 10 N).
    planet_tex = np.asarray(Image.open(OUT.with_name("saturn.jpg")).convert("RGB")).astype(float)
    lat = 90 - (np.arange(planet_tex.shape[0]) + 0.5) / planet_tex.shape[0] * 180
    k = planet_tex[(lat < 10) & (lat > -60)].mean() / 145.6
    targets = {"B": np.array([124.7, 116.1, 106.5]) * k / 255, "A": np.array([83.6, 79.3, 75.2]) * k / 255}
    shown = rgb * alpha[:, None]
    gain_b = targets["B"] / shown[(R > 104000) & (R < 116000)].mean(0)
    gain_a = targets["A"] / shown[(R > 123000) & (R < 133000)].mean(0)
    w = np.clip((R - 117580) / (122050 - 117580), 0, 1)[:, None]      # B gains inward, A gains outward
    rgb = np.clip(rgb * ((1 - w) * gain_b + w * gain_a), 0, 1)

    tex = np.zeros((4, N, 4), np.uint8)
    tex[:, :, :3] = (rgb * 255 + 0.5).astype(np.uint8)
    tex[:, :, 3] = (alpha * 255 + 0.5).astype(np.uint8)
    Image.fromarray(tex, "RGBA").save(OUT, optimize=True)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    build()
