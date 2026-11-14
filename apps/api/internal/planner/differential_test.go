package planner

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
	"os"
	"reflect"
	"testing"
)

func assertResponseParity(t *testing.T, got, want PlanResponse) {
	t.Helper()
	// Walk time and stop indices were added after the TypeScript review. They
	// are derived from the compared metrics and checked in stops_test.go.
	for i := range got.Routes {
		got.Routes[i].WalkHours, got.Routes[i].StopIndices = 0, nil
	}
	// Snapped coordinates retain unrounded floating point values. V8 and Go can
	// differ at the last bit; all rounded route metrics and points must match.
	for _, pair := range [][2]*SnappedCoord{{got.SnappedA, want.SnappedA}, {got.SnappedB, want.SnappedB}} {
		if pair[0] == nil || pair[1] == nil {
			if pair[0] != pair[1] {
				t.Fatal("snapped coordinate presence differs")
			}
			continue
		}
		if math.Abs(pair[0].Lat-pair[1].Lat) > 1e-12 || math.Abs(pair[0].Lon-pair[1].Lon) > 1e-12 || pair[0].ElevationM != pair[1].ElevationM {
			t.Fatalf("snapped coordinates differ: %+v vs %+v", pair[0], pair[1])
		}
	}
	got.SnappedA, got.SnappedB = nil, nil
	want.SnappedA, want.SnappedB = nil, nil
	if !reflect.DeepEqual(got, want) {
		gb, _ := json.Marshal(got)
		wb, _ := json.Marshal(want)
		t.Fatalf("TypeScript parity mismatch\ngot: %s\nwant: %s", gb, wb)
	}
}
func TestReviewedTypeScriptSmallGrids(t *testing.T) {
	data, err := os.ReadFile("testdata/small-grids.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		AllowEquivalentPaths bool
		Name                 string
		Dataset              Dataset
		A, B                 Coord
		MaxSlope             float64
		Weather              *WeatherFilter
		Expected             PlanResponse
	}
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, f := range fixtures {
		t.Run(f.Name, func(t *testing.T) {
			g := graphFor(t, f.Dataset)
			got := planFor(t, g, f.A, f.B, f.MaxSlope, f.Weather)
			if f.AllowEquivalentPaths {
				// A flat rectangle has equal-cost corridors. Native math can
				// break those ties differently, so compare metrics and verify
				// every returned step while the other fixtures compare points.
				if len(got.Routes) != len(f.Expected.Routes) {
					t.Fatal("route count differs")
				}
				for i := range got.Routes {
					points := got.Routes[i].Points
					expected := f.Expected.Routes[i].Points
					if len(points) != len(expected) || points[0] != expected[0] || points[len(points)-1] != expected[len(expected)-1] {
						t.Fatal("path endpoints or point count differ")
					}
					distance := 0.0
					for j := 1; j < len(points); j++ {
						u, v := g.snap(points[j-1].Coord), g.snap(points[j].Coord)
						dr, dc := u/g.meta.Cols-v/g.meta.Cols, u%g.meta.Cols-v%g.meta.Cols
						if u == v || dr < -1 || dr > 1 || dc < -1 || dc > 1 {
							t.Fatal("nonadjacent path step")
						}
						distance += math.Hypot(float64(dr)*g.dy, float64(dc)*g.dx)
					}
					if rounded(distance, 10) != got.Routes[i].TotalDistanceM {
						t.Fatal("path distance differs")
					}
					got.Routes[i].Points = nil
					f.Expected.Routes[i].Points = nil
				}
			}
			assertResponseParity(t, got, f.Expected)
		})
	}
}
func TestReviewedTypeScriptRealTerrain(t *testing.T) {
	path := os.Getenv("PLANNER_TERRAIN_DATA")
	if path == "" {
		path = "../../../../data/site-terrain.json"
	}
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		t.Skip("local real DEM is not installed")
	}
	if err != nil {
		t.Fatal(err)
	}
	var d Dataset
	if err := json.Unmarshal(data, &d); err != nil {
		t.Fatal(err)
	}
	fixture, err := os.ReadFile("testdata/real-terrain.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Rows, Cols int
		A, B       Coord
		Queries    []struct {
			MaxSlope         float64
			Expected         PlanResponse
			RoutePointHashes []string
		}
	}
	if err := json.Unmarshal(fixture, &f); err != nil {
		t.Fatal(err)
	}
	if d.Meta.Rows != f.Rows || d.Meta.Cols != f.Cols {
		t.Fatal("real DEM dimensions differ from fixture")
	}
	g := graphFor(t, d)
	for _, q := range f.Queries {
		r := planFor(t, g, f.A, f.B, q.MaxSlope, nil)
		if len(r.Routes) != len(q.RoutePointHashes) {
			t.Fatalf("slope %g: route count differs", q.MaxSlope)
		}
		for i := range r.Routes {
			points, err := json.Marshal(r.Routes[i].Points)
			if err != nil {
				t.Fatal(err)
			}
			hash := sha256.Sum256(points)
			if hex.EncodeToString(hash[:]) != q.RoutePointHashes[i] {
				t.Fatalf("slope %g: %s points differ from TypeScript", q.MaxSlope, r.Routes[i].Strategy)
			}
			r.Routes[i].Points = []RoutePoint{}
		}
		assertResponseParity(t, r, q.Expected)
	}
}
