# Agent context

**What it is:** SF street map showing where you’ve walked/run from Apple Health workout-route GPX. Backend Go, frontend vanilla JS + canvas.

**Layout:**

- `main.go` — HTTP server, reads `data/*.zip` (latest by export time from `apple_health_export/export_cda.xml` effectiveTime, fallback to file mtime), matches GPX paths to street segments, serves GeoJSON and static files. Re-scans every 10 min. Key types: `streetFeat`, `countedStreet`, `matchPathsToStreets` → visit counts; `clipCountedStreets` / `clipStreetsToSF` to GeoJSON.
- `static/` — `index.html`, `index.css`, `index.js`. Map is canvas; transform is `lon*scale+tx`, `-lat*scale+ty` (y up in map space). Streets and paths drawn as Path2D or per-segment; heatmap by `properties.count` and `maxCount`.
- `static/sf.geojson`, `static/neighborhoods.geojson` — streets and neighborhood polygons (loaded at runtime).

**Data:** Expects `data/export.zip` with `apple_health_export/workout-routes/*.gpx` and optionally `apple_health_export/export_cda.xml` for export time. Server picks the zip with the latest export time (from CDA effectiveTime, else file mtime).

**APIs:** `GET /api/paths` (JSON array of features), `GET /api/neighborhoods`, `GET /api/streets`. Static under `/static/`.

**UI notes:** Scale bar and “last updated” are positioned inside the lat/lon ruler; ruler insets are `RULER_LEFT_INSET` / `RULER_BOTTOM_INSET` in `index.js`. Dimming uses class `scale-dimmed` after idle.
