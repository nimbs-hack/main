package planner

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func example(t *testing.T, name string) Mission {
	t.Helper()
	source, err := Examples.ReadFile("examples/" + name)
	if err != nil {
		t.Fatal(err)
	}
	rosterFile, err := Examples.ReadFile("examples/roster.json")
	if err != nil {
		t.Fatal(err)
	}
	var roster struct{ Astronauts json.RawMessage }
	if err := json.Unmarshal(rosterFile, &roster); err != nil {
		t.Fatal(err)
	}
	mission, err := ParseMission(source, roster.Astronauts)
	if err != nil {
		t.Fatal(err)
	}
	return mission
}

func encode(t *testing.T, mission Mission) []byte {
	t.Helper()
	data, err := EncodeMission(mission, PacketOptions{})
	if err != nil {
		t.Fatalf("EncodeMission: %v", err)
	}
	return data
}

// bare is the example mission with no sites or tasks, for tests that count bytes.
func bare(t *testing.T) Mission {
	mission := example(t, "ares-3.json")
	mission.Sites, mission.Tasks = []Site{}, []Task{}
	return mission
}

func TestCRC16MatchesTheCCITTFalseCheckValue(t *testing.T) {
	if got := CRC16([]byte("123456789")); got != 0x29b1 {
		t.Errorf("CRC16 = %#x, want 0x29b1", got)
	}
}

func TestMissionsSurviveARoundTripUnchanged(t *testing.T) {
	for _, name := range []string{"ares-3.json", "gale-traverse.json"} {
		mission := example(t, name)
		decoded, err := DecodeMission(encode(t, mission))
		if err != nil || !reflect.DeepEqual(decoded, mission) {
			t.Errorf("%s: decoded mission differs (err %v)", name, err)
		}
		if !reflect.DeepEqual(PlanMission(decoded), PlanMission(mission)) {
			t.Errorf("%s: plans differ after a round trip", name)
		}
	}
}

func TestTheEncoderStillWritesTheCommittedExampleFile(t *testing.T) {
	committed, err := Examples.ReadFile("examples/ares-3.mhr")
	if err != nil {
		t.Fatal(err)
	}
	if string(encode(t, example(t, "ares-3.json"))) != string(committed) {
		t.Error("examples/ares-3.mhr no longer matches what the encoder writes for ares-3.json")
	}
}

func TestTheFileIsACCSDSSpacePacket(t *testing.T) {
	data, err := EncodeMission(example(t, "ares-3.json"), PacketOptions{SequenceCount: 5})
	if err != nil {
		t.Fatal(err)
	}
	first := int(data[0])<<8 | int(data[1])
	if first>>13 != 0 || first>>12&1 != 1 || first&0x7ff != DefaultAPID {
		t.Errorf("first header word = %#x", first)
	}
	if got := int(data[2])<<8 | int(data[3]); got != 0b11<<14|5 {
		t.Errorf("sequence word = %#x", got)
	}
	if got := int(data[4])<<8 | int(data[5]); got != len(data)-6-1 {
		t.Errorf("length field = %d, file is %d bytes", got, len(data))
	}
	packet, err := DecodePacket(data)
	if err != nil || packet.APID != DefaultAPID || packet.SequenceCount != 5 {
		t.Errorf("packet = %+v, %v", packet, err)
	}
	if _, err := EncodeMission(bare(t), PacketOptions{APID: 4096}); err == nil {
		t.Error("an application id over 11 bits passed")
	}
}

func TestTheFileStaysSmall(t *testing.T) {
	mission := bare(t)
	data := encode(t, mission)
	// 6 header, 6 mission, 7 name, 6 crew at 7 bytes plus names, 3 phases at 4, 2 checksum.
	if len(data) != 112 {
		t.Errorf("bare mission is %d bytes, want 112", len(data))
	}
	asJSON, _ := json.Marshal(mission)
	if len(asJSON)/len(data) < 10 {
		t.Errorf("JSON is only %d bytes against %d", len(asJSON), len(data))
	}
	// Three sites and six tasks, two of them with notes, double it.
	if got := len(encode(t, example(t, "ares-3.json"))); got != 225 {
		t.Errorf("example mission is %d bytes, want 225", got)
	}
}

func TestASiteCostsNineBytesPlusItsNameATaskSixPlusItsNote(t *testing.T) {
	mission := bare(t)
	base := len(encode(t, mission))
	mission.Sites = []Site{{"A", -4.5895, 137.4417}}
	withSite := len(encode(t, mission))
	two := 2
	mission.Tasks = []Task{{Site: 0, Phase: 1, Crew: &two, Kind: "sample", EVA: true, Hours: 3}}
	withTask := len(encode(t, mission))
	if withSite-base != 9+1 || withTask-withSite != 6 {
		t.Errorf("site adds %d bytes, task adds %d", withSite-base, withTask-withSite)
	}
}

func TestCoordinatesKeepTheirSignAndSixDecimals(t *testing.T) {
	mission := bare(t)
	mission.Sites = []Site{{"SW", -89.999999, -179.999999}, {"NE", 90, 180}, {"ZERO", 0, 0.0000004}}
	decoded, err := DecodeMission(encode(t, mission))
	want := []Site{{"SW", -89.999999, -179.999999}, {"NE", 90, 180}, {"ZERO", 0, 0}}
	if err != nil || !reflect.DeepEqual(decoded.Sites, want) {
		t.Errorf("sites = %+v, %v", decoded.Sites, err)
	}
}

func TestAnUnassignedInsideTaskSurvives(t *testing.T) {
	mission := bare(t)
	mission.Sites = []Site{{"A", 1, 2}}
	mission.Tasks = []Task{{Site: 0, Phase: 0, Kind: "other", EVA: false, Hours: 127.5, Note: "inventory"}}
	decoded, err := DecodeMission(encode(t, mission))
	if err != nil || !reflect.DeepEqual(decoded.Tasks, mission.Tasks) {
		t.Errorf("tasks = %+v, %v", decoded.Tasks, err)
	}
}

func TestAPresetPhaseCostsFourBytesAnOverrideOnlyWhatChanged(t *testing.T) {
	mission := bare(t)
	mission.Type = "custom"
	mission.Phases = []Phase{phaseOf("habitat", func(p *Phase) { p.Days = 30 })}
	plain := len(encode(t, mission))
	mission.Phases[0].WaterRecovery, mission.Phases[0].BasePowerW = 0.9, 12000
	if got := len(encode(t, mission)) - plain; got != 1+2 {
		t.Errorf("two overrides add %d bytes, want 3", got)
	}
}

func TestOverridesThatMatchAnotherKindsPresetAreKept(t *testing.T) {
	mission := bare(t)
	mission.Type = "custom"
	mission.Phases = []Phase{phaseOf("transit", func(p *Phase) {
		p.Days, p.WaterRecovery, p.OxygenRecovery, p.EVAHoursPerWeek = 5, 0, 0, 127.5
	})}
	decoded, err := DecodeMission(encode(t, mission))
	if err != nil || decoded.Phases[0] != mission.Phases[0] {
		t.Errorf("phase = %+v, %v", decoded.Phases, err)
	}
}

// resealed rewrites the checksum so a test reaches the check behind it.
func resealed(data []byte) []byte {
	crc := CRC16(data[:len(data)-2])
	data[len(data)-2], data[len(data)-1] = byte(crc>>8), byte(crc)
	return data
}

func refused(t *testing.T, data []byte, want string) {
	t.Helper()
	_, err := DecodeMission(data)
	if _, ok := err.(*MissionError); !ok || !strings.Contains(err.Error(), want) {
		t.Errorf("error = %v, want a MissionError containing %q", err, want)
	}
}

func TestEverySingleFlippedBitIsCaught(t *testing.T) {
	good := encode(t, example(t, "ares-3.json"))
	for bit := range len(good) * 8 {
		damaged := append([]byte(nil), good...)
		damaged[bit>>3] ^= 1 << (bit & 7)
		if _, err := DecodeMission(damaged); err == nil {
			t.Fatalf("flipping bit %d went unnoticed", bit)
		}
	}
}

func TestDamagedOrForeignFilesAreRefused(t *testing.T) {
	good := encode(t, bare(t))
	fresh := func() []byte { return append([]byte(nil), good...) }

	refused(t, good[:len(good)-9], "length field does not match the file size")
	refused(t, nil, "0 bytes is outside the size of a packet")
	refused(t, []byte(`{"type":"analog"}`), "not a valid mission file")

	damaged := fresh()
	damaged[20] ^= 0xff
	refused(t, damaged, "checksum mismatch, the file is damaged")

	newer := fresh()
	newer[6] = 3<<4 | newer[6]&0x0f
	refused(t, resealed(newer), "format version 3, this reader knows version 2")

	older := fresh()
	older[6] = 1<<4 | older[6]&0x0f
	refused(t, resealed(older), "format version 1, this reader knows version 2")

	morePhases := fresh()
	morePhases[9] = 4
	refused(t, resealed(morePhases), "it ends before the mission does")

	moreCrew := fresh()
	moreCrew[8] = 200
	refused(t, resealed(moreCrew), "not a valid mission file")

	// First crew record starts after the 7-byte name; its second byte is age.
	young := fresh()
	young[6+6+7+1] = 5
	refused(t, resealed(young), "crew member 1 age must be a number from 18 to 99; got 5")

	longer := append(fresh()[:len(good)-2], 0, 0, 0)
	longer[5]++
	refused(t, resealed(longer), "extra bytes after the last task")
}

func TestLinkEstimates(t *testing.T) {
	links := LinkEstimates(110)
	near(t, "low gain", links[0].Seconds, 58.6667, 1e-3)
	near(t, "high gain", links[1].Seconds, 0.88, 1e-9)
	near(t, "relay", links[2].Seconds, 0.0275, 1e-9)
	near(t, "share", ShareOfDailyCommands(110), 880.0/225000, 1e-12)
	if curiosityLinks[0].Seconds != 0 {
		t.Error("LinkEstimates changed the shared table")
	}
}

func server(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	Register(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func call(t *testing.T, method, url, body string) (int, map[string]json.RawMessage) {
	t.Helper()
	request, err := http.NewRequest(method, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(response.Body)
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(raw, &fields)
	return response.StatusCode, fields
}

func TestCatalogRoute(t *testing.T) {
	status, fields := call(t, http.MethodGet, server(t).URL+"/api/planner/catalog", "")
	if status != http.StatusOK {
		t.Fatalf("status %d", status)
	}
	var types []typeEntry
	var kinds []kindEntry
	var exampleMission Mission
	var roster []Astronaut
	for field, into := range map[string]any{"missionTypes": &types, "phaseKinds": &kinds, "example": &exampleMission, "sampleRoster": &roster} {
		if err := json.Unmarshal(fields[field], into); err != nil {
			t.Fatalf("%s: %v", field, err)
		}
	}
	if len(types) != len(MissionTypes) || len(kinds) != len(PhaseKinds) || len(roster) != 8 {
		t.Errorf("%d types, %d kinds, %d roster entries", len(types), len(kinds), len(roster))
	}
	if types[5].ID != "mars-long-stay" || len(types[5].Phases) != 3 || kinds[2].BasePowerW != StationBasePowerW {
		t.Errorf("types[5] = %+v, kinds[2] = %+v", types[5], kinds[2])
	}
	if exampleMission.Name != "ARES-3" || len(exampleMission.Tasks) != 6 {
		t.Errorf("example = %s with %d tasks", exampleMission.Name, len(exampleMission.Tasks))
	}
}

func TestPlanRoute(t *testing.T) {
	url := server(t).URL + "/api/planner/plan"
	source, _ := Examples.ReadFile("examples/ares-3.json")
	rosterFile, _ := Examples.ReadFile("examples/roster.json")
	var roster struct{ Astronauts json.RawMessage }
	_ = json.Unmarshal(rosterFile, &roster)
	body, _ := json.Marshal(map[string]json.RawMessage{"mission": source, "roster": roster.Astronauts})

	status, fields := call(t, http.MethodPost, url, string(body))
	if status != http.StatusOK {
		t.Fatalf("status %d: %s", status, fields["error"])
	}
	var response planResponse
	raw, _ := json.Marshal(fields)
	if err := json.Unmarshal(raw, &response); err != nil {
		t.Fatal(err)
	}
	if response.Plan.Days != 960 || response.FileBytes != 225 || len(response.Links) != 3 || response.Cautions == nil || len(response.Cautions) != 0 {
		t.Errorf("days %d, file %d bytes, %d links, cautions %v", response.Plan.Days, response.FileBytes, len(response.Links), response.Cautions)
	}
	file, err := base64.StdEncoding.DecodeString(response.File)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeMission(file)
	if err != nil || !reflect.DeepEqual(decoded, response.Mission) {
		t.Errorf("the file in the response does not hold the mission in the response: %v", err)
	}

	// Sending the checked mission back gives the same answer: it is stable.
	again, _ := json.Marshal(map[string]any{"mission": response.Mission})
	status, fields = call(t, http.MethodPost, url, string(again))
	if status != http.StatusOK || string(fields["file"]) != `"`+response.File+`"` {
		t.Errorf("second pass: status %d, file changed", status)
	}

	cases := []struct {
		name, body string
		status     int
		want       string
	}{
		{"mission that does not add up", `{"mission":{"type":"custom","crew":["VEGA"]}}`, http.StatusUnprocessableEntity, `no \"VEGA\" in the roster`},
		{"empty field", `{"mission":{"type":"analog","crew":[{"name":"A","sex":"male","age":30,"massKg":null,"heightCm":170}]}}`,
			http.StatusUnprocessableEntity, "crew member 1 massKg must be a number from 30 to 250; got nothing"},
		{"no mission", `{}`, http.StatusUnprocessableEntity, "mission must be an object"},
		{"not JSON", `{"mission":`, http.StatusBadRequest, "the request could not be read"},
		{"too large", `{"mission":"` + strings.Repeat("x", maxRequestBytes) + `"}`, http.StatusRequestEntityTooLarge, "too large"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			status, fields := call(t, http.MethodPost, url, c.body)
			if status != c.status || !strings.Contains(string(fields["error"]), c.want) {
				t.Errorf("status %d, error %s", status, fields["error"])
			}
		})
	}
	if status, _ := call(t, http.MethodGet, url, ""); status != http.StatusMethodNotAllowed {
		t.Errorf("GET on the plan route gave %d", status)
	}
}

func TestDecodeRoute(t *testing.T) {
	url := server(t).URL + "/api/planner/decode"
	good := encode(t, example(t, "ares-3.json"))
	status, fields := call(t, http.MethodPost, url, string(good))
	var mission Mission
	if err := json.Unmarshal(fields["mission"], &mission); status != http.StatusOK || err != nil || mission.Name != "ARES-3" {
		t.Errorf("status %d, mission %q, %v", status, mission.Name, err)
	}
	good[30] ^= 1
	status, fields = call(t, http.MethodPost, url, string(good))
	if status != http.StatusUnprocessableEntity || !strings.Contains(string(fields["error"]), "checksum mismatch") {
		t.Errorf("damaged file: status %d, error %s", status, fields["error"])
	}
}
