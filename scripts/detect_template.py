#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np

try:
    import cv2 as cv2_module  # type: ignore[import-not-found]
except Exception:  # noqa: BLE001
    cv2_module = None

cv2 = cv2_module

if cv2 is None:
    from PIL import Image, ImageDraw
    from scipy.signal import correlate2d
else:
    Image = None  # type: ignore[assignment]
    ImageDraw = None  # type: ignore[assignment]
    correlate2d = None  # type: ignore[assignment]


EPSILON = 1e-9


def require_cv2():
    if cv2 is None:
        raise RuntimeError("OpenCV is not available in this Python environment")
    return cv2


def require_pillow_image_module():
    if Image is None:
        raise RuntimeError("Pillow is not available in this Python environment")
    return Image


def require_pillow_draw_module():
    if ImageDraw is None:
        raise RuntimeError("Pillow ImageDraw is not available in this Python environment")
    return ImageDraw


def require_correlate2d():
    if correlate2d is None:
        raise RuntimeError("scipy.signal.correlate2d is not available in this Python environment")
    return correlate2d


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Detect a template image inside a screenshot")
    parser.add_argument("--screenshot", required=True, help="Path to screenshot image")
    parser.add_argument("--template", required=True, help="Path to template image")
    parser.add_argument("--annotated", required=True, help="Where to write annotated output")
    parser.add_argument("--threshold", type=float, default=0.72, help="Minimum score to mark as found")
    parser.add_argument(
        "--scales",
        default="1",
        help="Comma-separated template scales to try, for example: 0.7,0.75,0.8",
    )
    return parser.parse_args()


def parse_scales(raw: str) -> list[float]:
    values: list[float] = []
    for piece in raw.split(","):
        piece = piece.strip()
        if not piece:
            continue
        value = float(piece)
        if value <= 0:
            continue
        rounded = round(value, 4)
        if rounded not in values:
            values.append(rounded)
    return values or [1.0]


def cv2_find_best_match(screenshot_path: Path, template_path: Path, scales: list[float]) -> tuple[dict | None, tuple[int, int], tuple[int, int]]:
    cv = require_cv2()
    screenshot = cv.imread(str(screenshot_path), cv.IMREAD_COLOR)
    template = cv.imread(str(template_path), cv.IMREAD_COLOR)
    if screenshot is None:
        raise RuntimeError(f"Could not load screenshot: {screenshot_path}")
    if template is None:
        raise RuntimeError(f"Could not load template: {template_path}")

    best: dict | None = None
    screenshot_h, screenshot_w = screenshot.shape[:2]
    template_h, template_w = template.shape[:2]

    for scale in scales:
        scaled_w = max(1, int(round(template_w * scale)))
        scaled_h = max(1, int(round(template_h * scale)))
        if scaled_w > screenshot_w or scaled_h > screenshot_h:
            continue

        scaled_template = cv.resize(template, (scaled_w, scaled_h), interpolation=cv.INTER_LANCZOS4)
        result = cv.matchTemplate(screenshot, scaled_template, cv.TM_CCOEFF_NORMED)
        _, max_score, _, max_loc = cv.minMaxLoc(result)
        center_x = max_loc[0] + scaled_w / 2.0
        center_y = max_loc[1] + scaled_h / 2.0

        candidate = {
            "score": float(max_score),
            "scale": scale,
            "top_left": [int(max_loc[0]), int(max_loc[1])],
            "center": [float(center_x), float(center_y)],
            "size": [scaled_w, scaled_h],
        }
        if best is None or candidate["score"] > best["score"]:
            best = candidate

    return best, (screenshot_w, screenshot_h), (template_w, template_h)


def cv2_draw_annotation(screenshot_path: Path, match: dict | None, output_path: Path) -> None:
    cv = require_cv2()
    image = cv.imread(str(screenshot_path), cv.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"Could not reload screenshot: {screenshot_path}")

    if match is not None:
        x, y = match["top_left"]
        width, height = match["size"]
        center_x, center_y = match["center"]
        center = (int(round(center_x)), int(round(center_y)))
        cv.rectangle(image, (x, y), (x + width - 1, y + height - 1), (0, 255, 0), 3)
        cv.line(image, (center[0] - 14, center[1] - 14), (center[0] + 14, center[1] + 14), (0, 0, 255), 3)
        cv.line(image, (center[0] - 14, center[1] + 14), (center[0] + 14, center[1] - 14), (0, 0, 255), 3)
        label = f"score={match['score']:.3f} scale={match['scale']:.3f}"
        label_y = max(20, y - 10)
        cv.putText(image, label, (x, label_y), cv.FONT_HERSHEY_SIMPLEX, 0.65, (0, 255, 0), 2, cv.LINE_AA)
    else:
        cv.putText(image, "No match found", (12, 30), cv.FONT_HERSHEY_SIMPLEX, 0.8, (64, 64, 255), 2, cv.LINE_AA)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    cv.imwrite(str(output_path), image)


def load_rgb(path: Path) -> Any:
    image_module = require_pillow_image_module()
    return image_module.open(path).convert("RGB")


def rgb_to_gray(image: Any) -> np.ndarray:
    rgb = np.asarray(image, dtype=np.float32)
    return rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114


def resize_template(image: Any, scale: float) -> Any:
    image_module = require_pillow_image_module()
    width = max(1, int(round(image.width * scale)))
    height = max(1, int(round(image.height * scale)))
    return image.resize((width, height), image_module.Resampling.LANCZOS)


def normalized_cross_correlation(image: np.ndarray, template: np.ndarray) -> np.ndarray:
    template = template.astype(np.float32)
    image = image.astype(np.float32)

    template_zero = template - float(template.mean())
    template_energy = float(np.sum(template_zero * template_zero))
    if template_energy <= EPSILON:
        return np.zeros((1, 1), dtype=np.float32)

    corr2d = require_correlate2d()
    kernel = np.ones(template.shape, dtype=np.float32)
    image_sum = corr2d(image, kernel, mode="valid")
    image_sq_sum = corr2d(image * image, kernel, mode="valid")
    numerator = corr2d(image, template_zero, mode="valid")

    window_size = float(template.size)
    variance = image_sq_sum - (image_sum * image_sum) / window_size
    variance = np.maximum(variance, 0.0)
    denominator = np.sqrt(variance * template_energy)

    scores = np.zeros_like(numerator, dtype=np.float32)
    np.divide(numerator, denominator, out=scores, where=denominator > EPSILON)
    return scores


def pillow_find_best_match(screenshot_image: Any, template_image: Any, scales: list[float]) -> dict | None:
    screenshot_gray = rgb_to_gray(screenshot_image)
    best: dict | None = None

    for scale in scales:
        scaled_template = resize_template(template_image, scale)
        if scaled_template.width > screenshot_image.width or scaled_template.height > screenshot_image.height:
            continue

        scaled_gray = rgb_to_gray(scaled_template)
        scores = normalized_cross_correlation(screenshot_gray, scaled_gray)
        if scores.size == 0:
            continue

        flat_index = int(np.argmax(scores))
        score = float(scores.flat[flat_index])
        y, x = np.unravel_index(flat_index, scores.shape)
        center_x = x + scaled_template.width / 2.0
        center_y = y + scaled_template.height / 2.0

        candidate = {
            "score": score,
            "scale": scale,
            "top_left": [int(x), int(y)],
            "center": [float(center_x), float(center_y)],
            "size": [scaled_template.width, scaled_template.height],
        }
        if best is None or candidate["score"] > best["score"]:
            best = candidate

    return best


def pillow_draw_annotation(screenshot_image: Any, match: dict | None, output_path: Path) -> None:
    draw_module = require_pillow_draw_module()
    annotated = screenshot_image.copy()
    draw = draw_module.Draw(annotated)

    if match is not None:
        x, y = match["top_left"]
        width, height = match["size"]
        center_x, center_y = match["center"]
        draw.rectangle((x, y, x + width - 1, y + height - 1), outline=(0, 255, 0), width=3)
        draw.line((center_x - 14, center_y - 14, center_x + 14, center_y + 14), fill=(255, 0, 0), width=3)
        draw.line((center_x - 14, center_y + 14, center_x + 14, center_y - 14), fill=(255, 0, 0), width=3)
        label = f"score={match['score']:.3f} scale={match['scale']:.3f}"
        text_y = max(0, y - 18)
        draw.text((x, text_y), label, fill=(0, 255, 0))
    else:
        draw.text((12, 12), "No match found", fill=(255, 64, 64))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    annotated.save(output_path)


def main() -> int:
    args = parse_args()
    screenshot_path = Path(args.screenshot).expanduser().resolve()
    template_path = Path(args.template).expanduser().resolve()
    annotated_path = Path(args.annotated).expanduser().resolve()
    scales = parse_scales(args.scales)

    if cv2 is not None:
        match, image_size, template_size = cv2_find_best_match(screenshot_path, template_path, scales)
        found = match is not None and match["score"] >= args.threshold
        cv2_draw_annotation(screenshot_path, match if found else None, annotated_path)
        image_width, image_height = image_size
        template_width, template_height = template_size
        engine = "cv2"
    else:
        screenshot_image = load_rgb(screenshot_path)
        template_image = load_rgb(template_path)
        match = pillow_find_best_match(screenshot_image, template_image, scales)
        found = match is not None and match["score"] >= args.threshold
        pillow_draw_annotation(screenshot_image, match if found else None, annotated_path)
        image_width, image_height = screenshot_image.width, screenshot_image.height
        template_width, template_height = template_image.width, template_image.height
        engine = "pillow-scipy"

    payload = {
        "found": found,
        "threshold": args.threshold,
        "scales": scales,
        "engine": engine,
        "screenshot": str(screenshot_path),
        "template": str(template_path),
        "annotated": str(annotated_path),
        "image": {
            "width": image_width,
            "height": image_height,
        },
        "templateSize": {
            "width": template_width,
            "height": template_height,
        },
        "match": match,
    }
    print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
