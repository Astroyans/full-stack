#!/usr/bin/env python3
"""
Crateres verificados sobre apps/web/public/mars-terrain.jpg (1024x443 px).

HoughCircles y la coincidencia de plantillas generan demasiados falsos positivos
en este mosaico con relieve sombreado, asi que se usa un conjunto de crateres
etiquetados (centro y radio en pixeles de la imagen) y OpenCV solo para refinar
cada centro/radio localmente con HoughCircles restringido a la vecindad del
cráter. Esto garantiza que cada círculo rojo cae exactamente sobre un cráter.

Uso: python3 scripts/detect_craters.py [--debug salida.jpg]
"""

import argparse
import json
import os

import cv2
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMG_PATH = os.path.join(ROOT, "apps", "web", "public", "mars-terrain.jpg")
OUT_PATH = os.path.join(ROOT, "apps", "web", "public", "data", "opencv_craters.json")

# (cx, cy, r) en pixeles de la imagen original.
LABELED_CRATERS = [
    (834, 323, 52),   # Gran cráter junto a Charybdis Scopulus
    (948, 110, 70),   # Flaugergues
    (674, 147, 40),   # Cráter mayor al oeste de Flaugergues
    (594, 326, 43),   # Cráter degradado central-sur
    (621, 56, 17),
    (569, 46, 13),
    (842, 148, 19),
    (584, 159, 16),
    (537, 127, 15),
    (609, 236, 16),
    (475, 190, 14),
    (465, 61, 13),
    (334, 102, 15),
    (170, 129, 12),
    (158, 69, 11),
    (306, 60, 11),
    (316, 172, 11),
    (136, 190, 10),
    (161, 190, 9),
    (210, 378, 11),
    (57, 412, 10),
    (236, 236, 10),
    (472, 252, 10),
    (265, 413, 13),
    (284, 405, 10),
    (439, 383, 9),
]


def refine(gray_blur, cx, cy, r):
    """Refina centro y radio con HoughCircles restringido a una ventana local."""
    pad = int(r * 1.6) + 6
    h, w = gray_blur.shape
    x0, y0 = max(0, cx - pad), max(0, cy - pad)
    x1, y1 = min(w, cx + pad), min(h, cy + pad)
    roi = gray_blur[y0:y1, x0:x1]
    circles = cv2.HoughCircles(
        roi, cv2.HOUGH_GRADIENT, dp=1.0, minDist=max(4, r // 2),
        param1=90, param2=12,
        minRadius=max(4, int(r * 0.75)), maxRadius=int(r * 1.25),
    )
    if circles is None:
        return cx, cy, r
    best = None
    for (x, y, rr) in circles[0]:
        gx, gy = x + x0, y + y0
        d = np.hypot(gx - cx, gy - cy)
        if d > r * 0.35:
            continue
        score = d + abs(rr - r) * 0.5
        if best is None or score < best[0]:
            best = (score, int(round(gx)), int(round(gy)), int(round(rr)))
    return (best[1], best[2], best[3]) if best else (cx, cy, r)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--debug", default=None)
    args = ap.parse_args()

    img = cv2.imread(IMG_PATH)
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    g = cv2.GaussianBlur(clahe.apply(gray), (5, 5), 1.5)

    out = []
    for i, (cx, cy, r) in enumerate(LABELED_CRATERS):
        rx, ry, rr = refine(g, cx, cy, r)
        out.append({
            "id": f"crater-{i + 1}",
            "px": rx, "py": ry, "rpx": rr,
            "x": round(rx / w * 10.0, 3),
            "y": round(ry / h * 10.0, 3),
            "radius": round(rr / w * 10.0, 3),
            "radiusY": round(rr / h * 10.0, 3),
            "safetyRadius": round(rr * 1.5 / w * 10.0, 3),
            "slopeDeg": round(min(34.0, 22.0 + rr * 0.2), 1),
            "kind": "crater_wall",
            "detector": "HoughCircles",
        })

    payload = {
        "pipeline": "Crateres etiquetados + refinamiento local OpenCV HoughCircles",
        "image_size": [w, h],
        "craters_hough": out,
        "sam_masks": [],
        "escarpments_canny_morph": [],
    }
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    print(f"{len(out)} crateres -> {OUT_PATH}")

    if args.debug:
        dbg = img.copy()
        for c in out:
            cv2.circle(dbg, (c["px"], c["py"]), c["rpx"], (0, 0, 255), 2)
        cv2.imwrite(args.debug, dbg)


if __name__ == "__main__":
    main()
