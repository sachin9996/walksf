#!/usr/bin/env python3
"""Generate ASCII-art style Open Graph image from sf.geojson."""
import json
import hashlib
import math
from PIL import Image, ImageDraw, ImageFont

OG_W, OG_H = 1200, 630
BG = (10, 22, 40)
FONT_SIZE = 10

SKIP = {
    "service", "footway", "path", "cycleway", "steps",
    "pedestrian", "track", "construction", "proposed",
}

TIERS = {
    "motorway":     {"color": (200, 220, 250), "sample": 1.0, "weight": 5},
    "motorway_link":{"color": (180, 200, 235), "sample": 1.0, "weight": 4},
    "trunk":        {"color": (195, 215, 245), "sample": 1.0, "weight": 5},
    "trunk_link":   {"color": (170, 195, 230), "sample": 1.0, "weight": 4},
    "primary":      {"color": (140, 170, 210), "sample": 1.0, "weight": 3},
    "secondary":    {"color": (75, 100, 140),  "sample": 0.6, "weight": 2},
    "tertiary":     {"color": (55, 75, 115),   "sample": 0.4, "weight": 2},
    "residential":  {"color": (35, 50, 80),    "sample": 0.12, "weight": 1},
    "unclassified": {"color": (35, 50, 80),    "sample": 0.12, "weight": 1},
    "living_street":{"color": (35, 50, 80),    "sample": 0.12, "weight": 1},
}
DEFAULT_TIER = {"color": (45, 60, 95), "sample": 0.3, "weight": 1}

H_CHARS = {1: ".", 2: "-", 3: "-", 4: "=", 5: "="}
V_CHARS = {1: ".", 2: ":", 3: "|", 4: "|", 5: "!"}
D1_CHARS = {1: ",", 2: "/", 3: "/", 4: "/", 5: "/"}
D2_CHARS = {1: "`", 2: "\\", 3: "\\", 4: "\\", 5: "\\"}


def stable_hash(s):
    return int(hashlib.md5(s.encode()).hexdigest(), 16) / (1 << 128)


def classify_angle(dx, dy):
    if abs(dx) < 0.001 and abs(dy) < 0.001:
        return "h"
    deg = math.degrees(math.atan2(abs(dy), abs(dx)))
    if deg < 20:
        return "h"
    if deg > 70:
        return "v"
    if (dx > 0) == (dy > 0):
        return "d2"
    return "d1"


def pick_char(direction, weight, neighbor_count):
    if neighbor_count >= 2:
        dirs = set()
        return None
    table = {"h": H_CHARS, "v": V_CHARS, "d1": D1_CHARS, "d2": D2_CHARS}
    return table.get(direction, H_CHARS).get(weight, ".")


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


def main():
    font = ImageFont.truetype("Menlo", FONT_SIZE)
    char_w = font.getbbox("@")[2]
    char_h = int(FONT_SIZE * 1.4)

    pad_x, pad_top, pad_bot = 6, 30, 22
    cols = (OG_W - 2 * pad_x) // char_w
    rows = (OG_H - pad_top - pad_bot) // char_h

    with open("static/sf.geojson") as f:
        data = json.load(f)

    min_lon, max_lon = -122.525, -122.34
    min_lat, max_lat = 37.685, 37.825
    lon_span = max_lon - min_lon
    lat_span = max_lat - min_lat

    pixel_w = cols * char_w
    pixel_h = rows * char_h
    aspect_geo = lon_span / lat_span
    aspect_pixel = pixel_w / pixel_h
    if aspect_pixel > aspect_geo:
        eff_pixel_w = int(pixel_h * aspect_geo)
        eff_pixel_h = pixel_h
    else:
        eff_pixel_w = pixel_w
        eff_pixel_h = int(pixel_w / aspect_geo)
    eff_w = eff_pixel_w / char_w
    eff_h = eff_pixel_h / char_h
    off_x = (cols - eff_w) / 2
    off_y = (rows - eff_h) / 2

    def project(lon, lat):
        x = (lon - min_lon) / lon_span * eff_w + off_x
        y = (max_lat - lat) / lat_span * eff_h + off_y
        return x, y

    grid_dirs = [[set() for _ in range(cols)] for _ in range(rows)]
    grid_weight = [[0] * cols for _ in range(rows)]
    grid_color = [[(0, 0, 0)] * cols for _ in range(rows)]
    grid_dir = [["h"] * cols for _ in range(rows)]

    layers = [
        ("residential", "unclassified", "living_street"),
        ("tertiary",),
        ("secondary",),
        ("primary",),
        ("trunk_link", "motorway_link"),
        ("trunk", "motorway"),
    ]

    feats_by_hw = {}
    for feat in data["features"]:
        hw = feat.get("properties", {}).get("highway", "")
        if hw in SKIP:
            continue
        feats_by_hw.setdefault(hw, []).append(feat)

    for group in layers:
        for hw in group:
            tier = TIERS.get(hw, DEFAULT_TIER)
            for feat in feats_by_hw.get(hw, []):
                name = feat.get("properties", {}).get("name", "")
                fid = f"{hw}:{name}:{feat['geometry']['coordinates'][0]}"
                if stable_hash(fid) > tier["sample"]:
                    continue
                coords = feat["geometry"]["coordinates"]
                w = tier["weight"]
                for i in range(len(coords) - 1):
                    x0, y0 = project(coords[i][0], coords[i][1])
                    x1, y1 = project(coords[i + 1][0], coords[i + 1][1])
                    dx_geo = x1 - x0
                    dy_geo = y1 - y0
                    d = classify_angle(dx_geo, dy_geo)
                    ix0, iy0 = int(round(x0)), int(round(y0))
                    ix1, iy1 = int(round(x1)), int(round(y1))
                    for cx, cy in bresenham(ix0, iy0, ix1, iy1):
                        if 0 <= cx < cols and 0 <= cy < rows:
                            grid_dirs[cy][cx].add(d)
                            if w >= grid_weight[cy][cx]:
                                grid_weight[cy][cx] = w
                                grid_color[cy][cx] = tier["color"]
                                grid_dir[cy][cx] = d

    grid_char = [[" "] * cols for _ in range(rows)]
    for cy in range(rows):
        for cx in range(cols):
            w = grid_weight[cy][cx]
            if w == 0:
                continue
            dirs = grid_dirs[cy][cx]
            d = grid_dir[cy][cx]
            has_perp = ("h" in dirs and "v" in dirs)
            if has_perp and w >= 3:
                grid_char[cy][cx] = "+"
            elif has_perp:
                grid_char[cy][cx] = "+"
            else:
                table = {"h": H_CHARS, "v": V_CHARS, "d1": D1_CHARS, "d2": D2_CHARS}
                grid_char[cy][cx] = table.get(d, H_CHARS).get(w, ".")

    img = Image.new("RGBA", (OG_W, OG_H), BG + (255,))

    center_x = pad_x + (OG_W - 2 * pad_x - cols * char_w) // 2 - 120
    center_y = pad_top

    def draw_crisp(x, y, ch, fnt, color):
        mask = fnt.getmask(ch, mode="1")
        mw, mh = mask.size
        glyph = Image.frombytes("L", (mw, mh), bytes(mask))
        colored = Image.new("RGBA", (mw, mh), (0, 0, 0, 0))
        colored.paste(color, mask=glyph)
        img.paste(colored, (int(x), int(y)), colored)

    for row in range(rows):
        for col in range(cols):
            ch = grid_char[row][col]
            if ch == " ":
                continue
            r, g, b = grid_color[row][col]
            draw_crisp(
                center_x + col * char_w, center_y + row * char_h,
                ch, font, (r, g, b, 255),
            )

    title_font = ImageFont.truetype("Menlo", 66)
    title = "Walk SF"

    td = ImageDraw.Draw(img)
    title_bbox = td.textbbox((0, 0), title, font=title_font)
    title_w = title_bbox[2] - title_bbox[0]
    title_h = title_bbox[3] - title_bbox[1]

    margin = 80
    tx = OG_W - title_w - margin
    ty = (OG_H - title_h) // 2 - title_bbox[1]

    draw_crisp(tx, ty, title, title_font, (180, 195, 215, 255))

    img = img.convert("RGB")
    out = "static/images/preview.png"
    img.save(out, "PNG")
    print(f"wrote {out} ({OG_W}x{OG_H}, {cols}x{rows} chars)")


if __name__ == "__main__":
    main()
