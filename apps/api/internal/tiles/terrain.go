package tiles

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"log"
	"math"
	"net/http"
	"strings"
)

const (
	TerrainPath = "/api/terrain/mars-v14"

	terrainUpstream         = "https://marshub.s3.amazonaws.com/mars_v14"
	terrainVersion          = "2.0"
	terrainMaxBytes         = 2 * 1024 * 1024
	terrainMetadataMaxBytes = 16 * 1024 * 1024
	terrainCacheControl     = "public, max-age=2592000"
)

// RegisterTerrain proxies Mars quantized meshes and returns a cache flush function.
func RegisterTerrain(mux *http.ServeMux, cacheDir string, client *http.Client) func() {
	if client == nil {
		client = http.DefaultClient
	}
	// Metadata and meshes share the original disk keys and eviction budget.
	// As in the TypeScript API, validation happens before downloads enter the cache.
	cache := NewCache(cacheDir, 8192, 16*1024*1024, nil)

	mux.HandleFunc("GET "+TerrainPath+"/layer.json", func(w http.ResponseWriter, r *http.Request) {
		data, err := cache.Get(r.Context(), "layer.json", func(ctx context.Context) ([]byte, error) {
			data, _, err := Fetch(ctx, client, terrainUpstream+"/layer.json", terrainMetadataMaxBytes)
			if err != nil {
				return nil, err
			}
			return localTerrainMetadata(data)
		})
		if err != nil {
			log.Printf("Terrain metadata unavailable: %v", err)
			writeTerrainUnavailable(w, "Terrain metadata unavailable")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", terrainCacheControl)
		_, _ = w.Write(data)
	})

	mux.HandleFunc("GET "+TerrainPath+"/{z}/{x}/{file}", func(w http.ResponseWriter, r *http.Request) {
		z, x, file := r.PathValue("z"), r.PathValue("x"), r.PathValue("file")
		y, hasSuffix := strings.CutSuffix(file, ".terrain")
		zoom, zErr := ParseCoordinate(z, 18)
		valid := false
		if zErr == nil && hasSuffix {
			_, xErr := ParseCoordinate(x, (1<<(zoom+1))-1)
			_, yErr := ParseCoordinate(y, (1<<zoom)-1)
			valid = xErr == nil && yErr == nil
		}
		if !valid {
			w.Header().Set("Content-Type", "text/plain; charset=UTF-8")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte("Invalid terrain tile coordinates"))
			return
		}
		// Mars uses planetocentric latitude and east longitude in [-180, 180].
		// Keep TMS row order, twice as many columns as rows, and mesh bytes unchanged.
		data, err := cache.Get(r.Context(), z+"-"+x+"-"+y+".terrain", func(ctx context.Context) ([]byte, error) {
			data, headers, err := Fetch(ctx, client, terrainUpstream+"/"+z+"/"+x+"/"+y+".terrain?v="+terrainVersion, terrainMaxBytes)
			if err != nil {
				return nil, err
			}
			if strings.Contains(strings.ToLower(headers.Get("Content-Type")), "text/") {
				return nil, errors.New("invalid terrain tile content type")
			}
			if err := validateTerrainMesh(data); err != nil {
				return nil, err
			}
			return data, nil
		})
		if err != nil {
			log.Printf("Terrain tile unavailable: %v", err)
			writeTerrainUnavailable(w, "Terrain tile unavailable")
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Cache-Control", terrainCacheControl)
		_, _ = w.Write(data)
	})
	return cache.Flush
}

func localTerrainMetadata(data []byte) ([]byte, error) {
	// Raw fields preserve availability, extensions, and numeric precision.
	var metadata map[string]json.RawMessage
	if err := json.Unmarshal(data, &metadata); err != nil {
		return nil, err
	}
	var format, version string
	var available []json.RawMessage
	if json.Unmarshal(metadata["format"], &format) != nil || format != "quantized-mesh-1.0" ||
		json.Unmarshal(metadata["version"], &version) != nil || version != terrainVersion ||
		json.Unmarshal(metadata["available"], &available) != nil || available == nil {
		return nil, errors.New("unexpected terrain metadata")
	}
	metadata["tiles"] = json.RawMessage(`["{z}/{x}/{y}.terrain?v=` + terrainVersion + `"]`)
	return json.Marshal(metadata)
}

func validateTerrainMesh(data []byte) error {
	if len(data) < 96 || len(data) > terrainMaxBytes {
		return errors.New("invalid terrain tile size")
	}
	count := uint64(binary.LittleEndian.Uint32(data[88:92]))
	minHeight := float64(math.Float32frombits(binary.LittleEndian.Uint32(data[24:28])))
	maxHeight := float64(math.Float32frombits(binary.LittleEndian.Uint32(data[28:32])))
	if count == 0 || 92+count*6+4 > uint64(len(data)) ||
		math.IsNaN(minHeight) || math.IsInf(minHeight, 0) ||
		math.IsNaN(maxHeight) || math.IsInf(maxHeight, 0) {
		return errors.New("invalid quantized-mesh header")
	}
	return nil
}

func writeTerrainUnavailable(w http.ResponseWriter, message string) {
	w.Header().Set("Content-Type", "text/plain; charset=UTF-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusBadGateway)
	_, _ = w.Write([]byte(message))
}
