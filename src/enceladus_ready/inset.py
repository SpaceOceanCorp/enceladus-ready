"""High-resolution Cassini ISS insets for the south-polar relief tile.

Each frame's pixel scale is known, so only position, rotation and viewing tilt
need searching. Frames are matched against the georeferenced Schenk & McKinnon
(2024) mosaic, and finer frames are then matched against the frames already
placed. A grid of small blocks fits the final plane-to-plane transform. Every
frame must also pass a test against the original mosaic before it is used, so a
bad match cannot mislead later frames.

Brightness comes from the base albedo and only fine detail comes from the frame,
which avoids visible tone changes at frame edges. Relief-driven parallax remains
as a small local error because each frame uses one transform.
"""

from __future__ import annotations

import json
import math
import re
import shutil
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt

from . import body
from .sources import MOSAIC, OUT, RAW, ROOT, EquirectRaster
from .tile import HALF_M, TILE_ID, save_png

OPUS = "https://opus.pds-rings.seti.org/api/files"
FRAME_DIR = ROOT / "data" / "frames" / "iss"
ALIGNMENT_CACHE = ROOT / "data" / "frames" / "iss_alignment.json"
EXTENT_M = 160_000.0  # some frames extend past the tile
CANVAS_M = 40.0
COARSE_M = 100.0
FINE_M = 40.0
MIN_PEAK = 0.28
MIN_PEAK_GAP = 0.08
MIN_BLOCKS = 6
MIN_MOSAIC_NCC = 0.25
MIN_NCC_DROP = 0.2
MAX_OFFSET_M = 300.0
HIGHPASS_SIGMA = 8.0
DETAIL_GAMMA = 0.6  # reduces the low-Sun contrast so frames sit with the flattened base
MAX_TEXTURE = 8192
DETAIL_MAX_SCALE_M = 18.0


@dataclass(frozen=True)
class FrameSpec:
    image: str
    scale_m: float  # ground scale per pixel of the 1024 x 1024 working image
    flyby: str
    emission_deg: float


# Cassini NAC clear-filter frames. Summed 512-pixel images use half their native scale.
FRAMES = [
    FrameSpec("1500062131", 84.2, "2005-07-14", 26.5),
    FrameSpec("1500062262", 81.2, "2005-07-14", 34.7),
    FrameSpec("1500063766", 3.3, "2005-07-14", 68.4),
    FrameSpec("1597182368", 8.9, "2008-08-11", 36.5),
    FrameSpec("1597182401", 12.9, "2008-08-11", 37.2),
    FrameSpec("1597182434", 17.1, "2008-08-11", 38.9),
    FrameSpec("1597182467", 20.6, "2008-08-11", 36.4),
    FrameSpec("1597182500", 23.8, "2008-08-11", 32.1),
    FrameSpec("1597182533", 26.5, "2008-08-11", 25.1),
    FrameSpec("1597182568", 29.8, "2008-08-11", 20.4),
    FrameSpec("1597182735", 48.0, "2008-08-11", 20.0),
    FrameSpec("1604166937", 8.8, "2008-10-31", 14.0),
    FrameSpec("1604166970", 12.4, "2008-10-31", 18.0),
    FrameSpec("1604167003", 16.4, "2008-10-31", 24.8),
    FrameSpec("1604167036", 20.0, "2008-10-31", 24.4),
    FrameSpec("1604167059", 21.9, "2008-10-31", 17.0),
    FrameSpec("1604167092", 25.0, "2008-10-31", 8.8),
    FrameSpec("1604167125", 28.5, "2008-10-31", 9.1),
    FrameSpec("1604167158", 33.2, "2008-10-31", 22.7),
    FrameSpec("1604167191", 40.0, "2008-10-31", 37.1),
    FrameSpec("1604167225", 44.5, "2008-10-31", 38.3),
    FrameSpec("1604167409", 69.9, "2008-10-31", 43.8),
    FrameSpec("1604167575", 81.6, "2008-10-31", 32.0),
    FrameSpec("1637462964", 24.2, "2009-11-21", 64.9),
    FrameSpec("1637463028", 16.7, "2009-11-21", 54.3),
    FrameSpec("1637463515", 19.3, "2009-11-21", 34.1),
    FrameSpec("1637463615", 26.7, "2009-11-21", 47.3),
    FrameSpec("1637463724", 35.3, "2009-11-21", 53.7),
    FrameSpec("1660432760", 17.7, "2010-08-13", 28.3),
    FrameSpec("1660432914", 24.7, "2010-08-13", 47.5),
]
SPECS = {spec.image: spec for spec in FRAMES}


def read_vicar(path: Path) -> np.ndarray:
    """Read a single-band VICAR image, including its PDS binary prefix."""
    raw = path.read_bytes()
    size = int(re.search(rb"LBLSIZE=(\d+)", raw[:64])[1])
    label = raw[:size].decode("latin1")

    def value(key: str) -> str:
        return re.search(r"\b" + key + r"='?([\w.+-]+)", label)[1]

    lines, record, nbb, nlb = int(value("NL")), int(value("RECSIZE")), int(value("NBB")), int(value("NLB"))
    fmt = value("FORMAT")
    big = value("INTFMT") == "HIGH"
    little_real = "RIEEE" in value("REALFMT")
    dtype = {
        "BYTE": "u1",
        "HALF": (">" if big else "<") + "i2",
        "FULL": (">" if big else "<") + "i4",
        "REAL": ("<" if little_real else ">") + "f4",
    }[fmt]
    rows = np.frombuffer(raw, dtype="u1", offset=size + nlb * record, count=lines * record).reshape(lines, record)
    return np.frombuffer(rows[:, nbb:].tobytes(), dtype=dtype).reshape(lines, -1).astype(np.float32)


def fetch_frames() -> None:
    """Download calibrated frames from the PDS Ring-Moon Systems node."""
    FRAME_DIR.mkdir(parents=True, exist_ok=True)
    headers = {"User-Agent": "enceladus-ready/0.1"}
    for spec in FRAMES:
        opus_id = f"co-iss-n{spec.image}"
        with urllib.request.urlopen(urllib.request.Request(f"{OPUS}/{opus_id}.json", headers=headers), timeout=120) as r:
            urls = json.load(r)["data"][opus_id]["coiss_calib"]
        for url in urls:
            target = FRAME_DIR / url.rsplit("/", 1)[1]
            if not target.exists():
                with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=180) as r:
                    target.write_bytes(r.read())


def load_frame(spec: FrameSpec) -> np.ndarray:
    """Load a frame as 1024 x 1024 I/F with isolated hot pixels removed."""
    path = next(FRAME_DIR.glob(f"N{spec.image}_*_CALIB.IMG"))
    image = np.nan_to_num(read_vicar(path), nan=0.0, posinf=0.0, neginf=0.0)
    image = np.maximum(image, 0.0)
    if image.shape[0] != 1024:
        image = cv2.resize(image, (1024, 1024), interpolation=cv2.INTER_CUBIC)
    median = cv2.medianBlur(image, 3)
    spread = np.median(np.abs(image - median)) * 1.4826
    hot = np.abs(image - median) > max(6.0 * spread, 0.02)
    image[hot] = median[hot]
    return image


def highpass(image: np.ndarray, sigma: float = HIGHPASS_SIGMA) -> np.ndarray:
    return image - cv2.GaussianBlur(image, (0, 0), sigma)


def ncc(a: np.ndarray, b: np.ndarray, mask: np.ndarray) -> float:
    x, y = a[mask].astype(np.float64), b[mask].astype(np.float64)
    if x.size < 500:
        return 0.0
    x, y = x - x.mean(), y - y.mean()
    denominator = np.sqrt((x * x).sum() * (y * y).sum())
    return float((x * y).sum() / denominator) if denominator else 0.0


def lit_mask(frame: np.ndarray) -> np.ndarray:
    broad = cv2.GaussianBlur(frame, (0, 0), 25.0)
    return broad > 0.2 * np.percentile(broad, 95)


def jacobian_scale(H: np.ndarray, x: float = 512.0, y: float = 512.0) -> float:
    """Geometric mean of how many target pixels one frame pixel spans at (x, y)."""
    points = np.float64([[[x, y]], [[x + 1.0, y]], [[x, y + 1.0]]])
    out = cv2.perspectiveTransform(points, H)[:, 0]
    return float(np.sqrt(abs(np.linalg.det(np.column_stack([out[1] - out[0], out[2] - out[0]])))))


def footprint(H: np.ndarray) -> np.ndarray:
    corners = np.float64([[[0, 0]], [[1023, 0]], [[1023, 1023]], [[0, 1023]]])
    return cv2.perspectiveTransform(corners, H)[:, 0]


def rotated_crop(frame: np.ndarray, center: tuple[float, float], angle: float, side: int, squeeze: float = 1.0, axis: float = 0.0) -> tuple[np.ndarray, np.ndarray]:
    """Rotate about a frame point, optionally foreshorten, and cut a square.

    squeeze compresses along axis (degrees) and stretches across it, keeping area.
    Returns the crop and the frame-to-crop matrix.
    """
    rotation = cv2.getRotationMatrix2D((0.0, 0.0), angle, 1.0)[:, :2]
    linear = rotation
    if squeeze != 1.0:
        c, s = math.cos(math.radians(axis)), math.sin(math.radians(axis))
        turn = np.array([[c, s], [-s, c]])
        linear = rotation @ turn.T @ np.diag([squeeze ** 0.5, squeeze ** -0.5]) @ turn
    shift = np.array([side / 2.0, side / 2.0]) - linear @ np.array(center)
    M = np.column_stack([linear, shift])
    crop = cv2.warpAffine(frame, M, (side, side), flags=cv2.INTER_LINEAR)
    return crop, np.vstack([M, [0, 0, 1]])


def scale_matrix(factor: float) -> np.ndarray:
    return np.diag([factor, factor, 1.0])


def translation(x: float, y: float) -> np.ndarray:
    return np.array([[1.0, 0.0, x], [0.0, 1.0, y], [0.0, 0.0, 1.0]])


def global_search(frame: np.ndarray, spec: FrameSpec, reference: np.ndarray, common_m: float, poses: list[tuple]) -> dict | None:
    """Find the best position and pose with a large template."""
    factor = spec.scale_m / common_m
    lit = lit_mask(frame)
    rows, cols = np.where(lit)
    if rows.size < 5000:
        return None
    center = (float(np.clip(cols.mean(), 300, 723)), float(np.clip(rows.mean(), 300, 723)))
    side = 600
    results = []
    normalized = frame / max(float(np.median(frame[lit])), 1e-6)
    for pose in poses:
        crop, to_crop = rotated_crop(normalized, center, pose[0], side, pose[1], pose[2])
        small = cv2.resize(crop, None, fx=factor, fy=factor, interpolation=cv2.INTER_AREA)
        if min(small.shape) < 32 or small.shape[0] >= reference.shape[0] or small.shape[1] >= reference.shape[1]:
            continue
        score = cv2.matchTemplate(reference, highpass(small), cv2.TM_CCOEFF_NORMED)
        _, peak, _, location = cv2.minMaxLoc(score)
        results.append((float(peak), pose, location, to_crop))
    if not results:
        return None
    results.sort(key=lambda item: item[0], reverse=True)
    peak, pose, location, to_crop = results[0]
    runner_up = 0.0
    for other in results[1:]:
        different_angle = min(abs(other[1][0] - pose[0]), 360 - abs(other[1][0] - pose[0])) > 12
        far = np.hypot(other[2][0] - location[0], other[2][1] - location[1]) > 25
        if different_angle or far:
            runner_up = other[0]
            break
    transform = translation(location[0], location[1]) @ scale_matrix(factor) @ to_crop
    return {"peak": peak, "runner_up": runner_up, "pose": pose, "transform": transform}


def refine_blocks(frame: np.ndarray, spec: FrameSpec, reference: np.ndarray, common_m: float, seed: np.ndarray, pose: tuple) -> tuple:
    """Match a grid of blocks near the predicted positions and fit a homography."""
    factor = spec.scale_m / common_m
    block = int(np.clip(64.0 / factor, 192, 512))
    step = max(block // 2, 96)
    search = int(round(2000.0 / common_m))
    lit = lit_mask(frame)
    normalized = frame / max(float(np.median(frame[lit])), 1e-6)
    source, target = [], []
    half = block // 2
    for cy in range(half, 1024 - half + 1, step):
        for cx in range(half, 1024 - half + 1, step):
            if lit[cy - half:cy + half, cx - half:cx + half].mean() < 0.85:
                continue
            crop, _ = rotated_crop(normalized, (float(cx), float(cy)), pose[0], block, pose[1], pose[2])
            small = highpass(cv2.resize(crop, None, fx=factor, fy=factor, interpolation=cv2.INTER_AREA), 6.0)
            predicted = cv2.perspectiveTransform(np.float64([[[cx, cy]]]), seed)[0, 0]
            height, width = small.shape
            x0, y0 = int(round(predicted[0] - width / 2.0)) - search, int(round(predicted[1] - height / 2.0)) - search
            x1, y1 = x0 + width + 2 * search, y0 + height + 2 * search
            if x0 < 0 or y0 < 0 or x1 > reference.shape[1] or y1 > reference.shape[0]:
                continue
            score = cv2.matchTemplate(reference[y0:y1, x0:x1], small, cv2.TM_CCOEFF_NORMED)
            _, peak, _, location = cv2.minMaxLoc(score)
            if peak >= 0.25:
                source.append((cx, cy))
                target.append((x0 + location[0] + width / 2.0, y0 + location[1] + height / 2.0))
    if len(source) < MIN_BLOCKS:
        return seed, len(source), None
    src, dst = np.float64(source).reshape(-1, 1, 2), np.float64(target).reshape(-1, 1, 2)
    H, inliers = cv2.findHomography(src, dst, cv2.RANSAC, 1.5, maxIters=5000, confidence=0.999)
    if H is None or int(inliers.sum()) < MIN_BLOCKS:
        return seed, len(source), None
    kept = inliers.ravel().astype(bool)
    residual = np.sqrt(np.mean(np.sum((cv2.perspectiveTransform(src[kept], H) - dst[kept]) ** 2, axis=2))) * common_m
    return H, int(kept.sum()), float(residual)


def sample_mosaic_plane(mosaic: EquirectRaster, x0_m: float, y0_m: float, spacing: float, nx: int, ny: int) -> np.ndarray:
    xs, ys = np.meshgrid(x0_m + np.arange(nx) * spacing, y0_m + np.arange(ny) * spacing, indexing="xy")
    lat, lon = body.stereographic_to_latlon(xs, ys)
    return mosaic.sample(np.degrees(lat), np.degrees(lon), order=1).astype(np.float32)


def warp(frame: np.ndarray, H: np.ndarray, size: tuple[int, int]) -> tuple[np.ndarray, np.ndarray]:
    image = cv2.warpPerspective(frame, H, size, flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    valid = cv2.warpPerspective(np.ones(frame.shape, np.uint8), H, size, flags=cv2.INTER_NEAREST, borderValue=0).astype(bool)
    return image, valid


def prefilter(frame: np.ndarray, source_m: float, target_m: float) -> np.ndarray:
    if target_m <= source_m:
        return frame
    return cv2.GaussianBlur(frame, (0, 0), 0.5 * target_m / source_m)


def pose_list(spec: FrameSpec, known: list[float], oblique: bool, min_known: int) -> list[tuple]:
    """Search everywhere until a flyby's frames agree on the spacecraft's roll."""
    if len(known) >= min_known:
        x = sum(math.cos(math.radians(a)) for a in known)
        y = sum(math.sin(math.radians(a)) for a in known)
        center = math.degrees(math.atan2(y, x))
        angles = [float((center + d) % 360.0) for d in range(-15, 16)]
    else:
        angles = [float(a) for a in range(0, 360, 3)]
    tilts = [(1.0, 0.0)]
    if oblique and spec.emission_deg >= 20.0:
        k = math.cos(math.radians(spec.emission_deg))
        tilts += [(k, phi) for phi in (0.0, 45.0, 90.0, 135.0)]
    return [(angle, k, phi) for angle in angles for k, phi in tilts]


def mosaic_check(frame: np.ndarray, spec: FrameSpec, H: np.ndarray, reference: np.ndarray) -> dict | None:
    """Compare a placed frame with the original mosaic at 100 m."""
    pixels = reference.shape[0]
    H100 = scale_matrix(CANVAS_M / COARSE_M) @ H
    image, valid = warp(prefilter(frame, spec.scale_m, COARSE_M), H100, (pixels, pixels))
    lit = warp(lit_mask(frame).astype(np.float32), H100, (pixels, pixels))[0] > 0.5
    mask = valid & lit
    if mask.sum() < 500:
        return None
    rows, cols = np.where(mask)
    y0, y1, x0, x1 = rows.min(), rows.max() + 1, cols.min(), cols.max() + 1
    a, b, m = highpass(image[y0:y1, x0:x1], 6.0), highpass(reference[y0:y1, x0:x1], 6.0), mask[y0:y1, x0:x1]
    score = ncc(a, b, m)
    moved = float(np.mean([ncc(np.roll(a, shift, axis=(1, 0)), b, m) for shift in ((10, 0), (-10, 0), (0, 10), (0, -10))]))
    best, offset = -1.0, (0, 0)
    for dy in range(-5, 6):
        for dx in range(-5, 6):
            value = ncc(np.roll(a, (dx, dy), axis=(1, 0)), b, m)
            if value > best:
                best, offset = value, (dx, dy)
    return {"mosaic_ncc": score, "ncc_if_moved_1km": moved, "best_offset_m": [offset[0] * COARSE_M, offset[1] * COARSE_M]}


def passes_check(check: dict | None) -> bool:
    if check is None:
        return False
    far = max(abs(check["best_offset_m"][0]), abs(check["best_offset_m"][1])) > MAX_OFFSET_M
    return check["mosaic_ncc"] >= MIN_MOSAIC_NCC and check["mosaic_ncc"] - check["ncc_if_moved_1km"] >= MIN_NCC_DROP and not far


def try_frame(frame, spec, canvas, local, common_m, poses, reference100):
    """Place one frame against the current canvas. Returns a result or a rejection."""
    factor = CANVAS_M / common_m
    if common_m == COARSE_M:
        reference = cv2.resize(canvas, None, fx=factor, fy=factor, interpolation=cv2.INTER_AREA)
        offset = (0, 0)
    else:
        rows, cols = np.where(local <= 45.0)
        if rows.size == 0:
            return {"reason": "no finer frames placed yet"}
        margin = int(8000.0 / CANVAS_M)
        y0, y1 = max(rows.min() - margin, 0), min(rows.max() + margin, canvas.shape[0])
        x0, x1 = max(cols.min() - margin, 0), min(cols.max() + margin, canvas.shape[1])
        reference = canvas[y0:y1, x0:x1]
        offset = (x0, y0)
    found = global_search(frame, spec, highpass(reference), common_m, poses)
    if found is None:
        return {"reason": "not enough lit surface"}
    if found["peak"] < MIN_PEAK or found["peak"] - found["runner_up"] < MIN_PEAK_GAP:
        return {"reason": "weak or ambiguous match", "peak": found["peak"], "next_peak": found["runner_up"]}
    H_common, blocks, residual = refine_blocks(frame, spec, highpass(reference, 6.0), common_m, found["transform"], found["pose"])
    H = translation(*offset) @ scale_matrix(common_m / CANVAS_M) @ H_common
    ratio = jacobian_scale(H) * CANVAS_M / spec.scale_m
    if not 0.7 <= ratio <= 1.3:
        return {"reason": "implausible scale", "peak": found["peak"], "scale_ratio": ratio}
    check = mosaic_check(frame, spec, H, reference100)
    if not passes_check(check):
        return {"reason": "failed the mosaic test", "peak": found["peak"], "check": check}
    return {
        "H": H, "peak": found["peak"], "runner_up": found["runner_up"], "pose": found["pose"], "blocks": blocks,
        "residual_m": residual, "common_m": common_m, "scale_ratio": ratio, "verify": check,
    }


def align(mosaic: EquirectRaster) -> tuple[list, dict]:
    """Register frames against the mosaic, then against frames already placed."""
    pixels = int(round(2.0 * EXTENT_M / CANVAS_M)) + 1
    base = sample_mosaic_plane(mosaic, -EXTENT_M, -EXTENT_M, CANVAS_M, pixels, pixels)
    base = (base / np.median(base)).astype(np.float32)
    base_local = np.full((pixels, pixels), 100.0, dtype=np.float32)
    # Each flyby has its own reference, because sunlight differs between flybys.
    layers: dict = {}
    n100 = int(round(2.0 * EXTENT_M / COARSE_M)) + 1
    reference100 = sample_mosaic_plane(mosaic, -EXTENT_M, -EXTENT_M, COARSE_M, n100, n100)
    frames = {spec.image: load_frame(spec) for spec in FRAMES}
    remaining = list(FRAMES)
    aligned: list = []
    rejected: dict = {}

    def place(spec, result):
        frame = frames[spec.image]
        image, valid = warp(prefilter(frame / np.median(frame[lit_mask(frame)]), spec.scale_m, CANVAS_M), result["H"], (pixels, pixels))
        lit = valid & (warp(lit_mask(frame).astype(np.float32), result["H"], (pixels, pixels))[0] > 0.5)
        canvas, local = layers.setdefault(spec.flyby, (base.copy(), base_local.copy()))
        better = lit & (max(spec.scale_m, CANVAS_M) < local)
        canvas[better] = image[better]
        local[better] = max(spec.scale_m, CANVAS_M)
        result["spec"] = spec
        aligned.append(result)
        v = result["verify"]
        print(f"{spec.image} ({spec.flyby}, {spec.scale_m} m): peak {result['peak']:.2f}, next {result['runner_up']:.2f}, roll {result['pose'][0]:.0f}, tilt {result['pose'][1]:.2f}, blocks {result['blocks']}, mosaic {v['mosaic_ncc']:.2f}, moved {v['ncc_if_moved_1km']:.2f}, offset {v['best_offset_m']}", flush=True)

    plan = [(COARSE_M, False, 2), (COARSE_M, True, 2), (FINE_M, True, 1), (FINE_M, True, 1), (FINE_M, True, 1)]
    for number, (common_m, oblique, min_known) in enumerate(plan, start=1):
        print(f"pass {number}: {common_m:.0f} m, tilt search {oblique}, {len(remaining)} frames left", flush=True)
        before = len(remaining)
        for spec in sorted(remaining, key=lambda s: (s.emission_deg, -s.scale_m)):
            if common_m == COARSE_M and spec.scale_m < (15.0 if oblique else 20.0):
                continue
            known = [i["pose"][0] for i in aligned if i["spec"].flyby == spec.flyby]
            if common_m == FINE_M and not known:
                rejected[spec.image] = {"reason": "no frame from this flyby placed"}
                continue
            canvas, local = layers.get(spec.flyby, (base, base_local))
            result = try_frame(frames[spec.image], spec, canvas, local, common_m, pose_list(spec, known, oblique, min_known), reference100)
            if "H" not in result:
                rejected[spec.image] = result
                continue
            remaining = [s for s in remaining if s.image != spec.image]
            rejected.pop(spec.image, None)
            place(spec, result)
        if common_m == FINE_M and len(remaining) == before:
            break
    return aligned, {k: v for k, v in rejected.items() if any(s.image == k for s in remaining)}


def soften_shadows(image: np.ndarray, usable: np.ndarray, sigma_px: float = 3.0) -> np.ndarray:
    """Blur only deep shadow, where Cassini's image compression shows as blocks."""
    level = cv2.GaussianBlur(image, (0, 0), max(sigma_px * 0.4, 1.0))
    low, high = np.percentile(level[usable], [10, 25])
    if high <= low:
        return image
    weight = np.clip((high - level) / (high - low), 0.0, 1.0)
    # Weighted blur, so bright ground next to a shadow does not bleed into it.
    smooth = cv2.GaussianBlur(image * weight, (0, 0), sigma_px) / np.maximum(cv2.GaussianBlur(weight, (0, 0), sigma_px), 1e-4)
    return image * (1.0 - weight) + smooth * weight


def composite(aligned: list, base_path: Path, spacing: float, x0_m: float, y0_m: float, nx: int, ny: int, frames: list) -> tuple:
    """Blend frames over the base albedo, coarsest first."""
    base = np.asarray(Image.open(base_path), dtype=np.float32) / 65535.0
    base_spacing = 2.0 * HALF_M / (base.shape[0] - 1)
    map_x, map_y = np.meshgrid(
        ((x0_m + np.arange(nx) * spacing + HALF_M) / base_spacing).astype(np.float32),
        ((y0_m + np.arange(ny) * spacing + HALF_M) / base_spacing).astype(np.float32),
        indexing="xy",
    )
    out = cv2.remap(base, map_x, map_y, cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    sigma = 500.0 / spacing
    base_broad = cv2.GaussianBlur(out, (0, 0), sigma)
    alpha = np.zeros((ny, nx), np.float32)
    source = np.zeros((ny, nx), np.uint8)
    transform = np.array([
        [CANVAS_M / spacing, 0.0, (-EXTENT_M - x0_m) / spacing],
        [0.0, CANVAS_M / spacing, (-EXTENT_M - y0_m) / spacing],
        [0.0, 0.0, 1.0],
    ])
    for index, item in sorted(enumerate(aligned, start=1), key=lambda pair: -pair[1]["spec"].scale_m):
        spec = item["spec"]
        if spec.image not in frames:
            continue
        frame = load_frame(spec)
        H = transform @ item["H"]
        image, valid = warp(prefilter(frame, spec.scale_m, spacing), H, (nx, ny))
        lit = warp(lit_mask(frame).astype(np.float32), H, (nx, ny))[0] > 0.5
        usable = valid & lit
        if not usable.any():
            continue
        image = soften_shadows(image, usable, max(100.0 / spacing, 2.0))
        broad = cv2.GaussianBlur(image, (0, 0), sigma)
        floor = max(float(np.percentile(broad[usable], 5)), 1e-3)
        detail = np.clip(image / np.maximum(broad, floor), 0.2, 2.2) ** DETAIL_GAMMA
        result = np.clip(base_broad * detail, 0.0, 1.0)
        edge = distance_transform_edt(usable)
        weight = np.clip((edge * spacing) / 1000.0, 0.0, 1.0).astype(np.float32)
        out = out * (1.0 - weight) + result * weight
        alpha = np.maximum(alpha, weight)
        source[weight > 0.5] = index
    return out, alpha, source


def tile_bounds(chosen: list) -> np.ndarray:
    """Frame corners in tile metres, limited to the tile: x0, y0, x1, y1."""
    corners = np.vstack([footprint(i["H"]) for i in chosen]) * CANVAS_M - EXTENT_M
    return np.array([
        max(corners[:, 0].min(), -HALF_M), max(corners[:, 1].min(), -HALF_M),
        min(corners[:, 0].max(), HALF_M), min(corners[:, 1].max(), HALF_M),
    ])


def clusters(chosen: list, gap_m: float = 3000.0) -> list[list]:
    """Group frames whose bounds touch, so each group fits one texture."""
    groups = [[item] for item in chosen]
    merged = True
    while merged:
        merged = False
        for a in range(len(groups)):
            for b in range(a + 1, len(groups)):
                p, q = tile_bounds(groups[a]), tile_bounds(groups[b])
                if p[0] - gap_m <= q[2] and q[0] - gap_m <= p[2] and p[1] - gap_m <= q[3] and q[1] - gap_m <= p[3]:
                    groups[a] += groups.pop(b)
                    merged = True
                    break
            if merged:
                break
    return groups


def spacing_for(bounds: np.ndarray, wanted: float) -> float:
    """Use the wanted spacing unless the texture would exceed Unreal's limit."""
    needed = max(bounds[2] - bounds[0], bounds[3] - bounds[1]) / (MAX_TEXTURE - 2)
    return wanted if needed <= wanted else float(math.ceil(needed / 5.0) * 5.0)


def build_tier(name: str, chosen: list, aligned: list, wanted: float, folder: Path, base_path: Path) -> dict | None:
    bounds = tile_bounds(chosen)
    if bounds[2] <= bounds[0] or bounds[3] <= bounds[1]:
        return None
    spacing = spacing_for(bounds, wanted)
    x0, y0 = float(math.floor(bounds[0] / spacing) * spacing), float(math.floor(bounds[1] / spacing) * spacing)
    x1, y1 = float(math.ceil(bounds[2] / spacing) * spacing), float(math.ceil(bounds[3] / spacing) * spacing)
    nx, ny = int(round((x1 - x0) / spacing)) + 1, int(round((y1 - y0) / spacing)) + 1
    image, alpha, source = composite(aligned, base_path, spacing, x0, y0, nx, ny, [i["spec"].image for i in chosen])
    save_png(folder / f"albedo_{name}_linear.png", np.rint(np.clip(image, 0, 1) * 65535).astype(np.uint16))
    save_png(folder / f"mask_{name}.png", np.rint(np.clip(alpha, 0, 1) * 255).astype(np.uint8))
    save_png(folder / f"source_{name}.png", source)
    covered = float((alpha > 0.5).sum() * (spacing / 1000.0) ** 2)
    print(name, nx, ny, f"{spacing:.0f} m, {covered:.0f} km2", flush=True)
    return {
        "name": name, "pixel_spacing_m": spacing, "pixels": [nx, ny],
        "world_min_cm": [x0 * 100.0, y0 * 100.0], "world_max_cm": [x1 * 100.0, y1 * 100.0],
        "covered_km2": covered, "frames": [i["spec"].image for i in chosen],
        "files": [f"albedo_{name}_linear.png", f"mask_{name}.png", f"source_{name}.png"],
    }


def package(aligned: list, rejected: dict) -> None:
    root = OUT / "unreal" / TILE_ID / "relief" / "insets"
    if root.exists():
        shutil.rmtree(root)
    folder = root / "cassini_iss"
    folder.mkdir(parents=True)
    base_path = OUT / "unreal" / TILE_ID / "relief" / "albedo_flattened_linear.png"

    tiers = []
    wide = build_tier("wide", aligned, aligned, 20.0, folder, base_path)
    if wide:
        tiers.append(wide)
    fine = [i for i in aligned if i["spec"].scale_m <= DETAIL_MAX_SCALE_M]
    groups = sorted(clusters(fine), key=lambda g: min(i["spec"].scale_m for i in g)) if fine else []
    for number, group in enumerate(groups, start=1):
        tier = build_tier(f"detail_{number:02d}", group, aligned, 10.0, folder, base_path)
        if tier:
            tiers.append(tier)

    index = {str(n): item["spec"].image for n, item in enumerate(aligned, start=1)}
    (folder / "inset.json").write_text(json.dumps({
        "terrain": "relief only",
        "source": "Cassini ISS narrow-angle clear-filter frames, calibrated products from the PDS Ring-Moon Systems node",
        "method": "Each frame is placed on the Schenk and McKinnon (2024) mosaic by searching position, rotation and viewing tilt at its known scale, then fitted with one plane-to-plane transform. Broad brightness comes from the base albedo and only fine detail comes from the frame.",
        "uv_rule": "UV = (WorldXY - world_min_cm) / (world_max_cm - world_min_cm), then (UV * (size - 1) + 0.5) / size. Blend over the base with the mask.",
        "limits": [
            "Alignment is tested against the 100 m mosaic, so absolute position finer than about 100 m is not guaranteed.",
            "Relief creates small local misalignment because each frame uses one transform.",
            "Shadows are real and baked in from a low Sun on the date of each frame. Lighting direction changes between flybys.",
            "Contrast is reduced for display, so this is not reflectance. Deep shadows are lightly blurred to hide compression blocks in the original Cassini images.",
            "Detail is 2D imagery. The DEM under it remains about 400 m.",
        ],
        "tiers": tiers,
        "source_index": index,
        "frames": [{
            "image": i["spec"].image, "flyby": i["spec"].flyby, "scale_m": i["spec"].scale_m, "emission_deg": i["spec"].emission_deg,
            "peak": i["peak"], "next_peak": i["runner_up"], "roll_deg": i["pose"][0], "tilt_factor": i["pose"][1],
            "blocks": i["blocks"], "block_residual_m": i["residual_m"], "matched_at_m": i["common_m"], **i["verify"],
        } for i in aligned],
        "rejected_frames": rejected,
        "alignment_reference": MOSAIC,
    }, indent=2), encoding="utf-8")


def save_alignment(aligned: list, rejected: dict) -> None:
    payload = {"rejected": rejected, "aligned": [{**{k: v for k, v in i.items() if k not in ("H", "spec")}, "H": i["H"].tolist(), "image": i["spec"].image} for i in aligned]}
    ALIGNMENT_CACHE.write_text(json.dumps(payload), encoding="utf-8")


def load_alignment() -> tuple[list, dict]:
    payload = json.loads(ALIGNMENT_CACHE.read_text(encoding="utf-8"))
    aligned = [{**{k: v for k, v in i.items() if k != "image"}, "H": np.array(i["H"]), "spec": SPECS[i["image"]]} for i in payload["aligned"]]
    return aligned, payload["rejected"]


def build(reuse_alignment: bool = False) -> None:
    fetch_frames()
    if reuse_alignment and ALIGNMENT_CACHE.exists():
        aligned, rejected = load_alignment()
    else:
        aligned, rejected = align(EquirectRaster(RAW / MOSAIC))
        save_alignment(aligned, rejected)
    print(f"placed {len(aligned)} of {len(FRAMES)} frames", flush=True)
    package(aligned, rejected)
