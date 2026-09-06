#!/usr/bin/env python3
"""Generate English LingoFlow store screenshots (1280x800) in PIL."""
import os
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageOps, ImageColor

ROOT = Path(os.environ.get("LINGOFLOW_ROOT", "."))
OUT = ROOT / "store-assets" / "en" / "screenshots"
OUT.mkdir(parents=True, exist_ok=True)
ICON = ROOT / "icons" / "icon-128.png"

W, H = 1280, 800

COLORS = {
    "blue": "#62a8ff",
    "violet": "#7468ff",
    "lavender": "#b9b0ff",
    "ink": "#111827",
    "muted": "#61708a",
    "panel": (255, 255, 255, 214),
    "line": (108, 120, 255, 46),
    "white": "#ffffff",
    "dark_card": "#29254e",
    "purple_text": "#6875b5",
    "green": "#10b981",
    "red": "#ef4444",
    "yellow": "#fbbf24",
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


F = {
    "brand": font(34, bold=False),
    "kicker": font(19, bold=True),
    "h1": font(48, bold=True),
    "lead": font(24),
    "h2": font(36, bold=True),
    "body": font(21, chinese=True),
    "small": font(18),
    "tiny": font(14),
    "card_title": font(24, bold=True),
    "card_body": font(18),
}


def load_icon(size=72):
    if not ICON.exists():
        return None
    img = Image.open(ICON).convert("RGBA")
    img = img.resize((size, size), Image.Resampling.LANCZOS)
    return img


def rounded_rect(draw, xy, fill, outline=None, width=1, radius=20):
    draw.rounded_rectangle(xy, radius=radius, fill=fill, outline=outline, width=width)


def base():
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
        (W + 120, H + 150, 440, 440, COLORS["violet"], 36),
        (-170, 260, 360, 360, COLORS["blue"], 36),
    ]:
        overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        od = ImageDraw.Draw(overlay)
        od.ellipse((cx - rw, cy - rh, cx + rw, cy + rh), fill=(*ImageColor.getrgb(color), alpha))
        img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
        draw = ImageDraw.Draw(img)
    return img, draw


def draw_brand(draw, img, x=74, y=64):
    icon = load_icon(72)
    if icon:
        img.paste(icon, (x, y), icon)
    draw.text((x + 90, y + 14), "LingoFlow", fill=COLORS["violet"], font=F["brand"])
    return y + 110


def draw_text_block(draw, x, y, kicker, title, lead, max_w=560):
    draw.text((x, y), kicker, fill=COLORS["violet"], font=F["kicker"])
    y += 32
    # wrap title
    words = title.split()
    line = ""
    for word in words:
        test = (line + " " + word).strip()
        if draw.textlength(test, font=F["h1"]) <= max_w:
            line = test
        else:
            draw.text((x, y), line, fill=COLORS["ink"], font=F["h1"])
            y += F["h1"].size + 8
            line = word
    if line:
        draw.text((x, y), line, fill=COLORS["ink"], font=F["h1"])
        y += F["h1"].size + 12
    # lead
    lead_lines = []
    line = ""
    for word in lead.split():
        test = (line + " " + word).strip()
        if draw.textlength(test, font=F["lead"]) <= max_w:
            line = test
        else:
            lead_lines.append(line)
            line = word
    if line:
        lead_lines.append(line)
    for l in lead_lines:
        draw.text((x, y), l, fill=COLORS["muted"], font=F["lead"])
        y += F["lead"].size + 10
    return y


def wrap_text(draw, text, max_w, f):
    lines = []
    current = ""
    if " " in text:
        for word in text.split():
            test = (current + " " + word).strip() if current else word
            if draw.textlength(test, font=f) <= max_w:
                current = test
            else:
                if current:
                    lines.append(current)
                current = word
    else:
        for char in text:
            test = current + char
            if draw.textlength(test, font=f) <= max_w:
                current = test
            else:
                if current:
                    lines.append(current)
                current = char
    if current:
        lines.append(current)
    return lines


def browser_card(img, draw, x, y, w, h, article_items):
    # card shadow simulation via larger translucent rect
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    rounded_rect(od, (x + 6, y + 12, x + w + 6, y + h + 12), (0, 0, 0, 30), radius=30)
    img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
    draw = ImageDraw.Draw(img)
    rounded_rect(draw, (x, y, x + w, y + h), COLORS["white"], outline="#e2e8f7", width=2, radius=30)
    # browser bar
    bar_h = 48
    rounded_rect(draw, (x, y, x + w, y + bar_h), "#f8faff", outline="#e2e8f7", width=1, radius=30)
    # draw only top rounded corners
    draw.rectangle((x + 1, y + bar_h // 2, x + w - 1, y + bar_h), fill="#f8faff")
    for dx, color in [(20, "#ff6b6b"), (36, "#fbbf24"), (52, "#34d399")]:
        draw.ellipse((x + dx, y + 18, x + dx + 11, y + 29), fill=color)
    draw.rounded_rectangle((x + 75, y + 14, x + w - 20, y + 34), radius=12, fill="#e9edf7")
    # content
    cy = y + bar_h + 32
    cx = x + 44
    for item in article_items:
        if item["type"] == "h2":
            draw.text((cx, cy), item["text"], fill=COLORS["ink"], font=F["h2"])
            cy += F["h2"].size + 22
        elif item["type"] in ("para", "translation"):
            max_w = w - 88
            fill = "#233047" if item["type"] == "para" else COLORS["purple_text"]
            if item["type"] == "translation":
                draw.rectangle((cx, cy, cx + 4, cy + F["body"].size + 12), fill=COLORS["violet"])
                tx = cx + 16
            else:
                tx = cx
            for line in wrap_text(draw, item["text"], max_w, F["body"]):
                draw.text((tx, cy), line, fill=fill, font=F["body"])
                cy += F["body"].size + 8
            cy += 14
    return img, draw


def screenshot_01_bilingual():
    img, draw = base()
    y = draw_brand(draw, img, 74, 64)
    # left text
    y = draw_text_block(draw, 74, y, "BILINGUAL MODE",
                        "Original English and Translation Aligned",
                        "Bilingual mode places the translated text right below each paragraph, keeping the page layout and reading flow intact.",
                        max_w=560)
    # right browser card
    article = [
        {"type": "h2", "text": "How will OpenAI compete?"},
        {"type": "para", "text": "Great products start with clear thinking, patient iteration, and a strong sense of what users truly need."},
        {"type": "translation", "text": "优秀产品始于清晰思考、耐心迭代，以及对用户真实需求的敏锐理解。"},
        {"type": "para", "text": "The best tools feel quiet in your workflow, but powerful exactly when you need them."},
        {"type": "translation", "text": "最好的工具会安静地融入工作流，并在你需要时刚好发挥力量。"},
    ]
    img, draw = browser_card(img, draw, 660, 190, 540, 560, article)
    img.save(OUT / "01-bilingual-mode.png")


def screenshot_02_selection():
    img, draw = base()
    y = draw_brand(draw, img, 74, 64)
    draw_text_block(draw, 74, y, "SELECTION TRANSLATE",
                    "Word Lookup & Sentence Translation",
                    "Hover over any word for dictionary details, or select a sentence to translate instantly. Saved words and sentences go into your vocabulary list.",
                    max_w=560)
    # dictionary card
    x, y, w, h = 660, 190, 540, 460
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    rounded_rect(od, (x + 8, y + 16, x + w + 8, y + h + 16), (0, 0, 0, 40), radius=28)
    img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
    draw = ImageDraw.Draw(img)
    rounded_rect(draw, (x, y, x + w, y + h), COLORS["dark_card"], radius=28)
    cx, cy = x + 36, y + 36
    draw.text((cx, cy), "demands", fill="white", font=F["h2"])
    cy += F["h2"].size + 10
    draw.text((cx, cy), "/dɪˈmændz/", fill="#bdb7df", font=F["lead"])
    cy += F["lead"].size + 24
    for pos, meaning in [("noun", "The quantity of a good or service that consumers are willing to buy."),
                         ("verb", "To ask for something forcefully or require a particular skill.")]:
        draw.rounded_rectangle((cx, cy, cx + 70, cy + 28), radius=14, fill="#e7e3ff")
        draw.text((cx + 35, cy + 3), pos, fill="#5b54e8", font=F["small"], anchor="ma")
        line = ""
        max_w = w - 130
        for word in meaning.split():
            test = (line + " " + word).strip()
            if draw.textlength(test, font=F["body"]) <= max_w:
                line = test
            else:
                draw.text((cx + 90, cy), line, fill="#edeaff", font=F["body"])
                cy += F["body"].size + 8
                line = word
        if line:
            draw.text((cx + 90, cy), line, fill="#edeaff", font=F["body"])
            cy += F["body"].size + 18
    # quote
    cy += 10
    draw.rectangle((cx, cy, cx + 3, cy + F["small"].size + 10), fill="#b9b0ff")
    draw.text((cx + 14, cy), "\"The role demands strong problem-solving skills.\"", fill="#bdb7df", font=F["small"])
    # toolbar — dynamic width and vertically centered text
    tx, ty = 120, 620
    labels = ["Translate", "Copy", "Save"]
    f_btn = F["small"]
    btn_h = 30
    pad_x = 14
    gap = 10
    side = 14
    x = tx + side
    buttons = []
    for label in labels:
        lw = int(draw.textlength(label, font=f_btn))
        bw = lw + pad_x * 2
        buttons.append((x, bw, label))
        x += bw + gap
    toolbar_w = x - gap + side
    rounded_rect(draw, (tx, ty, tx + toolbar_w, ty + 54), "#29254e", radius=18)
    for bx, bw, label in buttons:
        by = ty + 12
        rounded_rect(draw, (bx, by, bx + bw, by + btn_h), radius=12, fill="#7468ff")
        draw.text((bx + bw // 2, by + btn_h // 2), label, fill="white", font=f_btn, anchor="mm")
    img.save(OUT / "02-selection-translation.png")


def screenshot_03_engines():
    img, draw = base()
    y = draw_brand(draw, img, 74, 64)
    draw_text_block(draw, 74, y, "MULTIPLE ENGINES",
                    "Free, API & AI Models Clearly Labeled",
                    "Choose the engine that fits your workflow and pick a translation color to tell original and translated text apart.",
                    max_w=560)
    # settings panel
    x, y, w, h = 700, 190, 500, 460
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    rounded_rect(od, (x + 8, y + 12, x + w + 8, y + h + 12), (0, 0, 0, 30), radius=28)
    img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
    draw = ImageDraw.Draw(img)
    rounded_rect(draw, (x, y, x + w, y + h), COLORS["white"], outline="#e2e8f7", width=2, radius=28)
    rows = [
        ("engine", "Google Translate", "Free", "Fast and general-purpose for light web translation.", COLORS["green"]),
        ("engine", "Microsoft Translator", "API", "Stable and professional for long-term reading.", COLORS["red"]),
        ("engine", "Gemini AI", "API", "More natural, context-aware translations.", COLORS["red"]),
        ("color", "Translation Color", "Blue", "Pick a color to tell original and translated text apart at a glance.", None),
    ]
    cy = y + 24
    for idx, (kind, *rest) in enumerate(rows):
        if kind == "engine":
            name, tag, desc, tag_color = rest
            draw.text((x + 28, cy), name, fill=COLORS["ink"], font=F["card_title"])
            tw = draw.textlength(name, font=F["card_title"])
            tag_x = x + 38 + int(tw)
            tag_bg = "#d1fae5" if tag_color == COLORS["green"] else "#fee2e2"
            draw.rounded_rectangle((tag_x, cy, tag_x + 60, cy + 24), radius=12, fill=tag_bg)
            draw.text((tag_x + 30, cy + 2), tag, fill=tag_color, font=F["tiny"], anchor="ma")
            cy += F["card_title"].size + 8
            draw.text((x + 28, cy), desc, fill=COLORS["muted"], font=F["card_body"])
            cy += F["card_body"].size + 26
        else:
            name, select_text, desc, _ = rest
            draw.text((x + 28, cy), name, fill=COLORS["ink"], font=F["card_title"])
            sw = int(draw.textlength(select_text, font=F["small"]))
            box_w = sw + 36
            box_h = 30
            sx = x + w - 28 - box_w
            sy = cy - 1
            draw.rounded_rectangle((sx, sy, sx + box_w, sy + box_h), radius=10, fill="#dbeafe", outline="#93c5fd", width=1)
            draw.text((sx + box_w // 2, sy + box_h // 2 + 1), select_text, fill="#2563eb", font=F["small"], anchor="mm")
            cy += F["card_title"].size + 10
            # wrap desc to card width
            max_dw = w - 56
            line = ""
            for word in desc.split():
                test = (line + " " + word).strip()
                if draw.textlength(test, font=F["card_body"]) <= max_dw:
                    line = test
                else:
                    draw.text((x + 28, cy), line, fill=COLORS["muted"], font=F["card_body"])
                    cy += F["card_body"].size + 6
                    line = word
            if line:
                draw.text((x + 28, cy), line, fill=COLORS["muted"], font=F["card_body"])
                cy += F["card_body"].size + 26
        if idx < len(rows) - 1:
            draw.line([(x + 28, cy - 8), (x + w - 28, cy - 8)], fill="#e2e8f7", width=1)
    img.save(OUT / "03-translation-engines.png")


def screenshot_04_library():
    img, draw = base()
    y = draw_brand(draw, img, 74, 64)
    draw_text_block(draw, 74, y, "LEARN & REVIEW",
                    "Vocabulary, History & Settings in One Popup",
                    "Save translated words and sentences, review your history, and switch themes — all from the same popup.",
                    max_w=560)
    # 2x2 library cards
    cards = [
        ("Vocabulary", "Save words, sentences, meanings and source pages for later review.", ["Word", "Sentence"]),
        ("History", "Track translated content, or turn off history saving in settings.", ["Search", "Clear"]),
        ("Light / Dark", "A blue-purple brand theme that follows system or manual preference.", []),
        ("Auto Save", "Settings take effect immediately, no extra clicks needed.", []),
    ]
    sx, sy = 660, 190
    cw, ch, gap = 260, 210, 18
    for i, (title, desc, pills) in enumerate(cards):
        col = i % 2
        row = i // 2
        cx = sx + col * (cw + gap)
        cy = sy + row * (ch + gap)
        overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        od = ImageDraw.Draw(overlay)
        rounded_rect(od, (cx + 4, cy + 8, cx + cw + 4, cy + ch + 8), (0, 0, 0, 25), radius=22)
        img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
        draw = ImageDraw.Draw(img)
        rounded_rect(draw, (cx, cy, cx + cw, cy + ch), COLORS["white"], outline="#e2e8f7", width=2, radius=22)
        draw.text((cx + 24, cy + 24), title, fill=COLORS["ink"], font=F["card_title"])
        # wrap desc
        max_w = cw - 48
        line = ""
        dy = cy + 60
        for word in desc.split():
            test = (line + " " + word).strip()
            if draw.textlength(test, font=F["card_body"]) <= max_w:
                line = test
            else:
                draw.text((cx + 24, dy), line, fill=COLORS["muted"], font=F["card_body"])
                dy += F["card_body"].size + 6
                line = word
        if line:
            draw.text((cx + 24, dy), line, fill=COLORS["muted"], font=F["card_body"])
        # pills
        px = cx + 24
        py = cy + ch - 42
        for pill in pills:
            pw = int(draw.textlength(pill, font=F["tiny"])) + 20
            draw.rounded_rectangle((px, py, px + pw, py + 22), radius=11, fill="#eeecff")
            draw.text((px + pw // 2, py + 3), pill, fill="#5b54e8", font=F["tiny"], anchor="ma")
            px += pw + 8
    img.save(OUT / "04-vocabulary-history.png")


def screenshot_05_support():
    img, draw = base()
    y = draw_brand(draw, img, 74, 64)
    draw_text_block(draw, 74, y, "PRIVACY FIRST",
                    "Your Reading Data Stays Under Your Control",
                    "Translation history, vocabulary and API settings are stored locally in your browser. You can disable history at any time, or restore the original page in one click.",
                    max_w=560)
    # privacy card
    x, y, w, h = 660, 190, 540, 520
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    rounded_rect(od, (x + 8, y + 12, x + w + 8, y + h + 12), (0, 0, 0, 30), radius=28)
    img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
    draw = ImageDraw.Draw(img)
    rounded_rect(draw, (x, y, x + w, y + h), COLORS["white"], outline="#e2e8f7", width=2, radius=28)
    rows = [
        ("Local Storage", "History, vocabulary and settings stay in your browser."),
        ("History Toggle", "Turn off history saving whenever you want."),
        ("Restore Original", "Remove inserted translations from the page in one click."),
    ]
    cy = y + 32
    for title, desc in rows:
        rx, ry = x + 24, cy
        rw, rh = w - 48, 92
        rounded_rect(draw, (rx, ry, rx + rw, ry + rh), "#ffffff", outline="#e2e8f7", width=1, radius=18)
        # dot
        draw.ellipse((rx + 18, ry + 20, rx + 30, ry + 32), fill=COLORS["violet"])
        draw.text((rx + 48, ry + 14), title, fill=COLORS["ink"], font=F["card_title"])
        draw.text((rx + 48, ry + 50), desc, fill=COLORS["muted"], font=F["card_body"])
        cy += rh + 14
    # button
    by = y + h - 80
    bw, bh = 220, 54
    bx = x + 28
    draw.rounded_rectangle((bx, by, bx + bw, by + bh), radius=16, fill=COLORS["blue"])
    draw.text((bx + bw // 2, by + bh // 2), "Start Foreign Reading", fill="white", font=F["small"], anchor="mm")
    img.save(OUT / "05-privacy-support.png")


if __name__ == "__main__":
    screenshot_01_bilingual()
    screenshot_02_selection()
    screenshot_03_engines()
    screenshot_04_library()
    screenshot_05_support()
    print(f"Generated English screenshots in {OUT}")
