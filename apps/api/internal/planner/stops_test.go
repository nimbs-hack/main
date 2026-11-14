package planner

import (
	"context"
	"math"
	"strings"
	"testing"
)

func TestStopsVisitEveryStopInOrder(t *testing.T) {
	g := graphFor(t, grid(5, 5, make([]float64, 25)))
	a, s1, b := g.CoordForCell(0, 0), g.CoordForCell(4, 0), g.CoordForCell(4, 4)
	r, err := g.PlanStops(context.Background(), []Coord{a, s1, b}, false, 10, nil)
	if err != nil {
		t.Fatal(err)
	}
	requireStatus(t, r, "ok", "")
	for _, route := range r.Routes {
		if len(route.StopIndices) != 3 || route.StopIndices[0] != 0 || route.StopIndices[2] != len(route.Points)-1 {
			t.Fatalf("%s stop indices %v for %d points", route.Strategy, route.StopIndices, len(route.Points))
		}
		mid := route.Points[route.StopIndices[1]]
		if mid.Lat != rounded(s1.Lat, 1e6) || mid.Lon != rounded(s1.Lon, 1e6) {
			t.Fatalf("%s misses S1: %+v", route.Strategy, mid)
		}
	}
	// The detour through S1 is two straight 4-cell legs, longer than the diagonal.
	if got, want := r.Routes[0].TotalDistanceM, rounded(4*g.dy+4*g.dx, 10); got != want {
		t.Fatalf("distance %v, want %v", got, want)
	}
}

func TestRoundTripRetracesOutbound(t *testing.T) {
	g := graphFor(t, grid(1, 4, []float64{0, 10, 10, 20}))
	a, b := g.CoordForCell(0, 0), g.CoordForCell(0, 3)
	oneWay := planFor(t, g, a, b, 89, nil).Routes[0]
	r, err := g.PlanStops(context.Background(), []Coord{a, b}, true, 89, nil)
	if err != nil {
		t.Fatal(err)
	}
	requireStatus(t, r, "ok", "")
	route := r.Routes[0]
	if !r.RoundTrip || len(route.Points) != 2*len(oneWay.Points)-1 {
		t.Fatalf("round trip has %d points, one way %d", len(route.Points), len(oneWay.Points))
	}
	if route.StopIndices[1] != len(oneWay.Points)-1 || route.StopIndices[2] != len(route.Points)-1 {
		t.Fatal(route.StopIndices)
	}
	if route.TotalDistanceM != rounded(2*oneWay.TotalDistanceM, 10) || route.ElevationGainM != 20 || route.ElevationLossM != 20 {
		t.Fatalf("%+v", route)
	}
	last, first := route.Points[len(route.Points)-1], route.Points[0]
	if last.Coord != first.Coord {
		t.Fatal("round trip does not end at A")
	}
	want := WalkHours(route.TotalDistanceM, 20, 20)
	if math.Abs(route.WalkHours-want) > 1e-3 || route.WalkHours <= oneWay.WalkHours {
		t.Fatalf("walk %v, want %v", route.WalkHours, want)
	}
}

func TestStopsNameTheBlockedLeg(t *testing.T) {
	// A wall between S1 and B: the A to S1 leg is flat, the next leg is not.
	g := graphFor(t, grid(1, 4, []float64{0, 0, 100, 100}))
	r, err := g.PlanStops(context.Background(), []Coord{g.CoordForCell(0, 0), g.CoordForCell(0, 1), g.CoordForCell(0, 3)}, false, 10, nil)
	if err != nil {
		t.Fatal(err)
	}
	requireStatus(t, r, "unreachable", "slope")
	if !strings.HasPrefix(r.Message, "S1 to B: ") || r.MinRequiredSlopeDeg == nil {
		t.Fatal(r.Message)
	}
}

func TestStopsValidation(t *testing.T) {
	g := graphFor(t, grid(2, 2, make([]float64, 4)))
	a := g.CoordForCell(0, 0)
	for _, stops := range [][]Coord{{a}, make([]Coord, MaxStops+1)} {
		if _, err := g.PlanStops(context.Background(), stops, false, 10, nil); err == nil {
			t.Fatalf("accepted %d stops", len(stops))
		}
	}
	r, err := g.PlanStops(context.Background(), []Coord{a, {Lat: 5, Lon: 5}, a}, false, 10, nil)
	if err != nil {
		t.Fatal(err)
	}
	if r.Status != "out_of_bounds" || !strings.Contains(r.Message, "every stop") {
		t.Fatal(r)
	}
}
