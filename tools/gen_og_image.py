#!/usr/bin/env python3
"""Open Graph image: coarse ASCII of the schematic map.

Edges of the city, parks, woods, beach, and lakes. Freeways are drawn
on top, including the span from the mainland to Yerba Buena Island.
Characters are ASCII. No hillshade.
"""
import hashlib
import io
import json
import math
import re
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]

OG_W, OG_H = 1200, 630
# Large cells. The card is usually shown small, so a finer grid turns to noise.
FONT_SIZE = 14

WATER = (11, 30, 45, 255)
CITY = (124, 136, 142, 255)
PARK = (109, 154, 98, 255)
WOODS = (62, 107, 72, 255)
BEACH = (196, 180, 150, 255)
FREEWAY = (214, 220, 226, 255)
TITLE = (214, 220, 226, 255)

# Interior is a light fill. The silhouette uses a direction character.
FILL = {0: ".", 1: "*", 2: "#", 3: "~"}
COLOR = {0: CITY, 1: PARK, 2: WOODS, 3: BEACH}
EDGE = {"h": "-", "v": "|", "d1": "/", "d2": "\\"}

LAND_MIN_LON, LAND_MIN_LAT = -122.516, 37.670159
LAND_MAX_LON, LAND_MAX_LAT = -122.358, 37.844

SKIP_LAYERS = {
    "PAPER", "PAPER_FWYS", "PAPER_WATER", "PSEUDO",
    "PRIVATE", "PRIVATE_PARKING",
}


def brighten(color):
    return tuple(min(255, int(c + (255 - c) * 0.5)) for c in color[:3]) + (255,)


def classify_angle(dx, dy):
    if abs(dx) < 0.001 and abs(dy) < 0.001:
        return "+"
    deg = math.degrees(math.atan2(abs(dy), abs(dx)))
    if deg < 22:
        return "h"
    if deg > 68:
        return "v"
    if (dx > 0) == (dy > 0):
        return "d2"
    return "d1"


def bresenham(x0, y0, x1, y1):
    pts = []
    dx, dy = abs(x1 - x0), abs(y1 - y0)
    sx = 1 if x0 < x1 else -1
    sy = 1 if y0 < y1 else -1
    err = dx - dy
    while True:
        pts.append((x0, y0))
        if x0 == x1 and y0 == y1:
            break
        e2 = 2 * err
        if e2 > -dy:
            err -= dy
            x0 += sx
        if e2 < dx:
            err += dx
            y0 += sy
    return pts


def draw_crisp(img, x, y, ch, font, color):
    if ord(ch[0]) > 127:
        raise ValueError(f"not ascii: {ch!r}")
    bb = font.getbbox(ch)
    mask = font.getmask(ch, mode="1")
    mw, mh = mask.size
    glyph = Image.frombytes("L", (mw, mh), bytes(mask))
    colored = Image.new("RGBA", (mw, mh), (0, 0, 0, 0))
    colored.paste(color, mask=glyph)
    img.paste(colored, (int(x + bb[0]), int(y + bb[1])), colored)


def main():
    font = ImageFont.truetype("Menlo", FONT_SIZE)
    ascent, descent = font.getmetrics()
    char_w = font.getbbox("@")[2]
    char_h = ascent + descent

    with open(ROOT / "static" / "neighborhoods.geojson") as f:
        neighborhoods = json.load(f)

    min_lon, min_lat = 1e9, 1e9
    max_lon, max_lat = -1e9, -1e9
    for feat in neighborhoods["features"]:
        for poly in feat["geometry"]["coordinates"]:
            for lon, lat in poly[0]:
                min_lon = min(min_lon, lon)
                max_lon = max(max_lon, lon)
                min_lat = min(min_lat, lat)
                max_lat = max(max_lat, lat)

    mid_lat = (min_lat + max_lat) / 2
    lon_scale = math.cos(math.radians(mid_lat))
    lon_span = max_lon - min_lon
    lat_span = max_lat - min_lat
    pad = 0.045 * max(lon_span * lon_scale, lat_span)
    min_lon -= pad / lon_scale
    max_lon += pad / lon_scale
    min_lat -= pad
    max_lat += pad
    lon_span = max_lon - min_lon
    lat_span = max_lat - min_lat
    aspect = (lon_span * lon_scale) / lat_span

    title_font = ImageFont.truetype("Menlo", 64)
    title = "Walk SF"
    title_bb = title_font.getbbox(title)
    title_w = title_bb[2] - title_bb[0]
    title_h = title_bb[3] - title_bb[1]

    margin = 36
    avail_w = OG_W - margin - title_w - 80
    avail_h = OG_H - 2 * margin
    rows = avail_h // char_h
    cols = int(round(rows * char_h * aspect / char_w))
    if cols * char_w > avail_w:
        cols = avail_w // char_w
        rows = int(round(cols * char_w / aspect / char_h))

    def cell_of(lon, lat):
        x = (lon - min_lon) / lon_span * cols
        y = (max_lat - lat) / lat_span * rows
        return x, y

    land = np.array(Image.open(ROOT / "static" / "images" / "land.webp").convert("L"))
    land_rows, land_cols = land.shape
    mask = Image.new("L", (cols, rows), 0)
    mask_draw = ImageDraw.Draw(mask)
    for feat in neighborhoods["features"]:
        for poly in feat["geometry"]["coordinates"]:
            mask_draw.polygon([cell_of(lon, lat) for lon, lat in poly[0]], fill=255)
    inside = np.array(mask) > 127

    yy, xx = np.mgrid[0:rows, 0:cols]
    lon = min_lon + (xx + 0.5) / cols * lon_span
    lat = max_lat - (yy + 0.5) / rows * lat_span
    lc = np.clip(
        ((lon - LAND_MIN_LON) / (LAND_MAX_LON - LAND_MIN_LON) * (land_cols - 1)).astype(int),
        0, land_cols - 1,
    )
    lr = np.clip(
        ((LAND_MAX_LAT - lat) / (LAND_MAX_LAT - LAND_MIN_LAT) * (land_rows - 1)).astype(int),
        0, land_rows - 1,
    )
    samples = land[lr, lc]
    kind = np.zeros(samples.shape, dtype=np.int8)
    kind[samples >= 32] = 1
    kind[samples >= 96] = 2
    kind[samples >= 160] = 3
    kind[samples >= 224] = 4

    # -1 is water: the bay, and lakes such as Lake Merced.
    kinds = np.where(inside, kind, -1).astype(np.int8)
    inland = int(((kinds == 4) & inside).sum())
    kinds[kinds == 4] = -1
    print(f"inland water cells {inland}")

    def at(r, c):
        if r < 0 or c < 0 or r >= rows or c >= cols:
            return -1
        return int(kinds[r, c])

    grid_char = [[" "] * cols for _ in range(rows)]
    grid_color = [[WATER] * cols for _ in range(rows)]
    for r in range(rows):
        for c in range(cols):
            me = at(r, c)
            if me < 0:
                continue
            # Only the shore: the city outline and the edge of a lake.
            # A boundary between park and city is just a color change.
            gx = gy = 0
            edge = False
            for rr, cc, wx, wy in (
                (r - 1, c, 0, -1), (r + 1, c, 0, 1),
                (r, c - 1, -1, 0), (r, c + 1, 1, 0),
                (r - 1, c - 1, -1, -1), (r - 1, c + 1, 1, -1),
                (r + 1, c - 1, -1, 1), (r + 1, c + 1, 1, 1),
            ):
                if at(rr, cc) < 0:
                    edge = True
                    gx += wx
                    gy += wy
            if edge:
                glyph = classify_angle(-gy, gx)
                grid_char[r][c] = EDGE.get(glyph, "+")
                grid_color[r][c] = brighten(COLOR[me])
            else:
                grid_char[r][c] = FILL[me]
                grid_color[r][c] = COLOR[me]

    with open(ROOT / "static" / "sf.geojson") as f:
        streets = json.load(f)
    for feat in streets["features"]:
        props = feat.get("properties") or {}
        if props.get("active") is False or props.get("layer") in SKIP_LAYERS:
            continue
        if props.get("classcode") != "1":
            continue
        geom = feat.get("geometry") or {}
        coords = geom.get("coordinates") or []
        if geom.get("type") != "LineString" or len(coords) < 2:
            continue
        for i in range(len(coords) - 1):
            x0, y0 = cell_of(coords[i][0], coords[i][1])
            x1, y1 = cell_of(coords[i + 1][0], coords[i + 1][1])
            d = classify_angle(x1 - x0, y1 - y0)
            ch = EDGE.get(d, "+")
            ix0, iy0 = int(round(x0)), int(round(y0))
            ix1, iy1 = int(round(x1)), int(round(y1))
            # The Bay Bridge's western span is one segment with both ends on
            # land and water in between. Other freeway cells stay on land,
            # so the continuation toward Oakland is not drawn.
            span = at(iy0, ix0) >= 0 and at(iy1, ix1) >= 0
            for cx, cy in bresenham(ix0, iy0, ix1, iy1):
                if 0 <= cx < cols and 0 <= cy < rows and (at(cy, cx) >= 0 or span):
                    grid_char[cy][cx] = ch
                    grid_color[cy][cx] = FREEWAY

    img = Image.new("RGBA", (OG_W, OG_H), WATER)
    ox = margin
    oy = (OG_H - rows * char_h) // 2
    for r in range(rows):
        for c in range(cols):
            ch = grid_char[r][c]
            if ch == " ":
                continue
            draw_crisp(img, ox + c * char_w, oy + r * char_h, ch, font, grid_color[r][c])

    map_right = ox + cols * char_w
    tx = map_right + (OG_W - map_right - title_w) / 2
    ty = (OG_H - title_h) / 2 - title_bb[1]
    draw_crisp(img, tx, ty, title, title_font, TITLE)

    # Platforms cache og:image by URL, and many ignore a query string.
    # A new content hash in the filename is a new URL.
    raw = img.convert("RGB")
    buf = io.BytesIO()
    raw.save(buf, "PNG")
    png = buf.getvalue()
    name = "preview." + hashlib.sha256(png).hexdigest()[:12] + ".png"
    images = ROOT / "static" / "images"
    for old in images.glob("preview*.png"):
        if old.name != name:
            old.unlink()
    out = images / name
    out.write_bytes(png)

    html_path = ROOT / "static" / "index.html"
    html = html_path.read_text()
    updated = re.sub(
        r"static/images/preview(?:\.[0-9a-f]{12})?\.png",
        "static/images/" + name,
        html,
    )
    if name not in updated:
        raise SystemExit("og:image urls in static/index.html were not updated")
    if updated != html:
        html_path.write_text(updated)
    print(f"wrote {out} ({OG_W}x{OG_H}, {cols}x{rows} chars, {char_w}x{char_h}px)")


if __name__ == "__main__":
    main()
