package main

import (
	"archive/zip"
	"bytes"
	"compress/gzip"
	"encoding/json/jsontext"
	json "encoding/json/v2"
	"encoding/xml"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"math"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dsoprea/go-exif/v3"
	exifcommon "github.com/dsoprea/go-exif/v3/common"
)

const (
	sfTolerance         = 0.01
	gridCellSize        = 0.0005
	earthRadiusM        = 6371000
	maxSegmentLenDeg    = 0.006
	pathMatchToleranceM = 15
	headingToleranceDeg = 30
)

type point struct {
	Lat, Lon float64
}

var dataDir string
var staticDir string
var streets []streetFeat
var nbds []nbdFeat

var (
	addr  = flag.String("addr", "127.0.0.1:8080", "listen address")
	debug = flag.Bool("debug", false, "enable debug logging")
)

type streetFeat struct {
	Type     string `json:"type,omitempty"`
	Geometry struct {
		Type        string      `json:"type"`
		Coordinates [][]float64 `json:"coordinates"`
	} `json:"geometry"`
	Properties map[string]any `json:"properties,omitempty"`
}

type nbdFeat struct {
	Props struct {
		Name string `json:"name"`
	} `json:"properties"`
	Geom struct {
		Type   string         `json:"type"`
		Coords jsontext.Value `json:"coordinates"`
	} `json:"geometry"`
}

type nbdStats struct {
	List  []nbdRow `json:"neighborhoods"`
	Geo   []any    `json:"features"`
	Bytes []byte
}

type nbdRow struct {
	ID    string  `json:"id"`
	Name  string  `json:"name"`
	Total float64 `json:"total_km"`
	Expl  float64 `json:"explored_km"`
	Unex  float64 `json:"unexplored_km"`
	Pct   float64 `json:"pct"`
}

type drawLabel struct {
	Lon    float64 `json:"lon"`
	Lat    float64 `json:"lat"`
	Name   string  `json:"name"`
	MinLon float64 `json:"minLon"`
	MaxLon float64 `json:"maxLon"`
	MinLat float64 `json:"minLat"`
	MaxLat float64 `json:"maxLat"`
	Angle  float64 `json:"angle"`
	Length float64 `json:"length"`
}

type drawNbdFeat struct {
	Name  string        `json:"name"`
	Rings [][][]float64 `json:"rings"`
}

type drawCorePayload struct {
	Streets       string           `json:"streets"`
	Paths         string           `json:"paths"`
	Bounds        [4]float64       `json:"bounds"`
	Neighborhoods drawCoreNbdBlock `json:"neighborhoods,omitempty"`
}

type drawCoreNbdBlock struct {
	Outlines string        `json:"outlines"`
	List     []nbdRow      `json:"list"`
	Features []drawNbdFeat `json:"features"`
}

type drawOverlayPayload struct {
	Labels []drawLabel `json:"labels"`
}

type photoRecord struct {
	ID       string  `json:"id"`
	Lat      float64 `json:"lat"`
	Lon      float64 `json:"lon"`
	Date     string  `json:"date,omitempty"`
	URL      string  `json:"url"`
	ThumbURL string  `json:"thumb_url,omitempty"`
}

type photoData struct {
	Photos []photoRecord `json:"photos"`
}

type Server struct {
	paths           atomic.Pointer[[]byte]
	rawPaths        atomic.Pointer[[]byte]
	streetsBody     atomic.Pointer[[]byte]
	drawCoreBody    atomic.Pointer[[]byte]
	drawOverlayBody atomic.Pointer[[]byte]
	nbds            atomic.Pointer[nbdStats]
	photos          atomic.Pointer[photoData]
	updated         atomic.Int64
	lastZip         string
	lastPaths       atomic.Pointer[[]pathFeature]
}

func (s *Server) storeDrawPayload(pathFeats []streetFeat, st *nbdStats) {
	core := buildDrawCore(pathFeats, st)
	coreBody, err := json.Marshal(core)
	if err == nil {
		s.drawCoreBody.Store(&coreBody)
	}
	overlay := buildDrawOverlay(st)
	overlayBody, err := json.Marshal(overlay)
	if err == nil {
		s.drawOverlayBody.Store(&overlayBody)
	}
}

func newServer() *Server {
	start := time.Now()
	s := &Server{}

	sfPath := filepath.Join(staticDir, "sf.geojson")
	t0 := time.Now()
	b, err := os.ReadFile(sfPath)
	if err != nil {
		slog.Warn("read sf.geojson failed, using empty", "err", err)
		streets = nil
		s.tick()
		return s
	}
	slog.Debug("startup", "step", "read_streets_file", "duration_ms", time.Since(t0).Milliseconds(), "size_bytes", len(b))

	var doc struct {
		Features []streetFeat `json:"features"`
	}
	t0 = time.Now()
	if err := json.Unmarshal(b, &doc); err != nil {
		slog.Warn("parse sf.geojson failed", "err", err)
		streets = nil
		s.tick()
		return s
	}
	slog.Debug("startup", "step", "parse_streets_json", "duration_ms", time.Since(t0).Milliseconds(), "features", len(doc.Features))

	t0 = time.Now()
	var filtered []streetFeat
	for _, f := range doc.Features {
		h, _ := f.Properties["highway"].(string)
		switch h {
		case "motorway", "motorway_link", "trunk", "trunk_link":
			continue
		}
		filtered = append(filtered, f)
	}
	streets = filtered
	slog.Debug("startup", "step", "filter_streets", "duration_ms", time.Since(t0).Milliseconds(), "walkable", len(streets))

	t0 = time.Now()
	fc := map[string]any{"type": "FeatureCollection", "features": streets}
	body, err := json.Marshal(fc)
	if err == nil {
		s.streetsBody.Store(&body)
	}
	s.storeDrawPayload(nil, nil)
	s.photos.Store(&photoData{Photos: nil})
	slog.Debug("startup", "step", "marshal_streets_and_draw_payload", "duration_ms", time.Since(t0).Milliseconds())

	t0 = time.Now()
	if nb, err := os.ReadFile(filepath.Join(staticDir, "neighborhoods.geojson")); err == nil {
		var nbdDoc struct {
			Features []nbdFeat `json:"features"`
		}
		if json.Unmarshal(nb, &nbdDoc) == nil {
			nbds = nbdDoc.Features
			slog.Debug("startup", "step", "load_neighborhoods", "duration_ms", time.Since(t0).Milliseconds(), "count", len(nbds))
			if st := computeNbdStats(nil); st != nil {
				s.nbds.Store(st)
				s.storeDrawPayload(nil, st)
			}
		}
	} else {
		slog.Debug("startup", "step", "load_neighborhoods", "duration_ms", time.Since(t0).Milliseconds(), "skipped", true)
	}
	if s.drawCoreBody.Load() == nil {
		s.storeDrawPayload(nil, nil)
	}

	t0 = time.Now()
	s.tick()
	slog.Debug("startup", "step", "first_tick", "duration_ms", time.Since(t0).Milliseconds())
	slog.Debug("startup", "step", "done", "total_duration_ms", time.Since(start).Milliseconds())
	return s
}

func zipExportTime(z *zip.Reader, fallback time.Time) time.Time {
	const cdaPath = "apple_health_export/export_cda.xml"
	var ef *zip.File
	for _, f := range z.File {
		if f.Name == cdaPath {
			ef = f
			break
		}
	}
	if ef == nil {
		return fallback
	}
	rc, err := ef.Open()
	if err != nil {
		return fallback
	}
	defer rc.Close()
	var doc struct {
		XMLName       xml.Name `xml:"urn:hl7-org:v3 ClinicalDocument"`
		EffectiveTime struct {
			Value string `xml:"value,attr"`
		} `xml:"urn:hl7-org:v3 effectiveTime"`
	}
	if err := xml.NewDecoder(rc).Decode(&doc); err != nil {
		return fallback
	}
	v := strings.TrimSpace(doc.EffectiveTime.Value)
	if v == "" || len(v) < 14 {
		return fallback
	}
	var t time.Time
	if len(v) >= 19 && (v[14] == '+' || v[14] == '-') {
		t, err = time.Parse("20060102150405-0700", v)
	} else {
		t, err = time.Parse("20060102150405", v[:14])
	}
	if err != nil {
		return fallback
	}
	return t
}

func (s *Server) tick() {
	start := time.Now()

	dir := os.DirFS(dataDir)
	t0 := time.Now()
	entries, err := fs.Glob(dir, "export*.zip")
	if err != nil {
		slog.Error("tick glob data dir", "err", err)
		return
	}
	slog.Debug("tick", "step", "glob", "duration_ms", time.Since(t0).Milliseconds(), "zips", len(entries))
	if len(entries) == 0 {
		slog.Warn("no export zip in data dir", "dir", dataDir)
		return
	}
	var best string
	var bestTime time.Time
	t0 = time.Now()
	for _, e := range entries {
		path := filepath.Join(dataDir, e)
		f, openErr := os.Open(path)
		if openErr != nil {
			continue
		}
		stat, statErr := f.Stat()
		if statErr != nil {
			f.Close()
			continue
		}
		z, zipErr := zip.NewReader(f, stat.Size())
		if zipErr != nil {
			f.Close()
			continue
		}
		t := zipExportTime(z, stat.ModTime())
		f.Close()
		if t.After(bestTime) {
			bestTime = t
			best = e
		}
	}
	if best == "" || best == s.lastZip {
		return
	}
	slog.Debug("tick", "step", "zip_select", "duration_ms", time.Since(t0).Milliseconds(), "zip", best)
	s.lastZip = best
	path := filepath.Join(dataDir, best)
	t0 = time.Now()
	f, err := os.Open(path)
	if err != nil {
		slog.Error("open zip", "path", path, "err", err)
		return
	}
	stat, err := f.Stat()
	if err != nil {
		f.Close()
		slog.Error("stat zip", "path", path, "err", err)
		return
	}
	z, err := zip.NewReader(f, stat.Size())
	if err != nil {
		f.Close()
		slog.Error("zip reader", "path", path, "err", err)
		return
	}
	exportTime := zipExportTime(z, stat.ModTime())
	s.updated.Store(exportTime.UnixMilli())
	paths, err := buildPathsFromZip(z)
	f.Close()
	if err != nil {
		slog.Error("build paths", "path", path, "err", err)
		return
	}
	slog.Debug("tick", "step", "build_paths", "duration_ms", time.Since(t0).Milliseconds(), "activities", len(paths))

	t0 = time.Now()
	visitedList, visitedSegs := matchPathsToStreets(paths)
	slog.Debug("tick", "step", "match_paths", "duration_ms", time.Since(t0).Milliseconds(), "visited_segments", len(visitedList))

	t0 = time.Now()
	clippedVisited, droppedLong := clipStreetsToSF(visitedList)
	if clippedVisited == nil {
		clippedVisited = []any{}
	}
	slog.Debug("tick", "step", "clip", "duration_ms", time.Since(t0).Milliseconds(), "dropped_long", droppedLong)

	t0 = time.Now()
	processed, err := json.Marshal(clippedVisited)
	if err != nil {
		slog.Error("marshal paths", "err", err)
		return
	}
	s.paths.Store(&processed)
	slog.Debug("tick", "step", "marshal_store", "duration_ms", time.Since(t0).Milliseconds())

	t0 = time.Now()
	st := computeNbdStats(visitedSegs)
	if st != nil {
		s.nbds.Store(st)
	}
	s.storeDrawPayload(visitedList, st)
	s.lastPaths.Store(&paths)
	slog.Debug("tick", "step", "nbd_and_draw", "duration_ms", time.Since(t0).Milliseconds())

	t0 = time.Now()
	if payload := processImagesDir(filepath.Join(staticDir, "images", "full")); payload != nil {
		s.photos.Store(payload)
	} else {
		s.photos.Store(&photoData{Photos: nil})
	}
	slog.Debug("tick", "step", "images", "duration_ms", time.Since(t0).Milliseconds())
	slog.Debug("tick", "step", "done", "duration_ms", time.Since(start).Milliseconds(), "zip", best)
}

func (s *Server) registerStaticRoutes(staticDir string) {
	var pctNum, explKm, totalKm, pctFrac string
	if st := s.nbds.Load(); st != nil && len(st.List) > 0 {
		var total, expl float64
		for _, row := range st.List {
			total += row.Total
			expl += row.Expl
		}
		if total > 0 {
			frac := expl / total
			pctNum = fmt.Sprintf("%.1f", math.Round(frac*1000)/10)
			explKm = fmt.Sprintf("%.1f", expl)
			totalKm = fmt.Sprintf("%.1f", total)
			pctFrac = fmt.Sprintf("%.4g", frac)
		}
	}

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		tmpl, err := os.ReadFile(filepath.Join(staticDir, "index.html"))
		if err != nil {
			http.NotFound(w, r)
			return
		}

		var updatedText []byte
		if ts := s.updated.Load(); ts != 0 {
			updatedText = []byte("Last updated " + time.UnixMilli(ts).Format(time.RFC822Z))
		}
		html := bytes.Replace(tmpl, []byte("__LAST_UPDATED_TIMESTAMP__"), updatedText, 1)
		html = bytes.Replace(html, []byte("__EXPL_PCT__"), []byte(pctNum), 1)
		html = bytes.Replace(html, []byte("__EXPL_KM__"), []byte(explKm), 1)
		html = bytes.Replace(html, []byte("__TOTAL_KM__"), []byte(totalKm), 1)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(html)
	})

	http.HandleFunc("/static/index.css", func(w http.ResponseWriter, r *http.Request) {
		b, err := os.ReadFile(filepath.Join(staticDir, "index.css"))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		b = bytes.Replace(b, []byte("__EXPL_FRACTION__"), []byte(pctFrac), 1)
		w.Header().Set("Content-Type", "text/css; charset=utf-8")
		if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			w.Header().Set("Content-Encoding", "gzip")
			gz := gzip.NewWriter(w)
			gz.Write(b)
			gz.Close()
		} else {
			w.Write(b)
		}
	})

	serveStaticFile("/static/index.js", filepath.Join(staticDir, "index.js"), "application/javascript; charset=utf-8", true)

	registerImageRoutes(filepath.Join(staticDir, "images"), "/static/images/")
}

func serveStaticFile(route, filePath, contentType string, useGzip bool) {
	http.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
		b, err := os.ReadFile(filePath)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", contentType)
		if useGzip && strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			w.Header().Set("Content-Encoding", "gzip")
			gz := gzip.NewWriter(w)
			gz.Write(b)
			gz.Close()
		} else {
			w.Write(b)
		}
	})
}

func registerImageRoutes(rootDir, urlPrefix string) {
	count := 0
	filepath.WalkDir(rootDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		var ct string
		switch strings.ToLower(filepath.Ext(d.Name())) {
		case ".jpg", ".jpeg":
			ct = "image/jpeg"
		case ".png":
			ct = "image/png"
		case ".svg":
			ct = "image/svg+xml"
		case ".gif":
			ct = "image/gif"
		case ".webp":
			ct = "image/webp"
		case ".ico":
			ct = "image/x-icon"
		default:
			return nil
		}
		rel, err := filepath.Rel(rootDir, path)
		if err != nil {
			return nil
		}
		route := urlPrefix + filepath.ToSlash(rel)
		filePath := path
		http.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
			b, err := os.ReadFile(filePath)
			if err != nil {
				http.Error(w, "not found", 404)
				return
			}
			w.Header().Set("Content-Type", ct)
			w.Write(b)
		})
		count++
		return nil
	})
	slog.Debug("registered image routes", "dir", rootDir, "count", count)
}

func main() {
	flag.Parse()
	if *debug {
		slog.SetLogLoggerLevel(slog.LevelDebug)
	}
	exe, err := os.Executable()
	if err != nil {
		slog.Error("executable path", "err", err)
		exe = "."
	}
	dataDir = filepath.Join(filepath.Dir(exe), "data")
	if _, err := os.Stat(dataDir); err != nil {
		if cwd, err := os.Getwd(); err == nil {
			dataDir = filepath.Join(cwd, "data")
		}
	}
	staticDir = filepath.Join(filepath.Dir(exe), "static")
	if _, err := os.Stat(staticDir); err != nil {
		if cwd, err := os.Getwd(); err == nil {
			staticDir = filepath.Join(cwd, "static")
		}
	}
	slog.Debug("startup", "step", "begin", "data_dir", dataDir, "static_dir", staticDir)
	srv := newServer()
	go func() {
		ticker := time.NewTicker(10 * time.Minute)
		for range ticker.C {
			srv.tick()
		}
	}()

	http.HandleFunc("/api/paths", func(w http.ResponseWriter, r *http.Request) {
		body := []byte("[]")
		if p := srv.paths.Load(); p != nil {
			body = *p
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Encoding", "gzip")
		gz := gzip.NewWriter(w)
		gz.Write(body)
		gz.Close()
	})
	http.HandleFunc("/api/neighborhoods", func(w http.ResponseWriter, r *http.Request) {
		body := []byte(`{"neighborhoods":[],"features":[]}`)
		if p := srv.nbds.Load(); p != nil && len(p.Bytes) > 0 {
			body = p.Bytes
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Encoding", "gzip")
		gz := gzip.NewWriter(w)
		gz.Write(body)
		gz.Close()
	})
	http.HandleFunc("/api/photos", func(w http.ResponseWriter, r *http.Request) {
		var body []byte
		if p := srv.photos.Load(); p != nil && len(p.Photos) > 0 {
			body, _ = json.Marshal(p)
		}
		if body == nil {
			body = []byte(`{"photos":[]}`)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Encoding", "gzip")
		gz := gzip.NewWriter(w)
		gz.Write(body)
		gz.Close()
	})
	http.HandleFunc("/api/streets", func(w http.ResponseWriter, r *http.Request) {
		body := []byte("[]")
		if b := srv.streetsBody.Load(); b != nil {
			body = *b
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Content-Encoding", "gzip")
		gz := gzip.NewWriter(w)
		gz.Write(body)
		gz.Close()
	})
	http.HandleFunc("/api/draw", func(w http.ResponseWriter, r *http.Request) {
		body := []byte(`{"streets":"","paths":"","bounds":[0,0,0,0]}`)
		if b := srv.drawCoreBody.Load(); b != nil {
			body = *b
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Content-Encoding", "gzip")
		gz := gzip.NewWriter(w)
		gz.Write(body)
		gz.Close()
	})
	http.HandleFunc("/api/draw/overlay", func(w http.ResponseWriter, r *http.Request) {
		body := []byte(`{"labels":[]}`)
		if b := srv.drawOverlayBody.Load(); b != nil {
			body = *b
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Content-Encoding", "gzip")
		gz := gzip.NewWriter(w)
		gz.Write(body)
		gz.Close()
	})
	srv.registerStaticRoutes(staticDir)

	mux := http.DefaultServeMux
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") && r.Method != http.MethodGet {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
			return
		}
		h := w.Header()
		if strings.HasPrefix(r.URL.Path, "/static/images/") {
			h.Set("Cache-Control", "public, max-age=604800") // 1 week for images
		} else {
			h.Set("Cache-Control", "public, max-age=600")
		}
		h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Permissions-Policy", "camera=(), geolocation=(), microphone=(), payment=(), usb=()")
		h.Set("Content-Security-Policy", "default-src 'none'; base-uri 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'")
		mux.ServeHTTP(w, r)
	})

	slog.Info("listening", "addr", *addr)
	httpSrv := &http.Server{
		Addr:         *addr,
		Handler:      handler,
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt)
	go func() {
		<-sigCh
		slog.Info("received SIGINT, shutting down")
		httpSrv.Close()
	}()

	if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("server", "err", err)
		os.Exit(1)
	}
}

type pathGeometry struct {
	Type        string      `json:"type"`
	Coordinates [][]float64 `json:"coordinates"`
}

type pathFeature struct {
	Type       string         `json:"type"`
	Geometry   pathGeometry   `json:"geometry"`
	Properties map[string]any `json:"properties"`
}

func buildPathsFromZip(z *zip.Reader) ([]pathFeature, error) {
	var out []pathFeature
	prefix := "apple_health_export/workout-routes/"
	for _, f := range z.File {
		if !strings.HasPrefix(f.Name, prefix) || strings.ToLower(filepath.Ext(f.Name)) != ".gpx" {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			slog.Debug("skip gpx", "name", f.Name, "err", err)
			continue
		}
		pts, err := parseGPX(rc)
		rc.Close()
		if err != nil {
			slog.Debug("skip gpx", "name", f.Name, "err", err)
			continue
		}
		if len(pts) < 2 {
			continue
		}
		coords := make([][]float64, len(pts))
		for i, p := range pts {
			if p[2] != courseMissing {
				coords[i] = []float64{p[0], p[1], p[2]}
			} else {
				coords[i] = []float64{p[0], p[1]}
			}
		}
		out = append(out, pathFeature{
			Type: "Feature",
			Geometry: pathGeometry{
				Type:        "LineString",
				Coordinates: coords,
			},
			Properties: map[string]any{},
		})
	}
	return out, nil
}

type gpxTrkPt struct {
	Lat string `xml:"lat,attr"`
	Lon string `xml:"lon,attr"`
	Ext struct {
		Course string `xml:"course"`
	} `xml:"extensions"`
}

type gpxDoc struct {
	XMLName xml.Name `xml:"http://www.topografix.com/GPX/1/1 gpx"`
	Trk     []struct {
		TrkSeg []struct {
			TrkPt []gpxTrkPt `xml:"http://www.topografix.com/GPX/1/1 trkpt"`
		} `xml:"http://www.topografix.com/GPX/1/1 trkseg"`
	} `xml:"http://www.topografix.com/GPX/1/1 trk"`
}

const courseMissing = -1.0

func parseGPX(r io.Reader) ([][3]float64, error) {
	var doc gpxDoc
	if err := xml.NewDecoder(r).Decode(&doc); err != nil {
		return nil, err
	}
	var pts [][3]float64
	for _, trk := range doc.Trk {
		for _, seg := range trk.TrkSeg {
			for _, pt := range seg.TrkPt {
				lat, errLat := strconv.ParseFloat(pt.Lat, 64)
				lon, errLon := strconv.ParseFloat(pt.Lon, 64)
				if errLat != nil || errLon != nil {
					continue
				}
				course := courseMissing
				if pt.Ext.Course != "" {
					if c, err := strconv.ParseFloat(strings.TrimSpace(pt.Ext.Course), 64); err == nil && c >= 0 && c < 360 {
						course = c
					}
				}
				pts = append(pts, [3]float64{lon, lat, course})
			}
		}
	}
	return pts, nil
}

func partMaxSegmentLen(part [][]float64) float64 {
	var max float64
	for i := 0; i < len(part)-1; i++ {
		a, b := part[i], part[i+1]
		if len(a) < 2 || len(b) < 2 {
			continue
		}
		d := math.Hypot(b[0]-a[0], b[1]-a[1])
		if d > max {
			max = d
		}
	}
	return max
}

func clipStreetsToSF(feats []streetFeat) (out []any, droppedLong int) {
	for _, f := range feats {
		coords := f.Geometry.Coordinates
		if len(coords) < 2 {
			continue
		}
		if partMaxSegmentLen(coords) > maxSegmentLenDeg {
			droppedLong++
			continue
		}
		out = append(out, map[string]any{
			"type": "Feature",
			"geometry": map[string]any{
				"type": "LineString", "coordinates": coords,
			},
			"properties": map[string]any{},
		})
	}
	return out, droppedLong
}

func haversineM(lon1, lat1, lon2, lat2 float64) float64 {
	const rad = math.Pi / 180
	phi1 := lat1 * rad
	phi2 := lat2 * rad
	dPhi := phi2 - phi1
	dLambda := (lon2 - lon1) * rad
	a := math.Sin(dPhi/2)*math.Sin(dPhi/2) + math.Cos(phi1)*math.Cos(phi2)*math.Sin(dLambda/2)*math.Sin(dLambda/2)
	c := 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
	return earthRadiusM * c
}

func exifDateString(rootIfd *exif.Ifd) string {
	const exifTimeLayout = "2006:01:02 15:04:05"
	tryTag := func(ifd *exif.Ifd, tagID uint16) string {
		entries, err := ifd.FindTagWithId(tagID)
		if err != nil || len(entries) == 0 {
			return ""
		}
		s, err := entries[0].FormatFirst()
		if err != nil || s == "" {
			return ""
		}
		t, err := time.Parse(exifTimeLayout, s)
		if err != nil {
			return ""
		}
		return t.Format("Jan 2, 2006")
	}
	if exifIfd, err := exif.FindIfdFromRootIfd(rootIfd, "IFD/Exif"); err == nil {
		if d := tryTag(exifIfd, 0x9003); d != "" {
			return d
		}
	}
	if d := tryTag(rootIfd, 0x0132); d != "" {
		return d
	}
	return ""
}

func processImagesDir(dirPath string) *photoData {
	entries, err := os.ReadDir(dirPath)
	if err != nil {
		slog.Warn("images dir not found, skipping photos", "path", dirPath, "err", err)
		return nil
	}
	var jpgNames []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		lower := strings.ToLower(name)
		if !strings.HasSuffix(lower, ".jpg") {
			continue
		}
		jpgNames = append(jpgNames, name)
	}
	slog.Debug("processing images dir", "jpg_files", len(jpgNames))

	im, err := exifcommon.NewIfdMappingWithStandard()
	if err != nil {
		slog.Warn("exif mapping", "err", err)
		return nil
	}
	if err := exifcommon.LoadStandardIfds(im); err != nil {
		if strings.Contains(err.Error(), "already registered under IFD") {
			slog.Warn("exif load standard ifds", "err", err)
		} else {
			slog.Error("exif load standard ifds", "err", err)
			return nil
		}
	}
	ti := exif.NewTagIndex()
	if err := exif.LoadStandardTags(ti); err != nil {
		slog.Warn("exif load standard tags", "err", err)
		return nil
	}

	var photos []photoRecord
	var processed int
	var firstSkipReason string
	for _, name := range jpgNames {
		filePath := filepath.Join(dirPath, name)
		raw, err := os.ReadFile(filePath)
		if err != nil {
			if firstSkipReason == "" {
				firstSkipReason = "read: " + err.Error()
			}
			slog.Debug("skip image read", "name", name, "err", err)
			continue
		}
		rawExif, err := exif.SearchAndExtractExif(raw)
		if err != nil || len(rawExif) == 0 {
			if firstSkipReason == "" {
				firstSkipReason = "no EXIF"
				if err != nil {
					firstSkipReason += ": " + err.Error()
				}
			}
			slog.Debug("skip no EXIF", "name", name, "err", err)
			continue
		}
		_, index, err := exif.Collect(im, ti, rawExif)
		if err != nil {
			if firstSkipReason == "" {
				firstSkipReason = "parse EXIF: " + err.Error()
			}
			slog.Debug("skip exif collect", "name", name, "err", err)
			continue
		}
		rootIfd := index.RootIfd
		gpsIfd, err := exif.FindIfdFromRootIfd(rootIfd, "IFD/GPSInfo")
		if err != nil || gpsIfd == nil {
			if firstSkipReason == "" {
				firstSkipReason = "no GPS IFD in EXIF"
			}
			slog.Debug("skip no GPS IFD", "name", name, "err", err)
			continue
		}
		gps, err := gpsIfd.GpsInfo()
		if err != nil || gps == nil {
			if firstSkipReason == "" {
				firstSkipReason = "no GPS in EXIF"
			}
			slog.Debug("skip no GPS", "name", name, "err", err)
			continue
		}
		lat, lon := gps.Latitude.Decimal(), gps.Longitude.Decimal()
		if lat == 0 && lon == 0 {
			if firstSkipReason == "" {
				firstSkipReason = "GPS coordinates are zero"
			}
			slog.Debug("skip zero GPS", "name", name)
			continue
		}
		processed++
		rec := photoRecord{
			ID:       name,
			Lat:      lat,
			Lon:      lon,
			Date:     exifDateString(rootIfd),
			URL:      "/static/images/full/" + name,
			ThumbURL: "/static/images/thumb/" + name,
		}
		photos = append(photos, rec)
	}
	slog.Debug("photos from images dir", "processed", processed, "included", len(photos))
	if len(jpgNames) > 0 && processed == 0 && firstSkipReason != "" {
		slog.Info("all JPG files skipped", "example_reason", firstSkipReason, "hint", "photos need GPS in EXIF")
	}
	return &photoData{Photos: photos}
}

func segmentBearingDeg(a, b point) float64 {
	const rad = math.Pi / 180
	lat1 := a.Lat * rad
	lat2 := b.Lat * rad
	dLon := (b.Lon - a.Lon) * rad
	y := math.Sin(dLon) * math.Cos(lat2)
	x := math.Cos(lat1)*math.Sin(lat2) - math.Sin(lat1)*math.Cos(lat2)*math.Cos(dLon)
	br := math.Atan2(y, x) * (180 / math.Pi)
	if br < 0 {
		br += 360
	}
	return br
}

func angleDiffDeg(a, b float64) float64 {
	d := math.Mod(math.Abs(a-b), 360)
	if d > 180 {
		d = 360 - d
	}
	return d
}

type pathGrid map[string][][]float64

func (g pathGrid) hasPoint(pt point, segmentBearingDeg float64) bool {
	cx := int(math.Floor(pt.Lon / gridCellSize))
	cy := int(math.Floor(pt.Lat / gridCellSize))
	for dx := -1; dx <= 1; dx++ {
		for dy := -1; dy <= 1; dy++ {
			key := fmt.Sprintf("%d,%d", cx+dx, cy+dy)
			for _, cell := range g[key] {
				if len(cell) < 2 {
					continue
				}
				if haversineM(cell[0], cell[1], pt.Lon, pt.Lat) > pathMatchToleranceM {
					continue
				}
				if len(cell) >= 3 && cell[2] != courseMissing {
					course := cell[2]
					opp := math.Mod(segmentBearingDeg+180, 360)
					if angleDiffDeg(course, segmentBearingDeg) > headingToleranceDeg &&
						angleDiffDeg(course, opp) > headingToleranceDeg {
						continue
					}
				}
				return true
			}
		}
	}
	return false
}

type segmentKey struct{ Si, J int }

func matchPathsToStreets(paths []pathFeature) ([]streetFeat, map[segmentKey]struct{}) {
	if len(streets) == 0 {
		return nil, map[segmentKey]struct{}{}
	}

	grid := make(pathGrid)
	for _, feat := range paths {
		pts := feat.Geometry.Coordinates
		if len(pts) < 2 {
			continue
		}
		for _, p := range pts {
			if len(p) < 2 {
				continue
			}
			pt := []float64{p[0], p[1]}
			if len(p) >= 3 {
				pt = append(pt, p[2])
			}
			cx := int(math.Floor(p[0] / gridCellSize))
			cy := int(math.Floor(p[1] / gridCellSize))
			key := fmt.Sprintf("%d,%d", cx, cy)
			grid[key] = append(grid[key], pt)
		}
	}

	n := len(streets)
	visitedSegs := make(map[segmentKey]struct{})
	var result []streetFeat
	var mu sync.Mutex
	var wg sync.WaitGroup
	numWorkers := max(runtime.NumCPU(), 1)
	chunk := (n + numWorkers - 1) / numWorkers
	for w := range numWorkers {
		lo := w * chunk
		hi := min(lo+chunk, n)
		if lo >= hi {
			continue
		}
		wg.Add(1)
		go func(lo, hi int) {
			defer wg.Done()
			for si := lo; si < hi; si++ {
				coords := streets[si].Geometry.Coordinates
				for j := 0; j < len(coords)-1; j++ {
					a, b := coords[j], coords[j+1]
					if len(a) < 2 || len(b) < 2 {
						continue
					}
					mid := point{Lon: (a[0] + b[0]) / 2, Lat: (a[1] + b[1]) / 2}
					segBearing := segmentBearingDeg(point{Lon: a[0], Lat: a[1]}, point{Lon: b[0], Lat: b[1]})
					if grid.hasPoint(mid, segBearing) {
						c0 := []float64{a[0], a[1]}
						c1 := []float64{b[0], b[1]}
						seg := streetFeat{}
						seg.Geometry.Coordinates = [][]float64{c0, c1}
						mu.Lock()
						visitedSegs[segmentKey{si, j}] = struct{}{}
						result = append(result, seg)
						mu.Unlock()
					}
				}
			}
		}(lo, hi)
	}
	wg.Wait()
	return result, visitedSegs
}

func pointInNbd(pt point, nbdPolys [][][]float64) bool {
	for _, poly := range nbdPolys {
		n := len(poly)
		if n < 3 {
			continue
		}
		inside := false
		for i, j := 0, n-1; i < n; j, i = i, i+1 {
			xi, yi := poly[i][0], poly[i][1]
			xj, yj := poly[j][0], poly[j][1]
			if ((yi > pt.Lat) != (yj > pt.Lat)) && (pt.Lon < (xj-xi)*(pt.Lat-yi)/(yj-yi+1e-20)+xi) {
				inside = !inside
			}
		}
		if inside {
			return true
		}
	}
	return false
}

func roundRing(ring [][]float64) [][]float64 {
	out := make([][]float64, len(ring))
	for j, c := range ring {
		if len(c) >= 2 {
			out[j] = []float64{roundCoord6(c[0]), roundCoord6(c[1])}
		} else {
			out[j] = c
		}
	}
	return out
}

func getNbdPolys(raw jsontext.Value) [][][]float64 {
	var poly [][][]float64
	if json.Unmarshal(raw, &poly) == nil && len(poly) > 0 {
		return [][][]float64{roundRing(poly[0])}
	}
	var multi [][][][]float64
	if json.Unmarshal(raw, &multi) == nil && len(multi) > 0 {
		var out [][][]float64
		for _, p := range multi {
			if len(p) > 0 {
				out = append(out, roundRing(p[0]))
			}
		}
		return out
	}
	return nil
}

func roundCoord6(x float64) float64 {
	const scale = 1e6
	return math.Round(x*scale) / scale
}

func roundNbdCoords(raw jsontext.Value) any {
	var poly [][][]float64
	if json.Unmarshal(raw, &poly) == nil && len(poly) > 0 {
		out := make([][][]float64, len(poly))
		for i, ring := range poly {
			out[i] = roundRing(ring)
		}
		return out
	}
	var multi [][][][]float64
	if json.Unmarshal(raw, &multi) == nil && len(multi) > 0 {
		out := make([][][][]float64, len(multi))
		for i, p := range multi {
			out[i] = make([][][]float64, len(p))
			for j, ring := range p {
				out[i][j] = roundRing(ring)
			}
		}
		return out
	}
	return nil
}

const pathCoordPrec = 6

func appendPathPolyline(s *strings.Builder, coords [][]float64) {
	for i, c := range coords {
		if len(c) < 2 {
			continue
		}
		x, y := c[0], c[1]
		if i == 0 {
			fmt.Fprintf(s, "M%.*f %.*f", pathCoordPrec, x, pathCoordPrec, y)
		} else {
			fmt.Fprintf(s, "L%.*f %.*f", pathCoordPrec, x, pathCoordPrec, y)
		}
	}
}

func polylinesToPathString(polylines [][][]float64) string {
	var b strings.Builder
	for _, coords := range polylines {
		if len(coords) >= 2 {
			appendPathPolyline(&b, coords)
		}
	}
	return b.String()
}

func ringsToPathString(rings [][][]float64) string {
	var b strings.Builder
	for _, ring := range rings {
		if len(ring) < 2 {
			continue
		}
		appendPathPolyline(&b, ring)
		b.WriteByte('Z')
	}
	return b.String()
}

func buildDrawCore(pathFeats []streetFeat, st *nbdStats) *drawCorePayload {
	out := &drawCorePayload{}
	var streetPolys [][][]float64
	for _, f := range streets {
		coords := f.Geometry.Coordinates
		if len(coords) >= 2 {
			streetPolys = append(streetPolys, coords)
		}
	}
	var pathPolys [][][]float64
	for _, f := range pathFeats {
		coords := f.Geometry.Coordinates
		if len(coords) >= 2 {
			pathPolys = append(pathPolys, coords)
		}
	}
	out.Streets = polylinesToPathString(streetPolys)
	out.Paths = polylinesToPathString(pathPolys)
	minLon, minLat := math.Inf(1), math.Inf(1)
	maxLon, maxLat := math.Inf(-1), math.Inf(-1)
	for _, poly := range streetPolys {
		for _, c := range poly {
			if len(c) >= 2 {
				if c[0] < minLon {
					minLon = c[0]
				}
				if c[0] > maxLon {
					maxLon = c[0]
				}
				if c[1] < minLat {
					minLat = c[1]
				}
				if c[1] > maxLat {
					maxLat = c[1]
				}
			}
		}
	}
	for _, poly := range pathPolys {
		for _, c := range poly {
			if len(c) >= 2 {
				if c[0] < minLon {
					minLon = c[0]
				}
				if c[0] > maxLon {
					maxLon = c[0]
				}
				if c[1] < minLat {
					minLat = c[1]
				}
				if c[1] > maxLat {
					maxLat = c[1]
				}
			}
		}
	}
	if minLon != math.Inf(1) {
		out.Bounds = [4]float64{minLon, minLat, maxLon, maxLat}
	}
	if len(nbds) > 0 {
		var allRings [][][]float64
		for i := range nbds {
			nb := &nbds[i]
			rings := getNbdPolys(nb.Geom.Coords)
			if len(rings) == 0 {
				continue
			}
			name := nb.Props.Name
			if name == "" {
				name = fmt.Sprintf("Neighborhood %d", i+1)
			}
			out.Neighborhoods.Features = append(out.Neighborhoods.Features, drawNbdFeat{Name: name, Rings: rings})
			allRings = append(allRings, rings...)
		}
		out.Neighborhoods.Outlines = ringsToPathString(allRings)
		if st != nil {
			out.Neighborhoods.List = st.List
		}
	}
	return out
}

func buildDrawOverlay(st *nbdStats) *drawOverlayPayload {
	out := &drawOverlayPayload{}
	for _, f := range streets {
		name, _ := f.Properties["name"].(string)
		if name == "" {
			continue
		}
		coords := f.Geometry.Coordinates
		if f.Geometry.Type != "LineString" || len(coords) < 2 {
			continue
		}
		minLon, maxLon := coords[0][0], coords[0][0]
		minLat, maxLat := coords[0][1], coords[0][1]
		var sumLon, sumLat float64
		for _, c := range coords {
			if len(c) < 2 {
				continue
			}
			if c[0] < minLon {
				minLon = c[0]
			}
			if c[0] > maxLon {
				maxLon = c[0]
			}
			if c[1] < minLat {
				minLat = c[1]
			}
			if c[1] > maxLat {
				maxLat = c[1]
			}
			sumLon += c[0]
			sumLat += c[1]
		}
		n := float64(len(coords))
		dlon := coords[len(coords)-1][0] - coords[0][0]
		dlat := coords[len(coords)-1][1] - coords[0][1]
		angle := math.Atan2(-dlat, dlon)
		length := math.Sqrt((maxLon-minLon)*(maxLon-minLon) + (maxLat-minLat)*(maxLat-minLat))
		out.Labels = append(out.Labels, drawLabel{
			Lon: sumLon / n, Lat: sumLat / n, Name: name,
			MinLon: minLon, MaxLon: maxLon, MinLat: minLat, MaxLat: maxLat,
			Angle: angle, Length: length,
		})
	}
	return out
}

func computeNbdStats(visitedSegs map[segmentKey]struct{}) *nbdStats {
	if len(nbds) == 0 {
		return nil
	}
	if visitedSegs == nil {
		visitedSegs = make(map[segmentKey]struct{})
	}
	type agg struct {
		total, expl float64
	}
	byName := make(map[string]*agg)
	var names []string
	for i := range nbds {
		nb := &nbds[i]
		name := nb.Props.Name
		if name == "" {
			name = fmt.Sprintf("Neighborhood %d", i+1)
		}
		if byName[name] == nil {
			byName[name] = &agg{}
			names = append(names, name)
		}
		nbdPolys := getNbdPolys(nb.Geom.Coords)
		if len(nbdPolys) == 0 {
			continue
		}
		for si, f := range streets {
			coords := f.Geometry.Coordinates
			for j := 0; j < len(coords)-1; j++ {
				a, b := coords[j], coords[j+1]
				if len(a) < 2 || len(b) < 2 {
					continue
				}
				mid := point{Lon: (a[0] + b[0]) / 2, Lat: (a[1] + b[1]) / 2}
				if !pointInNbd(mid, nbdPolys) {
					continue
				}
				lenKm := haversineM(a[0], a[1], b[0], b[1]) / 1000
				byName[name].total += lenKm
				if _, ok := visitedSegs[segmentKey{si, j}]; ok {
					byName[name].expl += lenKm
				}
			}
		}
	}
	var rows []nbdRow
	for i, name := range names {
		a := byName[name]
		unex := a.total - a.expl
		if unex < 0 {
			unex = 0
		}
		pct := 0.0
		if a.total > 0 {
			pct = 100 * a.expl / a.total
		}
		rows = append(rows, nbdRow{
			ID:    fmt.Sprintf("n%02d", i),
			Name:  name,
			Total: math.Round(a.total*100) / 100,
			Expl:  math.Round(a.expl*100) / 100,
			Unex:  math.Round(unex*100) / 100,
			Pct:   math.Round(pct*10) / 10,
		})
	}
	for i := 0; i < len(rows); i++ {
		for j := i + 1; j < len(rows); j++ {
			if rows[j].Pct < rows[i].Pct {
				rows[i], rows[j] = rows[j], rows[i]
			}
		}
	}
	var geo []any
	for _, nb := range nbds {
		coords := roundNbdCoords(nb.Geom.Coords)
		if coords == nil {
			continue
		}
		geo = append(geo, map[string]any{
			"type":       "Feature",
			"properties": map[string]any{"name": nb.Props.Name},
			"geometry":   map[string]any{"type": nb.Geom.Type, "coordinates": coords},
		})
	}
	out := &nbdStats{List: rows, Geo: geo}
	b, err := json.Marshal(map[string]any{"neighborhoods": rows, "features": geo})
	if err != nil {
		return nil
	}
	out.Bytes = b
	return out
}
