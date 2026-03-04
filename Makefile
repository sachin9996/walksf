.PHONY: build install

build:
	GOEXPERIMENT=jsonv2 go build -o sfwalkpercent .

install: static/neighborhoods.geojson

static/neighborhoods.geojson:
	curl -fsSL -o $@ https://data.sfgov.org/resource/gfpk-269f.geojson
