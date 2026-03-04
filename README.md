# SF Walk%

Visualize San Francisco streets I've walked (from Apple Health data).

## Data

Put an **Apple Health export** zip in the `data/` directory. Use the Health app: Profile → Export All Health Data, then place the downloaded `export.zip` in `data/`.

Neighborhood GeoJSON comes from [SF Open Data](https://data.sfgov.org/resource/gfpk-269f.geojson).

```bash
make
./sfwalkpercent -addr=:8080
```

## Flags

- `-addr` — listen address (default: `:8080`)
