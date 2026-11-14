package planner

import (
	"context"
	"fmt"
	"math"
	"slices"
)

type weatherContext struct {
	temperature, pressure                                                                   []float64
	minTemp, minPressure, weight, maxTemp, maxPressure, tempSpan, pressureSpan, cautionSpan float64
	checkTemp, checkPressure                                                                bool
}

func (g *Graph) weather(ctx context.Context, f *WeatherFilter) (*weatherContext, error) {
	if f == nil {
		return nil, nil
	}
	n := len(g.elevations)
	if len(f.CellTempK) != n || len(f.CellPressurePa) != n {
		return nil, fmt.Errorf("weather field dimensions mismatch: expected %d cells, got temp=%d, pressure=%d", n, len(f.CellTempK), len(f.CellPressurePa))
	}
	for _, v := range []float64{f.LMSTHour, f.MinAirTempC, f.MinPressurePa, f.ThermalWeight} {
		if !finite(v) {
			return nil, fmt.Errorf("weather constraints must be finite")
		}
	}
	w := &weatherContext{temperature: make([]float64, n), pressure: make([]float64, n), minTemp: f.MinAirTempC + 273.15, minPressure: f.MinPressurePa, weight: clamp(f.ThermalWeight, 0, 1), checkTemp: true, checkPressure: true}
	w.maxTemp, w.maxPressure = w.minTemp, w.minPressure
	for i := range g.elevations {
		if i%1024 == 0 {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
		}
		w.temperature[i], w.pressure[i] = float64(float32(f.CellTempK[i])), float64(float32(f.CellPressurePa[i]))
		if !g.valid[i] {
			continue
		}
		if t := w.temperature[i]; finite(t) {
			w.maxTemp = math.Max(w.maxTemp, t)
		}
		if p := w.pressure[i]; finite(p) {
			w.maxPressure = math.Max(w.maxPressure, p)
		}
	}
	w.tempSpan = math.Max(5, w.maxTemp-w.minTemp)
	w.pressureSpan = math.Max(10, w.maxPressure-w.minPressure)
	w.cautionSpan = math.Max(10, w.minPressure*0.04)
	return w, nil
}
func (w *weatherContext) passable(i int) bool {
	if w == nil {
		return true
	}
	t, p := w.temperature[i], w.pressure[i]
	return finite(t) && finite(p) && (!w.checkTemp || t >= w.minTemp) && (!w.checkPressure || p >= w.minPressure)
}
func (w *weatherContext) risk(i int) float64 {
	td := clamp((w.maxTemp-w.temperature[i])/w.tempSpan, 0, 1)
	pd := clamp((w.maxPressure-w.pressure[i])/w.pressureSpan, 0, 1)
	nearT := math.Max(0, 1-math.Max(0, w.temperature[i]-w.minTemp)/5)
	nearP := math.Max(0, 1-math.Max(0, w.pressure[i]-w.minPressure)/w.cautionSpan)
	return 0.55*td + 0.45*pd + 0.6*math.Max(nearT, nearP)
}

type heapEntry struct {
	node  int
	score float64
}
type minHeap []heapEntry

// Preserve the reviewed engine's insertion-order handling of equal scores.
func (h *minHeap) push(node int, score float64) {
	*h = append(*h, heapEntry{node, score})
	i := len(*h) - 1
	for i > 0 {
		p := (i - 1) / 2
		if (*h)[p].score <= (*h)[i].score {
			break
		}
		(*h)[p], (*h)[i] = (*h)[i], (*h)[p]
		i = p
	}
}
func (h *minHeap) pop() heapEntry {
	first := (*h)[0]
	last := (*h)[len(*h)-1]
	*h = (*h)[:len(*h)-1]
	if len(*h) == 0 {
		return first
	}
	(*h)[0] = last
	for i := 0; ; {
		l, r, small := i*2+1, i*2+2, i
		if l < len(*h) && (*h)[l].score < (*h)[small].score {
			small = l
		}
		if r < len(*h) && (*h)[r].score < (*h)[small].score {
			small = r
		}
		if small == i {
			break
		}
		(*h)[i], (*h)[small] = (*h)[small], (*h)[i]
		i = small
	}
	return first
}

// Each request owns its scratch buffers and reuses them across strategy searches.
type searchState struct {
	score           []float64
	parent          []int
	closed, penalty []bool
	heap            minHeap
}

func newSearch(n int) *searchState {
	return &searchState{score: make([]float64, n), parent: make([]int, n), closed: make([]bool, n), penalty: make([]bool, n)}
}
func (s *searchState) reset(ctx context.Context) error {
	s.heap = s.heap[:0]
	for i := range s.score {
		if i%1024 == 0 {
			if err := ctx.Err(); err != nil {
				return err
			}
		}
		s.score[i] = math.Inf(1)
		s.parent[i] = -1
		s.closed[i] = false
	}
	return nil
}
func (g *Graph) heuristic(u, goal int) float64 {
	return math.Hypot(float64(u/g.meta.Cols-goal/g.meta.Cols)*g.dy, float64(u%g.meta.Cols-goal%g.meta.Cols)*g.dx)
}
func (g *Graph) astar(ctx context.Context, s *searchState, start, goal int, limit float64, mode string, w *weatherContext) ([]int, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !w.passable(start) || !w.passable(goal) {
		return nil, nil
	}
	if err := s.reset(ctx); err != nil {
		return nil, err
	}
	s.score[start] = 0
	s.heap.push(start, g.heuristic(start, goal))
	tan := math.Tan(limit * math.Pi / 180)
	for len(s.heap) > 0 {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		u := s.heap.pop().node
		if u == goal {
			path := []int{}
			for cur := goal; cur != -1; cur = s.parent[cur] {
				path = append(path, cur)
			}
			slices.Reverse(path)
			return path, nil
		}
		if s.closed[u] {
			continue
		}
		s.closed[u] = true
		for d := range directions {
			v, ok := g.neighbor(u, d)
			if !ok || s.closed[v] || !g.edgePassable(u, v, d, limit, tan, w) {
				continue
			}
			dist := g.distances[d]
			cost := dist
			switch mode {
			case "gentlest", "weather-safe":
				ratio := g.slope(u, v, dist) / math.Max(1, limit)
				thermal := 0.0
				if w != nil && w.weight > 0 {
					thermal = w.weight * w.risk(v)
				}
				if mode == "gentlest" {
					cost = dist * (1 + 4.5*ratio*ratio + thermal)
				} else {
					cost = dist * (1 + 80*thermal + 0.5*ratio*ratio)
				}
			case "alternate":
				if s.penalty[v] {
					cost = dist * 3.5
				}
			}
			next := s.score[u] + cost
			if next < s.score[v] {
				s.score[v] = next
				s.parent[v] = u
				s.heap.push(v, next+g.heuristic(v, goal))
			}
		}
	}
	return nil, nil
}

// With values=nil this is minimax slope Dijkstra. Otherwise it maximizes the
// minimum weather value, keeping the other weather constraint active.
func (g *Graph) bottleneck(ctx context.Context, s *searchState, start, goal int, limit float64, values []float64, w *weatherContext) (*float64, error) {
	if err := s.reset(ctx); err != nil {
		return nil, err
	}
	if !g.valid[start] || !g.valid[goal] || !w.passable(start) || !w.passable(goal) {
		return nil, nil
	}
	s.score[start] = 0
	if values != nil {
		s.score[start] = -values[start]
	}
	s.heap.push(start, s.score[start])
	tan := math.Tan(limit * math.Pi / 180)
	for len(s.heap) > 0 {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		item := s.heap.pop()
		u := item.node
		if u == goal {
			if values != nil {
				return ptr(-s.score[u]), nil
			}
			return ptr(math.Ceil(item.score*10) / 10), nil
		}
		if s.closed[u] {
			continue
		}
		s.closed[u] = true
		for d, dir := range directions {
			v, ok := g.neighbor(u, d)
			if !ok || !g.valid[v] || s.closed[v] {
				continue
			}
			var candidate float64
			if values == nil {
				slope := g.slope(u, v, g.distances[d])
				if d >= 4 {
					slope = math.Max(slope, g.diagonalSlope(u, v, d))
				}
				candidate = math.Max(s.score[u], slope)
			} else {
				if !g.edgePassable(u, v, d, limit, tan, w) {
					continue
				}
				candidate = math.Max(s.score[u], -values[v])
				if d >= 4 {
					candidate = math.Max(candidate, math.Max(-values[u+dir[1]], -values[u+dir[0]*g.meta.Cols]))
				}
			}
			if candidate < s.score[v] {
				s.score[v] = candidate
				s.heap.push(v, candidate)
			}
		}
	}
	return nil, nil
}
