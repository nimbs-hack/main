// Package planner routes across a local Mars DEM using planetocentric latitude
// and east-positive longitude normalized to [-180, 180).
package planner

type Coord struct {
	Lat float64 `json:"lat"`
	Lon float64 `json:"lon"`
}

type Metadata struct {
	ID             string     `json:"id"`
	Name           string     `json:"name"`
	SourceItemID   string     `json:"sourceItemId"`
	SourceTitle    string     `json:"sourceTitle"`
	DTMURL         string     `json:"dtmUrl"`
	HillshadeURL   string     `json:"hillshadeUrl"`
	BBox           [4]float64 `json:"bbox"`
	Center         Coord      `json:"center"`
	Rows           int        `json:"rows"`
	Cols           int        `json:"cols"`
	WidthMeters    float64    `json:"widthMeters"`
	HeightMeters   float64    `json:"heightMeters"`
	CellSizeMeters float64    `json:"cellSizeMeters"`
	MinElevationM  float64    `json:"minElevationM"`
	MaxElevationM  float64    `json:"maxElevationM"`
	NodataValue    float64    `json:"nodataValue"`
}

type Dataset struct {
	Meta        Metadata  `json:"meta"`
	ElevationsM []float64 `json:"elevationsM"`
}

// WeatherFilter fields are sampled at each DEM cell in row-major order. Callers
// must not mutate these slices while Plan is copying them at request entry.
type WeatherFilter struct {
	LMSTHour       float64
	MinAirTempC    float64
	MinPressurePa  float64
	ThermalWeight  float64
	CellTempK      []float64
	CellPressurePa []float64
}

type RoutePoint struct {
	Coord
	ElevationM float64  `json:"elevationM"`
	DistanceM  float64  `json:"distanceM"`
	SlopeDeg   float64  `json:"slopeDeg"`
	TempC      *float64 `json:"tempC,omitempty"`
	PressurePa *float64 `json:"pressurePa,omitempty"`
}

type Route struct {
	ID             string       `json:"id"`
	Label          string       `json:"label"`
	Strategy       string       `json:"strategy"`
	TotalDistanceM float64      `json:"totalDistanceM"`
	ElevationGainM float64      `json:"elevationGainM"`
	ElevationLossM float64      `json:"elevationLossM"`
	MaxSlopeDeg    float64      `json:"maxSlopeDeg"`
	MeanSlopeDeg   float64      `json:"meanSlopeDeg"`
	MinTempC       *float64     `json:"minTempC,omitempty"`
	MaxTempC       *float64     `json:"maxTempC,omitempty"`
	MinPressurePa  *float64     `json:"minPressurePa,omitempty"`
	MaxPressurePa  *float64     `json:"maxPressurePa,omitempty"`
	WalkHours      float64      `json:"walkHours"`
	StopIndices    []int        `json:"stopIndices"`
	Points         []RoutePoint `json:"points"`
}

type SnappedCoord struct {
	Coord
	ElevationM float64 `json:"elevationM"`
}

type PlanResponse struct {
	Status                   string        `json:"status"`
	Routes                   []Route       `json:"routes"`
	RoundTrip                bool          `json:"roundTrip,omitempty"`
	Message                  string        `json:"message,omitempty"`
	MaxSlopeDeg              float64       `json:"maxSlopeDeg"`
	PassableEdgeRatio        float64       `json:"passableEdgeRatio"`
	MinRequiredSlopeDeg      *float64      `json:"minRequiredSlopeDeg,omitempty"`
	MaxFeasibleMinTempC      *float64      `json:"maxFeasibleMinTempC,omitempty"`
	MaxFeasibleMinPressurePa *float64      `json:"maxFeasibleMinPressurePa,omitempty"`
	BlockedReason            string        `json:"blockedReason,omitempty"`
	WeatherApplied           bool          `json:"weatherApplied,omitempty"`
	AppliedLMSTHour          *float64      `json:"appliedLmstHour,omitempty"`
	MinTempFilterC           *float64      `json:"minTempFilterC,omitempty"`
	MinPressureFilterPa      *float64      `json:"minPressureFilterPa,omitempty"`
	SnappedA                 *SnappedCoord `json:"snappedA,omitempty"`
	SnappedB                 *SnappedCoord `json:"snappedB,omitempty"`
}
