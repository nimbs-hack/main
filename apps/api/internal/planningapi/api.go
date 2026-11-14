// Package planningapi serves the local DEM planner through the existing Go API.
package planningapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"mars-console/api/internal/planner"
	"mars-console/api/internal/weather"
)

type service struct {
	dataDir string
	mu      sync.Mutex
	graph   *planner.Graph
	// Bound simultaneous million-cell searches and field allocations.
	slots chan struct{}
}

func Register(mux *http.ServeMux, dataDir string) {
	s := &service{dataDir: dataDir, slots: make(chan struct{}, 2)}
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		g, err := s.load()
		reply(w, http.StatusOK, struct {
			OK         bool   `json:"ok"`
			SiteLoaded bool   `json:"siteLoaded"`
			SiteID     string `json:"siteId,omitempty"`
		}{true, err == nil, siteID(g)})
	})
	mux.HandleFunc("GET /api/site", s.withGraph(func(w http.ResponseWriter, r *http.Request, g *planner.Graph) {
		reply(w, http.StatusOK, struct {
			Meta planner.Metadata `json:"meta"`
		}{g.Meta})
	}))
	mux.HandleFunc("GET /api/terrain/elevation", s.withGraph(func(w http.ResponseWriter, r *http.Request, g *planner.Graph) {
		lat, err1 := strconv.ParseFloat(r.URL.Query().Get("lat"), 64)
		lon, err2 := strconv.ParseFloat(r.URL.Query().Get("lon"), 64)
		if err1 != nil || err2 != nil || !finite(lat) || !finite(lon) {
			fail(w, 400, "lat and lon must be finite numbers")
			return
		}
		point := planner.Coord{Lat: lat, Lon: lon}
		reply(w, 200, struct {
			Lat       float64  `json:"lat"`
			Lon       float64  `json:"lon"`
			Inside    bool     `json:"insideSite"`
			Elevation *float64 `json:"elevationM"`
		}{lat, lon, g.Inside(point), g.ElevationAt(point)})
	}))
	mux.HandleFunc("POST /api/graph/routes", s.withGraph(s.routes))
	mux.HandleFunc("POST /api/weather/evaluate", s.withGraph(s.evaluate))
	mux.HandleFunc("GET /api/weather", s.withGraph(s.weather))
	mux.HandleFunc("GET /api/site/{layer}", s.withGraph(s.mask))
}

func siteID(g *planner.Graph) string {
	if g == nil {
		return ""
	}
	return g.Meta.ID
}
func finite(n float64) bool { return !math.IsNaN(n) && !math.IsInf(n, 0) }
func reply(w http.ResponseWriter, code int, value any) {
	var b bytes.Buffer
	if err := json.NewEncoder(&b).Encode(value); err != nil {
		http.Error(w, "Could not encode planning response", 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_, _ = w.Write(b.Bytes())
}
func fail(w http.ResponseWriter, code int, message string) {
	reply(w, code, struct {
		Error string `json:"error"`
	}{message})
}

func (s *service) load() (*planner.Graph, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.graph != nil {
		return s.graph, nil
	}
	file, err := os.Open(filepath.Join(s.dataDir, "site-terrain.json"))
	if err != nil {
		return nil, err
	}
	defer file.Close()
	var data planner.Dataset
	if err := json.NewDecoder(io.LimitReader(file, 128<<20)).Decode(&data); err != nil {
		return nil, err
	}
	graph, err := planner.NewGraph(data)
	if err != nil {
		return nil, err
	}
	s.graph = graph
	return graph, nil
}

func (s *service) withGraph(next func(http.ResponseWriter, *http.Request, *planner.Graph)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		select {
		case s.slots <- struct{}{}:
			defer func() { <-s.slots }()
		case <-r.Context().Done():
			return
		}
		g, err := s.load()
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				fail(w, 503, "Planning DEM is missing. Run bun run fetch-site.")
			} else {
				fail(w, 503, "Planning DEM could not be loaded. Regenerate it with bun run fetch-site.")
			}
			return
		}
		if r.Context().Err() != nil {
			return
		}
		next(w, r, g)
	}
}

func decode(w http.ResponseWriter, r *http.Request, target any) error {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20))
	var raw json.RawMessage
	if err := decoder.Decode(&raw); err != nil {
		return fmt.Errorf("invalid JSON payload: %w", err)
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return errors.New("expected a JSON object")
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return errors.New("expected one JSON object")
	}
	if err := rejectNullOptions(raw); err != nil {
		return err
	}
	return json.Unmarshal(raw, target)
}

// Optional numeric settings may be omitted, but null is not a numeric default.
func rejectNullOptions(raw json.RawMessage) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return err
	}
	for _, name := range []string{"sol", "lmstHour", "minAirTempC", "minPressurePa", "thermalWeight", "maxWindSpeedMps", "maxPressureSwingPa", "maxEvaHours"} {
		if value, exists := fields[name]; exists && bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return fmt.Errorf("%s must be a number", name)
		}
	}
	for _, name := range []string{"weatherConstraints", "limits"} {
		if value, exists := fields[name]; exists {
			if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
				return fmt.Errorf("%s must be an object", name)
			}
			if err := rejectNullOptions(value); err != nil {
				return err
			}
		}
	}
	return nil
}

type coordinate struct {
	Lat *float64 `json:"lat"`
	Lon *float64 `json:"lon"`
}

func (c *coordinate) value() (planner.Coord, error) {
	if c == nil || c.Lat == nil || c.Lon == nil || !finite(*c.Lat) || !finite(*c.Lon) || *c.Lat < -90 || *c.Lat > 90 || *c.Lon < -180 || *c.Lon >= 180 {
		return planner.Coord{}, errors.New("waypoints must use planetocentric latitude and longitude in [-180, 180)")
	}
	return planner.Coord{Lat: *c.Lat, Lon: *c.Lon}, nil
}

type constraints struct {
	Enabled       bool     `json:"enabled"`
	Scenario      string   `json:"scenario"`
	Sol           *int     `json:"sol"`
	LMSTHour      *float64 `json:"lmstHour"`
	MinAirTempC   *float64 `json:"minAirTempC"`
	MinPressurePa *float64 `json:"minPressurePa"`
	ThermalWeight *float64 `json:"thermalWeight"`
}

func defaults(c constraints) (weather.Options, weather.Limits, float64, error) {
	o := weather.Options{Scenario: "nominal", Sol: 1000, LMSTHour: 12}
	l := weather.DefaultLimits()
	weight := 0.35
	if c.Scenario != "" {
		o.Scenario = c.Scenario
	}
	if c.Sol != nil {
		o.Sol = *c.Sol
	}
	if c.LMSTHour != nil {
		o.LMSTHour = *c.LMSTHour
	}
	if c.MinAirTempC != nil {
		l.MinAirTempK = *c.MinAirTempC + 273.15
	}
	if c.MinPressurePa != nil {
		l.MinPressurePa = *c.MinPressurePa
	}
	if c.ThermalWeight != nil {
		weight = *c.ThermalWeight
	}
	if o.Scenario != "nominal" && o.Scenario != "auto" && o.Scenario != "dust-storm" && o.Scenario != "cold-snap" {
		return o, l, weight, errors.New("unknown weather scenario")
	}
	if o.Sol < 0 || o.Sol > 100000 || !finite(o.LMSTHour) || o.LMSTHour < 0 || o.LMSTHour > 48 || !finite(l.MinAirTempK) || (c.MinAirTempC != nil && (*c.MinAirTempC < -180 || *c.MinAirTempC > 60)) || !finite(l.MinPressurePa) || l.MinPressurePa < 0 || l.MinPressurePa > 2500 || !finite(weight) || weight < 0 || weight > 1 {
		return o, l, weight, errors.New("weather constraints are outside their supported ranges")
	}
	return o, l, weight, nil
}
func grid(g *planner.Graph) weather.Grid {
	reference := -2500.0
	if strings.Contains(g.Meta.ID, "gale") || strings.Contains(g.Meta.ID, "mount-sharp") {
		reference = -4500
	}
	return weather.Grid{Rows: g.Meta.Rows, Cols: g.Meta.Cols, BBox: g.Meta.BBox, Elevations: g.Elevations, Valid: g.Valid, ID: g.Meta.ID, Name: g.Meta.Name, ReferenceElevationM: reference, CellSizeMeters: g.Meta.CellSizeMeters}
}
func (s *service) routes(w http.ResponseWriter, r *http.Request, g *planner.Graph) {
	var body struct {
		A         *coordinate  `json:"waypointA"`
		B         *coordinate  `json:"waypointB"`
		Via       []coordinate `json:"via"`
		RoundTrip bool         `json:"roundTrip"`
		Slope     *float64     `json:"maxSlopeDeg"`
		Weather   constraints  `json:"weatherConstraints"`
	}
	if err := decode(w, r, &body); err != nil {
		fail(w, 400, err.Error())
		return
	}
	a, err := body.A.value()
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	b, err := body.B.value()
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	if len(body.Via) > planner.MaxStops-2 {
		fail(w, 400, fmt.Sprintf("at most %d intermediate stops", planner.MaxStops-2))
		return
	}
	stops := []planner.Coord{a}
	for i := range body.Via {
		stop, err := body.Via[i].value()
		if err != nil {
			fail(w, 400, err.Error())
			return
		}
		stops = append(stops, stop)
	}
	stops = append(stops, b)
	if body.Slope == nil || !finite(*body.Slope) || *body.Slope < 0 || *body.Slope > 89 {
		fail(w, 400, "maxSlopeDeg must be in [0, 89]")
		return
	}
	o, limits, weight, err := defaults(body.Weather)
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	field, err := weather.ComputeFieldContext(r.Context(), grid(g), o)
	if err != nil {
		computationError(w, r, err)
		return
	}
	var filter *planner.WeatherFilter
	if body.Weather.Enabled {
		filter = &planner.WeatherFilter{LMSTHour: o.LMSTHour, MinAirTempC: limits.MinAirTempK - 273.15, MinPressurePa: limits.MinPressurePa, ThermalWeight: weight, CellTempK: field.TempK, CellPressurePa: field.PressurePa}
	}
	result, err := g.PlanStops(r.Context(), stops, body.RoundTrip, *body.Slope, filter)
	if err != nil {
		computationError(w, r, err)
		return
	}
	// Route vertices lie on DEM cells. Attach departure conditions even when
	// weather filtering is off so profile values never imply a routing limit.
	for ri := range result.Routes {
		route := &result.Routes[ri]
		minT, maxT, minP, maxP := math.Inf(1), math.Inf(-1), math.Inf(1), math.Inf(-1)
		for pi := range route.Points {
			point := &route.Points[pi]
			b := g.Meta.BBox
			row := min(g.Meta.Rows-1, max(0, int(math.Round((b[3]-point.Lat)/(b[3]-b[1])*float64(g.Meta.Rows-1)))))
			col := min(g.Meta.Cols-1, max(0, int(math.Round((point.Lon-b[0])/(b[2]-b[0])*float64(g.Meta.Cols-1)))))
			i := row*g.Meta.Cols + col
			temp, pressure := field.TempK[i]-273.15, field.PressurePa[i]
			point.TempC, point.PressurePa = &temp, &pressure
			minT, maxT = math.Min(minT, temp), math.Max(maxT, temp)
			minP, maxP = math.Min(minP, pressure), math.Max(maxP, pressure)
		}
		if len(route.Points) > 0 {
			route.MinTempC, route.MaxTempC, route.MinPressurePa, route.MaxPressurePa = &minT, &maxT, &minP, &maxP
		}
	}
	reply(w, 200, result)
}
func computationError(w http.ResponseWriter, r *http.Request, err error) {
	if r.Context().Err() != nil || errors.Is(err, context.Canceled) {
		return
	}
	fail(w, 400, err.Error())
}

type requestLimits struct {
	MinAirTempC        *float64 `json:"minAirTempC"`
	MinPressurePa      *float64 `json:"minPressurePa"`
	MaxWindSpeedMps    *float64 `json:"maxWindSpeedMps"`
	MaxPressureSwingPa *float64 `json:"maxPressureSwingPa"`
	MaxEvaHours        *float64 `json:"maxEvaHours"`
}

func (s *service) evaluate(w http.ResponseWriter, r *http.Request, g *planner.Graph) {
	var body struct {
		Scenario string         `json:"scenario"`
		Sol      *int           `json:"sol"`
		LMSTHour *float64       `json:"lmstHour"`
		Limits   requestLimits  `json:"limits"`
		Route    *weather.Route `json:"route"`
	}
	if err := decode(w, r, &body); err != nil {
		fail(w, 400, err.Error())
		return
	}
	o, l, _, err := defaults(constraints{Scenario: body.Scenario, Sol: body.Sol, LMSTHour: body.LMSTHour, MinAirTempC: body.Limits.MinAirTempC, MinPressurePa: body.Limits.MinPressurePa})
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	if body.Limits.MaxWindSpeedMps != nil {
		l.MaxWindSpeedMps = *body.Limits.MaxWindSpeedMps
	}
	if body.Limits.MaxPressureSwingPa != nil {
		l.MaxPressureSwingPa = *body.Limits.MaxPressureSwingPa
	}
	if body.Limits.MaxEvaHours != nil {
		l.MaxEvaHours = *body.Limits.MaxEvaHours
	}
	s.weatherResponse(w, r, g, o, l, body.Route)
}
func queryConstraints(r *http.Request) (constraints, error) {
	q := r.URL.Query()
	c := constraints{Scenario: q.Get("scenario")}
	if raw, ok := q["sol"]; ok {
		n, err := strconv.Atoi(raw[0])
		if err != nil {
			return c, errors.New("sol must be an integer")
		}
		c.Sol = &n
	}
	for key, target := range map[string]**float64{"lmstHour": &c.LMSTHour, "minAirTempC": &c.MinAirTempC, "minPressurePa": &c.MinPressurePa} {
		if raw, ok := q[key]; ok {
			n, err := strconv.ParseFloat(raw[0], 64)
			if err != nil {
				return c, fmt.Errorf("%s must be a number", key)
			}
			*target = &n
		}
	}
	return c, nil
}
func (s *service) weather(w http.ResponseWriter, r *http.Request, g *planner.Graph) {
	c, err := queryConstraints(r)
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	o, l, _, err := defaults(c)
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	s.weatherResponse(w, r, g, o, l, nil)
}
func (s *service) weatherResponse(w http.ResponseWriter, r *http.Request, g *planner.Graph, o weather.Options, l weather.Limits, route *weather.Route) {
	snapshot, err := weather.Generate(grid(g), o)
	if err != nil {
		computationError(w, r, err)
		return
	}
	evaluation, err := weather.EvaluateContext(r.Context(), snapshot, weather.EvaluateOptions{Limits: &l, Route: route, LMSTHour: o.LMSTHour, StepHours: 0.5})
	if err != nil {
		computationError(w, r, err)
		return
	}
	if r.Context().Err() != nil {
		return
	}
	reply(w, 200, struct {
		Weather    weather.Snapshot   `json:"weather"`
		Current    weather.Sample     `json:"current"`
		Evaluation weather.Evaluation `json:"evaluation"`
	}{snapshot, snapshot.Current, evaluation})
}
func (s *service) mask(w http.ResponseWriter, r *http.Request, g *planner.Graph) {
	name := strings.TrimSuffix(r.PathValue("layer"), ".png")
	if !strings.HasSuffix(r.PathValue("layer"), ".png") {
		fail(w, 404, "unknown planning layer")
		return
	}
	if name == "hillshade" {
		http.ServeFile(w, r, filepath.Join(s.dataDir, "site-hillshade.png"))
		return
	}
	if name != "passability" && name != "temperature" && name != "pressure" {
		fail(w, 404, "unknown planning layer")
		return
	}
	var data []byte
	var err error
	if name == "passability" {
		slope := 20.0
		if raw := r.URL.Query().Get("maxSlopeDeg"); raw != "" {
			slope, err = strconv.ParseFloat(raw, 64)
		}
		if err != nil || !finite(slope) || slope < 0 || slope > 89 {
			fail(w, 400, "maxSlopeDeg must be in [0, 89]")
			return
		}
		data, err = g.SlopeMask(r.Context(), slope)
	} else {
		c, e := queryConstraints(r)
		if e != nil {
			fail(w, 400, e.Error())
			return
		}
		o, l, _, e := defaults(c)
		if e != nil {
			fail(w, 400, e.Error())
			return
		}
		field, e := weather.ComputeFieldContext(r.Context(), grid(g), o)
		if e != nil {
			computationError(w, r, e)
			return
		}
		rgba := image.NewNRGBA(image.Rect(0, 0, g.Meta.Cols, g.Meta.Rows))
		for i, valid := range g.Valid {
			if i%4096 == 0 && r.Context().Err() != nil {
				return
			}
			if !valid {
				continue
			}
			blocked := field.TempK[i] < l.MinAirTempK
			if name == "pressure" {
				blocked = field.PressurePa[i] < l.MinPressurePa
			}
			value := (field.TempK[i] - 153.15) / 120
			if name == "pressure" {
				value = (field.PressurePa[i] - 400) / 600
			}
			value = math.Max(0, math.Min(1, value))
			shade := color.NRGBA{uint8(40 + 200*value), uint8(100 + 80*(1-math.Abs(2*value-1))), uint8(240 - 200*value), 210}
			if blocked {
				shade = color.NRGBA{255, 122, 47, 210}
			}
			rgba.SetNRGBA(i%g.Meta.Cols, i/g.Meta.Cols, shade)
		}
		var buf bytes.Buffer
		err = png.Encode(&buf, rgba)
		data = buf.Bytes()
	}
	if err != nil {
		computationError(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(data)
}
