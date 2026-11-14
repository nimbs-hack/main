package weather

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strings"

	"mars-console/api/internal/planner"
)

func validateSnapshot(s Snapshot) error {
	for _, f := range []Forecast{s.Forecast, s.NextSol} {
		if len(f.Hourly) != 24 {
			return fmt.Errorf("each forecast sol must have exactly 24 hourly points")
		}
		for i, h := range f.Hourly {
			if h.LMSTHour != float64(i) || !finite(h.TempK) || h.TempK <= 0 || !finite(h.PressurePa) || h.PressurePa <= 0 || !finite(h.WindSpeedMps) || h.WindSpeedMps < 0 || !finite(h.UVIndex) || h.UVIndex < 0 || !finite(h.SolarIrradianceWm2) || h.SolarIrradianceWm2 < 0 {
				return fmt.Errorf("invalid weather at hour %d", i)
			}
		}
		for _, v := range []float64{f.LsDeg, f.AirTemp.MinK, f.AirTemp.MaxK, f.Pressure.MinPa, f.Pressure.AvgPa, f.Pressure.SwingPa, f.Pressure.ReferenceElevationM, f.Wind.MaxMps, f.DustOpacityTau, f.Daylight.SunriseHour, f.Daylight.SunsetHour} {
			if !finite(v) {
				return fmt.Errorf("forecast contains non-finite values")
			}
		}
		if f.Daylight.SunriseHour < 0 || f.Daylight.SunsetHour > 24 || f.Daylight.SunriseHour > f.Daylight.SunsetHour || f.Pressure.SwingPa < 0 {
			return fmt.Errorf("invalid daylight or pressure swing")
		}
	}
	if !finite(s.Site.MinElevationM) || !finite(s.Site.MaxElevationM) || s.Site.MinElevationM > s.Site.MaxElevationM {
		return fmt.Errorf("invalid site elevation bounds")
	}
	return nil
}

type walkPoint struct{ hours, elevation float64 }

func walkProfile(s Snapshot, o EvaluateOptions, l Limits) ([]walkPoint, float64, float64, float64, error) {
	floor, rim := s.Site.MinElevationM, s.Site.MaxElevationM
	if o.ElevationM != nil {
		rim = *o.ElevationM
	}
	duration := l.MaxEvaHours
	r := o.Route
	if r != nil {
		if len(r.Points) > 100000 {
			return nil, 0, 0, 0, fmt.Errorf("route exceeds 100000 vertices")
		}
		for _, v := range []float64{r.TotalDistanceM, r.ElevationGainM, r.ElevationLossM} {
			if !finite(v) || v < 0 {
				return nil, 0, 0, 0, fmt.Errorf("route distance, gain and loss must be finite and nonnegative")
			}
		}
		if len(r.Points) == 1 {
			return nil, 0, 0, 0, fmt.Errorf("route requires at least two vertices")
		}
		if len(r.Points) >= 2 {
			floor, rim = math.Inf(1), math.Inf(-1)
			for i, p := range r.Points {
				if !finite(p.DistanceM) || !finite(p.ElevationM) || math.Abs(p.ElevationM) > 100000 || p.DistanceM < 0 || (i > 0 && p.DistanceM < r.Points[i-1].DistanceM) {
					return nil, 0, 0, 0, fmt.Errorf("invalid route vertex %d", i)
				}
				floor = math.Min(floor, p.ElevationM)
				rim = math.Max(rim, p.ElevationM)
			}
		}
		if r.MinElevationM != nil {
			floor = *r.MinElevationM
		}
		if r.MaxElevationM != nil {
			rim = *r.MaxElevationM
		}
		duration = planner.WalkHours(r.TotalDistanceM, r.ElevationGainM, r.ElevationLossM)
	}
	if !finite(floor) || !finite(rim) || math.Abs(floor) > 100000 || math.Abs(rim) > 100000 || floor > rim {
		return nil, 0, 0, 0, fmt.Errorf("invalid route elevation bounds")
	}
	if r != nil && len(r.Points) >= 2 {
		pts := make([]walkPoint, len(r.Points))
		pts[0] = walkPoint{0, r.Points[0].ElevationM}
		floor = math.Min(floor, pts[0].elevation)
		rim = math.Max(rim, pts[0].elevation)
		for i := 1; i < len(pts); i++ {
			a, b := r.Points[i-1], r.Points[i]
			delta := b.ElevationM - a.ElevationM
			pts[i] = walkPoint{pts[i-1].hours + planner.WalkHours(b.DistanceM-a.DistanceM, math.Max(0, delta), math.Max(0, -delta)), b.ElevationM}
			floor = math.Min(floor, b.ElevationM)
			rim = math.Max(rim, b.ElevationM)
		}
		duration = pts[len(pts)-1].hours
		if duration <= 0 {
			duration = 0.25
			for i := range pts {
				pts[i].hours = float64(i) / float64(len(pts)-1) * duration
			}
		}
		return pts, duration, floor, rim, nil
	}
	duration = math.Max(0.25, duration)
	return []walkPoint{{0, floor}, {duration / 2, rim}, {duration, floor}}, duration, floor, rim, nil
}
func elevationAt(pts []walkPoint, t float64) float64 {
	i := sort.Search(len(pts), func(i int) bool { return pts[i].hours >= t })
	if i == 0 {
		return pts[0].elevation
	}
	if i == len(pts) {
		return pts[i-1].elevation
	}
	a, b := pts[i-1], pts[i]
	if b.hours == a.hours {
		return math.Max(a.elevation, b.elevation)
	}
	return a.elevation + (b.elevation-a.elevation)*(t-a.hours)/(b.hours-a.hours)
}
func priority(s Status) int {
	if s == Go {
		return 0
	}
	if s == Degraded {
		return 1
	}
	return 2
}
func check(id string, value, limit float64, unit string, lower bool, caution float64) Check {
	c := Check{ID: id, Status: Go, MeasuredValue: value, LimitValue: limit, Unit: unit, Margin: limit - value}
	if lower {
		c.Margin = value - limit
		if value < limit {
			c.Status = NoGo
		} else if value < caution {
			c.Status = Degraded
		}
	} else {
		if value > limit {
			c.Status = NoGo
		} else if value > caution {
			c.Status = Degraded
		}
	}
	c.Reason = fmt.Sprintf("%s %.4g %s; limit %.4g %s", id, value, unit, limit, unit)
	return c
}

// Evaluate computes the daily checks and half-LMST-hour departure slots by
// default. Limits must be a complete value; start with DefaultLimits to apply
// partial HTTP overrides. MaxEvaHours accepts up to 12 Earth hours; the default is four.
func Evaluate(s Snapshot, o EvaluateOptions) (Evaluation, error) {
	return EvaluateContext(context.Background(), s, o)
}

// EvaluateContext also supports cancellation between departure calculations.
func EvaluateContext(ctx context.Context, s Snapshot, o EvaluateOptions) (Evaluation, error) {
	if err := ctx.Err(); err != nil {
		return Evaluation{}, err
	}
	if err := validateSnapshot(s); err != nil {
		return Evaluation{}, err
	}
	if !finite(o.LMSTHour) || o.LMSTHour < 0 || o.LMSTHour > 48 {
		return Evaluation{}, fmt.Errorf("lmstHour must be in [0,48]")
	}
	l := DefaultLimits()
	if o.Limits != nil {
		l = *o.Limits
	}
	for _, v := range []float64{l.MinAirTempK, l.MaxWindSpeedMps, l.MinPressurePa, l.MaxPressureSwingPa, l.MaxEvaHours} {
		if !finite(v) || v < 0 {
			return Evaluation{}, fmt.Errorf("limits must be finite and non-negative")
		}
	}
	if l.MinAirTempK <= 0 || l.MaxEvaHours <= 0 {
		return Evaluation{}, fmt.Errorf("minimum temperature and maxEvaHours must be positive")
	}
	if l.MaxEvaHours > 12 {
		return Evaluation{}, fmt.Errorf("maxEvaHours cannot exceed 12 Earth hours")
	}
	step := o.StepHours
	if step == 0 {
		step = 0.5
	}
	if !finite(step) || step < 0.25 || step > 4 {
		return Evaluation{}, fmt.Errorf("stepHours must be in [0.25,4] LMST hours")
	}
	pts, duration, floor, rim, err := walkProfile(s, o, l)
	if err != nil {
		return Evaluation{}, err
	}
	e := Evaluation{Status: Go, IsSimulated: true, Limits: l, EstimatedRouteHours: duration, FloorElevationM: floor, EvaluationElevationM: rim, SelectedHourWeather: sample(s, o.LMSTHour), DepartureSlots: []DepartureSlot{}, RecommendedWindows: []Recommendation{}}
	var thermalHours float64
	e.SafeWindow, thermalHours = safeWindow(s, rim, l)
	ref := s.Pressure.ReferenceElevationM
	minTemp := LapseTempByElevation(s.AirTemp.MinK, rim, ref)
	maxTemp := LapseTempByElevation(s.AirTemp.MaxK, rim, ref)
	tempCheck := check("air_temp", minTemp, l.MinAirTempK, "K", true, l.MinAirTempK+5)
	tempCheck.Status = Go
	if maxTemp < l.MinAirTempK || thermalHours < duration {
		tempCheck.Status = NoGo
	} else if minTemp < l.MinAirTempK {
		tempCheck.Status = Degraded
	}
	e.Checks = []Check{tempCheck, check("wind_speed", s.Wind.MaxMps, l.MaxWindSpeedMps, "m/s", false, l.MaxWindSpeedMps*0.8), check("pressure", ScalePressureByElevation(s.Pressure.MinPa, rim, ref), l.MinPressurePa, "Pa", true, l.MinPressurePa*1.04), check("pressure_swing", ScalePressureByElevation(s.Pressure.SwingPa, rim, ref), l.MaxPressureSwingPa, "Pa", false, l.MaxPressureSwingPa*0.85), check("eva_duration", duration, l.MaxEvaHours, "h", false, l.MaxEvaHours)}
	dc := &e.Checks[4]
	if e.SafeWindow.DurationHours < duration {
		dc.Status = NoGo
		dc.Reason = "Thermal and wind window shorter than walk"
	} else if dc.Status == Go && e.SafeWindow.DurationHours < duration+1 {
		dc.Status = Degraded
		dc.Reason = "Less than one Earth hour of window margin"
	}
	for _, c := range e.Checks {
		if priority(c.Status) > priority(e.Status) {
			e.Status = c.Status
		}
	}
	for offset := 0.0; offset < 48; offset += step {
		if err := ctx.Err(); err != nil {
			return Evaluation{}, err
		}
		e.DepartureSlots = append(e.DepartureSlots, departure(s, pts, duration, floor, offset, l))
	}
	e.RecommendedWindows = recommend(e.DepartureSlots, duration)
	e.Summary = fmt.Sprintf("%s: %.2f Earth-hour walk, %.2f h suit limit. Simulated weather.", e.Status, duration, l.MaxEvaHours)
	return e, nil
}
func departure(s Snapshot, pts []walkPoint, duration, floor, offset float64, l Limits) DepartureSlot {
	walkLMST := duration / EarthHoursPerLMSTHour
	end := math.Min(48, offset+walkLMST)
	solOff := int(offset / 24)
	f := s.Forecast
	if solOff == 1 {
		f = s.NextSol
	}
	slot := DepartureSlot{OffsetHours: offset, Sol: f.Sol, SolOffset: solOff, StartLMSTHour: wrap(offset, 24), EndLMSTHour: wrap(end, 24), StartLMSTLabel: clockLabel(wrap(offset, 24)), EndLMSTLabel: clockLabel(wrap(end, 24)), DurationHours: duration, Status: Go, MinEncounteredTempK: math.Inf(1), MinEncounteredPressurePa: math.Inf(1), Reasons: []string{}}
	if end == 48 {
		slot.EndLMSTHour = 24
		slot.EndLMSTLabel = "24:00"
	}
	for i, f := range []Forecast{s.Forecast, s.NextSol} {
		rise, set := daylightBounds(f.Daylight)
		startDay := float64(i)*24 + rise
		endDay := float64(i)*24 + set
		slot.DaylightFraction += math.Max(0, math.Min(end, endDay)-math.Max(offset, startDay)) / walkLMST
	}
	slot.DaylightFraction = math.Min(1, slot.DaylightFraction)
	visit := func(t, elev float64) {
		w := sample(s, math.Min(48, offset+t/EarthHoursPerLMSTHour))
		temp := LapseTempByElevation(w.TempK, elev, w.ReferenceElevationM)
		p := ScalePressureByElevation(w.PressurePa, elev, w.ReferenceElevationM)
		slot.MinEncounteredTempK = math.Min(slot.MinEncounteredTempK, temp)
		slot.MaxEncounteredTempK = math.Max(slot.MaxEncounteredTempK, temp)
		slot.MinEncounteredPressurePa = math.Min(slot.MinEncounteredPressurePa, p)
		slot.MaxEncounteredWindMps = math.Max(slot.MaxEncounteredWindMps, w.WindSpeedMps)
		slot.MaxUVIndex = math.Max(slot.MaxUVIndex, w.UVIndex)
	}
	// Retain every vertex, including narrow peaks between regular walk samples.
	for _, p := range pts {
		visit(p.hours, p.elevation)
	}
	steps := int(clamp(math.Ceil(duration/0.25), 8, 64))
	for i := 0; i <= steps; i++ {
		t := float64(i) / float64(steps) * duration
		visit(t, elevationAt(pts, t))
	}
	for h := math.Floor(offset) + 1; h < end; h++ {
		t := (h - offset) * EarthHoursPerLMSTHour
		visit(t, elevationAt(pts, t))
	}
	swing := ScalePressureByElevation(f.Pressure.SwingPa, floor, f.Pressure.ReferenceElevationM)
	tau := f.DustOpacityTau
	if end > 24 {
		swing = math.Max(swing, ScalePressureByElevation(s.NextSol.Pressure.SwingPa, floor, s.NextSol.Pressure.ReferenceElevationM))
		tau = math.Max(tau, s.NextSol.DustOpacityTau)
	}
	checks := []Check{check("walk duration", duration, l.MaxEvaHours, "h", false, l.MaxEvaHours), check("temperature", slot.MinEncounteredTempK, l.MinAirTempK, "K", true, l.MinAirTempK+5), check("pressure", slot.MinEncounteredPressurePa, l.MinPressurePa, "Pa", true, l.MinPressurePa*1.04), check("wind", slot.MaxEncounteredWindMps, l.MaxWindSpeedMps, "m/s", false, l.MaxWindSpeedMps*0.8), check("baro swing", swing, l.MaxPressureSwingPa, "Pa", false, l.MaxPressureSwingPa*0.85)}
	addReason := func(status Status, reason string) {
		if priority(status) > priority(slot.Status) {
			slot.Status = status
		}
		slot.Reasons = append(slot.Reasons, reason)
	}
	for _, c := range checks {
		if c.Status != Go {
			addReason(c.Status, c.Reason)
		}
	}
	if slot.DaylightFraction < 0.5 {
		addReason(NoGo, fmt.Sprintf("only %.1f%% daylight", slot.DaylightFraction*100))
	} else if slot.DaylightFraction < 1-1e-12 {
		addReason(Degraded, fmt.Sprintf("%.1f%% daylight", slot.DaylightFraction*100))
	}
	if tau > 1.5 {
		addReason(Degraded, fmt.Sprintf("high dust tau %.2f", tau))
	}
	if offset+walkLMST > 48 {
		addReason(NoGo, "exceeds 48 h LMST forecast horizon")
	}
	marginScore := func(margin, good, bad float64) float64 {
		if margin >= 0 {
			return 0.5 + 0.5*math.Min(1, margin/good)
		}
		return math.Max(0, 0.4*(1+margin/bad))
	}
	ts := marginScore(slot.MinEncounteredTempK-l.MinAirTempK, 30, 30)
	ps := marginScore(slot.MinEncounteredPressurePa-l.MinPressurePa, 120, 100)
	ws := marginScore(l.MaxWindSpeedMps-slot.MaxEncounteredWindMps, math.Max(4, l.MaxWindSpeedMps*0.6), 10)
	ds := clamp(1-math.Max(0, tau-0.35)*0.32, 0.1, 1)
	score := 100 * (0.3*ts + 0.25*slot.DaylightFraction + 0.2*ws + 0.15*ps + 0.1*ds)
	if swing > l.MaxPressureSwingPa {
		score *= 0.85
	}
	if duration > l.MaxEvaHours {
		score *= 0.75
	}
	switch slot.Status {
	case Go:
		score = clamp(score, 70, 100)
	case Degraded:
		score = clamp(score*0.88, 35, 79)
	case NoGo:
		score = clamp(score*0.65, 0, 48)
	}
	slot.Score = round(score, 1)
	slot.Reason = strings.Join(slot.Reasons, "; ")
	if slot.Reason == "" {
		slot.Reason = "Within modeled weather limits; 100% daylight"
	}
	return slot
}
func recommend(slots []DepartureSlot, duration float64) []Recommendation {
	out := []Recommendation{}
	for i := 0; i < len(slots); {
		first := slots[i]
		j := i + 1
		for j < len(slots) && slots[j].Sol == first.Sol && slots[j].Status == first.Status {
			j++
		}
		if first.Status != NoGo {
			best := first
			midpoint := (first.OffsetHours + slots[j-1].OffsetHours) / 2
			for _, c := range slots[i:j] {
				if c.Score > best.Score+0.05 || (math.Abs(c.Score-best.Score) <= 0.05 && math.Abs(c.OffsetHours-midpoint) < math.Abs(best.OffsetHours-midpoint)) {
					best = c
				}
			}
			out = append(out, Recommendation{Status: first.Status, Sol: first.Sol, StartOffsetHours: first.OffsetHours, EndOffsetHours: slots[j-1].OffsetHours, BestDepartureOffsetHours: best.OffsetHours, BestDepartureLMST: best.StartLMSTLabel, EstimatedDurationHours: duration, Score: best.Score, Summary: best.Reason})
		}
		i = j
	}
	// Blocked slots remain visible in DepartureSlots, but are not recommendations.
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Status != b.Status {
			return priority(a.Status) < priority(b.Status)
		}
		if a.Score != b.Score {
			return a.Score > b.Score
		}
		sa, sb := a.EndOffsetHours-a.StartOffsetHours, b.EndOffsetHours-b.StartOffsetHours
		if sa != sb {
			return sa > sb
		}
		return a.StartOffsetHours < b.StartOffsetHours
	})
	if len(out) > 4 {
		out = out[:4]
	}
	for i := range out {
		out[i].Rank = i + 1
	}
	return out
}
func safeWindow(s Snapshot, elevation float64, l Limits) (SafeWindow, float64) {
	type interval struct{ start, end float64 }
	runs := []interval{}
	thermal := 0.0
	for hour := 0.0; hour < 24; hour++ {
		a, b := sample(s, hour), sample(s, hour+1)
		rise, set := daylightBounds(s.Daylight)
		start, end := math.Max(hour, rise), math.Min(hour+1, set)
		clip := func(a, b, minimum float64) {
			if a < minimum && b < minimum {
				end = start
			} else if a < minimum {
				start = math.Max(start, hour+(minimum-a)/(b-a))
			} else if b < minimum {
				end = math.Min(end, hour+(minimum-a)/(b-a))
			}
		}
		clip(LapseTempByElevation(a.TempK, elevation, a.ReferenceElevationM), LapseTempByElevation(b.TempK, elevation, b.ReferenceElevationM), l.MinAirTempK)
		thermal += math.Max(0, end-start) * EarthHoursPerLMSTHour
		clip(-a.WindSpeedMps, -b.WindSpeedMps, -l.MaxWindSpeedMps)
		if end <= start {
			continue
		}
		if len(runs) > 0 && math.Abs(runs[len(runs)-1].end-start) < 1e-9 {
			runs[len(runs)-1].end = end
		} else {
			runs = append(runs, interval{start, end})
		}
	}
	w := SafeWindow{Note: "No daylight interval meets thermal and wind limits"}
	for _, r := range runs {
		d := (r.end - r.start) * EarthHoursPerLMSTHour
		if d > w.DurationHours {
			start, end := r.start, r.end
			w = SafeWindow{&start, &end, d, "Thermal and wind window only; see departure slots for pressure and route checks"}
		}
	}
	return w, thermal
}
