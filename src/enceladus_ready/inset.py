"""High-resolution Cassini ISS insets for the south-polar relief tile.

Each frame's pixel scale is known, so only position and rotation need searching.
Frames are matched against the georeferenced Schenk & McKinnon (2024) mosaic, and
finer frames are then matched against the frames already placed. A grid of small
blocks fits the final plane-to-plane transform. Every result is tested against
the original mosaic, independently of the chain.

Brightness comes from the base albedo and only fine detail comes from the frame,
which avoids visible tone changes at frame edges. Relief-driven parallax remains
as a small local error because each frame uses one transform.
"""

from __future__ import annotations

import json
import re
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt, gaussian_filter

from . import body
from .sources import MOSAIC, OUT, RAW, ROOT, EquirectRaster
from .tile import HALF_M, TILE_ID, save_png

OPUS = "https://opus.pds-rings.seti.org/api/files"
FRAME_DIR = ROOT / "data" / "frames" / "e5_2008"
EXTENT_M = 160_000.0  # some frames extend past the tile
CANVAS_M = 40.0
COARSE_M = 100.0
FINE_M = 40.0
MIN_PEAK = 0.28
MIN_BLOCKS = 6
HIGHPASS_SIGMA = 8.0
DETAIL_GAMMA = 0.6  # reduces the low-Sun contrast so frames sit with the flattened base


@dataclass(frozen=True)
class FrameSpec:
    image: str
    scale_m: float  # mean pixel scale on the ground


# Cassini NAC clear-filter frames from the 31 October 2008 flyby.
FRAMES = [
    FrameSpec("1604167575", 81.6),
    FrameSpec("1604167409", 69.9),
    FrameSpec("1604167225", 44.5),
    FrameSpec("1604167036", 40.0),
    FrameSpec("1604167191", 40.0),
    FrameSpec("1604167158", 33.2),
    FrameSpec("1604167125", 28.5),
    FrameSpec("1604167092", 25.0),
    FrameSpec("1604167059", 21.9),
    FrameSpec("1604167003", 16.4),
    FrameSpec("1604166970", 12.4),
    FrameSpec("1604166937", 8.8),
]


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


def rotated_crop(frame: np.ndarray, center: tuple[float, float], angle: float, side: int) -> tuple[np.ndarray, np.ndarray]:
    """Rotate about a frame point and cut a square. Returns the crop and frame-to-crop matrix."""
    M = cv2.getRotationMatrix2D(center, angle, 1.0)
    M[0, 2] += side / 2.0 - center[0]
    M[1, 2] += side / 2.0 - center[1]
    crop = cv2.warpAffine(frame, M, (side, side), flags=cv2.INTER_LINEAR)
    return crop, np.vstack([M, [0, 0, 1]])


def scale_matrix(factor: float) -> np.ndarray:
    return np.diag([factor, factor, 1.0])


def translation(x: float, y: float) -> np.ndarray:
    return np.array([[1.0, 0.0, x], [0.0, 1.0, y], [0.0, 0.0, 1.0]])


def global_search(frame: np.ndarray, spec: FrameSpec, reference: np.ndarray, common_m: float, angles: list[float]) -> dict:
    """Find the best position and rotation with a large central template."""
    factor = spec.scale_m / common_m
    lit = lit_mask(frame)
    rows, cols = np.where(lit)
    center = (float(np.clip(cols.mean(), 300, 723)), float(np.clip(rows.mean(), 300, 723)))
    side = 600
    results = []
    normalized = frame / max(float(np.median(frame[lit])), 1e-6)
    for angle in angles:
        crop, to_crop = rotated_crop(normalized, center, angle, side)
        small = cv2.resize(crop, None, fx=factor, fy=factor, interpolation=cv2.INTER_AREA)
        if min(small.shape) < 32 or small.shape[0] >= reference.shape[0] or small.shape[1] >= reference.shape[1]:
            continue
        score = cv2.matchTemplate(reference, highpass(small), cv2.TM_CCOEFF_NORMED)
        _, peak, _, location = cv2.minMaxLoc(score)
        results.append((float(peak), angle, location, to_crop))
    results.sort(key=lambda item: item[0], reverse=True)
    peak, angle, location, to_crop = results[0]
    runner_up = 0.0
    for other in results[1:]:
        different_angle = min(abs(other[1] - angle), 360 - abs(other[1] - angle)) > 12
        far = np.hypot(other[2][0] - location[0], other[2][1] - location[1]) > 25
        if different_angle or far:
            runner_up = other[0]
            break
    transform = translation(location[0], location[1]) @ scale_matrix(factor) @ to_crop
    return {"peak": peak, "runner_up": runner_up, "angle": angle, "transform": transform}


def refine_blocks(frame: np.ndarray, spec: FrameSpec, reference: np.ndarray, common_m: float, seed: np.ndarray, angle: float) -> tuple:
    """Match a grid of blocks near the predicted positions and fit a homography."""
    factor = spec.scale_m / common_m
    block = int(np.clip(64.0 / factor, 192, 512))
    step = max(block // 2, 96)
    search = int(round(2000.0 / common_m))
    lit = lit_mask(frame)
    normalized = frame / max(float(np.median(frame[lit])), 1e-6)
    source, target, scores = [], [], []
    half = block // 2
    for cy in range(half, 1024 - half + 1, step):
        for cx in range(half, 1024 - half + 1, step):
            if lit[cy - half:cy + half, cx - half:cx + half].mean() < 0.85:
                continue
            crop, _ = rotated_crop(normalized, (float(cx), float(cy)), angle, block)
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
                scores.append(float(peak))
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


def angle_list(known: list[float]) -> list[float]:
    """Search everywhere until frames agree on the spacecraft's roll."""
    if len(known) < 2:
        return list(np.arange(0.0, 360.0, 3.0))
    center = float(np.median(known))
    return list(np.arange(center - 15.0, center + 15.1, 1.0) % 360.0)


def try_frame(frame, spec, canvas, local, common_m, angles):
    """Place one frame against the current canvas. Returns canvas-space homography or None."""
    factor = CANVAS_M / common_m
    if common_m == COARSE_M:
        reference = cv2.resize(canvas, None, fx=factor, fy=factor, interpolation=cv2.INTER_AREA)
        offset = (0, 0)
    else:
        rows, cols = np.where(local <= 45.0)
        if rows.size == 0:
            return None
        margin = int(8000.0 / CANVAS_M)
        y0, y1 = max(rows.min() - margin, 0), min(rows.max() + margin, canvas.shape[0])
        x0, x1 = max(cols.min() - margin, 0), min(cols.max() + margin, canvas.shape[1])
        reference = canvas[y0:y1, x0:x1]
        offset = (x0, y0)
    filtered = highpass(reference)
    found = global_search(frame, spec, filtered, common_m, angles)
    if found["peak"] < MIN_PEAK:
        return {"rejected": found["peak"], "runner_up": found["runner_up"]}
    H_common, blocks, residual = refine_blocks(frame, spec, highpass(reference, 6.0), common_m, found["transform"], found["angle"])
    H = translation(*offset) @ scale_matrix(common_m / CANVAS_M) @ H_common
    ratio = jacobian_scale(H) * CANVAS_M / spec.scale_m
    if not 0.7 <= ratio <= 1.3:
        return {"rejected": found["peak"], "runner_up": found["runner_up"], "bad_scale": ratio}
    return {"H": H, "peak": found["peak"], "runner_up": found["runner_up"], "angle": found["angle"], "blocks": blocks, "residual_m": residual, "common_m": common_m, "scale_ratio": ratio}


def align(mosaic: EquirectRaster) -> tuple[list, dict]:
    """Register frames against the mosaic, then against frames already placed."""
    pixels = int(round(2.0 * EXTENT_M / CANVAS_M)) + 1
    canvas = sample_mosaic_plane(mosaic, -EXTENT_M, -EXTENT_M, CANVAS_M, pixels, pixels)
    canvas = (canvas / np.median(canvas)).astype(np.float32)
    local = np.full((pixels, pixels), 100.0, dtype=np.float32)
    frames = {spec.image: load_frame(spec) for spec in FRAMES}
    remaining = list(FRAMES)
    aligned: list = []
    rejected: dict = {}

    def place(spec, result):
        frame = frames[spec.image]
        image, valid = warp(prefilter(frame / np.median(frame[lit_mask(frame)]), spec.scale_m, CANVAS_M), result["H"], (pixels, pixels))
        lit = valid & (warp(lit_mask(frame).astype(np.float32), result["H"], (pixels, pixels))[0] > 0.5)
        better = lit & (max(spec.scale_m, CANVAS_M) < local)
        canvas[better] = image[better]
        local[better] = max(spec.scale_m, CANVAS_M)
        result["spec"] = spec
        aligned.append(result)
        print(f"{spec.image}: peak {result['peak']:.2f} (next {result['runner_up']:.2f}), rotation {result['angle']:.0f}, blocks {result['blocks']}, block residual {result['residual_m']}, common {result['common_m']:.0f} m")

    for common_m in (COARSE_M, FINE_M, FINE_M, FINE_M):
        progress = False
        for spec in sorted(remaining, key=lambda s: -s.scale_m):
            if common_m == COARSE_M and spec.scale_m < 20.0:
                continue
            result = try_frame(frames[spec.image], spec, canvas, local, common_m, angle_list([i["angle"] for i in aligned]))
            if result is None or "H" not in result:
                rejected[spec.image] = result
                continue
            remaining = [s for s in remaining if s.image != spec.image]
            rejected.pop(spec.image, None)
            place(spec, result)
            progress = True
        if not remaining or (not progress and common_m == FINE_M):
            break
    return aligned, {k: v for k, v in rejected.items() if any(s.image == k for s in remaining)}


def verify(aligned: list, mosaic: EquirectRaster) -> None:
    """Test each frame against the original mosaic only, at 100 m."""
    spacing = 100.0
    pixels = int(round(2.0 * EXTENT_M / spacing)) + 1
    reference = sample_mosaic_plane(mosaic, -EXTENT_M, -EXTENT_M, spacing, pixels, pixels)
    down = scale_matrix(CANVAS_M / spacing)
    for item in aligned:
        spec = item["spec"]
        frame = load_frame(spec)
        H = down @ item["H"]
        image, valid = warp(prefilter(frame, spec.scale_m, spacing), H, (pixels, pixels))
        lit = warp(lit_mask(frame).astype(np.float32), H, (pixels, pixels))[0] > 0.5
        mask = valid & lit
        rows, cols = np.where(mask)
        y0, y1, x0, x1 = rows.min(), rows.max() + 1, cols.min(), cols.max() + 1
        a, b, m = highpass(image[y0:y1, x0:x1], 6.0), highpass(reference[y0:y1, x0:x1], 6.0), mask[y0:y1, x0:x1]
        score = ncc(a, b, m)
        shifted = [ncc(np.roll(a, shift, axis=(1, 0)), b, m) for shift in ((10, 0), (-10, 0), (0, 10), (0, -10))]
        best, best_shift = -1.0, (0, 0)
        for dy in range(-5, 6):
            for dx in range(-5, 6):
                value = ncc(np.roll(a, (dx, dy), axis=(1, 0)), b, m)
                if value > best:
                    best, best_shift = value, (dx, dy)
        item["verify"] = {
            "mosaic_ncc": score,
            "ncc_if_moved_1km": float(np.mean(shifted)),
            "best_offset_m": [best_shift[0] * spacing, best_shift[1] * spacing],
        }
        print(f"{spec.image}: mosaic correlation {score:.2f}, moved 1 km {np.mean(shifted):.2f}, best offset {best_shift[0] * spacing:+.0f}, {best_shift[1] * spacing:+.0f} m")


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


def package(aligned: list, rejected: dict) -> None:
    folder = OUT / "unreal" / TILE_ID / "relief" / "insets" / "e5_2008"
    folder.mkdir(parents=True, exist_ok=True)
    base_path = OUT / "unreal" / TILE_ID / "relief" / "albedo_flattened_linear.png"
    to_meters = CANVAS_M

    tiers = []
    plans = [
        ("wide_20m", 20.0, aligned),
        ("detail_10m", 10.0, [i for i in aligned if i["spec"].scale_m <= 17.0]),
    ]
    for name, spacing, chosen in plans:
        if not chosen:
            continue
        corners = np.vstack([footprint(i["H"]) for i in chosen]) * to_meters - EXTENT_M
        x0 = float(np.floor(max(corners[:, 0].min(), -HALF_M) / spacing) * spacing)
        y0 = float(np.floor(max(corners[:, 1].min(), -HALF_M) / spacing) * spacing)
        x1 = float(np.ceil(min(corners[:, 0].max(), HALF_M) / spacing) * spacing)
        y1 = float(np.ceil(min(corners[:, 1].max(), HALF_M) / spacing) * spacing)
        nx, ny = int(round((x1 - x0) / spacing)) + 1, int(round((y1 - y0) / spacing)) + 1
        image, alpha, source = composite(aligned, base_path, spacing, x0, y0, nx, ny, [i["spec"].image for i in chosen])
        save_png(folder / f"albedo_{name}_linear.png", np.rint(np.clip(image, 0, 1) * 65535).astype(np.uint16))
        save_png(folder / f"mask_{name}.png", np.rint(np.clip(alpha, 0, 1) * 255).astype(np.uint8))
        save_png(folder / f"source_{name}.png", source)
        tiers.append({
            "name": name,
            "pixel_spacing_m": spacing,
            "pixels": [nx, ny],
            "world_min_cm": [x0 * 100.0, y0 * 100.0],
            "world_max_cm": [x1 * 100.0, y1 * 100.0],
            "covered_km2": float((alpha > 0.5).sum() * (spacing / 1000.0) ** 2),
            "files": [f"albedo_{name}_linear.png", f"mask_{name}.png", f"source_{name}.png"],
        })
        print(name, nx, ny, f"{tiers[-1]['covered_km2']:.0f} km2")

    index = {str(n): item["spec"].image for n, item in enumerate(aligned, start=1)}
    (folder / "inset.json").write_text(json.dumps({
        "terrain": "relief only",
        "source": "Cassini ISS narrow-angle clear-filter frames, 31 October 2008, calibrated products from the PDS Ring-Moon Systems node",
        "method": "Each frame is placed on the Schenk and McKinnon (2024) mosaic by searching position and rotation at its known scale, then fitted with one plane-to-plane transform. Broad brightness comes from the base albedo and only fine detail comes from the frame.",
        "uv_rule": "UV = (WorldXY - world_min_cm) / (world_max_cm - world_min_cm), then (UV * (size - 1) + 0.5) / size. Blend over the base with the mask.",
        "limits": [
            "Alignment is tested against the 100 m mosaic, so absolute position finer than about 100 m is not guaranteed.",
            "Relief creates small local misalignment because each frame uses one transform.",
            "Shadows are real and baked in from a low Sun on one date. Contrast is reduced for display, so this is not reflectance.",
            "Deep shadows are lightly blurred to hide compression blocks in the original Cassini images.",
            "Detail is 2D imagery. The DEM under it remains about 400 m.",
        ],
        "tiers": tiers,
        "source_index": index,
        "frames": [{
            "image": i["spec"].image, "scale_m": i["spec"].scale_m, "peak": i["peak"], "next_peak": i["runner_up"],
            "rotation_deg": i["angle"], "blocks": i["blocks"], "block_residual_m": i["residual_m"], "matched_at_m": i["common_m"],
            **i.get("verify", {}),
        } for i in aligned],
        "rejected_frames": {k: (v if v is None else {a: b for a, b in v.items() if a != "H"}) for k, v in rejected.items()},
        "alignment_reference": MOSAIC,
    }, indent=2), encoding="utf-8")


def build() -> None:
    fetch_frames()
    mosaic = EquirectRaster(RAW / MOSAIC)
    aligned, rejected = align(mosaic)
    verify(aligned, mosaic)
    package(aligned, rejected)
