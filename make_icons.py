#!/usr/bin/env python3
"""Generate the PWA icons: dark field, amber grain speckles, thin ring."""
from __future__ import annotations

import math
import random
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent / "icons"
S = 1024


def render(maskable: bool) -> Image.Image:
    img = Image.new("RGB", (S, S), (13, 13, 15))
    d = ImageDraw.Draw(img, "RGBA")
    cx = cy = S / 2

    # Soft amber glow.
    max_r = S * 0.52
    for r in range(int(max_r), 0, -3):
        alpha = int(22 * (1 - r / max_r) ** 2)
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(231, 185, 107, alpha))

    # Thin ring.
    pad = S * (0.18 if maskable else 0.10)
    d.ellipse((pad, pad, S - pad, S - pad), outline=(231, 185, 107, 120), width=max(1, S // 110))

    # Grain speckles inside the safe area.
    rng = random.Random(11)
    radius = S * (0.34 if maskable else 0.38)
    for _ in range(int(S * S * 0.0032)):
        ang = rng.uniform(0, 2 * math.pi)
        rr = math.sqrt(rng.random()) * radius
        x = cx + math.cos(ang) * rr
        y = cy + math.sin(ang) * rr
        r = rng.uniform(S * 0.0012, S * 0.0055)
        alpha = rng.randint(25, 190)
        color = (242, 239, 232, alpha) if rng.random() < 0.45 else (231, 185, 107, alpha)
        d.ellipse((x - r, y - r, x + r, y + r), fill=color)
    return img


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    normal = render(False)
    maskable = render(True)
    normal.resize((512, 512), Image.LANCZOS).save(OUT / "icon-512.png")
    normal.resize((192, 192), Image.LANCZOS).save(OUT / "icon-192.png")
    normal.resize((180, 180), Image.LANCZOS).save(OUT / "apple-touch-icon.png")
    maskable.resize((512, 512), Image.LANCZOS).save(OUT / "maskable-512.png")
    print("wrote", OUT / "icon-512.png", OUT / "icon-192.png",
          OUT / "apple-touch-icon.png", OUT / "maskable-512.png")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
