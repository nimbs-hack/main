package planner

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

func TestScienceMissionSurvivesImportAndExport(t *testing.T) {
	mission := example(t, "yellowknife-science.json")
	file := encode(t, mission)
	committed, err := Examples.ReadFile("examples/yellowknife-science.mhr")
	if err != nil || string(file) != string(committed) {
		t.Fatalf("packed science example differs from its JSON: %v", err)
	}
	if file[6]>>4 != 4 || len(mission.Markers) != 10 || !strings.Contains(mission.Briefing, "https://science.nasa.gov/") {
		t.Fatal("science mission must carry its symbols and sources in version 4")
	}
	url := server(t).URL + "/api/planner"
	body, _ := json.Marshal(map[string]Mission{"mission": mission})
	status, fields := call(t, http.MethodPost, url+"/plan", string(body))
	if status != http.StatusOK {
		t.Fatalf("import: %d %s", status, fields["error"])
	}
	var planned planResponse
	raw, _ := json.Marshal(fields)
	if err := json.Unmarshal(raw, &planned); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(planned.Mission, mission) {
		t.Fatal("JSON import lost mission fields")
	}
	packed, err := base64.StdEncoding.DecodeString(planned.File)
	if err != nil || string(packed) != string(file) {
		t.Fatalf("API export differs from CLI file: %v", err)
	}
	status, fields = call(t, http.MethodPost, url+"/decode", string(packed))
	var decoded Mission
	err = json.Unmarshal(fields["mission"], &decoded)
	if status != http.StatusOK || err != nil || !reflect.DeepEqual(decoded, mission) {
		t.Fatalf("packed import differs: %d %v", status, err)
	}
	if planned.Plan.Total.EVAHours != 8 || planned.Plan.UnassignedTaskHours != 0 || len(planned.Plan.EVAOverruns) != 0 {
		t.Fatal("science tasks must fit the two four-hour EVA allocations")
	}
	for i, person := range planned.Plan.Crew {
		if person.TaskHours.EVA != person.Total.EVAHours {
			t.Errorf("crew %d: tasks and provisioned EVA hours differ", i)
		}
	}
}

func TestMarkerValidationAndUnicodeRoundTrip(t *testing.T) {
	mission := bare(t)
	mission.Markers = []Marker{{ID: "a3ec73a5-4d38-480a-b837-9c4a551d29f7", Symbol: "mil2525c-sample", Point: [2]float64{-4.5896404, 137.4493304}, Label: "Зразок породи"}}
	mission.Briefing = "Sample notes\nМісія\nhttps://science.nasa.gov/"
	normalized, err := Normalize(mission)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeMission(encode(t, mission))
	if err != nil || !reflect.DeepEqual(decoded, normalized) || decoded.Markers[0].Point != [2]float64{-4.58964, 137.44933} {
		t.Fatalf("Unicode/coordinates round trip: %+v, %v", decoded.Markers, err)
	}
	cases := []struct {
		name string
		edit func(*Mission)
	}{
		{"unknown symbol", func(m *Mission) { m.Markers[0].Symbol = "mil2525c-missing" }},
		{"latitude", func(m *Mission) { m.Markers[0].Point[0] = 91 }},
		{"longitude", func(m *Mission) { m.Markers[0].Point[1] = 181 }},
		{"duplicate id", func(m *Mission) { m.Markers = append(m.Markers, m.Markers[0]) }},
		{"empty id", func(m *Mission) { m.Markers[0].ID = "" }},
		{"label control", func(m *Mission) { m.Markers[0].Label = "bad\x00label" }},
		{"long briefing", func(m *Mission) { m.Briefing = strings.Repeat("x", 16001) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			candidate := mission
			candidate.Markers = append([]Marker(nil), mission.Markers...)
			tc.edit(&candidate)
			if _, err := EncodeMission(candidate, PacketOptions{}); err == nil {
				t.Fatal("invalid mission was accepted")
			}
		})
	}
}

func TestVersionFourRejectsDamagedOrOversizedExtras(t *testing.T) {
	mission := bare(t)
	base := encode(t, mission)
	mission.Briefing = "Source and assumptions"
	file := encode(t, mission)
	start := len(base) - crcBytes
	length := append([]byte(nil), file...)
	length[start], length[start+1] = 0xff, 0xff
	refused(t, resealed(length), "it ends before the symbols and briefing do")
	invalid := append([]byte(nil), file...)
	invalid[start+2] = '!'
	refused(t, resealed(invalid), "symbols and briefing are not a JSON object")
	file[start+3] ^= 1
	refused(t, file, "checksum mismatch")
	for i := range 255 {
		mission.Markers = append(mission.Markers, Marker{ID: fmt.Sprintf("%064d", i), Symbol: "mil2525c-sample", Label: strings.Repeat("x", 160)})
	}
	if _, err := EncodeMission(mission, PacketOptions{}); err == nil || !strings.Contains(err.Error(), "exceed") {
		t.Fatalf("oversized packet: %v", err)
	}
}
