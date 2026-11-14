// Package weather models simulated Martian weather and EVA departure windows.
// It does not provide operational flight or suit safety predictions.
package weather

const (
	MarsRadiusM           = 3396190.0
	MarsScaleHeightM      = 10800.0
	MarsSolSeconds        = 88775.244
	EarthHoursPerLMSTHour = MarsSolSeconds / 3600 / 24
	LapseRateKPerM        = -0.0025
)

// Grid uses planetocentric latitude and east-positive longitude in [-180,180].
// BBox is west,south,east,north. Cells are row-major, north to south.
// A nil Valid mask means all cells are valid; invalid outputs are zero.
type Grid struct {
	Rows, Cols          int
	BBox                [4]float64
	Elevations          []float64
	Valid               []bool
	ReferenceElevationM float64
	ID, Name            string
	// CellSizeMeters sets the pooling radius from source terrain metadata.
	// Zero derives it from the spherical grid spacing.
	CellSizeMeters float64 `json:"cellSizeMeters,omitempty"`
}

// Options is deterministic, including Sol 0. LMSTHour is an offset in [0,48]
// from midnight of Sol, not Earth hours. LsDeg defaults to the landing-relative
// date of Sol. Scenario accepts auto, nominal, cold-snap and dust-storm.
type Options struct {
	Sol      int      `json:"sol"`
	LMSTHour float64  `json:"lmstHour"`
	Scenario string   `json:"scenario"`
	LsDeg    *float64 `json:"lsDeg,omitempty"`
}

type Coord struct {
	Lat float64 `json:"lat"`
	Lon float64 `json:"lon"`
}
type Site struct {
	ID                  string  `json:"siteId"`
	Name                string  `json:"name"`
	Center              Coord   `json:"center"`
	ReferenceElevationM float64 `json:"referenceElevationM"`
	MinElevationM       float64 `json:"minElevationM"`
	MaxElevationM       float64 `json:"maxElevationM"`
}
type AirTemp struct {
	MinK float64 `json:"minK"`
	AvgK float64 `json:"avgK"`
	MaxK float64 `json:"maxK"`
}
type Pressure struct {
	MinPa               float64 `json:"minPa"`
	AvgPa               float64 `json:"avgPa"`
	MaxPa               float64 `json:"maxPa"`
	SwingPa             float64 `json:"swingPa"`
	ReferenceElevationM float64 `json:"referenceElevationM"`
}
type Wind struct {
	MinMps       float64 `json:"minMps"`
	AvgMps       float64 `json:"avgMps"`
	MaxMps       float64 `json:"maxMps"`
	CompassDeg   float64 `json:"compassDeg"`
	CompassPoint string  `json:"compassPoint"`
}
type Daylight struct {
	SunriseHour   float64 `json:"sunriseHour"`
	SunsetHour    float64 `json:"sunsetHour"`
	SunriseLMST   string  `json:"sunriseLmst"`
	SunsetLMST    string  `json:"sunsetLmst"`
	DurationHours float64 `json:"durationHours"`
}
type HourlyPoint struct {
	LMSTHour           float64 `json:"lmstHour"`
	LMSTLabel          string  `json:"lmstLabel"`
	TempK              float64 `json:"tempK"`
	PressurePa         float64 `json:"pressurePa"`
	WindSpeedMps       float64 `json:"windSpeedMps"`
	SolarIrradianceWm2 float64 `json:"solarIrradianceWm2"`
	UVIndex            float64 `json:"uvIndex"`
	IsDaylight         bool    `json:"isDaylight"`
}
type Forecast struct {
	Sol             int           `json:"sol"`
	LsDeg           float64       `json:"lsDeg"`
	TerrestrialDate string        `json:"terrestrialDate"`
	AirTemp         AirTemp       `json:"airTemp"`
	Pressure        Pressure      `json:"pressure"`
	Wind            Wind          `json:"wind"`
	DustOpacityTau  float64       `json:"dustOpacityTau"`
	Daylight        Daylight      `json:"daylight"`
	Hourly          []HourlyPoint `json:"hourly"`
}
type Snapshot struct {
	Forecast
	Site              Site     `json:"site"`
	Scenario          string   `json:"scenario"`
	IsSimulated       bool     `json:"isSimulated"`
	SourceType        string   `json:"sourceType"`
	SourceLabel       string   `json:"sourceLabel"`
	Disclaimer        string   `json:"disclaimer"`
	RealChannels      []string `json:"realChannels"`
	SimulatedChannels []string `json:"simulatedChannels"`
	NextSol           Forecast `json:"nextSol"`
	Current           Sample   `json:"current"`
}
type Sample struct {
	HourlyPoint
	Sol                 int     `json:"sol"`
	OffsetHours         float64 `json:"offsetHours"`
	LsDeg               float64 `json:"lsDeg"`
	DustOpacityTau      float64 `json:"dustOpacityTau"`
	ReferenceElevationM float64 `json:"referenceElevationM"`
}
type Field struct {
	SiteID         string    `json:"siteId"`
	Sol            int       `json:"sol"`
	LMSTHour       float64   `json:"lmstHour"`
	LMSTLabel      string    `json:"lmstLabel"`
	Scenario       string    `json:"scenario"`
	IsSimulated    bool      `json:"isSimulated"`
	TempK          []float64 `json:"tempK"`
	PressurePa     []float64 `json:"pressurePa"`
	Valid          []bool    `json:"valid"`
	ValidCount     int       `json:"validCount"`
	MinTempK       float64   `json:"minTempK"`
	MaxTempK       float64   `json:"maxTempK"`
	MeanTempK      float64   `json:"meanTempK"`
	MinTempC       float64   `json:"minTempC"`
	MaxTempC       float64   `json:"maxTempC"`
	MeanTempC      float64   `json:"meanTempC"`
	MinPressurePa  float64   `json:"minPressurePa"`
	MaxPressurePa  float64   `json:"maxPressurePa"`
	MeanPressurePa float64   `json:"meanPressurePa"`
}
type Status string

const (
	Go       Status = "GO"
	Degraded Status = "DEGRADED"
	NoGo     Status = "NO-GO"
)

// Limits uses kelvin. DefaultLimits returns the reviewed demo suit limits.
type Limits struct {
	MinAirTempK        float64 `json:"minAirTempK"`
	MaxWindSpeedMps    float64 `json:"maxWindSpeedMps"`
	MinPressurePa      float64 `json:"minPressurePa"`
	MaxPressureSwingPa float64 `json:"maxPressureSwingPa"`
	MaxEvaHours        float64 `json:"maxEvaHours"`
}

func DefaultLimits() Limits { return Limits{198.15, 15, 650, 35, 4} }

type RoutePoint struct {
	DistanceM  float64 `json:"distanceM"`
	ElevationM float64 `json:"elevationM"`
}

// Points take precedence over aggregate distance/gain/loss when present.
// DistanceM is cumulative. Walking duration is in Earth hours.
type Route struct {
	TotalDistanceM float64      `json:"totalDistanceM"`
	ElevationGainM float64      `json:"elevationGainM"`
	ElevationLossM float64      `json:"elevationLossM"`
	MinElevationM  *float64     `json:"minElevationM,omitempty"`
	MaxElevationM  *float64     `json:"maxElevationM,omitempty"`
	Points         []RoutePoint `json:"points,omitempty"`
}
type EvaluateOptions struct {
	Limits     *Limits  `json:"limits,omitempty"`
	Route      *Route   `json:"route,omitempty"`
	ElevationM *float64 `json:"elevationM,omitempty"`
	LMSTHour   float64  `json:"lmstHour"`
	StepHours  float64  `json:"stepHours"`
}
type Check struct {
	ID            string  `json:"id"`
	Status        Status  `json:"status"`
	MeasuredValue float64 `json:"measuredValue"`
	LimitValue    float64 `json:"limitValue"`
	Unit          string  `json:"unit"`
	Margin        float64 `json:"margin"`
	Reason        string  `json:"reason"`
}
type DepartureSlot struct {
	OffsetHours              float64  `json:"offsetHours"`
	Sol                      int      `json:"sol"`
	SolOffset                int      `json:"solOffset"`
	StartLMSTHour            float64  `json:"startLmstHour"`
	EndLMSTHour              float64  `json:"endLmstHour"`
	StartLMSTLabel           string   `json:"startLmstLabel"`
	EndLMSTLabel             string   `json:"endLmstLabel"`
	DurationHours            float64  `json:"durationHours"`
	Status                   Status   `json:"status"`
	Score                    float64  `json:"score"`
	MinEncounteredTempK      float64  `json:"minEncounteredTempK"`
	MaxEncounteredTempK      float64  `json:"maxEncounteredTempK"`
	MinEncounteredPressurePa float64  `json:"minEncounteredPressurePa"`
	MaxEncounteredWindMps    float64  `json:"maxEncounteredWindMps"`
	MaxUVIndex               float64  `json:"maxUvIndex"`
	DaylightFraction         float64  `json:"daylightFraction"`
	Reasons                  []string `json:"reasons"`
	Reason                   string   `json:"reason"`
}
type Recommendation struct {
	Rank                     int     `json:"rank"`
	Status                   Status  `json:"status"`
	Sol                      int     `json:"sol"`
	StartOffsetHours         float64 `json:"startOffsetHours"`
	EndOffsetHours           float64 `json:"endOffsetHours"`
	BestDepartureOffsetHours float64 `json:"bestDepartureOffsetHours"`
	BestDepartureLMST        string  `json:"bestDepartureLmst"`
	EstimatedDurationHours   float64 `json:"estimatedDurationHours"`
	Score                    float64 `json:"score"`
	Summary                  string  `json:"summary"`
}
type SafeWindow struct {
	StartLMSTHour *float64 `json:"startLmstHour"`
	EndLMSTHour   *float64 `json:"endLmstHour"`
	DurationHours float64  `json:"durationHours"`
	Note          string   `json:"note"`
}
type Evaluation struct {
	Status               Status           `json:"status"`
	IsSimulated          bool             `json:"isSimulated"`
	Limits               Limits           `json:"limits"`
	EstimatedRouteHours  float64          `json:"estimatedRouteHours"`
	FloorElevationM      float64          `json:"floorElevationM"`
	EvaluationElevationM float64          `json:"evaluationElevationM"`
	SelectedHourWeather  Sample           `json:"selectedHourWeather"`
	Checks               []Check          `json:"checks"`
	SafeWindow           SafeWindow       `json:"safeWindow"`
	DepartureSlots       []DepartureSlot  `json:"departureSlots"`
	RecommendedWindows   []Recommendation `json:"recommendedWindows"`
	Summary              string           `json:"summary"`
}
