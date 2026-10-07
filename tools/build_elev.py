#!/usr/bin/env python3
"""Build static/images/elev.webp — elevation of San Francisco for the map.

Source: AWS terrain tiles (terrarium RGB), a 3DEP/SRTM composite, zoom 14.
https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
"""

import io
import math
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "static" / "images" / "elev.webp"

MIN_LON, MIN_LAT = -122.516, 37.670159
MAX_LON, MAX_LAT = -122.358, 37.844
Z = 14
NCOLS = 1400

# Blur knocks out building-scale noise in the DEM while leaving the hills.
BLUR_SIGMA = 2.6


def world_px(lon, lat):
    world = 256 * (1 << Z)
    x = (lon + 180.0) / 360.0 * world
    rad = math.radians(lat)
    merc_y = math.log(math.tan(math.pi / 4 + rad / 2))
    y = (1 - merc_y / math.pi) / 2 * world
    return x, y


def tile_range():
    def xt(lon):
        return int((lon + 180.0) / 360.0 * (1 << Z))

    def yt(lat):
        rad = math.radians(lat)
        return int((1 - math.log(math.tan(math.pi / 4 + rad / 2)) / math.pi) / 2 * (1 << Z))

    xs = list(range(xt(MIN_LON), xt(MAX_LON) + 1))
    ys = list(range(yt(MAX_LAT), yt(MIN_LAT) + 1))
    return xs, ys


def fetch_elev(x, y):
    url = f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{Z}/{x}/{y}.png"
    proc = subprocess.run(["curl", "-fsS", "--retry", "3", url], check=True, capture_output=True)
    arr = np.asarray(Image.open(io.BytesIO(proc.stdout)).convert("RGB"), dtype=np.float64)
    r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    return (r * 256.0 + g + b / 256.0) - 32768.0


def load_mosaic():
    """Return elevation (meters) and the mercator origin of tile (minx, miny)."""
    xs, ys = tile_range()
    tiles = {(x, y): fetch_elev(x, y) for x in xs for y in ys}
    print(f"fetched {len(tiles)} tiles")
    tw, th = 256, 256
    mosaic = np.zeros((len(ys) * th, len(xs) * tw), dtype=np.float64)
    for ix, x in enumerate(xs):
        for iy, y in enumerate(ys):
            mosaic[iy * th : (iy + 1) * th, ix * tw : (ix + 1) * tw] = tiles[(x, y)]
    origin_x = xs[0] * tw
    origin_y = ys[0] * th
    return mosaic, origin_x, origin_y


def sample_lonlat(mosaic, origin_x, origin_y, ncols):
    lon_span = MAX_LON - MIN_LON
    lat_span = MAX_LAT - MIN_LAT
    nrows = int(round(ncols * lat_span / lon_span))
    # Pad outside the map so the hillshade kernel is valid on the edge.
    pad = 8
    lon_step = lon_span / (ncols - 1)
    lat_step = lat_span / (nrows - 1)
    lons = MIN_LON + lon_step * np.arange(-pad, ncols + pad)
    lats = MAX_LAT - lat_step * np.arange(-pad, nrows + pad)
    elev = np.empty((lats.size, lons.size), dtype=np.float64)
    h, w = mosaic.shape
    for i, lat in enumerate(lats):
        px, py = world_px(lons, lat)
        # world_px broadcasts lon array
        col = px - origin_x
        row = py - origin_y
        c0 = np.floor(col).astype(np.int32)
        r0 = np.floor(row).astype(np.int32)
        c1 = np.clip(c0 + 1, 0, w - 1)
        r1 = np.clip(r0 + 1, 0, h - 1)
        c0 = np.clip(c0, 0, w - 1)
        r0 = np.clip(r0, 0, h - 1)
        tc = col - np.floor(col)
        tr = row - np.floor(row)
        v00 = mosaic[r0, c0]
        v01 = mosaic[r0, c1]
        v10 = mosaic[r1, c0]
        v11 = mosaic[r1, c1]
        elev[i] = (v00 * (1 - tc) + v01 * tc) * (1 - tr) + (v10 * (1 - tc) + v11 * tc) * tr
    return elev, nrows, ncols, pad


def gaussian_blur(a, sigma):
    radius = max(1, int(round(sigma * 3)))
    x = np.arange(-radius, radius + 1, dtype=np.float64)
    k = np.exp(-(x * x) / (2 * sigma * sigma))
    k /= k.sum()
    pad = radius
    horiz = np.pad(a, ((0, 0), (pad, pad)), mode="edge")
    tmp = np.empty_like(a)
    for i, w in enumerate(k):
        tmp += w * horiz[:, i : i + a.shape[1]]
    vert = np.pad(tmp, ((pad, pad), (0, 0)), mode="edge")
    out = np.zeros_like(a)
    for i, w in enumerate(k):
        out += w * vert[i : i + a.shape[0], :]
    return out


def save_terrarium(elev, path):
    v = np.clip(elev + 32768.0, 0.0, 65535.999)
    whole = np.floor(v)
    r = np.floor(whole / 256.0)
    g = whole - r * 256.0
    b = np.floor((v - whole) * 256.0)
    rgb = np.stack([r, g, b], axis=-1).astype(np.uint8)
    Image.fromarray(rgb, "RGB").save(path, "WEBP", lossless=True, quality=100, method=6)


def main():
    mosaic, ox, oy = load_mosaic()
    print(f"mosaic {mosaic.shape} elev {mosaic.min():.1f}..{mosaic.max():.1f} m")
    elev, nrows, ncols, pad = sample_lonlat(mosaic, ox, oy, NCOLS)
    print(f"grid {elev.shape} -> crop {nrows}x{ncols}")
    elev = gaussian_blur(elev, BLUR_SIGMA)
    elev = elev[pad : pad + nrows, pad : pad + ncols]
    print(f"out {elev.shape} {elev.min():.1f}..{elev.max():.1f} m")
    save_terrarium(elev, OUT)
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e3:.0f} KB)")


if __name__ == "__main__":
    main()
