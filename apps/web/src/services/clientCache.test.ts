import { describe, expect, test } from "bun:test";
import { DEFAULT_EVA_WEATHER_LIMITS, TRAVERSE_PRESETS } from "@nimbs/shared";
import {
  MISSION_STATE_STORAGE_KEY,
  createDefaultMissionState,
  loadMissionState,
  saveMissionState,
} from "./browserCache";
import { ClientWeatherService } from "./clientWeather";

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

describe("browserCache mission state persistence", () => {
  test("saves and restores dual-unit mission UI state cleanly", () => {
    const storage = createMemoryStorage();
    const defaults = createDefaultMissionState();
    const state = {
      ...defaults,
      activeLayerId: "usgs-themis",
      showSoilLayer: true,
      showPressureLayer: true,
      uiMode: "advance" as const,
      activeUnitId: 2 as const,
      moveWaypointsMode: true,
      dualSimSpeedMultiplier: 8,
      simDepartureLmstHour: 10.5,
      simLmstHour: 15.5,
      weatherScenario: "dust-storm" as const,
      unit1: {
        ...defaults.unit1,
        presetId: "rover" as const,
        maxSlopeDeg: TRAVERSE_PRESETS.rover.maxSlopeDeg,
        waypoints: [
          { lat: 18.42, lon: 77.41 },
          { lat: 18.45, lon: 77.45 },
          { lat: 18.48, lon: 77.49 },
        ],
        selectedRouteId: "route-shortest",
        weatherLimits: {
          ...DEFAULT_EVA_WEATHER_LIMITS,
          minAirTempC: -95,
          flatSpeedMPerH: 5000,
          soilSpeedFactors: {
            bedrock: 1.1,
            "coarse-regolith": 0.9,
            "fine-regolith": 0.65,
            "loose-sand": 0.3,
          },
        },
      },
      unit2: {
        ...defaults.unit2,
        waypoints: [
          { lat: 18.43, lon: 77.42 },
          { lat: 18.47, lon: 77.48 },
        ],
      },
    };

    saveMissionState(state, storage);
    const loaded = loadMissionState(storage);

    expect(loaded.activeLayerId).toBe("usgs-themis");
    expect(loaded.showSoilLayer).toBe(true);
    expect(loaded.showPressureLayer).toBe(true);
    expect(loaded.uiMode).toBe("advance");
    expect(loaded.activeUnitId).toBe(2);
    expect(loaded.moveWaypointsMode).toBe(true);
    expect(loaded.dualSimSpeedMultiplier).toBe(8);
    expect(loaded.simDepartureLmstHour).toBe(10.5);
    expect(loaded.unit1.presetId).toBe("rover");
    expect(loaded.unit1.waypoints).toHaveLength(3);
    expect(loaded.unit1.selectedRouteId).toBe("route-shortest");
    expect(loaded.unit1.weatherLimits.soilSpeedFactors?.["loose-sand"]).toBe(0.3);
    expect(loaded.unit2.waypoints).toHaveLength(2);
    expect(loaded.simLmstHour).toBe(15.5);
    expect(loaded.weatherScenario).toBe("dust-storm");
    expect(loaded.unit1.weatherLimits.minAirTempC).toBe(-95);
    expect(loaded.unit1.weatherLimits.flatSpeedMPerH).toBe(5000);
  });

  test("repairs corrupted values and migrates legacy v1 persisted state into unit1", () => {
    const storage = createMemoryStorage();
    storage.setItem(MISSION_STATE_STORAGE_KEY, "{bad-json");
    expect(loadMissionState(storage)).toEqual(createDefaultMissionState());

    storage.setItem(
      MISSION_STATE_STORAGE_KEY,
      JSON.stringify({
        activeLayerId: "unknown-layer",
        maxSlopeDeg: 999,
        simLmstHour: -5,
        waypointA: { lat: 400, lon: 10 },
        waypointB: { lat: 18.45, lon: 77.45 },
        weatherLimits: { flatSpeedMPerH: 1 },
      }),
    );
    const repaired = loadMissionState(storage);
    const defaults = createDefaultMissionState();
    expect(repaired.activeLayerId).toBe(defaults.activeLayerId);
    expect(repaired.unit1.maxSlopeDeg).toBe(defaults.unit1.maxSlopeDeg);
    expect(repaired.simLmstHour).toBe(defaults.simLmstHour);
    expect(repaired.unit1.waypoints).toEqual([{ lat: 18.45, lon: 77.45 }]);
    expect(repaired.unit1.weatherLimits).toEqual(defaults.unit1.weatherLimits);
  });
});

describe("ClientWeatherService live, bundled fallback, and simulated caching", () => {
  test("caches live CORS RSS in memory and falls back to bundled JSON or simulation offline", async () => {
    let liveCalls = 0;
    const mockFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("mars.nasa.gov")) {
        liveCalls += 1;
        return new Response(
          JSON.stringify({
            sols: [
              {
                sol: "1901",
                ls: "145.2",
                min_temp: -78.5,
                max_temp: -18.2,
                pressure: 744.0,
                sunrise: "05:32:00",
                sunset: "17:44:00",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    }) as unknown as typeof fetch;

    const svc = new ClientWeatherService({ fetcher: mockFetch });
    const first = await svc.getWeather({ site: "jezero" });
    const second = await svc.getWeather({ site: "jezero" });
    expect(liveCalls).toBe(1);
    expect(first.sol).toBe(1901);
    expect(first.sourceType).toBe("hybrid");
    expect(second.sol).toBe(1901);

    const bundledOnlyFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("site-weather.json")) {
        return new Response(
          JSON.stringify({
            generatedAt: "2026-11-14T00:00:00Z",
            sites: {
              jezero: {
                siteId: "jezero",
                sol: 1859,
                lsDeg: 137.3,
                tempMinK: 186.44,
                tempAvgK: 216.04,
                tempMaxK: 271.85,
                pressureAvgPa: 734.2,
                sourceLabel: "Static bundle Sol 1859",
                realChannels: ["airTemp", "pressure", "ls"],
                fetchedAt: "2026-11-14T00:00:00Z",
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error("Network unreachable");
    }) as unknown as typeof fetch;

    const bundledSvc = new ClientWeatherService({ fetcher: bundledOnlyFetch });
    const fromBundle = await bundledSvc.getWeather({ site: "jezero" });
    expect(fromBundle.sol).toBe(1859);
    expect(fromBundle.sourceType).toBe("hybrid");

    const offlineSvc = new ClientWeatherService({
      enableLiveFetch: false,
      fetcher: (async () => {
        throw new Error("Offline");
      }) as unknown as typeof fetch,
    });
    const sim = await offlineSvc.getWeather({ site: "gale" });
    expect(sim.sourceType).toBe("simulated");
    expect(sim.isSimulated).toBe(true);
  });
});
