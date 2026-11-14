package planner

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/png"
	"math"
)

const marsRadiusM = 3396190

var directions = [8][2]int{{-1, 0}, {1, 0}, {0, -1}, {0, 1}, {-1, -1}, {-1, 1}, {1, -1}, {1, 1}}

// Graph keeps immutable private terrain data. The exported fields are detached
// snapshots for consumers such as weather modeling; changing them cannot change
// routing. Consumers must synchronize their own writes to those snapshots.
type Graph struct {
	Meta       Metadata
	Elevations []float64
	Valid      []bool
	meta       Metadata
	elevations []float64
	valid      []bool
	localSlope []float64
	dx, dy     float64
	distances  [8]float64
}

func finite(v float64) bool            { return !math.IsNaN(v) && !math.IsInf(v, 0) }
func clamp(v, lo, hi float64) float64  { return math.Max(lo, math.Min(hi, v)) }
func rounded(v, scale float64) float64 { return math.Floor(v*scale+0.5) / scale }
func ptr(v float64) *float64           { return &v }
func normalizeLon(v float64) float64 {
	// Already-normalized coordinates must keep their precision at DEM boundaries.
	if v >= -180 && v < 180 {
		return v
	}
	return math.Mod(math.Mod(v+180, 360)+360, 360) - 180
}
func surfaceDistance(a, b Coord) float64 {
	lat1, lat2 := a.Lat*(math.Pi/180), b.Lat*(math.Pi/180)
	dlat, dlon := (b.Lat-a.Lat)*(math.Pi/180), normalizeLon(b.Lon-a.Lon)*(math.Pi/180)
	h := math.Pow(math.Sin(dlat/2), 2) + math.Cos(lat1)*math.Cos(lat2)*math.Pow(math.Sin(dlon/2), 2)
	return 2 * marsRadiusM * math.Asin(math.Min(1, math.Sqrt(h)))
}

func NewGraph(dataset Dataset) (*Graph, error) {
	m := dataset.Meta
	if m.Rows <= 0 || m.Cols <= 0 || m.Rows > int(^uint(0)>>1)/m.Cols || m.Rows*m.Cols != len(dataset.ElevationsM) {
		return nil, fmt.Errorf("terrain dimensions must be positive and match elevationsM")
	}
	for _, v := range m.BBox {
		if !finite(v) {
			return nil, fmt.Errorf("terrain bbox must be finite")
		}
	}
	w, s, e, n := m.BBox[0], m.BBox[1], m.BBox[2], m.BBox[3]
	if w < -180 || e > 180 || s < -90 || n > 90 || w > e || s > n || (m.Cols > 1 && w == e) || (m.Rows > 1 && s == n) {
		return nil, fmt.Errorf("terrain bbox must be ordered, normalized lon/lat bounds with nonzero grid spacing")
	}
	for _, v := range []float64{m.Center.Lat, m.Center.Lon, m.WidthMeters, m.HeightMeters, m.CellSizeMeters, m.MinElevationM, m.MaxElevationM, m.NodataValue} {
		if !finite(v) {
			return nil, fmt.Errorf("terrain metadata must be finite")
		}
	}
	g := &Graph{Meta: m, meta: m, elevations: make([]float64, len(dataset.ElevationsM)), valid: make([]bool, len(dataset.ElevationsM)), localSlope: make([]float64, len(dataset.ElevationsM))}
	g.dx = surfaceDistance(Coord{(s + n) / 2, w}, Coord{(s + n) / 2, e}) / float64(max(1, m.Cols-1))
	g.dy = surfaceDistance(Coord{n, (w + e) / 2}, Coord{s, (w + e) / 2}) / float64(max(1, m.Rows-1))
	for d, dir := range directions {
		g.distances[d] = math.Hypot(float64(dir[0])*g.dy, float64(dir[1])*g.dx)
	}
	// Match the reviewed engine's Float32 DEM and sentinel representation.
	nodata := float64(float32(m.NodataValue))
	for i, v := range dataset.ElevationsM {
		g.elevations[i] = float64(float32(v))
		g.valid[i] = finite(g.elevations[i]) && g.elevations[i] != nodata
	}
	for u := range g.elevations {
		if !g.valid[u] {
			continue
		}
		for d := range directions {
			if v, ok := g.neighbor(u, d); ok && g.valid[v] {
				g.localSlope[u] = math.Max(g.localSlope[u], g.slope(u, v, g.distances[d]))
			}
		}
		g.localSlope[u] = float64(float32(g.localSlope[u]))
	}
	g.Elevations = append([]float64(nil), g.elevations...)
	g.Valid = append([]bool(nil), g.valid...)
	return g, nil
}

func (g *Graph) Inside(c Coord) bool {
	lon := normalizeLon(c.Lon)
	return finite(c.Lat) && finite(c.Lon) && c.Lat >= g.meta.BBox[1] && c.Lat <= g.meta.BBox[3] && lon >= g.meta.BBox[0] && lon <= g.meta.BBox[2]
}
func (g *Graph) CoordForCell(row, col int) Coord {
	b := g.meta.BBox
	return Coord{b[3] - float64(row)/float64(max(1, g.meta.Rows-1))*(b[3]-b[1]), normalizeLon(b[0] + float64(col)/float64(max(1, g.meta.Cols-1))*(b[2]-b[0]))}
}
func (g *Graph) fractional(c Coord) (float64, float64) {
	b := g.meta.BBox
	return clamp((b[3]-c.Lat)/math.Max(1e-9, b[3]-b[1])*float64(g.meta.Rows-1), 0, float64(g.meta.Rows-1)), clamp((normalizeLon(c.Lon)-b[0])/math.Max(1e-9, b[2]-b[0])*float64(g.meta.Cols-1), 0, float64(g.meta.Cols-1))
}
func (g *Graph) ElevationAt(c Coord) *float64 {
	if !g.Inside(c) {
		return nil
	}
	r, cx := g.fractional(c)
	r0, c0 := int(math.Floor(r)), int(math.Floor(cx))
	r1, c1 := min(g.meta.Rows-1, r0+1), min(g.meta.Cols-1, c0+1)
	fr, fc := r-float64(r0), cx-float64(c0)
	indices := [4]int{r0*g.meta.Cols + c0, r0*g.meta.Cols + c1, r1*g.meta.Cols + c0, r1*g.meta.Cols + c1}
	weights := [4]float64{(1 - fr) * (1 - fc), (1 - fr) * fc, fr * (1 - fc), fr * fc}
	elevation := 0.0
	for j, i := range indices {
		if weights[j] == 0 {
			continue
		}
		if !g.valid[i] {
			return nil
		}
		elevation += g.elevations[i] * weights[j]
	}
	return ptr(rounded(elevation, 100))
}
func (g *Graph) snap(c Coord) int {
	r, col := g.fractional(c)
	i := int(math.Floor(r+0.5))*g.meta.Cols + int(math.Floor(col+0.5))
	if !g.valid[i] {
		return -1
	}
	return i
}
func (g *Graph) neighbor(u, d int) (int, bool) {
	dir := directions[d]
	r, c := u/g.meta.Cols+dir[0], u%g.meta.Cols+dir[1]
	if r < 0 || r >= g.meta.Rows || c < 0 || c >= g.meta.Cols {
		return 0, false
	}
	return r*g.meta.Cols + c, true
}
func (g *Graph) slope(u, v int, dist float64) float64 {
	return math.Atan(math.Abs(g.elevations[v]-g.elevations[u])/math.Max(1e-6, dist)) * 180 / math.Pi
}
func (g *Graph) diagonalSlope(u, v, d int) float64 {
	dir := directions[d]
	x, y := u+dir[1], u+dir[0]*g.meta.Cols
	if !g.valid[x] || !g.valid[y] {
		return math.Inf(1)
	}
	return math.Max(math.Max(g.slope(u, x, g.dx), g.slope(x, v, g.dy)), math.Max(g.slope(u, y, g.dy), g.slope(y, v, g.dx)))
}
func (g *Graph) edgePassable(u, v, d int, maxSlope, tanMax float64, w *weatherContext) bool {
	if !g.valid[v] || !w.passable(v) {
		return false
	}
	if d >= 4 {
		dir := directions[d]
		if g.diagonalSlope(u, v, d) > maxSlope || !w.passable(u+dir[1]) || !w.passable(u+dir[0]*g.meta.Cols) {
			return false
		}
	}
	return math.Abs(g.elevations[v]-g.elevations[u]) <= g.distances[d]*tanMax+1e-9
}
func (g *Graph) passableRatio(ctx context.Context, limit float64) (float64, error) {
	total, pass := 0, 0
	tan := math.Tan(limit * math.Pi / 180)
	for u := range g.elevations {
		if u%1024 == 0 {
			if err := ctx.Err(); err != nil {
				return 0, err
			}
		}
		if !g.valid[u] {
			continue
		}
		for _, d := range []int{3, 1, 7, 6} {
			v, ok := g.neighbor(u, d)
			if !ok || !g.valid[v] {
				continue
			}
			if d >= 4 && math.IsInf(g.diagonalSlope(u, v, d), 1) {
				continue
			}
			total++
			if g.edgePassable(u, v, d, limit, tan, nil) {
				pass++
			}
		}
	}
	if total == 0 {
		return 0, nil
	}
	return rounded(float64(pass)/float64(total), 1000), nil
}

type contextWriter struct {
	ctx    context.Context
	buffer bytes.Buffer
}

func (w *contextWriter) Write(p []byte) (int, error) {
	if err := w.ctx.Err(); err != nil {
		return 0, err
	}
	return w.buffer.Write(p)
}

func (g *Graph) SlopeMask(ctx context.Context, maxSlope float64) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !finite(maxSlope) {
		return nil, fmt.Errorf("maxSlopeDeg must be finite")
	}
	limit := clamp(maxSlope, 0, 89)
	img := image.NewNRGBA(image.Rect(0, 0, g.meta.Cols, g.meta.Rows))
	for u, s := range g.localSlope {
		if u%1024 == 0 {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
		}
		if !g.valid[u] {
			continue
		}
		p := img.Pix[4*u : 4*u+4]
		if s > limit {
			copy(p, []byte{245, 158, 11, 175})
		} else if s > limit*0.75 {
			copy(p, []byte{234, 179, 8, 55})
		}
	}
	out := contextWriter{ctx: ctx}
	enc := png.Encoder{CompressionLevel: png.BestSpeed}
	if err := enc.Encode(&out, img); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return out.buffer.Bytes(), nil
}
