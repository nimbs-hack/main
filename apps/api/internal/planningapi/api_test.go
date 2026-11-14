package planningapi

import (
	"bytes"
	"encoding/json"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mars-console/api/internal/planner"
)

func testAPI(t *testing.T) *http.ServeMux {
	t.Helper()
	dir := t.TempDir()
	data := planner.Dataset{Meta: planner.Metadata{ID: "jezero-test", Name: "Test DEM", Rows: 5, Cols: 5, BBox: [4]float64{77, 18, 77.004, 18.004}, Center: planner.Coord{Lat: 18.002, Lon: 77.002}, WidthMeters: 225, HeightMeters: 237, CellSizeMeters: 59, NodataValue: -9999, MinElevationM: -2500, MaxElevationM: -2500}, ElevationsM: make([]float64, 25)}
	for i := range data.ElevationsM {
		data.ElevationsM[i] = -2500
	}
	raw, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "site-terrain.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	Register(mux, dir)
	return mux
}
func call(mux *http.ServeMux, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	out := httptest.NewRecorder()
	mux.ServeHTTP(out, req)
	return out
}
func TestPlanningEndpoints(t *testing.T) {
	mux := testAPI(t)
	body := `{"waypointA":{"lat":18.004,"lon":77},"waypointB":{"lat":18,"lon":77.004},"maxSlopeDeg":0}`
	response := call(mux, "POST", "/api/graph/routes", body)
	if response.Code != 200 {
		t.Fatalf("route: %d %s", response.Code, response.Body.String())
	}
	var result planner.PlanResponse
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Status != "ok" || len(result.Routes) == 0 || result.Routes[0].TotalDistanceM <= 0 {
		t.Fatalf("unexpected route: %+v", result)
	}
	for _, path := range []string{"/api/site", "/api/health", "/api/terrain/elevation?lat=18.002&lon=77.002"} {
		res := call(mux, "GET", path, "")
		if res.Code != 200 {
			t.Fatalf("%s: %d %s", path, res.Code, res.Body.String())
		}
	}
	for _, path := range []string{"/api/site/passability.png?maxSlopeDeg=0", "/api/site/temperature.png?sol=1000&lmstHour=12", "/api/site/pressure.png?sol=1000&lmstHour=12"} {
		res := call(mux, "GET", path, "")
		if res.Code != 200 || !bytes.HasPrefix(res.Body.Bytes(), []byte{137, 80, 78, 71}) {
			t.Fatalf("%s: %d %s", path, res.Code, res.Body.String())
		}
	}
	weather := call(mux, "POST", "/api/weather/evaluate", `{"sol":1000,"lmstHour":12,"scenario":"nominal","route":{"totalDistanceM":2500}}`)
	if weather.Code != 200 {
		t.Fatalf("weather: %d %s", weather.Code, weather.Body.String())
	}
	var decoded struct {
		Weather struct {
			IsSimulated bool `json:"isSimulated"`
		}
		Evaluation struct {
			EstimatedRouteHours float64 `json:"estimatedRouteHours"`
		}
	}
	if err := json.Unmarshal(weather.Body.Bytes(), &decoded); err != nil {
		t.Fatal(err)
	}
	if !decoded.Weather.IsSimulated || decoded.Evaluation.EstimatedRouteHours != 1 {
		t.Fatalf("wrong weather contract: %s", weather.Body.String())
	}
}
func TestRejectsInvalidInputs(t *testing.T) {
	mux := testAPI(t)
	for _, body := range []string{`null`, `[]`, `{} {}`, `{"sol":null}`, `{"sol":false}`, `{"sol":1.5}`, `{"scenario":"unknown"}`, `{"lmstHour":49}`, `{"limits":{"minPressurePa":-1}}`, `{"limits":{"maxEvaHours":0}}`} {
		res := call(mux, "POST", "/api/weather/evaluate", body)
		if res.Code != 400 {
			t.Errorf("%s: %d %s", body, res.Code, res.Body.String())
		}
	}
	for _, body := range []string{`{}`, `{"waypointA":{"lat":18},"waypointB":{"lat":18,"lon":77},"maxSlopeDeg":20}`, `{"waypointA":{"lat":18,"lon":77},"waypointB":{"lat":18,"lon":77},"maxSlopeDeg":-1}`} {
		res := call(mux, "POST", "/api/graph/routes", body)
		if res.Code != 400 {
			t.Errorf("%s: %d", body, res.Code)
		}
	}
	for _, path := range []string{"/api/terrain/elevation?lat=&lon=77", "/api/site/passability.png?maxSlopeDeg=NaN", "/api/site/temperature.png?sol=-1"} {
		res := call(mux, "GET", path, "")
		if res.Code != 400 {
			t.Errorf("%s: %d", path, res.Code)
		}
	}
}
func TestMissingDEMDoesNotReturnHTML(t *testing.T) {
	mux := http.NewServeMux()
	Register(mux, t.TempDir())
	res := call(mux, "GET", "/api/site", "")
	if res.Code != 503 || res.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("%d %s", res.Code, res.Body.String())
	}
}

func TestZeroPressureThreshold(t *testing.T) {
	res := call(testAPI(t), "POST", "/api/weather/evaluate", `{"limits":{"minPressurePa":0}}`)
	if res.Code != 200 {
		t.Fatalf("%d %s", res.Code, res.Body.String())
	}
}

func TestWeatherProfileWithoutFiltering(t *testing.T) {
	mux := testAPI(t)
	body := `{"waypointA":{"lat":18.004,"lon":77},"waypointB":{"lat":18,"lon":77.004},"maxSlopeDeg":10,"weatherConstraints":{"enabled":false,"lmstHour":12}}`
	res := call(mux, "POST", "/api/graph/routes", body)
	if res.Code != 200 {
		t.Fatal(res.Body.String())
	}
	var plan planner.PlanResponse
	if err := json.Unmarshal(res.Body.Bytes(), &plan); err != nil {
		t.Fatal(err)
	}
	if plan.WeatherApplied || len(plan.Routes) == 0 {
		t.Fatalf("unexpected result: %+v", plan)
	}
	for _, route := range plan.Routes {
		for _, point := range route.Points {
			if point.TempC == nil || point.PressurePa == nil || *point.PressurePa <= 0 {
				t.Fatalf("missing modeled profile: %+v", point)
			}
		}
	}
	// Values within the limit remain colored rather than disappearing.
	for _, layer := range []string{"temperature", "pressure"} {
		response := call(mux, "GET", "/api/site/"+layer+".png?minAirTempC=-180&minPressurePa=0", "")
		img, err := png.Decode(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		_, _, _, alpha := img.At(2, 2).RGBA()
		if alpha == 0 {
			t.Fatalf("%s field is invisible inside limits", layer)
		}
	}
}

func TestRouteStopsAndRoundTrip(t *testing.T) {
	mux := testAPI(t)
	body := `{"waypointA":{"lat":18.004,"lon":77},"via":[{"lat":18,"lon":77}],"waypointB":{"lat":18,"lon":77.004},"roundTrip":true,"maxSlopeDeg":10}`
	response := call(mux, "POST", "/api/graph/routes", body)
	var result planner.PlanResponse
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil || response.Code != 200 {
		t.Fatalf("%d %s", response.Code, response.Body.String())
	}
	route := result.Routes[0]
	if !result.RoundTrip || len(route.StopIndices) != 4 || route.WalkHours <= 0 {
		t.Fatalf("%+v", route)
	}
	if end := route.Points[len(route.Points)-1]; end.Lat != 18.004 || end.Lon != 77 {
		t.Fatalf("round trip ends at %+v", end)
	}
	tooMany := `{"waypointA":{"lat":18,"lon":77},"waypointB":{"lat":18,"lon":77},"maxSlopeDeg":10,"via":[` + strings.Repeat(`{"lat":18,"lon":77},`, planner.MaxStops-2) + `{"lat":18,"lon":77}]}`
	if res := call(mux, "POST", "/api/graph/routes", tooMany); res.Code != 400 {
		t.Fatalf("too many stops: %d", res.Code)
	}
	if res := call(mux, "POST", "/api/graph/routes", `{"waypointA":{"lat":18,"lon":77},"waypointB":{"lat":18,"lon":77},"maxSlopeDeg":10,"via":[{"lat":18}]}`); res.Code != 400 {
		t.Fatalf("bad stop: %d", res.Code)
	}
}
