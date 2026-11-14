package weather

import (
	"fmt"
	"math"
	"strings"
	"time"
)

func clamp(x, lo, hi float64) float64 { return math.Max(lo, math.Min(hi, x)) }
func wrap(x, period float64) float64  { return math.Mod(math.Mod(x, period)+period, period) }
func finite(x float64) bool           { return !math.IsNaN(x) && !math.IsInf(x, 0) }
func noise(sol int, seed float64) float64 {
	x := math.Sin(float64(sol)*12.9898+seed*78.233) * 43758.5453
	return x - math.Floor(x)
}
func round(x float64, n int) float64 { p := math.Pow10(n); return math.Floor(x*p+0.5) / p }
func clockLabel(h float64) string {
	if h == 24 {
		return "24:00"
	}
	m := int(math.Floor(wrap(h, 24)*60+0.5)) % 1440
	return fmt.Sprintf("%02d:%02d", m/60, m%60)
}
func ScalePressureByElevation(p, target, reference float64) float64 {
	return p * math.Exp(-(target-reference)/MarsScaleHeightM)
}
func LapseTempByElevation(t, target, reference float64) float64 {
	return t + LapseRateKPerM*(target-reference)
}

const rad = math.Pi / 180

func declination(ls float64) float64 { return math.Asin(math.Sin(25.19*rad) * math.Sin(ls*rad)) }
func solarNoon(ls float64) float64   { return 12 - 0.35*math.Sin((ls-251)*rad) + 0.15*math.Sin(2*ls*rad) }
func solarFactor(ls float64) float64 {
	return math.Pow((1+0.0934*math.Cos((ls-251)*rad))/(1-0.0934*0.0934), 2)
}
func solarDirection(lat, ls, hour float64) (float64, float64, float64) {
	d := declination(ls)
	a := (hour - solarNoon(ls)) * math.Pi / 12
	l := lat * rad
	return -math.Cos(d) * math.Sin(a), math.Cos(l)*math.Sin(d) - math.Sin(l)*math.Cos(d)*math.Cos(a), math.Sin(l)*math.Sin(d) + math.Cos(l)*math.Cos(d)*math.Cos(a)
}

// Stored clock bounds match the reviewed source's second-resolution LMST strings.
func daylightBounds(d Daylight) (float64, float64) {
	return math.Floor(d.SunriseHour*3600+0.5) / 3600, math.Floor(d.SunsetHour*3600+0.5) / 3600
}

func daylight(lat, ls float64) Daylight {
	half := 12 / math.Pi * math.Acos(clamp(-math.Tan(lat*rad)*math.Tan(declination(ls)), -0.98, 0.98))
	rise := clamp(solarNoon(ls)-half, 4, 8.5)
	set := clamp(solarNoon(ls)+half, 15.5, 20)
	return Daylight{rise, set, clockLabel(rise), clockLabel(set), (set - rise) * EarthHoursPerLMSTHour}
}
func seasonalPressure(ls float64) float64 {
	return 788 + 42*math.Cos((ls-295)*rad) + 18*math.Cos(2*(ls-210)*rad)
}
func dust(ls float64, scenario string, sol int) float64 {
	switch scenario {
	case "dust-storm":
		return round(2.65+noise(sol, 41)*0.75, 2)
	case "cold-snap":
		return round(0.28+noise(sol, 43)*0.08, 2)
	}
	return round(math.Max(0.2, 0.52+0.18*math.Cos((ls-255)*rad)+(noise(sol, 31)-0.5)*0.08), 2)
}
func temperatureRange(lat, ls, tau float64, scenario string, sol int) AirTemp {
	noon := math.Max(0.25, math.Cos((lat-declination(ls)/rad)*rad))
	sf := solarFactor(ls)
	jitter := (noise(sol, 17) - 0.5) * 4
	lo := 171 + 12*sf + 6*noon + jitter
	hi := 229 + 30*sf*noon + 7*math.Sin(ls*rad) + jitter
	delta := math.Max(0, tau-0.45)
	lo += math.Min(14, delta*5.2)
	hi -= math.Min(24, delta*9.5)
	if scenario == "cold-snap" {
		lo -= 11
		hi -= 21
	}
	if scenario == "dust-storm" {
		lo += 4
		hi -= 14
	}
	lo = clamp(lo, 150, 230)
	hi = math.Max(lo+18, math.Min(295, hi))
	return AirTemp{MinK: round(lo, 2), MaxK: round(hi, 2)}
}
func estimateLs(date time.Time) float64 {
	dt := float64(date.Unix())/86400 + 2440587.5 - 2451545
	m := (19.387 + 0.52402075*dt) * rad
	pbs := 0.0071 * math.Cos((0.985626*dt/2.2353+49.409)*rad)
	return wrap(270.3863+0.5240384*dt+(10.691+3e-7*dt)*math.Sin(m)+0.623*math.Sin(2*m)+0.05*math.Sin(3*m)+pbs, 360)
}
func validateOptions(o Options) error {
	if o.Sol < 0 || o.Sol > 1000000 {
		return fmt.Errorf("sol must be between 0 and 1000000")
	}
	if !finite(o.LMSTHour) || o.LMSTHour < 0 || o.LMSTHour > 48 {
		return fmt.Errorf("lmstHour must be in [0,48]")
	}
	if o.LsDeg != nil && !finite(*o.LsDeg) {
		return fmt.Errorf("lsDeg must be finite")
	}
	switch o.Scenario {
	case "", "auto", "nominal", "cold-snap", "dust-storm":
	default:
		return fmt.Errorf("unknown scenario %q", o.Scenario)
	}
	return nil
}

// Generate returns two simulated sols. It never reads the clock, disk or network.
// Explicit sol 0 refers to landing day. No observation is implied by the date.
func Generate(g Grid, o Options) (Snapshot, error) {
	if err := validateGrid(g); err != nil {
		return Snapshot{}, err
	}
	if err := validateOptions(o); err != nil {
		return Snapshot{}, err
	}
	scenario := o.Scenario
	if scenario == "" {
		scenario = "auto"
	}
	effective := scenario
	if effective == "auto" {
		effective = "nominal"
	}
	site := Site{ID: g.ID, Name: g.Name, Center: Coord{(g.BBox[1] + g.BBox[3]) / 2, (g.BBox[0] + g.BBox[2]) / 2}, ReferenceElevationM: g.ReferenceElevationM, MinElevationM: math.Inf(1), MaxElevationM: math.Inf(-1)}
	for i, e := range g.Elevations {
		if validCell(g, i) {
			site.MinElevationM = math.Min(site.MinElevationM, e)
			site.MaxElevationM = math.Max(site.MaxElevationM, e)
		}
	}
	if !finite(site.MinElevationM) {
		return Snapshot{}, fmt.Errorf("grid has no valid cells")
	}
	gale := strings.Contains(strings.ToLower(g.ID), "gale") || strings.Contains(strings.ToLower(g.ID), "mount-sharp") || strings.Contains(strings.ToLower(g.ID), "curiosity") || strings.Contains(strings.ToLower(g.ID), "msl")
	landing := time.Date(2021, 2, 18, 20, 55, 0, 0, time.UTC)
	if gale {
		landing = time.Date(2012, 8, 6, 5, 17, 57, 0, time.UTC)
	}
	date := time.Unix(landing.Unix()+int64(float64(o.Sol)*MarsSolSeconds), 0).UTC()
	dateLabel := date.Format("2006-01-02")
	dateNoon := time.Date(date.Year(), date.Month(), date.Day(), 12, 0, 0, 0, time.UTC)
	ls := round(estimateLs(dateNoon), 2)
	if o.LsDeg != nil {
		ls = round(wrap(*o.LsDeg, 360), 2)
	}
	tau := dust(ls, effective, o.Sol)
	p := ScalePressureByElevation(seasonalPressure(ls), g.ReferenceElevationM, -2500)
	if effective == "dust-storm" {
		p -= 6
	}
	if effective == "cold-snap" {
		p += 4
	}
	generatedAvgPa := p
	p = round(p, 2)
	swing := generatedAvgPa * (0.022 + 0.0155*math.Min(4, tau))
	pmin := round(p-swing/2, 2)
	pmax := round(p+swing/2, 2)
	w := Wind{MinMps: 0.8 + noise(o.Sol, 61)*0.8, AvgMps: 4.4 + noise(o.Sol, 67)*2, MaxMps: 9.5 + noise(o.Sol, 53)*2.2}
	if effective == "dust-storm" {
		w = Wind{MinMps: 4.2 + noise(o.Sol, 71)*1.8, AvgMps: 11.4 + noise(o.Sol, 73)*2.4, MaxMps: 18.5 + noise(o.Sol, 79)*5.2}
	}
	if effective == "cold-snap" {
		w = Wind{MinMps: 0.6 + noise(o.Sol, 83)*0.6, AvgMps: 3.2 + noise(o.Sol, 89)*1.4, MaxMps: 7.4 + noise(o.Sol, 97)*2}
	}
	dir := 108.0
	if gale {
		dir = 315
	}
	w.CompassDeg = round(wrap(dir+(noise(o.Sol, 101)-0.5)*44, 360), 1)
	setCompass(&w)
	w.MinMps = round(w.MinMps, 2)
	w.AvgMps = round(w.AvgMps, 2)
	w.MaxMps = round(w.MaxMps, 2)
	f := Forecast{Sol: o.Sol, LsDeg: ls, TerrestrialDate: dateLabel, AirTemp: temperatureRange(site.Center.Lat, ls, tau, effective, o.Sol), Pressure: Pressure{pmin, p, pmax, round(pmax-pmin, 2), g.ReferenceElevationM}, Wind: w, DustOpacityTau: tau, Daylight: daylight(site.Center.Lat, ls)}
	f.Hourly = buildHourly(site.Center.Lat, f)
	for _, h := range f.Hourly {
		f.AirTemp.AvgK += h.TempK / 24
	}
	f.AirTemp.AvgK = round(f.AirTemp.AvgK, 2)
	s := Snapshot{Forecast: f, Site: site, Scenario: scenario, IsSimulated: true, SourceType: "simulated", SourceLabel: "Simulated Mars climatology (" + effective + ")", Disclaimer: "Simulated weather, including the next-sol forecast and terrain corrections. Not live spacecraft telemetry or a validated suit safety forecast.", RealChannels: []string{}, SimulatedChannels: []string{"airTemp", "pressure", "pressureSwing", "windSpeed", "windDirection", "dustOpacity", "uvIndex", "daylight", "hourlyCurve", "terrainCorrections", "nextSol"}}
	s.NextSol = nextForecast(s, effective)
	s.Current = sample(s, o.LMSTHour)
	return s, nil
}
func setCompass(w *Wind) {
	names := [16]string{"N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"}
	w.CompassPoint = names[int(math.Floor(w.CompassDeg/22.5+0.5))%16]
}
func buildHourly(lat float64, f Forecast) []HourlyPoint {
	out := make([]HourlyPoint, 24)
	rise, set := f.Daylight.SunriseHour, f.Daylight.SunsetHour
	hmin := math.Max(1.5, rise-0.75)
	peak := math.Min(set-1.2, 14.5)
	cool := 24 - (peak - hmin)
	tides := [24]float64{}
	tmin, tmax := math.Inf(1), math.Inf(-1)
	for h := range tides {
		x := float64(h)
		tides[h] = math.Cos((x-8.5)*2*math.Pi/24) + 0.35*math.Cos((x-9)*4*math.Pi/24)
		tmin = math.Min(tmin, tides[h])
		tmax = math.Max(tmax, tides[h])
	}
	for h := range out {
		x := float64(h)
		norm := 0.0
		if x >= hmin && x <= peak {
			norm = math.Pow(math.Sin(math.Pi/2*(x-hmin)/math.Max(0.5, peak-hmin)), 1.2)
		} else {
			dt := x - peak
			if x <= peak {
				dt += 24
			}
			v := clamp(dt/math.Max(1, cool), 0, 1)
			norm = (math.Exp(-2.6*v) - math.Exp(-2.6)) / (1 - math.Exp(-2.6))
		}
		temp := f.AirTemp.MinK + (f.AirTemp.MaxK-f.AirTemp.MinK)*norm
		p := 0.85*(f.Pressure.MinPa+(tides[h]-tmin)/(tmax-tmin)*(f.Pressure.MaxPa-f.Pressure.MinPa)) + 0.15*f.Pressure.AvgPa
		weight := math.Min(1, math.Pow(math.Max(0, math.Cos((x-14)*math.Pi/14)), 1.3)+0.25*math.Max(0, math.Cos((x-2)*math.Pi/12)))
		wind := clamp(0.75*(f.Wind.MinMps+(f.Wind.MaxMps-f.Wind.MinMps)*(0.2+0.8*weight))+0.25*f.Wind.AvgMps, f.Wind.MinMps, f.Wind.MaxMps)
		day := x >= rise && x <= set
		irradiance, uv := 0.0, 0.0
		if day {
			noon := (rise + set) / 2
			cosz := math.Max(0.04, math.Sin(lat*rad)*math.Sin(declination(f.LsDeg))+math.Cos(lat*rad)*math.Cos(declination(f.LsDeg))*math.Cos((x-noon)*math.Pi/12))
			shape := math.Max(0, math.Cos((x-noon)*math.Pi/2/math.Max(3, (set-rise)/2)))
			tau := f.DustOpacityTau
			irradiance = 589 * solarFactor(f.LsDeg) * cosz * (math.Exp(-tau/math.Max(0.2, cosz)) + 0.18*(1-math.Exp(-0.5*tau))) * (0.85 + 0.15*shape)
			uv = math.Max(0.1, 11.5*solarFactor(f.LsDeg)*cosz*math.Exp(-0.85*tau))
		}
		out[h] = HourlyPoint{x, clockLabel(x), round(temp, 2), round(p, 2), round(wind, 2), round(irradiance, 1), round(uv, 2), day}
	}
	return out
}
func nextForecast(s Snapshot, scenario string) Forecast {
	b := s.Forecast
	n := b
	n.Sol++
	n.LsDeg = round(wrap(b.LsDeg+0.51, 360), 2)
	date, _ := time.Parse("2006-01-02", b.TerrestrialDate)
	n.TerrestrialDate = date.AddDate(0, 0, 1).Format("2006-01-02")
	maxStep := 0.12
	if scenario == "dust-storm" {
		maxStep = 0.3
	}
	n.DustOpacityTau = round(math.Max(0.2, b.DustOpacityTau+clamp(dust(n.LsDeg, scenario, n.Sol)-dust(b.LsDeg, scenario, b.Sol), -maxStep, maxStep)), 2)
	p := round(b.Pressure.AvgPa+ScalePressureByElevation(seasonalPressure(n.LsDeg)-seasonalPressure(b.LsDeg), b.Pressure.ReferenceElevationM, -2500)+(noise(n.Sol, 131)-0.5)*2.2, 2)
	swing := math.Max(2, b.Pressure.SwingPa*(0.022+0.0155*math.Min(4, n.DustOpacityTau))/(0.022+0.0155*math.Min(4, b.DustOpacityTau))+(noise(n.Sol, 137)-0.5)*1.4)
	n.Pressure = Pressure{round(p-swing/2, 2), p, round(p+swing/2, 2), swing, b.Pressure.ReferenceElevationM}
	a := temperatureRange(s.Site.Center.Lat, b.LsDeg, b.DustOpacityTau, scenario, b.Sol)
	c := temperatureRange(s.Site.Center.Lat, n.LsDeg, n.DustOpacityTau, scenario, n.Sol)
	n.AirTemp.MinK = round(clamp(b.AirTemp.MinK+clamp(c.MinK-a.MinK, -2.2, 2.2), 150, 230), 2)
	n.AirTemp.MaxK = round(math.Max(n.AirTemp.MinK+18, math.Min(295, b.AirTemp.MaxK+clamp(c.MaxK-a.MaxK, -2.8, 2.8))), 2)
	shift := (noise(n.Sol, 149) - 0.5) * 1.4
	n.Wind.MinMps = round(math.Max(0.4, b.Wind.MinMps+shift*0.35), 2)
	n.Wind.AvgMps = round(math.Max(n.Wind.MinMps+0.5, b.Wind.AvgMps+shift*0.7), 2)
	n.Wind.MaxMps = round(math.Max(n.Wind.AvgMps+1, b.Wind.MaxMps+shift*1.2), 2)
	n.Wind.CompassDeg = round(wrap(b.Wind.CompassDeg+(noise(n.Sol, 151)-0.5)*18, 360), 1)
	setCompass(&n.Wind)
	n.Daylight = daylight(s.Site.Center.Lat, n.LsDeg)
	n.Hourly = buildHourly(s.Site.Center.Lat, n)
	h22, h23 := b.Hourly[22], b.Hourly[23]
	n0, n1 := n.Hourly[0], n.Hourly[1]
	tg := h23.TempK + clamp((h23.TempK-h22.TempK)*0.85, -3.5, 1) - n0.TempK
	pg := h23.PressurePa - clamp((n1.PressurePa-n0.PressurePa)*0.5, -4, 4) - n0.PressurePa
	wg := h23.WindSpeedMps - clamp((n1.WindSpeedMps-n0.WindSpeedMps)*0.5, -1.5, 1.5) - n0.WindSpeedMps
	for i, w := range []float64{1, 0.6, 0.3, 0.1} {
		h := &n.Hourly[i]
		h.TempK = round(math.Max(145, h.TempK+w*tg), 2)
		h.PressurePa = round(math.Max(100, h.PressurePa+w*pg), 2)
		h.WindSpeedMps = round(math.Max(0.2, h.WindSpeedMps+w*wg), 2)
	}
	n.AirTemp = AirTemp{MinK: math.Inf(1)}
	n.Pressure.MinPa = math.Inf(1)
	n.Pressure.MaxPa = 0
	n.Pressure.AvgPa = 0
	n.Wind.MinMps = math.Inf(1)
	n.Wind.MaxMps = 0
	n.Wind.AvgMps = 0
	for _, h := range n.Hourly {
		n.AirTemp.MinK = math.Min(n.AirTemp.MinK, h.TempK)
		n.AirTemp.MaxK = math.Max(n.AirTemp.MaxK, h.TempK)
		n.AirTemp.AvgK += h.TempK / 24
		n.Pressure.MinPa = math.Min(n.Pressure.MinPa, h.PressurePa)
		n.Pressure.MaxPa = math.Max(n.Pressure.MaxPa, h.PressurePa)
		n.Pressure.AvgPa += h.PressurePa / 24
		n.Wind.MinMps = math.Min(n.Wind.MinMps, h.WindSpeedMps)
		n.Wind.MaxMps = math.Max(n.Wind.MaxMps, h.WindSpeedMps)
		n.Wind.AvgMps += h.WindSpeedMps / 24
	}
	n.AirTemp.AvgK = round(n.AirTemp.AvgK, 2)
	n.Pressure.AvgPa = round(n.Pressure.AvgPa, 2)
	n.Pressure.SwingPa = round(n.Pressure.MaxPa-n.Pressure.MinPa, 2)
	n.Wind.AvgMps = round(n.Wind.AvgMps, 2)
	return n
}

// SampleAt rejects times beyond the forecast instead of extrapolating them.
func SampleAt(s Snapshot, hour float64) (Sample, error) {
	if !finite(hour) || hour < 0 || hour > 48 {
		return Sample{}, fmt.Errorf("sample hour must be in [0,48]")
	}
	if err := validateSnapshot(s); err != nil {
		return Sample{}, err
	}
	return sample(s, hour), nil
}
func sample(s Snapshot, h float64) Sample {
	f := s.Forecast
	local := h
	if h >= 24 {
		f = s.NextSol
		local = h - 24
	}
	i := min(47, int(math.Floor(h)))
	alpha := h - float64(i)
	get := func(i int) HourlyPoint {
		if i < 24 {
			return s.Hourly[i]
		}
		if i < 48 {
			return s.NextSol.Hourly[i-24]
		}
		return s.NextSol.Hourly[0]
	}
	a, b := get(i), get(i+1)
	lerp := func(a, b float64) float64 { return a + alpha*(b-a) }
	deltaLs := wrap(s.NextSol.LsDeg-s.LsDeg+180, 360) - 180
	ls := wrap(s.LsDeg+deltaLs*h/24, 360)
	rise, set := daylightBounds(f.Daylight)
	return Sample{HourlyPoint: HourlyPoint{local, clockLabel(local), lerp(a.TempK, b.TempK), lerp(a.PressurePa, b.PressurePa), lerp(a.WindSpeedMps, b.WindSpeedMps), round(lerp(a.SolarIrradianceWm2, b.SolarIrradianceWm2), 1), round(lerp(a.UVIndex, b.UVIndex), 2), local >= rise && local <= set}, Sol: f.Sol, OffsetHours: h, LsDeg: ls, DustOpacityTau: f.DustOpacityTau, ReferenceElevationM: f.Pressure.ReferenceElevationM}
}
