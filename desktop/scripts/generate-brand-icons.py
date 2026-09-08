#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""a2d2 브랜드 아이콘을 한 번에 만들어 내는 스크립트.

이거 하나만 돌리면 데스크톱·iOS·안드로이드·윈도우 아이콘에 DMG 배경,
랜딩 워드마크, 파비콘 SVG 까지 전부 다시 나온다.
같은 입력이면 같은 바이트가 나오게(결정적) 짜 놨다.

    python3 desktop/scripts/generate-brand-icons.py
    python3 desktop/scripts/generate-brand-icons.py --check
    python3 desktop/scripts/generate-brand-icons.py --name a2d2 --source my-logo-1024.png

그림 구성
    검은(#111111) 둥근 사각 안에 흰 소문자 워드마크 "a2d2",
    글자 끝에 마침표처럼 앰버(#F5B301) 점 하나.

--source 를 주면
    그 PNG 를 "꽉 찬 정사각형 마스터 그림"으로 보고 글자 렌더 대신 갖다 쓴다.
    다만 DMG 배경 · 랜딩 워드마크 · SVG 는 글자 묶음이 따로 필요해서
    그때도 글자를 그린다(실행할 때 화면에 알려 준다).
"""

from __future__ import annotations

import argparse
import math
import os
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # pragma: no cover - 안내용
    sys.exit("Pillow 가 없다. `pip install Pillow` 로 깔고 다시 돌려라.")

RESAMPLE = Image.Resampling.LANCZOS

# ---------------------------------------------------------------------------
# 브랜드 값
# ---------------------------------------------------------------------------

BRAND_BG = (0x11, 0x11, 0x11, 0xFF)      # #111111 바탕
BRAND_FG = (0xFF, 0xFF, 0xFF, 0xFF)      # #FFFFFF 글자
BRAND_DOT = (0xF5, 0xB3, 0x01, 0xFF)     # #F5B301 앰버 점
BRAND_INK = (0x11, 0x11, 0x11, 0xFF)     # 밝은 바탕에 올리는 글자색
TAGLINE_FG = (0xB8, 0xB8, 0xB8, 0xFF)    # #B8B8B8 태그라인
ARROW_FG = (0x55, 0x55, 0x55, 0xFF)      # #555555 화살표

BG_HEX = "#111111"

TAGLINE = "Your people, your agents, your projects — all in one place."

# 정사각 그림칸(art box) 한 변을 1 로 봤을 때의 비율.
GROUP_OF_ART = 0.66   # 글자+점 묶음 너비
DOT_OF_ART = 0.09     # 점 지름
GAP_OF_ART = 0.04     # 글자와 점 사이

# 묶음 너비만 알면 점 크기가 정해지게 미리 나눠 둔다.
DOT_OF_GROUP = DOT_OF_ART / GROUP_OF_ART
GAP_OF_GROUP = GAP_OF_ART / GROUP_OF_ART

MASTER = 1024         # 마스터 한 변
SUPERSAMPLE = 2       # 2048 에 그려서 1024 로 줄인다(가장자리 곱게)

# 애플 Big Sur 격자: 1024 칸에 824 본체, 여백 100, 모서리 반지름 185.
ROUNDED_MARGIN = 100
ROUNDED_RADIUS = 185
ROUNDED_BODY = MASTER - 2 * ROUNDED_MARGIN   # 824

ANDROID_MARGIN = 0.06   # 안드로이드 레거시 아이콘 여백
ANDROID_CORNER = 0.22   # 본체 한 변 대비 모서리 반지름
ANDROID_SAFE = 0.66     # 어댑티브 전경 안전 영역(가운데 66%)

ICO_SIZES = [16, 24, 32, 48, 64, 256]

ICONSET_ENTRIES = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]

# ---------------------------------------------------------------------------
# 폰트 고르기 — 앞에서부터 있는 걸 쓴다
# ---------------------------------------------------------------------------

# (파일 경로, 찾을 스타일 이름들). 스타일이 None 이면 단일 폰트 파일이라 그냥 쓴다.
BOLD_FONT_CANDIDATES = [
    ("/System/Library/Fonts/Supplemental/Futura.ttc", ("Bold",)),
    ("/System/Library/Fonts/Avenir Next.ttc", ("Bold",)),
    ("/System/Library/Fonts/Supplemental/Avenir Next.ttc", ("Bold",)),
    ("/System/Library/Fonts/Helvetica.ttc", ("Bold",)),
    ("/System/Library/Fonts/Supplemental/Helvetica.ttc", ("Bold",)),
    ("/System/Library/Fonts/Supplemental/Arial Bold.ttf", None),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", None),
    ("/usr/share/fonts/TTF/DejaVuSans-Bold.ttf", None),
    ("DejaVuSans-Bold.ttf", None),
]

MEDIUM_FONT_CANDIDATES = [
    ("/System/Library/Fonts/Supplemental/Futura.ttc", ("Medium",)),
    ("/System/Library/Fonts/Avenir Next.ttc", ("Medium",)),
    ("/System/Library/Fonts/Supplemental/Avenir Next.ttc", ("Medium",)),
    ("/System/Library/Fonts/Helvetica.ttc", ("Regular",)),
    ("/System/Library/Fonts/Supplemental/Arial.ttf", None),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", None),
    ("DejaVuSans.ttf", None),
]


class FontRef:
    """어느 파일의 몇 번째 얼굴을 쓰는지 들고 다니는 손잡이."""

    def __init__(self, path: str | None, index: int, label: str, fallback: bool = False):
        self.path = path
        self.index = index
        self.label = label
        self.fallback = fallback

    def at(self, size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
        if self.fallback or self.path is None:
            return ImageFont.load_default()
        return ImageFont.truetype(self.path, size, index=self.index)


def _face_index(path: str, styles: tuple[str, ...] | None) -> int | None:
    """ttc 안에서 원하는 스타일(예: Bold)이 몇 번째인지 찾는다. 없으면 None."""
    if styles is None:
        try:
            ImageFont.truetype(path, 12, index=0)
        except Exception:
            return None
        return 0
    wanted = {s.lower() for s in styles}
    for index in range(64):
        try:
            face = ImageFont.truetype(path, 12, index=index)
        except Exception:
            return None
        name = face.getname()
        style = (name[1] or "").strip().lower()
        if style in wanted:
            return index
    return None


def pick_font(candidates, kind: str) -> FontRef:
    """후보를 앞에서부터 훑어 처음 걸리는 걸 쓴다. 하나도 없으면 Pillow 기본 폰트."""
    for path, styles in candidates:
        if not os.path.exists(path):
            continue
        index = _face_index(path, styles)
        if index is None:
            continue
        family, style = ImageFont.truetype(path, 12, index=index).getname()
        return FontRef(path, index, f"{family} {style} ({path}#{index})")
    return FontRef(None, 0, f"Pillow 기본 폰트 ({kind} 후보를 하나도 못 찾음)", fallback=True)


# ---------------------------------------------------------------------------
# 워드마크 그리기
# ---------------------------------------------------------------------------

_MEASURE = ImageDraw.Draw(Image.new("L", (4, 4)))


def _layout_box(font, text: str):
    """폰트가 알려 주는 글자 상자. 진짜로 찍히는 자리와는 조금 다를 수 있다."""
    return _MEASURE.textbbox((0, 0), text, font=font, anchor="ls")


def _ink_box(font, text: str):
    """실제로 한 번 찍어 보고 잉크가 닿은 자리를 잰다.

    폰트가 알려 주는 상자는 좌우 여분(side bearing)이 붙어 있어서
    그대로 가운데 맞추면 몇 픽셀씩 치우친다. 그래서 직접 찍어서 잰다.
    돌려주는 값은 왼쪽-베이스라인을 (0,0) 으로 본 상대 좌표.
    """
    lx0, ly0, lx1, ly1 = _layout_box(font, text)
    pad = 8
    ox = pad - int(math.floor(min(lx0, 0.0)))
    oy = pad - int(math.floor(ly0))
    width = int(math.ceil(lx1 - min(lx0, 0.0))) + 2 * pad
    height = int(math.ceil(ly1 - ly0)) + 2 * pad
    canvas = Image.new("L", (max(width, 1), max(height, 1)), 0)
    ImageDraw.Draw(canvas).text((ox, oy), text, font=font, fill=255, anchor="ls")
    box = canvas.getbbox()
    if box is None:                      # 빈 글자
        return (0.0, 0.0, 0.0, 0.0)
    return (box[0] - ox, box[1] - oy, box[2] - ox, box[3] - oy)


def _fit_font_size(font_ref: FontRef, text: str, target_width: float) -> int:
    """잉크 너비가 target_width 를 넘지 않는 가장 큰 정수 크기를 이분 탐색으로 찾는다."""
    lo, hi, best = 4, 6000, 4
    while lo <= hi:
        mid = (lo + hi) // 2
        try:
            box = _ink_box(font_ref.at(mid), text)
        except Exception:
            hi = mid - 1
            continue
        if box[2] - box[0] <= target_width:
            best = mid
            lo = mid + 1
        else:
            hi = mid - 1
    return best


def wordmark_metrics(font_ref: FontRef, text: str, group_width: float):
    """글자+점 묶음의 크기와 놓을 자리를 미리 계산한다.

    돌려주는 값은 왼쪽-베이스라인 기준 상대 좌표라서,
    나중에 원하는 중심에 맞춰 통째로 옮기기만 하면 된다.
    """
    dot = group_width * DOT_OF_GROUP
    gap = group_width * GAP_OF_GROUP
    text_target = group_width - dot - gap
    if text_target <= 0:
        raise ValueError("묶음 너비가 너무 작아서 글자가 안 들어간다")

    size = _fit_font_size(font_ref, text, text_target)
    font = font_ref.at(size)
    x0, y0, x1, y1 = _ink_box(font, text)

    left = x0
    right = x1 + gap + dot
    top = min(y0, -dot)        # 점은 베이스라인 위로 지름만큼 올라간다
    bottom = max(y1, 0.0)      # 점 바닥이 베이스라인
    return {
        "font": font,
        "font_size": size,
        "dot": dot,
        "gap": gap,
        "text_right": x1,
        "left": left,
        "right": right,
        "top": top,
        "bottom": bottom,
        "width": right - left,
        "height": bottom - top,
    }


def draw_wordmark(img: Image.Image, center, group_width: float, font_ref: FontRef,
                  text: str, fg, dot_color):
    """묶음 잉크의 한가운데가 center 에 오도록 글자와 점을 찍는다."""
    m = wordmark_metrics(font_ref, text, group_width)
    cx, cy = center
    origin_x = cx - m["width"] / 2.0 - m["left"]
    baseline_y = cy - m["height"] / 2.0 - m["top"]

    draw = ImageDraw.Draw(img)
    draw.text((origin_x, baseline_y), text, font=m["font"], fill=fg, anchor="ls")

    dot_left = origin_x + m["text_right"] + m["gap"]
    dot_top = baseline_y - m["dot"]
    draw.ellipse((dot_left, dot_top, dot_left + m["dot"], baseline_y), fill=dot_color)
    return m


# ---------------------------------------------------------------------------
# 변형 마스터 만들기 (2048 에 그려 1024 로 축소)
# ---------------------------------------------------------------------------

VARIANTS = ("rounded", "ios", "android-legacy", "android-round", "android-foreground")


def _paste_source(img: Image.Image, source: Image.Image, box):
    """--source 로 받은 그림을 그림칸에 맞춰 넣는다."""
    x, y, side = box
    fitted = source.resize((side, side), RESAMPLE)
    img.paste(fitted, (x, y), fitted)


def build_variant(variant: str, text: str, font_ref: FontRef,
                  source: Image.Image | None = None) -> Image.Image:
    """변형 하나를 1024 마스터로 만들어 돌려준다."""
    if variant not in VARIANTS:
        raise ValueError(f"모르는 변형: {variant}")

    px = MASTER * SUPERSAMPLE
    img = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    scale = px / MASTER

    if variant == "rounded":
        margin = round(ROUNDED_MARGIN * scale)
        radius = round(ROUNDED_RADIUS * scale)
        draw.rounded_rectangle((margin, margin, px - 1 - margin, px - 1 - margin),
                               radius=radius, fill=BRAND_BG)
        art = (margin, margin, px - 2 * margin)
    elif variant == "ios":
        draw.rectangle((0, 0, px - 1, px - 1), fill=BRAND_BG)
        art = (0, 0, px)
    elif variant in ("android-legacy", "android-round"):
        margin = round(ANDROID_MARGIN * px)
        side = px - 2 * margin
        box = (margin, margin, px - 1 - margin, px - 1 - margin)
        if variant == "android-legacy":
            draw.rounded_rectangle(box, radius=round(side * ANDROID_CORNER), fill=BRAND_BG)
        else:
            draw.ellipse(box, fill=BRAND_BG)
        art = (margin, margin, side)
    else:  # android-foreground — 바탕 없이 안전 영역 안에만 그린다
        safe = round(ANDROID_SAFE * px)
        offset = (px - safe) // 2
        art = (offset, offset, safe)

    x, y, side = art
    if source is not None:
        if variant == "android-foreground":
            _paste_source(img, source, art)
        else:
            mark = Image.new("RGBA", (px, px), (0, 0, 0, 0))
            _paste_source(mark, source, art)
            # 바탕 모양(둥근 사각/원) 밖으로는 안 나가게 알파를 곱한다
            mark.putalpha(Image.composite(mark.getchannel("A"),
                                          Image.new("L", (px, px), 0),
                                          img.getchannel("A")))
            img.alpha_composite(mark)
    else:
        color = BRAND_FG
        draw_wordmark(img, (x + side / 2.0, y + side / 2.0), side * GROUP_OF_ART,
                      font_ref, text, color, BRAND_DOT)

    return img.resize((MASTER, MASTER), RESAMPLE)


# ---------------------------------------------------------------------------
# 만들어야 하는 파일 목록 — 검사(--check)도 이 표 하나만 본다
# ---------------------------------------------------------------------------

DESKTOP_PNGS = [
    ("32x32.png", 32),
    ("64x64.png", 64),
    ("128x128.png", 128),
    ("128x128@2x.png", 256),
    ("icon.png", 512),
    ("Square30x30Logo.png", 30),
    ("Square44x44Logo.png", 44),
    ("Square71x71Logo.png", 71),
    ("Square89x89Logo.png", 89),
    ("Square107x107Logo.png", 107),
    ("Square142x142Logo.png", 142),
    ("Square150x150Logo.png", 150),
    ("Square284x284Logo.png", 284),
    ("Square310x310Logo.png", 310),
    ("StoreLogo.png", 50),
]

IOS_PNGS = [
    ("AppIcon-20x20@1x.png", 20),
    ("AppIcon-20x20@2x.png", 40),
    ("AppIcon-20x20@2x-1.png", 40),
    ("AppIcon-20x20@3x.png", 60),
    ("AppIcon-29x29@1x.png", 29),
    ("AppIcon-29x29@2x.png", 58),
    ("AppIcon-29x29@2x-1.png", 58),
    ("AppIcon-29x29@3x.png", 87),
    ("AppIcon-40x40@1x.png", 40),
    ("AppIcon-40x40@2x.png", 80),
    ("AppIcon-40x40@2x-1.png", 80),
    ("AppIcon-40x40@3x.png", 120),
    ("AppIcon-60x60@2x.png", 120),
    ("AppIcon-60x60@3x.png", 180),
    ("AppIcon-76x76@1x.png", 76),
    ("AppIcon-76x76@2x.png", 152),
    ("AppIcon-83.5x83.5@2x.png", 167),
    ("AppIcon-512@2x.png", 1024),
]

# 원래 파일 크기 그대로 재현한다. hdpi 가 49 인 것도 원본이 그래서다(표준 72 아님).
ANDROID_DENSITIES = [
    ("mdpi", 48, 108),
    ("hdpi", 49, 162),
    ("xhdpi", 96, 216),
    ("xxhdpi", 144, 324),
    ("xxxhdpi", 192, 432),
]

PUBLIC_PNGS = [
    ("app-icon@2x.png", 112),
    ("app-icon@3x.png", 168),
]

LANDING_WORDMARK = ("landing/buzz-wordmark.png", 777, 326)
DMG_BACKGROUND = ("dmg-background.png", 1320, 1000)


def expected_outputs(root: Path):
    """(경로, 기대 크기, 기대 모드) 목록. 없는 파일은 표의 기본값을 쓴다."""
    icons = root / "desktop/src-tauri/icons"
    public = root / "desktop/public"
    out = []

    for name, size in DESKTOP_PNGS:
        out.append((icons / name, (size, size), "RGBA"))
    out.append((icons / "buzz-source.png", (MASTER, MASTER), "RGB"))

    for name, size in IOS_PNGS:
        path = icons / "ios" / name
        out.append((path, (existing_side(path, size),) * 2, "RGBA"))

    for density, launcher, foreground in ANDROID_DENSITIES:
        base = icons / "android" / f"mipmap-{density}"
        for name, default in (("ic_launcher.png", launcher),
                              ("ic_launcher_round.png", launcher),
                              ("ic_launcher_foreground.png", foreground)):
            path = base / name
            out.append((path, (existing_side(path, default),) * 2, "RGBA"))

    for name, size in PUBLIC_PNGS:
        out.append((public / name, (size, size), "RGBA"))

    name, width, height = LANDING_WORDMARK
    out.append((public / name, (width, height), "RGBA"))
    name, width, height = DMG_BACKGROUND
    out.append((icons / name, (width, height), "RGB"))
    return out


def existing_side(path: Path, default: int) -> int:
    """이미 있는 파일이면 그 크기를 그대로 따라간다. 없으면 표의 값."""
    if path.exists():
        try:
            with Image.open(path) as im:
                if im.width == im.height:
                    return im.width
        except Exception:
            pass
    return default


# ---------------------------------------------------------------------------
# 저장 도우미 — 결정적으로(같은 입력이면 같은 바이트) 쓴다
# ---------------------------------------------------------------------------

WRITTEN: list[tuple[Path, str]] = []


def save_png(img: Image.Image, path: Path, mode: str = "RGBA"):
    path.parent.mkdir(parents=True, exist_ok=True)
    out = img.convert(mode) if img.mode != mode else img.copy()
    out.info = {}          # 원본에 붙어 온 메타데이터(ICC 등)는 떼고 저장
    out.save(path, format="PNG", optimize=True)
    WRITTEN.append((path, f"{out.width}x{out.height} {mode}"))


def scaled(master: Image.Image, side: int) -> Image.Image:
    return master if side == master.width else master.resize((side, side), RESAMPLE)


# ---------------------------------------------------------------------------
# icns / ico
# ---------------------------------------------------------------------------

def write_icns(master: Image.Image, path: Path) -> bool:
    """iconutil 로 icns 를 만든다. iconutil 이 없으면 건너뛰고 False."""
    if shutil.which("iconutil") is None:
        print("  ! iconutil 이 없어서 icon.icns 는 건너뛴다", file=sys.stderr)
        return False
    with tempfile.TemporaryDirectory(prefix="a2d2-iconset-") as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for name, side in ICONSET_ENTRIES:
            scaled(master, side).save(iconset / name, format="PNG", optimize=True)
        path.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(path)],
                       check=True)
    WRITTEN.append((path, f"icns / {len(ICONSET_ENTRIES)}장"))
    return True


def write_ico(master: Image.Image, path: Path):
    frames = [scaled(master, side) for side in ICO_SIZES]
    base = frames[-1]      # 256 짜리를 기준으로 두고 나머지는 append_images 로 넘긴다
    path.parent.mkdir(parents=True, exist_ok=True)
    base.save(path, format="ICO",
              sizes=[(s, s) for s in ICO_SIZES],
              append_images=frames[:-1])
    WRITTEN.append((path, "ico / " + ", ".join(str(s) for s in ICO_SIZES)))


def icns_chunks(path: Path) -> list[tuple[str, int]]:
    """만들어진 icns 안에 어떤 청크가 들어갔는지 훑는다."""
    data = path.read_bytes()
    chunks, offset = [], 8
    while offset + 8 <= len(data):
        kind = data[offset:offset + 4].decode("ascii", "replace")
        length = struct.unpack(">I", data[offset + 4:offset + 8])[0]
        if length < 8:
            break
        chunks.append((kind, length))
        offset += length
    return chunks


# ---------------------------------------------------------------------------
# SVG 파비콘
# ---------------------------------------------------------------------------

SVG_FONT_STACK = "Futura, 'Avenir Next', 'Helvetica Neue', Helvetica, Arial, sans-serif"


def write_svg(path: Path, text: str, font_ref: FontRef):
    """512 뷰박스 파비콘. 자리 계산은 Futura 기준으로 하고 글자는 SVG text 로 둔다."""
    side = 512.0
    m = wordmark_metrics(font_ref, text, side * GROUP_OF_ART)
    ratio = side * GROUP_OF_ART / m["width"]      # 이분 탐색으로 조금 작아진 만큼 되돌린다

    font_size = m["font_size"] * ratio
    dot = m["dot"]
    gap = m["gap"]
    text_width = (m["text_right"] - m["left"]) * ratio
    group_w = m["width"] * ratio
    group_h = m["height"] * ratio

    left = side / 2.0 - group_w / 2.0
    baseline = side / 2.0 + group_h / 2.0 - m["bottom"] * ratio
    text_cx = left + text_width / 2.0
    dot_cx = left + text_width + gap + dot / 2.0
    dot_cy = baseline - dot / 2.0

    def n(value: float) -> str:
        return f"{value:.2f}".rstrip("0").rstrip(".")

    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" '
        f'role="img" aria-label="{text}">\n'
        f'  <rect width="512" height="512" rx="96" fill="{BG_HEX}"/>\n'
        f'  <text x="{n(text_cx)}" y="{n(baseline)}" fill="#FFFFFF" '
        f'font-family="{SVG_FONT_STACK}" font-weight="700" '
        f'font-size="{n(font_size)}" text-anchor="middle">{text}</text>\n'
        f'  <circle cx="{n(dot_cx)}" cy="{n(dot_cy)}" r="{n(dot / 2.0)}" fill="#F5B301"/>\n'
        f'</svg>\n'
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(svg, encoding="utf-8")
    WRITTEN.append((path, f"svg / 512 viewBox, font-size {n(font_size)}"))


# ---------------------------------------------------------------------------
# 랜딩 워드마크 · DMG 배경
# ---------------------------------------------------------------------------

def write_landing_wordmark(path: Path, text: str, font_ref: FontRef,
                           width: int, height: int, side_margin: float = 0.06):
    ss = SUPERSAMPLE
    img = Image.new("RGBA", (width * ss, height * ss), (0, 0, 0, 0))
    draw_wordmark(img, (width * ss / 2.0, height * ss / 2.0),
                  width * ss * (1 - 2 * side_margin), font_ref, text,
                  BRAND_INK, BRAND_DOT)
    save_png(img.resize((width, height), RESAMPLE), path, "RGBA")


def _arrow(draw: ImageDraw.ImageDraw, x0: float, x1: float, y: float,
           thickness: float, head_len: float, head_half: float, color):
    """설치 창에서 앱을 Applications 로 끌어다 놓으라는 회색 화살표."""
    shaft_end = x1 - head_len
    draw.rectangle((x0, y - thickness / 2.0, shaft_end, y + thickness / 2.0), fill=color)
    draw.polygon([(shaft_end, y - head_half), (x1, y), (shaft_end, y + head_half)], fill=color)


def write_dmg_background(path: Path, text: str, bold: FontRef, medium: FontRef,
                         width: int, height: int):
    ss = SUPERSAMPLE
    img = Image.new("RGBA", (width * ss, height * ss), BRAND_BG)

    # 워드마크: 위에서 22% 지점, 너비는 그림 가로의 28%
    draw_wordmark(img, (width * ss / 2.0, height * ss * 0.22),
                  width * ss * 0.28, bold, text, BRAND_FG, BRAND_DOT)

    # 태그라인: 44px 이 기본인데 너무 길면 가로 76% 안에 들어오게 줄인다
    draw = ImageDraw.Draw(img)
    max_width = width * ss * 0.76
    size = 44 * ss
    while size > 8:
        box = _ink_box(medium.at(size), TAGLINE)
        if box[2] - box[0] <= max_width:
            break
        size -= 1
    font = medium.at(size)
    draw.text((width * ss / 2.0, height * ss * 0.34), TAGLINE,
              font=font, fill=TAGLINE_FG, anchor="mm")

    # 아이콘 두 개(앱 · Applications) 사이의 화살표. 아이콘 자리엔 아무것도 안 그린다.
    _arrow(draw, 540 * ss, 780 * ss, 660 * ss,
           thickness=10 * ss, head_len=42 * ss, head_half=19 * ss, color=ARROW_FG)

    save_png(img.resize((width, height), RESAMPLE), path, "RGB")
    return size // ss


# ---------------------------------------------------------------------------
# 안드로이드 어댑티브 바탕색 xml
# ---------------------------------------------------------------------------

def write_android_background_color(path: Path):
    xml = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<resources>\n'
        f'  <color name="ic_launcher_background">{BG_HEX}</color>\n'
        '</resources>'
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(xml, encoding="utf-8")
    WRITTEN.append((path, f"xml / {BG_HEX}"))


# ---------------------------------------------------------------------------
# 검사
# ---------------------------------------------------------------------------

def run_check(root: Path) -> int:
    bad = 0
    for path, size, mode in expected_outputs(root):
        if not path.exists():
            print(f"  X 없음      {path}")
            bad += 1
            continue
        with Image.open(path) as im:
            actual = (im.width, im.height)
            actual_mode = im.mode
        problems = []
        if actual != size:
            problems.append(f"크기 {actual} != {size}")
        if actual_mode != mode:
            problems.append(f"모드 {actual_mode} != {mode}")
        if problems:
            print(f"  X 어긋남    {path} — {', '.join(problems)}")
            bad += 1
        else:
            print(f"  o {actual[0]}x{actual[1]} {actual_mode:4s} {path}")

    icns = root / "desktop/src-tauri/icons/icon.icns"
    if icns.exists():
        kinds = [k for k, _ in icns_chunks(icns)]
        print(f"  o icns 청크 {' '.join(kinds)}  {icns}")
    else:
        print(f"  X 없음      {icns}")
        bad += 1

    ico = root / "desktop/src-tauri/icons/icon.ico"
    if ico.exists():
        with Image.open(ico) as im:
            got = sorted(w for w, _ in im.ico.sizes())
        if got != sorted(ICO_SIZES):
            print(f"  X 어긋남    {ico} — 크기 {got} != {sorted(ICO_SIZES)}")
            bad += 1
        else:
            print(f"  o ico 크기  {got}  {ico}")
    else:
        print(f"  X 없음      {ico}")
        bad += 1

    for extra in [root / "desktop/public/buzz.svg",
                  root / "desktop/src-tauri/icons/android/values/ic_launcher_background.xml"]:
        if extra.exists():
            print(f"  o 있음      {extra}")
        else:
            print(f"  X 없음      {extra}")
            bad += 1

    print()
    print("검사 결과: 다 맞다" if bad == 0 else f"검사 결과: {bad}개가 어긋난다")
    return 0 if bad == 0 else 1


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def default_root() -> Path:
    # 이 파일은 <root>/desktop/scripts/ 에 있다
    return Path(__file__).resolve().parent.parent.parent


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="a2d2 브랜드 아이콘 한 방에 만들기",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--name", default="a2d2", help="워드마크에 넣을 글자 (기본: a2d2)")
    parser.add_argument("--root", type=Path, default=None,
                        help="저장소 뿌리 (기본: 이 스크립트 위치에서 자동으로 잡는다)")
    parser.add_argument("--source", type=Path, default=None,
                        help="꽉 찬 정사각형 마스터 PNG(1024 권장). 주면 글자 대신 이걸 쓴다")
    parser.add_argument("--check", action="store_true",
                        help="만들지 않고, 이미 있는 파일들의 크기·모드만 검사한다")
    args = parser.parse_args(argv)

    root = (args.root or default_root()).resolve()
    icons = root / "desktop/src-tauri/icons"
    public = root / "desktop/public"

    if args.check:
        print(f"검사 대상: {root}")
        return run_check(root)

    bold = pick_font(BOLD_FONT_CANDIDATES, "굵은 글씨")
    medium = pick_font(MEDIUM_FONT_CANDIDATES, "보통 글씨")
    print(f"저장소 뿌리 : {root}")
    print(f"워드마크    : {args.name!r}")
    print(f"굵은 폰트   : {bold.label}")
    print(f"보통 폰트   : {medium.label}")

    source = None
    if args.source is not None:
        with Image.open(args.source) as im:
            source = im.convert("RGBA")
        source.info = {}
        print(f"마스터 그림 : {args.source} ({source.width}x{source.height})")
        print("  ! --source 를 쓰면 DMG 배경·랜딩 워드마크·buzz.svg 는 그래도 글자를 그린다")
    print()

    masters = {v: build_variant(v, args.name, bold, source) for v in VARIANTS}

    # 1) 데스크톱 / 윈도우 타일 — 둥근 사각(바깥은 투명)
    for name, side in DESKTOP_PNGS:
        save_png(scaled(masters["rounded"], side), icons / name, "RGBA")

    # 2) 마스터 원본 — 꽉 찬 정사각형, 알파 없음
    save_png(masters["ios"], icons / "buzz-source.png", "RGB")

    # 3) macOS icns / Windows ico
    write_icns(masters["rounded"], icons / "icon.icns")
    write_ico(masters["rounded"], icons / "icon.ico")

    # 4) iOS — 여백 없이 꽉 찬 불투명(알파는 전부 255)
    for name, default in IOS_PNGS:
        path = icons / "ios" / name
        save_png(scaled(masters["ios"], existing_side(path, default)), path, "RGBA")

    # 5) 안드로이드 — 기존 파일 크기를 그대로 재현
    for density, launcher_default, foreground_default in ANDROID_DENSITIES:
        base = icons / "android" / f"mipmap-{density}"
        for name, variant, default in (
            ("ic_launcher.png", "android-legacy", launcher_default),
            ("ic_launcher_round.png", "android-round", launcher_default),
            ("ic_launcher_foreground.png", "android-foreground", foreground_default),
        ):
            path = base / name
            save_png(scaled(masters[variant], existing_side(path, default)), path, "RGBA")
    write_android_background_color(icons / "android/values/ic_launcher_background.xml")

    # 6) 웹에서 쓰는 앱 아이콘 · 파비콘 · 랜딩 워드마크
    for name, side in PUBLIC_PNGS:
        save_png(scaled(masters["rounded"], side), public / name, "RGBA")
    write_svg(public / "buzz.svg", args.name, bold)
    name, width, height = LANDING_WORDMARK
    write_landing_wordmark(public / name, args.name, bold, width, height)

    # 7) DMG 설치 창 배경
    name, width, height = DMG_BACKGROUND
    tagline_size = write_dmg_background(icons / name, args.name, bold, medium, width, height)
    print(f"DMG 태그라인 글자 크기: {tagline_size}px (1x 기준)")
    print()

    for path, note in WRITTEN:
        try:
            rel = path.relative_to(root)
        except ValueError:
            rel = path
        print(f"  {str(rel):62s} {note}")
    print()
    print(f"모두 {len(WRITTEN)}개 파일을 썼다. `--check` 로 크기를 다시 재 볼 수 있다.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
