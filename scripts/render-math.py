"""Render mixed Chinese text + LaTeX math to a PNG (no TeX install needed).

Input file format: one block per line.
  $...$   -> rendered as math (matplotlib mathtext)
  <text>  -> rendered with a CJK font
  <blank> -> vertical spacing

Usage: python scripts/render-math.py INPUT.txt OUTPUT.png [--width 11]
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.font_manager import FontProperties, fontManager  # noqa: E402

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\simsun.ttc",
]


def pick_cjk_font() -> FontProperties | None:
    """Return a FontProperties bound to a real font file (matplotlib needs the
    file path, not just a family name, for CJK glyphs on Windows)."""
    for path in FONT_CANDIDATES:
        if not os.path.exists(path):
            continue
        try:
            fontManager.addfont(path)
            return FontProperties(fname=path)
        except Exception:  # noqa: BLE001 - try the next candidate
            continue
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("source", type=Path)
    ap.add_argument("output", type=Path)
    ap.add_argument("--width", type=float, default=11.0, help="figure width in inches")
    ap.add_argument("--dpi", type=int, default=200)
    args = ap.parse_args()

    raw_lines = args.source.read_text(encoding="utf-8").splitlines()
    blocks: list[tuple[str, str]] = []
    for line in raw_lines:
        stripped = line.strip()
        if not stripped:
            blocks.append(("gap", ""))
        elif stripped.startswith("$") and stripped.endswith("$") and len(stripped) > 2:
            blocks.append(("math", stripped[1:-1].strip()))
        else:
            blocks.append(("text", stripped))

    mathtext_size = 19.0
    text_size = 13.0
    # Row heights are in inches so tall math lines never collide with the next row.
    heights = {"math": 0.46, "text": 0.34, "gap": 0.18}
    total = sum(heights[kind] for kind, _ in blocks) or heights["text"]
    pad = 0.35

    cjk_font = pick_cjk_font()
    matplotlib.rcParams["mathtext.fontset"] = "cm"

    fig_h = total + 2 * pad
    fig = plt.figure(figsize=(args.width, fig_h), dpi=args.dpi)
    fig.patch.set_facecolor("white")

    cursor = fig_h - pad
    for kind, content in blocks:
        step = heights[kind]
        center = (cursor - step * 0.5) / fig_h
        cursor -= step
        if kind == "gap":
            continue
        if kind == "math":
            fig.text(
                0.5,
                center,
                f"${content}$",
                ha="center",
                va="center",
                fontsize=mathtext_size,
                color="#111111",
            )
        else:
            fig.text(
                0.03,
                center,
                content,
                ha="left",
                va="center",
                fontsize=text_size,
                fontproperties=cjk_font,
                color="#111111",
            )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(args.output, facecolor="white", bbox_inches="tight", pad_inches=0.2)
    plt.close(fig)
    print(f"wrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
