package planner

import (
	"context"
	"fmt"
	"math"
)

func overlap(a, b []int) float64 {
	set := make(map[int]bool, len(b))
	for _, i := range b {
		set[i] = true
	}
	shared := 0
	for _, i := range a {
		if set[i] {
			shared++
		}
	}
	return float64(shared) / float64(max(1, min(len(a), len(b))))
}

// WalkHours is the suited walking-time model shared with the EVA evaluator:
// 2.5 km/h on the flat, plus one hour per 350 m climbed and 800 m descended.
// These rates are planning assumptions, not measured suit performance.
func WalkHours(distanceM, gainM, lossM float64) float64 {
	return distanceM/2500 + gainM/350 + lossM/800
}

func (g *Graph) summary(ctx context.Context, mode, label string, path []int, w *weatherContext) (Route, error) {
	route := Route{ID: "route-" + mode, Label: label, Strategy: mode, Points: make([]RoutePoint, 0, len(path))}
	distance, gain, loss, maxSlope, weighted := 0.0, 0.0, 0.0, 0.0, 0.0
	minT, maxT, minP, maxP := math.Inf(1), math.Inf(-1), math.Inf(1), math.Inf(-1)
	for i, u := range path {
		if err := ctx.Err(); err != nil {
			return Route{}, err
		}
		r, c := u/g.meta.Cols, u%g.meta.Cols
		coord := g.CoordForCell(r, c)
		slope := 0.0
		if i > 0 {
			v := path[i-1]
			dist := math.Hypot(float64(r-v/g.meta.Cols)*g.dy, float64(c-v%g.meta.Cols)*g.dx)
			dh := g.elevations[u] - g.elevations[v]
			if dh > 0 {
				gain += dh
			} else {
				loss -= dh
			}
			slope = g.slope(v, u, dist)
			maxSlope = math.Max(maxSlope, slope)
			weighted += slope * dist
			distance += dist
		}
		point := RoutePoint{Coord: Coord{rounded(coord.Lat, 1e6), rounded(coord.Lon, 1e6)}, ElevationM: rounded(g.elevations[u], 100), DistanceM: rounded(distance, 10), SlopeDeg: rounded(slope, 100)}
		if w != nil {
			t, p := rounded(w.temperature[u]-273.15, 100), rounded(w.pressure[u], 100)
			point.TempC, point.PressurePa = ptr(t), ptr(p)
			minT = math.Min(minT, t)
			maxT = math.Max(maxT, t)
			minP = math.Min(minP, p)
			maxP = math.Max(maxP, p)
		}
		route.Points = append(route.Points, point)
	}
	route.TotalDistanceM = rounded(distance, 10)
	route.ElevationGainM = rounded(gain, 10)
	route.ElevationLossM = rounded(loss, 10)
	route.MaxSlopeDeg = rounded(maxSlope, 100)
	route.WalkHours = rounded(WalkHours(distance, gain, loss), 1000)
	if distance > 0 {
		route.MeanSlopeDeg = rounded(weighted/distance, 100)
	}
	if w != nil && len(path) > 0 {
		route.MinTempC = ptr(minT)
		route.MaxTempC = ptr(maxT)
		route.MinPressurePa = ptr(minP)
		route.MaxPressurePa = ptr(maxP)
	}
	return route, nil
}

// Plan returns distinct candidates among shortest, gentlest, weather-safe, and
// alternate routes. Identical corridors are omitted using the reviewed overlap
// thresholds. Missing DEM endpoints are rejected, never relocated.
func (g *Graph) Plan(ctx context.Context, a, b Coord, maxSlope float64, filter *WeatherFilter) (PlanResponse, error) {
	return g.PlanStops(ctx, []Coord{a, b}, false, maxSlope, filter)
}

// MaxStops bounds A, B, and the intermediate stops in one request.
const MaxStops = 10

// PlanStops routes through every stop in order, one A* search per leg and
// strategy. With roundTrip the walk returns to the first stop by retracing the
// outbound path in reverse: known ground, no new search, and route metrics that
// cover the whole EVA. Each route's StopIndices gives the point index of every
// stop, including the return to the start.
func (g *Graph) PlanStops(ctx context.Context, stops []Coord, roundTrip bool, maxSlope float64, filter *WeatherFilter) (PlanResponse, error) {
	if err := ctx.Err(); err != nil {
		return PlanResponse{}, err
	}
	if len(stops) < 2 || len(stops) > MaxStops {
		return PlanResponse{}, fmt.Errorf("routes need 2 to %d stops", MaxStops)
	}
	if !finite(maxSlope) {
		return PlanResponse{}, fmt.Errorf("maxSlopeDeg must be finite")
	}
	limit := clamp(maxSlope, 0, 89)
	w, err := g.weather(ctx, filter)
	if err != nil {
		return PlanResponse{}, err
	}
	ratio, err := g.passableRatio(ctx, limit)
	if err != nil {
		return PlanResponse{}, err
	}
	res := PlanResponse{Routes: []Route{}, MaxSlopeDeg: limit, PassableEdgeRatio: ratio, RoundTrip: roundTrip}
	if filter != nil {
		res.WeatherApplied = true
		res.AppliedLMSTHour = ptr(rounded(filter.LMSTHour, 100))
		res.MinTempFilterC = ptr(rounded(filter.MinAirTempC, 100))
		res.MinPressureFilterPa = ptr(rounded(filter.MinPressurePa, 100))
	}
	for _, stop := range stops {
		if !g.Inside(stop) {
			res.Status = "out_of_bounds"
			what := "both Waypoint A and Waypoint B"
			if len(stops) > 2 {
				what = "every stop"
			}
			res.Message = fmt.Sprintf("Place %s inside the %gx%g km terrain bounds.", what, rounded(g.meta.WidthMeters/1000, 10), rounded(g.meta.HeightMeters/1000, 10))
			return res, nil
		}
	}
	nodes := make([]int, len(stops))
	for i, stop := range stops {
		if nodes[i] = g.snap(stop); nodes[i] < 0 {
			res.Status = "unreachable"
			res.BlockedReason = "nodata"
			res.Message = "Waypoints fell on missing elevation pixels."
			if len(stops) > 2 {
				res.Message = fmt.Sprintf("%s fell on missing elevation pixels.", stopName(i, len(stops)))
			}
			return res, nil
		}
	}
	start, goal := nodes[0], nodes[len(nodes)-1]
	res.SnappedA = &SnappedCoord{g.CoordForCell(start/g.meta.Cols, start%g.meta.Cols), rounded(g.elevations[start], 100)}
	res.SnappedB = &SnappedCoord{g.CoordForCell(goal/g.meta.Cols, goal%g.meta.Cols), rounded(g.elevations[goal], 100)}
	s := newSearch(len(g.elevations))
	// run joins one search per leg. On failure it returns the failing leg.
	run := func(mode string) ([]int, []int, int, error) {
		path, marks := []int{nodes[0]}, []int{0}
		for leg := 0; leg+1 < len(nodes); leg++ {
			part := []int{nodes[leg]}
			if nodes[leg] != nodes[leg+1] {
				found, err := g.astar(ctx, s, nodes[leg], nodes[leg+1], limit, mode, w)
				if err != nil || found == nil {
					return nil, nil, leg, err
				}
				part = found
			}
			path = append(path, part[1:]...)
			marks = append(marks, len(path)-1)
		}
		if roundTrip {
			outbound := len(path)
			for i := outbound - 2; i >= 0; i-- {
				path = append(path, path[i])
			}
			marks = append(marks, len(path)-1)
		}
		return path, marks, -1, nil
	}
	shortest, marks, failed, err := run("shortest")
	if err != nil {
		return PlanResponse{}, err
	}
	if shortest == nil {
		out, err := g.diagnose(ctx, s, nodes[failed], nodes[failed+1], res, filter, w)
		if err == nil && len(nodes) > 2 && out.Message != "" {
			out.Message = fmt.Sprintf("%s to %s: %s", stopName(failed, len(nodes)), stopName(failed+1, len(nodes)), out.Message)
		}
		return out, err
	}
	res.Status = "ok"
	route, err := g.summary(ctx, "shortest", "SHORTEST SAFE", shortest, w)
	if err != nil {
		return PlanResponse{}, err
	}
	route.StopIndices = marks
	res.Routes = append(res.Routes, route)
	paths := [][]int{shortest}
	for _, candidate := range []struct {
		mode, label string
		threshold   float64
	}{{"gentlest", "LOWEST SLOPE", 0.9}, {"weather-safe", "THERMAL SAFE", 0.88}, {"alternate", "ALT CORRIDOR", 0.85}} {
		if candidate.mode == "weather-safe" && (w == nil || w.weight <= 0) {
			continue
		}
		if candidate.mode == "alternate" {
			radius := max(2, min(8, int(math.Floor(float64(g.meta.Cols)/100+0.5))))
			endpoints := make(map[int]bool, len(nodes))
			for _, n := range nodes {
				endpoints[n] = true
			}
			for _, path := range paths {
				for _, u := range path {
					if err := ctx.Err(); err != nil {
						return PlanResponse{}, err
					}
					if endpoints[u] {
						continue
					}
					r, c := u/g.meta.Cols, u%g.meta.Cols
					for nr := max(0, r-radius); nr <= min(g.meta.Rows-1, r+radius); nr++ {
						for nc := max(0, c-radius); nc <= min(g.meta.Cols-1, c+radius); nc++ {
							s.penalty[nr*g.meta.Cols+nc] = true
						}
					}
				}
			}
		}
		path, marks, _, err := run(candidate.mode)
		if err != nil {
			return PlanResponse{}, err
		}
		if path == nil {
			continue
		}
		distinct := true
		for _, existing := range paths {
			if overlap(path, existing) >= candidate.threshold {
				distinct = false
				break
			}
		}
		if !distinct {
			continue
		}
		route, err := g.summary(ctx, candidate.mode, candidate.label, path, w)
		if err != nil {
			return PlanResponse{}, err
		}
		route.StopIndices = marks
		res.Routes = append(res.Routes, route)
		paths = append(paths, path)
	}
	if err := ctx.Err(); err != nil {
		return PlanResponse{}, err
	}
	return res, nil
}

// stopName labels stop i of n for messages: A, S1..Sk, B.
func stopName(i, n int) string {
	switch i {
	case 0:
		return "A"
	case n - 1:
		return "B"
	}
	return fmt.Sprintf("S%d", i)
}

func (g *Graph) diagnose(ctx context.Context, s *searchState, start, goal int, res PlanResponse, f *WeatherFilter, w *weatherContext) (PlanResponse, error) {
	res.Status = "unreachable"
	limit := res.MaxSlopeDeg
	var slopePath []int
	var err error
	if w != nil {
		slopePath, err = g.astar(ctx, s, start, goal, limit, "shortest", nil)
		if err != nil {
			return PlanResponse{}, err
		}
	}
	if w == nil || slopePath == nil {
		required, err := g.bottleneck(ctx, s, start, goal, limit, nil, nil)
		if err != nil {
			return PlanResponse{}, err
		}
		res.MinRequiredSlopeDeg = required
		if required == nil {
			res.BlockedReason = "nodata"
			res.Message = "No connected graph path between Waypoint A and Waypoint B."
		} else {
			res.BlockedReason = "slope"
			res.Message = fmt.Sprintf("No graph route under %.1f deg. Minimum required slope: %.1f deg.", limit, *required)
		}
		return res, nil
	}
	tempOnly, pressureOnly := *w, *w
	tempOnly.checkPressure = false
	pressureOnly.checkTemp = false
	tp, err := g.astar(ctx, s, start, goal, limit, "shortest", &tempOnly)
	if err != nil {
		return PlanResponse{}, err
	}
	pp, err := g.astar(ctx, s, start, goal, limit, "shortest", &pressureOnly)
	if err != nil {
		return PlanResponse{}, err
	}
	res.BlockedReason = "combined"
	if tp == nil && pp != nil {
		res.BlockedReason = "temperature"
	} else if tp != nil && pp == nil {
		res.BlockedReason = "pressure"
	}
	t, err := g.bottleneck(ctx, s, start, goal, limit, w.temperature, &pressureOnly)
	if err != nil {
		return PlanResponse{}, err
	}
	p, err := g.bottleneck(ctx, s, start, goal, limit, w.pressure, &tempOnly)
	if err != nil {
		return PlanResponse{}, err
	}
	if t != nil {
		res.MaxFeasibleMinTempC = ptr(math.Floor((*t-273.15)*100) / 100)
	}
	if p != nil {
		res.MaxFeasibleMinPressurePa = ptr(math.Floor(*p*100) / 100)
	}
	minutes := int(math.Floor((math.Mod(math.Mod(f.LMSTHour, 24)+24, 24))*60 + 0.5))
	clock := fmt.Sprintf("%02d:%02d", minutes/60%24, minutes%60)
	res.Message = fmt.Sprintf("No route passes weather constraints at %s.", clock)
	if res.BlockedReason == "temperature" && t != nil {
		res.Message = fmt.Sprintf("No route stays above %.1f C at %s. Warmest corridor drops to %.1f C.", f.MinAirTempC, clock, *res.MaxFeasibleMinTempC)
	} else if res.BlockedReason == "pressure" && p != nil {
		res.Message = fmt.Sprintf("No route stays above %.0f Pa at %s. Highest-pressure corridor drops to %.1f Pa.", f.MinPressurePa, clock, *res.MaxFeasibleMinPressurePa)
	} else if t != nil && p != nil {
		res.Message = fmt.Sprintf("No route meets %.1f C and %.0f Pa at %s. Corridor limits: %.1f C, %.1f Pa.", f.MinAirTempC, f.MinPressurePa, clock, *res.MaxFeasibleMinTempC, *res.MaxFeasibleMinPressurePa)
	}
	return res, nil
}
