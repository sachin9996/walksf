#!/usr/bin/env python3
"""Bake static/images/land.webp — park, woods, beach, and lakes on the elevation grid.

OpenStreetMap via Overpass, rasterized once onto the same lon/lat grid as
elev.webp. Pixel values are 0 city, 64 park, 128 woods, 192 beach, 255 water.
The browser reads this image; it does not rebuild the shapes.
"""

import json
import math
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "static" / "images" / "land.webp"

MIN_LON, MIN_LAT = -122.516, 37.670159
MAX_LON, MAX_LAT = -122.358, 37.844
NCOLS = 1400
NROWS = 1540

# Drop traffic-island crumbs. Pocket parks stay.
MIN_AREA_M2 = 400
# Skip fountains. Keep Lake Merced, Stow Lake, Mountain Lake.
MIN_WATER_M2 = 8000
# The bay and the Pacific are the page background, not inland water.
MAX_WATER_M2 = 3_000_000

PARK = 64
WOODS = 128
BEACH = 192
WATER = 255

OVERPASS = "https://overpass-api.de/api/interpreter"
QUERY = """
[out:json][timeout:180];
(
  way["leisure"~"^(park|garden|golf_course|nature_reserve)$"](37.66,-122.53,37.86,-122.35);
  way["landuse"~"^(forest|recreation_ground)$"](37.66,-122.53,37.86,-122.35);
  way["natural"~"^(wood|scrub|grassland|beach|water)$"](37.66,-122.53,37.86,-122.35);
  way["landuse"="reservoir"](37.66,-122.53,37.86,-122.35);
  relation["leisure"~"^(park|garden|golf_course|nature_reserve)$"](37.66,-122.53,37.86,-122.35);
  relation["landuse"~"^(forest|recreation_ground|reservoir)$"](37.66,-122.53,37.86,-122.35);
  relation["natural"~"^(wood|scrub|grassland|beach|water)$"](37.66,-122.53,37.86,-122.35);
);
out geom;
"""


def fetch_osm():
    proc = subprocess.run(
        [
            "curl",
            "-fsS",
            "--retry",
            "3",
            "--max-time",
            "180",
            "-A",
            "walksf/land",
            "-H",
            "Accept: application/json",
            "-X",
            "POST",
            OVERPASS,
            "--data-urlencode",
            "data@-",
        ],
        input=QUERY.encode(),
        check=True,
        capture_output=True,
    )
    return json.loads(proc.stdout)


def classify(tags):
    if tags.get("access") == "private":
        return None
    natural = tags.get("natural")
    leisure = tags.get("leisure")
    landuse = tags.get("landuse")
    water = tags.get("water")
    if natural == "water" or landuse == "reservoir":
        if water in ("bay", "river", "canal", "stream", "ditch", "wastewater"):
            return None
        return WATER
    if natural == "beach":
        return BEACH
    if natural in ("wood", "scrub", "grassland") or landuse == "forest" or leisure == "nature_reserve":
        return WOODS
    if leisure in ("park", "garden", "golf_course") or landuse == "recreation_ground":
        return PARK
    return None


def close_enough(a, b):
    return abs(a[0] - b[0]) < 1e-5 and abs(a[1] - b[1]) < 1e-5


def closed(ring):
    return len(ring) >= 4 and close_enough(ring[0], ring[-1])


def assemble(ways):
    """Join way fragments that share endpoints into rings."""
    unused = [list(w) for w in ways if len(w) >= 2]
    rings = []
    while unused:
        ring = unused.pop(0)
        progressed = True
        while progressed and not closed(ring):
            progressed = False
            for i, w in enumerate(unused):
                if close_enough(ring[-1], w[0]):
                    ring.extend(w[1:])
                elif close_enough(ring[-1], w[-1]):
                    ring.extend(reversed(w[:-1]))
                elif close_enough(ring[0], w[-1]):
                    ring = w[:-1] + ring
                elif close_enough(ring[0], w[0]):
                    ring = list(reversed(w[1:])) + ring
                else:
                    continue
                unused.pop(i)
                progressed = True
                break
        if closed(ring):
            rings.append(ring)
        elif len(ring) >= 4:
            ring.append(ring[0])
            rings.append(ring)
    return rings


def coords_of(geom):
    return [(p["lon"], p["lat"]) for p in geom or []]


def feature_rings(el):
    if el["type"] == "way":
        ring = coords_of(el.get("geometry"))
        if len(ring) >= 4:
            if not closed(ring):
                ring.append(ring[0])
            return [ring], []
        return [], []
    outers = []
    inners = []
    for mem in el.get("members") or []:
        if mem.get("type") != "way":
            continue
        pts = coords_of(mem.get("geometry"))
        if len(pts) < 2:
            continue
        role = mem.get("role") or "outer"
        if role == "inner":
            inners.append(pts)
        else:
            outers.append(pts)
    return assemble(outers), assemble(inners)


def ring_area_m2(ring):
    if len(ring) < 4:
        return 0.0
    lat = sum(p[1] for p in ring) / len(ring)
    m_lon = 111320.0 * math.cos(math.radians(lat))
    m_lat = 111320.0
    area = 0.0
    for i in range(len(ring) - 1):
        x0, y0 = ring[i][0] * m_lon, ring[i][1] * m_lat
        x1, y1 = ring[i + 1][0] * m_lon, ring[i + 1][1] * m_lat
        area += x0 * y1 - x1 * y0
    return abs(area) * 0.5


def to_px(ring):
    span_lon = MAX_LON - MIN_LON
    span_lat = MAX_LAT - MIN_LAT
    pts = []
    for lon, lat in ring:
        x = (lon - MIN_LON) / span_lon * (NCOLS - 1)
        y = (MAX_LAT - lat) / span_lat * (NROWS - 1)
        pts.append((x, y))
    return pts


def main():
    print("fetching openstreetmap")
    data = fetch_osm()
    elements = data.get("elements") or []
    print(f"elements {len(elements)}")

    features = []
    for el in elements:
        kind = classify(el.get("tags") or {})
        if kind is None:
            continue
        outers, inners = feature_rings(el)
        if not outers:
            continue
        area = sum(ring_area_m2(r) for r in outers) - sum(ring_area_m2(r) for r in inners)
        if kind == WATER:
            if area < MIN_WATER_M2 or area > MAX_WATER_M2:
                continue
        elif area < MIN_AREA_M2:
            continue
        name = (el.get("tags") or {}).get("name", "")
        features.append((area, kind, name, outers, inners))

    # Large shapes first so a smaller park sitting in a hole still gets drawn.
    features.sort(key=lambda f: f[0], reverse=True)
    counts = {PARK: 0, WOODS: 0, BEACH: 0, WATER: 0}

    def paint(kind):
        layer = Image.new("L", (NCOLS, NROWS), 0)
        draw = ImageDraw.Draw(layer)
        for area, k, name, outers, inners in features:
            if k != kind:
                continue
            for ring in outers:
                draw.polygon(to_px(ring), fill=kind)
            for ring in inners:
                draw.polygon(to_px(ring), fill=0)
            counts[kind] += 1
        return np.asarray(layer)

    # Woods cover forest inside a park. Beach covers both along the shore.
    # Lakes are painted last so they punch through a surrounding park.
    park = paint(PARK)
    woods = paint(WOODS)
    beach = paint(BEACH)
    water = paint(WATER)
    mask_arr = park.copy()
    mask_arr[woods != 0] = woods[woods != 0]
    mask_arr[beach != 0] = beach[beach != 0]
    mask_arr[water != 0] = water[water != 0]
    mask = Image.fromarray(mask_arr, mode="L")

    arr = np.asarray(mask)
    print(
        "features",
        { "park": counts[PARK], "woods": counts[WOODS], "beach": counts[BEACH], "water": counts[WATER] },
        "pixels",
        {
            "park": int((arr == PARK).sum()),
            "woods": int((arr == WOODS).sum()),
            "beach": int((arr == BEACH).sum()),
            "water": int((arr == WATER).sum()),
        },
    )
    named = sorted(((a, k, n) for a, k, n, _, _ in features if n), reverse=True)
    labels = {PARK: "park", WOODS: "woods", BEACH: "beach", WATER: "water"}
    for area, kind, name in named[:15]:
        print(f"  {labels[kind]:5} {area/1e4:7.1f} ha  {name}")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    mask.save(OUT, "WEBP", lossless=True)
    check = np.asarray(Image.open(OUT).convert("L"))
    if check.shape != (NROWS, NCOLS) or not np.array_equal(check, arr):
        raise SystemExit(f"wrote a mask that did not round-trip: {check.shape} {np.unique(check)}")
    print(f"wrote {OUT} {OUT.stat().st_size} bytes")


if __name__ == "__main__":
    main()
