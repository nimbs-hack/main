package planner

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image/color"
	"image/png"
	"math"
	"os"
	"reflect"
	"sync"
	"testing"
)

func grid(rows, cols int, e []float64) Dataset {
	return Dataset{Meta: Metadata{Rows: rows, Cols: cols, BBox: [4]float64{0, 0, float64(cols-1) * 0.001, float64(rows-1) * 0.001}, NodataValue: -99999}, ElevationsM: e}
}
func graphFor(t *testing.T, d Dataset) *Graph {
	t.Helper()
	g, err := NewGraph(d)
	if err != nil {
		t.Fatal(err)
	}
	return g
}
func planFor(t *testing.T, g *Graph, a, b Coord, limit float64, w *WeatherFilter) PlanResponse {
	t.Helper()
	r, err := g.Plan(context.Background(), a, b, limit, w)
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func weatherFor(g *Graph, p, t []float64) *WeatherFilter {
	if t == nil {
		t = make([]float64, len(p))
		for i := range t {
			t[i] = 250
		}
	}
	return &WeatherFilter{LMSTHour: 12, MinAirTempC: -150, MinPressurePa: 600, CellTempK: t, CellPressurePa: p}
}
func requireStatus(t *testing.T, r PlanResponse, status, reason string) {
	t.Helper()
	if r.Status != status || r.BlockedReason != reason {
		t.Fatalf("got %s/%s, want %s/%s: %s", r.Status, r.BlockedReason, status, reason, r.Message)
	}
}

func TestNodataAndInterpolation(t *testing.T) {
	d := grid(1, 4, []float64{-20, -5, 0, 10})
	d.Meta.NodataValue = 0
	g := graphFor(t, d)
	if !reflect.DeepEqual(g.Valid, []bool{true, true, false, true}) {
		t.Fatal(g.Valid)
	}
	d = grid(1, 2, []float64{-9999.9, 0})
	d.Meta.NodataValue = -9999.9
	g = graphFor(t, d)
	if g.Valid[0] || !g.Valid[1] {
		t.Fatal(g.Valid)
	}
	g = graphFor(t, grid(2, 2, []float64{0, -99999, 0, 0}))
	r := planFor(t, g, g.CoordForCell(0, 1), g.CoordForCell(1, 1), 10, nil)
	requireStatus(t, r, "unreachable", "nodata")
	if v := g.ElevationAt(g.CoordForCell(0, 0)); v == nil || *v != 0 {
		t.Fatal(v)
	}
	if g.ElevationAt(Coord{0.0009, 0.0001}) != nil || g.ElevationAt(Coord{1, 1}) != nil {
		t.Fatal("interpolated missing coverage")
	}
	g = graphFor(t, grid(2, 2, []float64{0, 10, 20, 30}))
	if v := g.ElevationAt(Coord{0.0005, 0.0005}); v == nil || *v != 15 {
		t.Fatal(v)
	}
}
func TestCornerClearanceAndMinimax(t *testing.T) {
	g := graphFor(t, grid(2, 2, []float64{0, -99999, -99999, 0}))
	a, b := g.CoordForCell(0, 0), g.CoordForCell(1, 1)
	r := planFor(t, g, a, b, 89, nil)
	requireStatus(t, r, "unreachable", "nodata")
	if r.MinRequiredSlopeDeg != nil || r.PassableEdgeRatio != 0 {
		t.Fatal(r)
	}
	g = graphFor(t, grid(2, 2, []float64{0, 100, 100, 0}))
	r = planFor(t, g, a, b, 10, nil)
	requireStatus(t, r, "unreachable", "slope")
	if r.MinRequiredSlopeDeg == nil || *r.MinRequiredSlopeDeg < 50 || r.PassableEdgeRatio != 0 {
		t.Fatal(r)
	}
	requireStatus(t, planFor(t, g, a, b, *r.MinRequiredSlopeDeg, nil), "ok", "")
	requireStatus(t, planFor(t, g, a, b, *r.MinRequiredSlopeDeg-0.1, nil), "unreachable", "slope")
	d := grid(1, 3, []float64{0, 10, 10})
	base := graphFor(t, d)
	spacing := 10 / math.Tan(10.0000001*math.Pi/180)
	d.Meta.BBox[2] = 0.002 * spacing / base.dx
	g = graphFor(t, d)
	r = planFor(t, g, g.CoordForCell(0, 0), g.CoordForCell(0, 2), 9, nil)
	if r.MinRequiredSlopeDeg == nil || *r.MinRequiredSlopeDeg != 10.1 {
		t.Fatal(r.MinRequiredSlopeDeg)
	}
}
func TestShortestAndMetrics(t *testing.T) {
	d := grid(4, 6, make([]float64, 24))
	d.Meta.BBox = [4]float64{0, 0, 0.01, 0.003}
	g := graphFor(t, d)
	a, b := g.CoordForCell(0, 0), g.CoordForCell(3, 5)
	for i := 0; i < 3; i++ {
		r := planFor(t, g, a, b, 0, nil)
		requireStatus(t, r, "ok", "")
		route := r.Routes[0]
		if route.TotalDistanceM != rounded(3*math.Hypot(g.dx, g.dy)+2*g.dx, 10) || len(route.Points) != 6 {
			t.Fatal(route)
		}
		a, b = b, a
	}
	g = graphFor(t, grid(1, 3, []float64{0, 10, 0}))
	a = g.CoordForCell(0, 0)
	r := planFor(t, g, a, g.CoordForCell(0, 2), 20, nil).Routes[0]
	if r.ElevationGainM != 10 || r.ElevationLossM != 10 || r.MeanSlopeDeg != r.MaxSlopeDeg || r.Points[2].DistanceM != r.TotalDistanceM {
		t.Fatal(r)
	}
	stationary := planFor(t, g, a, a, 0, nil).Routes[0]
	if len(stationary.Points) != 1 || stationary.TotalDistanceM != 0 || stationary.MeanSlopeDeg != 0 {
		t.Fatal(stationary)
	}
}
func TestWeatherBottlenecks(t *testing.T) {
	g := graphFor(t, grid(2, 2, []float64{0, 0, 0, 0}))
	a, b := g.CoordForCell(0, 0), g.CoordForCell(1, 1)
	w := weatherFor(g, []float64{900, 500, 500, 900}, nil)
	r := planFor(t, g, a, b, 10, w)
	requireStatus(t, r, "unreachable", "pressure")
	if r.MaxFeasibleMinPressurePa == nil || *r.MaxFeasibleMinPressurePa != 500 {
		t.Fatal(r)
	}
	w.MinPressurePa = 500
	requireStatus(t, planFor(t, g, a, b, 10, w), "ok", "")
	g = graphFor(t, grid(3, 3, []float64{0, 0, 0, 0, -99999, 0, 0, 0, 0}))
	a, b = g.CoordForCell(1, 0), g.CoordForCell(1, 2)
	w = weatherFor(g, []float64{400, 400, 400, 900, 900, 900, 800, 800, 800}, []float64{250, 250, 250, 260, 260, 260, 220, 220, 220})
	w.MinAirTempC = -33.15
	r = planFor(t, g, a, b, 10, w)
	requireStatus(t, r, "unreachable", "combined")
	if r.MaxFeasibleMinPressurePa == nil || *r.MaxFeasibleMinPressurePa != 400 || r.MaxFeasibleMinTempC == nil || math.Abs(*r.MaxFeasibleMinTempC+53.15) > 0.011 {
		t.Fatal(r)
	}
	relaxed := *w
	relaxed.MinPressurePa = *r.MaxFeasibleMinPressurePa
	requireStatus(t, planFor(t, g, a, b, 10, &relaxed), "ok", "")
	relaxed = *w
	relaxed.MinAirTempC = *r.MaxFeasibleMinTempC
	requireStatus(t, planFor(t, g, a, b, 10, &relaxed), "ok", "")
	for _, bad := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
		g = graphFor(t, grid(1, 3, []float64{0, 0, 0}))
		r = planFor(t, g, g.CoordForCell(0, 0), g.CoordForCell(0, 2), 10, weatherFor(g, []float64{900, bad, 900}, nil))
		if r.Status != "unreachable" || r.MaxFeasibleMinPressurePa != nil {
			t.Fatal(r)
		}
	}
}
func ridgeDataset() Dataset {
	d := grid(11, 11, make([]float64, 121))
	d.Meta.BBox = [4]float64{77.5, 18.4, 77.5178, 18.4169}
	for r := 0; r < 11; r++ {
		d.ElevationsM[r*11+5] = 45
	}
	d.ElevationsM[9*11+5] = 5
	return d
}
func TestRidgeRoutes(t *testing.T) {
	g := graphFor(t, ridgeDataset())
	a, b := g.CoordForCell(2, 1), g.CoordForCell(2, 9)
	strict := planFor(t, g, a, b, 10, nil)
	permissive := planFor(t, g, a, b, 30, nil)
	requireStatus(t, strict, "ok", "")
	requireStatus(t, permissive, "ok", "")
	if strict.Routes[0].MaxSlopeDeg > 10 || permissive.Routes[0].TotalDistanceM >= strict.Routes[0].TotalDistanceM {
		t.Fatal("ridge was not avoided")
	}
	passedSouth := false
	for _, p := range strict.Routes[0].Points {
		if p.Lat < g.CoordForCell(7, 5).Lat {
			passedSouth = true
		}
	}
	if !passedSouth {
		t.Fatal("missed southern pass")
	}
	r := planFor(t, g, a, b, 1, nil)
	requireStatus(t, r, "unreachable", "slope")
	if r.MinRequiredSlopeDeg == nil || *r.MinRequiredSlopeDeg <= 1 || *r.MinRequiredSlopeDeg >= 5 {
		t.Fatal(r)
	}
	requireStatus(t, planFor(t, g, Coord{}, b, 15, nil), "out_of_bounds", "")
	modes := map[string]bool{}
	for _, route := range permissive.Routes {
		modes[route.Strategy] = true
	}
	if !modes["gentlest"] {
		t.Fatalf("missing distinct gentlest: %v", modes)
	}
}
func TestWeatherStrategyAndMetrics(t *testing.T) {
	d := grid(15, 15, make([]float64, 225))
	d.Meta.BBox = [4]float64{77.2, 18.4, 77.7, 18.9}
	temps, pressure := make([]float64, 225), make([]float64, 225)
	for r := 0; r < 15; r++ {
		for c := 0; c < 15; c++ {
			i := r*15 + c
			temps[i] = 260
			pressure[i] = 900
			if r <= 10 && c >= 4 && c <= 10 {
				temps[i] = 220
				pressure[i] = 600
			}
		}
	}
	g := graphFor(t, d)
	w := weatherFor(g, pressure, temps)
	w.MinPressurePa = 100
	w.ThermalWeight = 0.85
	a, b := g.CoordForCell(2, 1), g.CoordForCell(2, 13)
	r := planFor(t, g, a, b, 20, w)
	requireStatus(t, r, "ok", "")
	var thermal *Route
	for i := range r.Routes {
		if r.Routes[i].Strategy == "weather-safe" {
			thermal = &r.Routes[i]
		}
	}
	if thermal == nil || *thermal.MinPressurePa <= *r.Routes[0].MinPressurePa || thermal.TotalDistanceM <= r.Routes[0].TotalDistanceM {
		t.Fatalf("missing thermal detour: %+v", thermal)
	}
	if !r.WeatherApplied || r.AppliedLMSTHour == nil || *r.AppliedLMSTHour != 12 || thermal.Points[0].TempC == nil {
		t.Fatal(r)
	}
	w.MinPressurePa = 700
	r = planFor(t, g, a, b, 20, w)
	if *r.Routes[0].MinPressurePa < 700 {
		t.Fatal("crossed pressure barrier")
	}
	// A larger flat grid leaves room for a distinct penalized corridor.
	g = graphFor(t, grid(31, 31, make([]float64, 961)))
	r = planFor(t, g, g.CoordForCell(15, 0), g.CoordForCell(15, 30), 0, nil)
	found := false
	for _, route := range r.Routes {
		if route.Strategy == "alternate" {
			found = true
		}
	}
	if !found {
		t.Fatal("missing alternate corridor")
	}
}
func TestValidationAndMask(t *testing.T) {
	g := graphFor(t, grid(1, 2, []float64{0, 0.1}))
	a, b := g.CoordForCell(0, 0), g.CoordForCell(0, 1)
	requireStatus(t, planFor(t, g, a, b, 0, nil), "unreachable", "slope")
	for _, v := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
		if _, err := g.Plan(context.Background(), a, b, v, nil); err == nil {
			t.Fatal("accepted nonfinite slope")
		}
		if _, err := g.SlopeMask(context.Background(), v); err == nil {
			t.Fatal("accepted nonfinite mask limit")
		}
	}
	w := weatherFor(g, []float64{900, 900}, nil)
	w.ThermalWeight = math.NaN()
	if _, err := g.Plan(context.Background(), a, b, 10, w); err == nil {
		t.Fatal("accepted invalid weather")
	}
	w = weatherFor(g, []float64{900}, nil)
	if _, err := g.Plan(context.Background(), a, b, 10, w); err == nil {
		t.Fatal("accepted weather dimensions")
	}
	for _, d := range []Dataset{grid(0, 1, nil), grid(2, 2, []float64{0}), {Meta: Metadata{Rows: 2, Cols: 2}, ElevationsM: make([]float64, 4)}} {
		if _, err := NewGraph(d); err == nil {
			t.Fatal("accepted invalid grid")
		}
	}
	data, err := g.SlopeMask(context.Background(), 0)
	if err != nil {
		t.Fatal(err)
	}
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if got := color.NRGBAModel.Convert(img.At(0, 0)); got != (color.NRGBA{245, 158, 11, 175}) {
		t.Fatal(got)
	}
	flat := graphFor(t, grid(1, 2, []float64{0, 0}))
	data, err = flat.SlopeMask(context.Background(), 0)
	if err != nil {
		t.Fatal(err)
	}
	img, err = png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	_, _, _, alpha := img.At(0, 0).RGBA()
	if alpha != 0 {
		t.Fatal("flat masked")
	}
}
func TestConcurrentRequestsAndImmutableTerrain(t *testing.T) {
	d := ridgeDataset()
	g := graphFor(t, d)
	a, b := g.CoordForCell(2, 1), g.CoordForCell(2, 9)
	expected := planFor(t, g, a, b, 10, nil)
	d.ElevationsM[0] = 999
	g.Elevations[0] = 999
	g.Valid[0] = false
	g.Meta.Rows = 0
	if got := planFor(t, g, a, b, 10, nil); !reflect.DeepEqual(got, expected) {
		t.Fatal("public snapshots changed routing")
	}
	w := weatherFor(g, make([]float64, len(g.elevations)), nil)
	for i := range w.CellPressurePa {
		w.CellPressurePa[i] = 900
	}
	expectedWeather := planFor(t, g, a, b, 10, w)
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 3; j++ {
				got, err := g.Plan(context.Background(), a, b, 10, w)
				if err != nil || !reflect.DeepEqual(got, expectedWeather) {
					t.Errorf("concurrent plan mismatch: %v", err)
				}
				if _, err := g.SlopeMask(context.Background(), 10); err != nil {
					t.Error(err)
				}
			}
		}()
	}
	wg.Wait()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := g.Plan(ctx, a, b, 10, nil); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if _, err := g.SlopeMask(ctx, 10); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}
func TestJSONContract(t *testing.T) {
	g := graphFor(t, grid(1, 1, []float64{0}))
	r := planFor(t, g, Coord{}, Coord{}, 0, nil)
	b, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		t.Fatal(err)
	}
	if raw["weatherApplied"] != nil || raw["minRequiredSlopeDeg"] != nil || raw["snappedA"] == nil {
		t.Fatal(string(b))
	}
	r = planFor(t, g, Coord{1, 1}, Coord{}, 0, nil)
	b, err = json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(b, []byte(`"routes":[]`)) {
		t.Fatal(string(b))
	}
}

// Set PLANNER_TERRAIN_DATA to exercise the uncommitted real DEM without making
// the deterministic suite depend on a local download.
func TestRealTerrain(t *testing.T) {
	path := os.Getenv("PLANNER_TERRAIN_DATA")
	if path == "" {
		t.Skip("PLANNER_TERRAIN_DATA is not set")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var d Dataset
	if err := json.Unmarshal(data, &d); err != nil {
		t.Fatal(err)
	}
	g := graphFor(t, d)
	if g.ElevationAt(g.Meta.Center) == nil {
		t.Fatal("missing center elevation")
	}
	a, b := g.CoordForCell(100, 100), g.CoordForCell(900, 900)
	r := planFor(t, g, a, b, 30, nil)
	requireStatus(t, r, "ok", "")
	if r.Routes[0].TotalDistanceM < 15000 || r.Routes[0].MaxSlopeDeg > 30 {
		t.Fatal(r.Routes[0])
	}
	strict := planFor(t, g, a, b, 0.5, nil)
	requireStatus(t, strict, "unreachable", "slope")
	if strict.MinRequiredSlopeDeg == nil {
		t.Fatal("missing slope recommendation")
	}
	requireStatus(t, planFor(t, g, a, b, *strict.MinRequiredSlopeDeg, nil), "ok", "")
	t.Logf("real DEM %dx%d: distance %.1f m, required slope %.1f deg, candidates %d", g.meta.Rows, g.meta.Cols, r.Routes[0].TotalDistanceM, *strict.MinRequiredSlopeDeg, len(r.Routes))
}

// Cancel at a known polling point so cancellation tests do not depend on timing.
type cancelAfterChecks struct {
	context.Context
	cancel    context.CancelFunc
	remaining int
}

func (c *cancelAfterChecks) Err() error {
	c.remaining--
	if c.remaining == 0 {
		c.cancel()
	}
	return c.Context.Err()
}
func TestCancellationDuringWork(t *testing.T) {
	g := graphFor(t, grid(101, 101, make([]float64, 10201)))
	a, b := g.CoordForCell(0, 0), g.CoordForCell(100, 100)
	operations := map[string]func(context.Context) error{
		"plan scan": func(ctx context.Context) error { _, err := g.Plan(ctx, a, b, 10, nil); return err },
		"mask scan": func(ctx context.Context) error { _, err := g.SlopeMask(ctx, 10); return err },
		"astar search": func(ctx context.Context) error {
			_, err := g.astar(ctx, newSearch(len(g.elevations)), 0, len(g.elevations)-1, 10, "shortest", nil)
			return err
		},
		"minimax search": func(ctx context.Context) error {
			_, err := g.bottleneck(ctx, newSearch(len(g.elevations)), 0, len(g.elevations)-1, 10, nil, nil)
			return err
		},
	}
	for name, operation := range operations {
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			checks := 5
			if name == "astar search" || name == "minimax search" {
				checks = 30
			}
			observed := &cancelAfterChecks{Context: ctx, cancel: cancel, remaining: checks}
			if err := operation(observed); !errors.Is(err, context.Canceled) {
				t.Fatalf("cancellation was not propagated: %v", err)
			}
		})
	}
}
