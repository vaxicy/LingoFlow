#!/usr/bin/env python3
"""Generate bilingual LingoFlow promo tiles (440x280 and 1400x560) in PIL."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageColor

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "store-assets" / "global"
OUT.mkdir(parents=True, exist_ok=True)
ICON = ROOT / "icons" / "icon-128.png"

COLORS = {
    "blue": "#62a8ff",
    "violet": "#7468ff",
    "lavender": "#b9b0ff",
    "ink": "#111827",
    "muted": "#61708a",
    "white": "#ffffff",
    "panel": "#f8faff",
    "line": "#e2e8f7",
}

GRADIENT = ["#f8fbff", "#edf3ff"]


def font(size, bold=False, chinese=False):
    candidates = []
    if chinese:
        if bold:
            candidates += [
                Path("C:/Windows/Fonts/msyhbd.ttc"),
                Path("C:/Windows/Fonts/simhei.ttf"),
            ]
        candidates += [
            Path("C:/Windows/Fonts/msyh.ttc"),
            Path("C:/Windows/Fonts/simhei.ttf"),
            Path("C:/Windows/Fonts/simsun.ttc"),
        ]
    else:
        if bold:
            candidates += [
                Path("C:/Windows/Fonts/arialbd.ttf"),
                Path("C:/Windows/Fonts/segoeuib.ttf"),
            ]
        candidates += [
            Path("C:/Windows/Fonts/arial.ttf"),
            Path("C:/Windows/Fonts/segoeui.ttf"),
            Path("C:/Windows/Fonts/msyh.ttc"),
        ]
    for c in candidates:
        if c.exists():
            return ImageFont.truetype(str(c), size)
    return ImageFont.load_default()


def rounded_rect(draw, xy, fill, outline=None, width=1, radius=20):
    draw.rounded_rectangle(xy, radius=radius, fill=fill, outline=outline, width=width)


def load_icon(size=72):
    if not ICON.exists():
        return None
    img = Image.open(ICON).convert("RGBA")
    img = img.resize((size, size), Image.Resampling.LANCZOS)
    return img


def base_bg(W, H):
    img = Image.new("RGB", (W, H), GRADIENT[0])
    draw = ImageDraw.Draw(img)
    for y in range(H):
        t = y / H
        r = int(248 + (237 - 248) * t)
        g = int(251 + (243 - 251) * t)
        b = int(255 + (255 - 255) * t)
        draw.line([(0, y), (W, y)], fill=(r, g, b))
    # decorative circles
    for cx, cy, rw, rh, color, alpha in [
        (W + 120, H + 150, W // 3, W // 3, COLORS["violet"], 36),
        (-170, H * 0.4, H * 0.6, H * 0.6, COLORS["blue"], 36),
    ]:
        overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        od = ImageDraw.Draw(overlay)
        od.ellipse((cx - rw, cy - rh, cx + rw, cy + rh), fill=(*ImageColor.getrgb(color), alpha))
        img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
    return img


def draw_brand(draw, img, x, y, icon_size=72, font_size=34):
    icon = load_icon(icon_size)
    if icon:
        img.paste(icon, (x, y), icon)
    draw.text((x + icon_size + 14, y + (icon_size - font_size) // 2 + 2), "LingoFlow", fill=COLORS["violet"], font=font(font_size, bold=False))


def small_promo():
    W, H = 440, 280
    img = base_bg(W, H)
    draw = ImageDraw.Draw(img)
    draw_brand(draw, img, 24, 22, icon_size=50, font_size=25)

    # kicker (English + Chinese)
    draw.text((24, 86), "Foreign Web Reader", fill=COLORS["violet"], font=font(14, bold=True))
    draw.text((24, 106), "外文网页阅读助手", fill=COLORS["violet"], font=font(14, bold=True, chinese=True))

    # Main title: Chinese large, English smaller below
    draw.text((24, 138), "英文网页 中文阅读", fill=COLORS["ink"], font=font(32, bold=True, chinese=True))
    draw.text((24, 180), "English Web, Chinese Reading", fill=COLORS["muted"], font=font(16))

    # pills
    pills = [
        ("双语", "Bilingual"),
        ("划词", "Select"),
    ]
    px, py = 24, 228
    for zh, en in pills:
        label = f"{zh} · {en}"
        pw = int(draw.textlength(label, font=font(13, chinese=True))) + 18
        rounded_rect(draw, (px, py, px + pw, py + 28), "#eeecff", outline=COLORS["line"], radius=14, width=1)
        draw.text((px + pw // 2, py + 5), label, fill="#5b54e8", font=font(13, chinese=True), anchor="ma")
        px += pw + 10

    img.save(OUT / "small-promo-440x280.png")


def large_promo():
    W, H = 1400, 560
    img = base_bg(W, H)
    draw = ImageDraw.Draw(img)
    draw_brand(draw, img, 72, 54, icon_size=76, font_size=36)

    # kicker
    draw.text((72, 146), "Foreign Web Reader", fill=COLORS["violet"], font=font(21, bold=True))
    draw.text((72, 174), "外文网页阅读助手", fill=COLORS["violet"], font=font(21, bold=True, chinese=True))

    # Main title: Chinese large, English below
    draw.text((72, 214), "英文网页 中文阅读", fill=COLORS["ink"], font=font(54, bold=True, chinese=True))
    draw.text((72, 290), "English Web, Chinese Reading", fill=COLORS["muted"], font=font(26))

    # description
    desc_y = 336
    draw.text((72, desc_y), "双语对照、划词翻译和生词本，让阅读更轻松。", fill=COLORS["muted"], font=font(21, chinese=True))
    draw.text((72, desc_y + 32), "Bilingual mode, word lookup & vocabulary — all in one popup.", fill=COLORS["muted"], font=font(21))

    # pills
    pills = [
        ("双语", "Bilingual"),
        ("划词", "Select"),
        ("保存", "Save"),
    ]
    px, py = 72, 422
    for zh, en in pills:
        label = f"{zh} · {en}"
        pw = int(draw.textlength(label, font=font(18, chinese=True))) + 22
        rounded_rect(draw, (px, py, px + pw, py + 36), "#eeecff", outline=COLORS["line"], radius=18, width=1)
        draw.text((px + pw // 2, py + 6), label, fill="#5b54e8", font=font(18, chinese=True), anchor="ma")
        px += pw + 14

    # Right panel: translation card
    cx, cy, cw, ch = 750, 140, 580, 380
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    rounded_rect(od, (cx + 10, cy + 14, cx + cw + 10, cy + ch + 14), (0, 0, 0, 28), radius=34)
    img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
    draw = ImageDraw.Draw(img)
    rounded_rect(draw, (cx, cy, cx + cw, cy + ch), COLORS["white"], outline=COLORS["line"], width=2, radius=34)

    # browser bar
    bar_h = 48
    rounded_rect(draw, (cx, cy, cx + cw, cy + bar_h), "#f8faff", outline=COLORS["line"], width=1, radius=34)
    draw.rectangle((cx + 1, cy + bar_h // 2, cx + cw - 1, cy + bar_h), fill="#f8faff")
    for dx, color in [(20, "#ff6b6b"), (36, "#fbbf24"), (52, "#34d399")]:
        draw.ellipse((cx + dx, cy + 18, cx + dx + 11, cy + 29), fill=color)
    draw.rounded_rectangle((cx + 75, cy + 14, cx + cw - 20, cy + 34), radius=12, fill="#e9edf7")

    # content (compact spacing to fit inside the card without overflow)
    tx, ty = cx + 44, cy + bar_h + 34
    f_title = font(28, bold=True)
    f_body = font(20, chinese=True)
    f_trans = font(20, chinese=True)
    draw.text((tx, ty), "How will OpenAI compete?", fill=COLORS["ink"], font=f_title)
    ty += f_title.size + 16

    body_lines = [
        "Great products start with clear thinking, patient",
        "iteration, and a strong sense of what users truly need.",
    ]
    for line in body_lines:
        draw.text((tx, ty), line, fill="#233047", font=f_body)
        ty += f_body.size + 6
    ty += 3

    draw.rectangle((tx, ty, tx + 4, ty + f_body.size + 10), fill=COLORS["violet"])
    trans_lines = ["优秀产品始于清晰思考、耐心迭代，", "以及对用户真实需求的敏锐理解。"]
    for line in trans_lines:
        draw.text((tx + 16, ty), line, fill="#6875b5", font=f_trans)
        ty += f_trans.size + 5
    ty += 6

    body_lines2 = [
        "The best tools feel quiet in your workflow, but",
        "powerful exactly when you need them.",
    ]
    for line in body_lines2:
        draw.text((tx, ty), line, fill="#233047", font=f_body)
        ty += f_body.size + 6
    ty += 3
    draw.rectangle((tx, ty, tx + 4, ty + f_body.size + 10), fill=COLORS["violet"])
    trans_lines2 = ["最好的工具会安静地融入工作流，", "并在你需要时刚好发挥力量。"]
    for line in trans_lines2:
        draw.text((tx + 16, ty), line, fill="#6875b5", font=f_trans)
        ty += f_trans.size + 5

    img.save(OUT / "top-promo-1400x560.png")


if __name__ == "__main__":
    small_promo()
    print(f"Generated {OUT / 'small-promo-440x280.png'} (440×280)")
    large_promo()
    print(f"Generated {OUT / 'top-promo-1400x560.png'} (1400×560)")
