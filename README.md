# Walk SF

https://walksf.quest

Walking all the streets of San Francisco!

## Data

Put an **Apple Health export** zip in the `data/` directory. Use the Health app: Profile → Export All Health Data, then place the downloaded `export.zip` in `data/`.

Neighborhood GeoJSON comes from [SF Open Data](https://data.sfgov.org/resource/gfpk-269f.geojson).

```bash
make
./walksf -addr=127.0.0.1:8080
```

## Flags

- `-addr` - listen address (default: `127.0.0.1:8080`)
- `-debug`- adds debug logs

## Notes for me because I'm forgetful

Google Photos gives me HEIC files with location information. Transform them into webp files that preserve this data using:

```
for f in *.HEIC; do
  magick "$f" -quality 85 "${f%.HEIC}.webp"
  exiftool -TagsFromFile "$f" -all:all "${f%.HEIC}.webp"
done
```

Convert them into lower resolution thumbnails with:

```
mkdir -p thumbs

for f in *.webp; do
  magick "$f" -thumbnail 300x300 -quality 75 "thumbs/$f"
done
```
