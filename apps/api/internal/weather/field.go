package weather

import (
	"context"
	"fmt"
	"math"
)

func validCell(g Grid, i int) bool { return g.Valid == nil || g.Valid[i] }
func validateGrid(g Grid) error {
	if g.Rows < 1 || g.Cols < 1 || g.Rows > 4000000/g.Cols {
		return fmt.Errorf("grid must contain 1 to 4000000 cells")
	}
	n := g.Rows * g.Cols
	if len(g.Elevations) != n || (g.Valid != nil && len(g.Valid) != n) {
		return fmt.Errorf("grid dimensions do not match elevations or valid mask")
	}
	for _, x := range g.BBox {
		if !finite(x) {
			return fmt.Errorf("bbox must be finite")
		}
	}
	if g.BBox[0] < -180 || g.BBox[2] > 180 || g.BBox[1] < -90 || g.BBox[3] > 90 || g.BBox[0] >= g.BBox[2] || g.BBox[1] >= g.BBox[3] {
		return fmt.Errorf("bbox must be ordered west,south,east,north in planetocentric degrees, longitude [-180,180]")
	}
	if !finite(g.CellSizeMeters) || g.CellSizeMeters < 0 {
		return fmt.Errorf("invalid cell size")
	}
	if !finite(g.ReferenceElevationM) || math.Abs(g.ReferenceElevationM) > 100000 {
		return fmt.Errorf("invalid reference elevation")
	}
	for i, e := range g.Elevations {
		if validCell(g, i) && (!finite(e) || math.Abs(e) > 100000) {
			return fmt.Errorf("invalid elevation at cell %d", i)
		}
	}
	return nil
}
func surfaceDistance(lat1, lon1, lat2, lon2 float64) float64 {
	h := math.Pow(math.Sin((lat2-lat1)*rad/2), 2) + math.Cos(lat1*rad)*math.Cos(lat2*rad)*math.Pow(math.Sin((lon2-lon1)*rad/2), 2)
	return 2 * MarsRadiusM * math.Asin(math.Min(1, math.Sqrt(h)))
}

func ComputeField(g Grid, o Options) (Field, error) {
	return ComputeFieldContext(context.Background(), g, o)
}

// ComputeFieldContext checks cancellation between rows and bounds allocation to
// four million cells. At one million cells, outputs use 17 MB and scratch uses
// about 12 MB. It retains no caches and does not copy the input elevations.
func ComputeFieldContext(ctx context.Context, g Grid, o Options) (Field, error) {
	if err := ctx.Err(); err != nil {
		return Field{}, err
	}
	s, err := Generate(g, o)
	if err != nil {
		return Field{}, err
	}
	if err := ctx.Err(); err != nil {
		return Field{}, err
	}
	w := s.Current
	n := g.Rows * g.Cols
	f := Field{SiteID: g.ID, Sol: w.Sol, LMSTHour: o.LMSTHour, LMSTLabel: w.LMSTLabel, Scenario: s.Scenario, IsSimulated: true, TempK: make([]float64, n), PressurePa: make([]float64, n), Valid: make([]bool, n), MinTempK: math.Inf(1), MinPressurePa: math.Inf(1)}
	lat := (g.BBox[1] + g.BBox[3]) / 2
	lon := (g.BBox[0] + g.BBox[2]) / 2
	dx := math.Max(1e-6, surfaceDistance(lat, g.BBox[0], lat, g.BBox[2])/float64(max(1, g.Cols-1)))
	dy := math.Max(1e-6, surfaceDistance(g.BBox[3], lon, g.BBox[1], lon)/float64(max(1, g.Rows-1)))
	cellSize := math.Max(dx, dy)
	if g.CellSizeMeters > 0 {
		cellSize = g.CellSizeMeters
	}
	radius := int(clamp(math.Floor(200/math.Max(10, cellSize)+0.5), 2, 10))
	// Summed-area tables provide the same square neighborhood mean as the TS
	// separable sliding window without scanning each cell's neighborhood.
	stride := g.Cols + 1
	size := (g.Rows + 1) * stride
	sums := make([]float64, size)
	counts := make([]int32, size)
	for r := 0; r < g.Rows; r++ {
		if err := ctx.Err(); err != nil {
			return Field{}, err
		}
		rowSum := 0.0
		var rowCount int32
		for c := 0; c < g.Cols; c++ {
			i := r*g.Cols + c
			if validCell(g, i) {
				rowSum += g.Elevations[i]
				rowCount++
			}
			k := (r+1)*stride + c + 1
			sums[k] = sums[k-stride] + rowSum
			counts[k] = counts[k-stride] + rowCount
		}
	}
	sx, sy, sz := solarDirection(lat, round(w.LsDeg, 2), w.OffsetHours)
	hasSolar := w.IsDaylight && w.SolarIrradianceWm2 > 0 && sz > 0.02
	amp := 5 * math.Exp(-0.55*w.DustOpacityTau) * math.Min(1.15, w.SolarIrradianceWm2/350)
	night := 1.0
	if w.IsDaylight {
		night = math.Max(0, 1-w.SolarIrradianceWm2/120) * 0.35
	}
	clear := math.Exp(-0.3 * w.DustOpacityTau)
	for r := 0; r < g.Rows; r++ {
		if err := ctx.Err(); err != nil {
			return Field{}, err
		}
		for c := 0; c < g.Cols; c++ {
			i := r*g.Cols + c
			if !validCell(g, i) {
				continue
			}
			f.Valid[i] = true
			e := g.Elevations[i]
			derivative := func(a, b int, hasA, hasB bool, spacing float64) float64 {
				if hasA {
					hasA = validCell(g, a)
				}
				if hasB {
					hasB = validCell(g, b)
				}
				if hasA && hasB {
					return (g.Elevations[b] - g.Elevations[a]) / (2 * spacing)
				}
				if hasB {
					return (g.Elevations[b] - e) / spacing
				}
				if hasA {
					return (e - g.Elevations[a]) / spacing
				}
				return 0
			}
			dzdx := derivative(i-1, i+1, c > 0, c+1 < g.Cols, dx)
			dzdy := derivative(i+g.Cols, i-g.Cols, r+1 < g.Rows, r > 0, dy)
			inv := 1 / math.Sqrt(dzdx*dzdx+dzdy*dzdy+1)
			t := LapseTempByElevation(w.TempK, e, w.ReferenceElevationM)
			if hasSolar {
				incidence := math.Max(0, (-dzdx*sx-dzdy*sy+sz)*inv)
				t += amp * clamp((incidence-sz)/math.Max(0.2, sz), -1, 1.2)
			}
			top, bottom := max(0, r-radius), min(g.Rows, r+radius+1)
			left, right := max(0, c-radius), min(g.Cols, c+radius+1)
			a, b, cc, d := top*stride+left, top*stride+right, bottom*stride+left, bottom*stride+right
			count := counts[d] - counts[b] - counts[cc] + counts[a]
			if count > 0 {
				mean := (sums[d] - sums[b] - sums[cc] + sums[a]) / float64(count)
				depth := math.Max(0, mean-e)
				t -= math.Min(2.5*night*clear, depth*0.02*night*clear)
			}
			p := ScalePressureByElevation(w.PressurePa, e, w.ReferenceElevationM)
			f.TempK[i] = t
			f.PressurePa[i] = p
			f.ValidCount++
			f.MeanTempK += t
			f.MeanPressurePa += p
			f.MinTempK = math.Min(f.MinTempK, t)
			f.MaxTempK = math.Max(f.MaxTempK, t)
			f.MinPressurePa = math.Min(f.MinPressurePa, p)
			f.MaxPressurePa = math.Max(f.MaxPressurePa, p)
		}
	}
	f.MeanTempK /= float64(f.ValidCount)
	f.MeanPressurePa /= float64(f.ValidCount)
	f.MinTempC = f.MinTempK - 273.15
	f.MaxTempC = f.MaxTempK - 273.15
	f.MeanTempC = f.MeanTempK - 273.15
	return f, nil
}
