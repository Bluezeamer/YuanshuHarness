# /// script
# dependencies = ["fonttools"]
# ///
"""把横排 logo 的字标转成 SVG 轮廓，写到同目录 text.json（gen.mjs 读它）：uv run scripts/brand/outline.py

只在改字标（字、字体、字距）或横幅标语时才需要重跑；需要系统装有 Noto CJK（Debian：fonts-noto-cjk）。
生成后要用仓库的 biome 格式化一次（`./node_modules/.bin/biome format --write scripts/brand/text.json`），否则 lint 会报格式错误。
中文「元枢」：Noto Serif CJK SC SemiBold；英文：Noto Sans CJK SC Medium；横幅标语：Noto Serif CJK SC Regular 与 Noto Sans CJK SC Regular。均为 SIL OFL 1.1，见 NOTICE。
"""

import json
from pathlib import Path

from fontTools.pens.boundsPen import ControlBoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTCollection

FONTS = "/usr/share/fonts/opentype/noto/"


def load(file, family):
    for f in TTCollection(FONTS + file).fonts:
        if (f["name"].getDebugName(16) or f["name"].getDebugName(1)) == family:
            return f
    raise SystemExit(f"字体没找到：{file} / {family}")


def outline(font, text, size, tracking):
    glyphs, cmap = font.getGlyphSet(), font.getBestCmap()
    scale = size / font["head"].unitsPerEm
    x, parts, bounds = 0.0, [], [1e9, 1e9, -1e9, -1e9]
    for ch in text:
        name = cmap.get(ord(ch))
        if name is None:
            raise SystemExit(f"缺字形：{ch}")
        t = (scale, 0, 0, -scale, x, 0)
        pen = SVGPathPen(glyphs, ntos=lambda v: f"{v:.2f}".rstrip("0").rstrip("."))
        glyphs[name].draw(TransformPen(pen, t))
        parts.append(pen.getCommands())
        bp = ControlBoundsPen(glyphs)
        glyphs[name].draw(TransformPen(bp, t))
        if bp.bounds:
            bounds = [
                min(bounds[0], bp.bounds[0]),
                min(bounds[1], bp.bounds[1]),
                max(bounds[2], bp.bounds[2]),
                max(bounds[3], bp.bounds[3]),
            ]
        x += glyphs[name].width * scale + tracking * size
    return {
        "d": " ".join(p for p in parts if p),
        "bbox": [round(v, 2) for v in bounds],
    }


serif = load("NotoSerifCJK-SemiBold.ttc", "Noto Serif CJK SC")
sans = load("NotoSansCJK-Medium.ttc", "Noto Sans CJK SC")
serif_regular = load("NotoSerifCJK-Regular.ttc", "Noto Serif CJK SC")
sans_regular = load("NotoSansCJK-Regular.ttc", "Noto Sans CJK SC")
out = {
    "cn": outline(serif, "元枢", 100, 0.08),
    "en": outline(sans, "YUANSHU HARNESS", 100, 0.34),
    # 宽幅横幅（README 头部）的两行标语
    "tag_cn": outline(serif_regular, "万象之枢，昼夜不怠", 100, 0.1),
    "tag_en": outline(sans_regular, "One session. Many windows. Every host.", 100, 0.02),
}
Path(__file__).with_name("text.json").write_text(
    json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
)
print("scripts/brand/text.json")
