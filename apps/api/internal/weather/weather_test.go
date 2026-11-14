package weather

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"reflect"
	"strings"
	"testing"
)

func testGrid() Grid {
	return Grid{Rows: 2, Cols: 2, BBox: [4]float64{77.442, 18.661, 77.448, 18.667}, Elevations: []float64{-2500, -2500, -2500, -2500}, ReferenceElevationM: -2500, ID: "jezero", Name: "Jezero"}
}
func mustGenerate(t *testing.T) Snapshot {
	t.Helper()
	ls := 90.0
	s, err := Generate(testGrid(), Options{Sol: 100, LsDeg: &ls})
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func constantWeather(t *testing.T) Snapshot {
	s := mustGenerate(t)
	s.Site.MinElevationM = 0
	s.Site.MaxElevationM = 0
	for _, f := range []*Forecast{&s.Forecast, &s.NextSol} {
		f.AirTemp = AirTemp{250, 250, 250}
		f.Pressure = Pressure{1000, 1000, 1000, 0, 0}
		f.Wind = Wind{MinMps: 1, AvgMps: 1, MaxMps: 1}
		f.Daylight = Daylight{SunriseHour: 0, SunsetHour: 24}
		for i := range f.Hourly {
			f.Hourly[i].TempK = 250
			f.Hourly[i].PressurePa = 1000
			f.Hourly[i].WindSpeedMps = 1
			f.Hourly[i].IsDaylight = true
		}
	}
	return s
}
func evaluate(t *testing.T, s Snapshot, o EvaluateOptions) Evaluation {
	t.Helper()
	e, err := Evaluate(s, o)
	if err != nil {
		t.Fatal(err)
	}
	return e
}
func closeTo(t *testing.T, label string, got, want, tolerance float64) {
	t.Helper()
	if math.Abs(got-want) > tolerance {
		t.Errorf("%s: got %.10f want %.10f tolerance %g", label, got, want, tolerance)
	}
}

func TestReviewedTSParity(t *testing.T) {
	data, err := os.ReadFile("testdata/parity.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Grid  Grid `json:"grid"`
		Cases []struct {
			Scenario string   `json:"scenario"`
			Weather  Snapshot `json:"weather"`
			Fields   []struct {
				LMSTHour   float64   `json:"lmstHour"`
				TempK      []float64 `json:"tempK"`
				PressurePa []float64 `json:"pressurePa"`
			} `json:"fields"`
			Evaluation struct {
				Status              Status  `json:"status"`
				EstimatedRouteHours float64 `json:"estimatedRouteHours"`
				DepartureSlots      []struct {
					Status           Status  `json:"status"`
					Reason           string  `json:"reason"`
					MinTempC         float64 `json:"minEncounteredTempC"`
					PressurePa       float64 `json:"minEncounteredPressurePa"`
					WindMps          float64 `json:"maxEncounteredWindMps"`
					DaylightFraction float64 `json:"daylightFraction"`
				} `json:"departureSlots"`
			} `json:"evaluation"`
		} `json:"cases"`
	}
	if err = json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	ls := 137.0
	for _, c := range fixture.Cases {
		t.Run(c.Scenario, func(t *testing.T) {
			opts := Options{Sol: 1859, LsDeg: &ls, Scenario: c.Scenario, LMSTHour: 12}
			s, err := Generate(fixture.Grid, opts)
			if err != nil {
				t.Fatal(err)
			}
			for j, pair := range [][2]Forecast{{s.Forecast, c.Weather.Forecast}, {s.NextSol, c.Weather.NextSol}} {
				a, b := pair[0], pair[1]
				closeTo(t, "dust", a.DustOpacityTau, b.DustOpacityTau, 1e-9)
				closeTo(t, "pressure mean", a.Pressure.AvgPa, b.Pressure.AvgPa, 1e-9)
				closeTo(t, "pressure swing", a.Pressure.SwingPa, b.Pressure.SwingPa, 1e-9)
				for i, h := range a.Hourly {
					want := b.Hourly[i]
					closeTo(t, "hourly temperature", h.TempK, want.TempK, 1e-9)
					closeTo(t, "hourly pressure", h.PressurePa, want.PressurePa, 1e-9)
					closeTo(t, "hourly wind", h.WindSpeedMps, want.WindSpeedMps, 1e-9)
					closeTo(t, "hourly irradiance", h.SolarIrradianceWm2, want.SolarIrradianceWm2, 1e-9)
					closeTo(t, "hourly UV", h.UVIndex, want.UVIndex, 1e-9)
					if h.IsDaylight != want.IsDaylight {
						t.Errorf("sol %d hour %d daylight differs", j, i)
					}
				}
			}
			for _, want := range c.Fields {
				opts.LMSTHour = want.LMSTHour
				f, err := ComputeField(fixture.Grid, opts)
				if err != nil {
					t.Fatal(err)
				}
				for i := range f.TempK {
					closeTo(t, "field temperature", f.TempK[i], want.TempK[i], 0.002)
					closeTo(t, "field pressure", f.PressurePa[i], want.PressurePa[i], 0.0002)
				}
			}
			e := evaluate(t, s, EvaluateOptions{LMSTHour: 12, Route: &Route{Points: []RoutePoint{{0, -2500}, {500, -2450}, {1200, -2510}}}})
			if e.Status != c.Evaluation.Status {
				t.Errorf("daily status got %s want %s", e.Status, c.Evaluation.Status)
			}
			closeTo(t, "walk duration", e.EstimatedRouteHours, c.Evaluation.EstimatedRouteHours, 1e-9)
			if len(e.DepartureSlots) != len(c.Evaluation.DepartureSlots) {
				t.Fatal("slot count differs")
			}
			for i, slot := range e.DepartureSlots {
				want := c.Evaluation.DepartureSlots[i]
				if slot.Status != want.Status && !(slot.Status == Go && want.Status == Degraded && want.Reason == "100% daylight.") {
					t.Errorf("slot %d status got %s want %s", i, slot.Status, want.Status)
				}
				closeTo(t, "slot temperature", slot.MinEncounteredTempK-273.15, want.MinTempC, 1e-8)
				closeTo(t, "slot pressure", slot.MinEncounteredPressurePa, want.PressurePa, 1e-8)
				closeTo(t, "slot wind", slot.MaxEncounteredWindMps, want.WindMps, 1e-8)
				closeTo(t, "slot daylight", slot.DaylightFraction, want.DaylightFraction, 1e-10)
			}
		})
	}
}
func TestReproducibilityAndProvenance(t *testing.T) {
	s := mustGenerate(t)
	again := mustGenerate(t)
	if !reflect.DeepEqual(s, again) {
		t.Fatal("generation changed for identical inputs")
	}
	if !s.IsSimulated || s.SourceType != "simulated" || len(s.RealChannels) != 0 || s.Disclaimer == "" {
		t.Fatal("missing simulation provenance")
	}
	for _, v := range []interface{}{s, evaluate(t, s, EvaluateOptions{})} {
		if _, err := json.Marshal(v); err != nil {
			t.Fatal(err)
		}
	}
	landing, err := Generate(testGrid(), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if landing.TerrestrialDate != "2021-02-18" {
		t.Fatal(landing.TerrestrialDate)
	}
}
func TestReviewedSafetyFixes(t *testing.T) {
	t.Run("Earth hours and forecast horizon", func(t *testing.T) {
		e := evaluate(t, constantWeather(t), EvaluateOptions{Route: &Route{TotalDistanceM: 10000}, StepHours: 1})
		closeTo(t, "arrival", e.DepartureSlots[12].EndLMSTHour, 12+4/EarthHoursPerLMSTHour, 1e-10)
		if e.DepartureSlots[45].Status != NoGo || !strings.Contains(e.DepartureSlots[45].Reason, "forecast horizon") {
			t.Fatal(e.DepartureSlots[45])
		}
		for _, r := range e.RecommendedWindows {
			if r.EndOffsetHours > 44 {
				t.Fatal("recommended departure beyond forecast coverage")
			}
		}
	})
	t.Run("unrounded thresholds", func(t *testing.T) {
		s := constantWeather(t)
		for i := range s.Hourly {
			s.Hourly[i].PressurePa = 649.96
		}
		if evaluate(t, s, EvaluateOptions{}).DepartureSlots[0].Status != NoGo {
			t.Fatal("pressure rounded to pass")
		}
		e := evaluate(t, constantWeather(t), EvaluateOptions{Route: &Route{TotalDistanceM: 10010}})
		if e.Checks[4].Status != NoGo {
			t.Fatal("duration rounded to pass")
		}
	})
	t.Run("hourly knots", func(t *testing.T) {
		s := constantWeather(t)
		s.Hourly[1].WindSpeedMps = 15.01
		slot := evaluate(t, s, EvaluateOptions{Route: &Route{TotalDistanceM: 10000}}).DepartureSlots[0]
		if slot.Status != NoGo || slot.MaxEncounteredWindMps != 15.01 {
			t.Fatal(slot)
		}
	})
	t.Run("all route vertices", func(t *testing.T) {
		points := make([]RoutePoint, 201)
		for i := range points {
			points[i].DistanceM = float64(i) * 10
		}
		points[1].ElevationM = 600
		l := DefaultLimits()
		l.MinAirTempK = 249.15
		e := evaluate(t, constantWeather(t), EvaluateOptions{Route: &Route{Points: points}, Limits: &l})
		closeTo(t, "isolated peak", e.DepartureSlots[0].MinEncounteredTempK, 248.5, 1e-10)
		if e.DepartureSlots[0].Status != NoGo {
			t.Fatal("peak missed")
		}
	})
	t.Run("thermal crossings", func(t *testing.T) {
		s := constantWeather(t)
		s.Daylight.SunriseHour = 6.5
		s.Daylight.SunsetHour = 18.5
		for i := range s.Hourly {
			s.Hourly[i].TempK = 230
		}
		s.Hourly[12].TempK = 250
		l := DefaultLimits()
		l.MinAirTempK = 240
		e := evaluate(t, s, EvaluateOptions{Limits: &l, Route: &Route{TotalDistanceM: 2500}})
		if e.SafeWindow.StartLMSTHour == nil || e.SafeWindow.EndLMSTHour == nil {
			t.Fatal(e.SafeWindow)
		}
		closeTo(t, "start", *e.SafeWindow.StartLMSTHour, 11.5, 1e-10)
		closeTo(t, "end", *e.SafeWindow.EndLMSTHour, 12.5, 1e-10)
		closeTo(t, "duration", e.SafeWindow.DurationHours, EarthHoursPerLMSTHour, 1e-10)
	})
	t.Run("elapsed daylight", func(t *testing.T) {
		s := constantWeather(t)
		s.Daylight.SunriseHour = 6.5
		s.Daylight.SunsetHour = 18.5
		e := evaluate(t, s, EvaluateOptions{Route: &Route{TotalDistanceM: 2500 * EarthHoursPerLMSTHour}, StepHours: 1})
		closeTo(t, "daylight", e.DepartureSlots[6].DaylightFraction, 0.5, 1e-10)
	})
	t.Run("next sol swing", func(t *testing.T) {
		s := constantWeather(t)
		s.NextSol.Pressure.SwingPa = 100
		e := evaluate(t, s, EvaluateOptions{Route: &Route{TotalDistanceM: 5000}, StepHours: 1})
		if !strings.Contains(e.DepartureSlots[23].Reason, "baro swing") || e.DepartureSlots[23].Status != NoGo {
			t.Fatal(e.DepartureSlots[23])
		}
	})
}
func TestFieldValidationAndCancellation(t *testing.T) {
	g := testGrid()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := ComputeFieldContext(ctx, g, Options{}); err != context.Canceled {
		t.Fatal(err)
	}
	g.Valid = []bool{false, true, true, true}
	g.Elevations[0] = math.NaN()
	f, err := ComputeField(g, Options{LMSTHour: 12})
	if err != nil {
		t.Fatal(err)
	}
	if f.TempK[0] != 0 || f.PressurePa[0] != 0 || f.ValidCount != 3 {
		t.Fatal("nodata was not excluded")
	}
	if _, err := json.Marshal(f); err != nil {
		t.Fatal(err)
	}
	g.Valid = nil
	if _, err := ComputeField(g, Options{}); err == nil {
		t.Fatal("accepted valid NaN elevation")
	}
	g = testGrid()
	g.Rows = 4000001
	if _, err := ComputeField(g, Options{}); err == nil {
		t.Fatal("accepted oversized grid")
	}
	if _, err := SampleAt(mustGenerate(t), 48.01); err == nil {
		t.Fatal("extrapolated beyond horizon")
	}
}
func BenchmarkMillionCellField(b *testing.B) {
	g := testGrid()
	g.Rows = 1000
	g.Cols = 1000
	g.Elevations = make([]float64, 1000000)
	for i := range g.Elevations {
		g.Elevations[i] = -2500 + float64(i%100)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := ComputeField(g, Options{Sol: 1859, LMSTHour: 12}); err != nil {
			b.Fatal(err)
		}
	}
}

func TestSiteReferenceElevations(t *testing.T) {
	ls := 137.0
	jezero, err := Generate(testGrid(), Options{Sol: 1859, LsDeg: &ls})
	if err != nil {
		t.Fatal(err)
	}
	g := testGrid()
	g.ID = "mount-sharp"
	g.BBox = [4]float64{137.157, -4.813, 137.163, -4.807}
	g.ReferenceElevationM = -4500
	for i := range g.Elevations {
		g.Elevations[i] = -4500
	}
	gale, err := Generate(g, Options{Sol: 1859, LsDeg: &ls})
	if err != nil {
		t.Fatal(err)
	}
	closeTo(t, "Gale pressure", gale.Pressure.AvgPa, ScalePressureByElevation(jezero.Pressure.AvgPa, -4500, -2500), 0.01)
	if gale.Site.ReferenceElevationM != -4500 || gale.Pressure.ReferenceElevationM != -4500 {
		t.Fatal("reference elevation was replaced")
	}
}

func TestRejectInvalidEvaluationInputs(t *testing.T) {
	s := constantWeather(t)
	l := DefaultLimits()
	l.MaxEvaHours = 12.001
	if _, err := Evaluate(s, EvaluateOptions{Limits: &l}); err == nil {
		t.Fatal("allowed suit duration above 12 hours")
	}
	if _, err := Evaluate(s, EvaluateOptions{Route: &Route{Points: []RoutePoint{{10, 0}, {9, 0}}}}); err == nil {
		t.Fatal("accepted decreasing distances")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := EvaluateContext(ctx, s, EvaluateOptions{}); err != context.Canceled {
		t.Fatal(err)
	}
	s.Hourly[0].TempK = math.NaN()
	if _, err := Evaluate(s, EvaluateOptions{}); err == nil {
		t.Fatal("accepted invalid forecast")
	}
}

func TestConfigurableEVADuration(t *testing.T) {
	s := constantWeather(t)
	route := &Route{TotalDistanceM: 30000}
	defaults := evaluate(t, s, EvaluateOptions{Route: route})
	if defaults.Checks[4].Status != NoGo {
		t.Fatal("12-hour walk passed default four-hour limit")
	}
	limits := DefaultLimits()
	limits.MaxEvaHours = 12
	expanded := evaluate(t, s, EvaluateOptions{Route: route, Limits: &limits, StepHours: 1})
	if expanded.Checks[4].Status != Go || expanded.DepartureSlots[0].Status != Go {
		t.Fatal("12-hour walk failed configured 12-hour limit")
	}
	closeTo(t, "12-hour LMST conversion", expanded.DepartureSlots[0].EndLMSTHour, 12/EarthHoursPerLMSTHour, 1e-10)
	if expanded.DepartureSlots[37].Status != NoGo {
		t.Fatal("12-hour walk crossed forecast horizon")
	}
	over := evaluate(t, s, EvaluateOptions{Route: &Route{TotalDistanceM: 30001}, Limits: &limits})
	if over.Checks[4].Status != NoGo {
		t.Fatal("duration comparison rounded away a limit violation")
	}
	example := evaluate(t, s, EvaluateOptions{Limits: &limits})
	if example.EstimatedRouteHours != 12 {
		t.Fatal("example EVA ignored configured duration")
	}
}
