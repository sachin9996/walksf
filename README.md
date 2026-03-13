# SF Walk%

Visualize San Francisco streets I've walked (from Apple Health data).

## Data

Put an **Apple Health export** zip in the `data/` directory. Use the Health app: Profile → Export All Health Data, then place the downloaded `export.zip` in `data/`.

Neighborhood GeoJSON comes from [SF Open Data](https://data.sfgov.org/resource/gfpk-269f.geojson).

```bash
make
./sfwalkpercent -addr=127.0.0.1:8080
```

## Flags

- `-addr` — listen address (default: `127.0.0.1:8080`)

## Notes for me because I'm forgetful

Google Photos gives me HEIC files with location information. Transform them into jpg files that preserve this data using:

```
for f in *.HEIC; do
  magick "$f" -quality 92 "${f%.hHEICeic}.jpg"
  exiftool -TagsFromFile "$f" -all:all "${f%.HEIC}.jpg"
done
```

Convert them into lower resolution thumbnails with:

```
mkdir -p thumbs

for f in *.jpg; do
  magick "$f" -thumbnail 300x300 -quality 80 "thumbs/$f"
done
```
