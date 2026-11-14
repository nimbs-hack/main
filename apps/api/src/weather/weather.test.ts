import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SiteDataset } from "@nimbs/shared";
import { createApp } from "../index";
import { TerrainGraph } from "../terrain/engine";
import {
  DEFAULT_EVA_LIMITS,
  MARS_SCALE_HEIGHT_M,
  celsiusToKelvin,
  degreesToCompassSector,
  evaluateEvaWeather,
  generateMartianWeather,
  kelvinToCelsius,
  scalePressureByElevation,
} from "./generator";
import { type SiteWeatherFile, WeatherService, parseMedaRssLatest } from "./service";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "nimbs-weather-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTestGraph(minElevM = -2550, maxElevM = -1680): TerrainGraph {
  const rows = 5;
  const cols = 5;
  const elevationsM = Array.from({ length: rows * cols }, (_, idx) =>
    idx === 0 ? minElevM : idx === 24 ? maxElevM : (minElevM + maxElevM) / 2,
  );
  const dataset: SiteDataset = {
    meta: {
      id: "jezero-test-site",
      name: "Jezero Test Rim",
      sourceItemId: "test",
      sourceTitle: "test",
      dtmUrl: "https://example.invalid/dtm.tif",
      hillshadeUrl: "https://example.invalid/hs.tif",
      bbox: [77.3, 18.5, 77.6, 18.8],
      center: { lat: 18.65, lon: 77.45 },
      widthMeters: 20000,
      heightMeters: 20000,
      rows,
      cols,
      cellSizeMeters: 5000,
      minElevationM: minElevM,
      maxElevationM: maxElevM,
      nodataValue: -32767,
    },
    elevationsM,
  };
  return new TerrainGraph(dataset);
}

describe("Martian weather physics and generator", () => {
  test("scales pressure exponentially with Mars scale height H = 10,800 m", () => {
    const pFloor = 750;
    const pRim = scalePressureByElevation(pFloor, -1696, -2500);
    const expected = pFloor * Math.exp(-(-1696 - -2500) / MARS_SCALE_HEIGHT_M);
    expect(pRim).toBeCloseTo(expected, 6);
    expect(pRim).toBeLessThan(pFloor);

    const jezero = generateMartianWeather({
      site: "jezero",
      sol: 1859,
      lsDeg: 137,
      scenario: "nominal",
    });
    const gale = generateMartianWeather({
      site: "gale",
      sol: 1859,
      lsDeg: 137,
      scenario: "nominal",
    });
    expect(gale.pressure.avgPa).toBeGreaterThan(jezero.pressure.avgPa);
    expect(gale.site.referenceElevationM).toBe(-4500);
  });

  test("maps azimuth degrees to 16-sector compass labels and converts K/C", () => {
    expect(degreesToCompassSector(0)).toBe("N");
    expect(degreesToCompassSector(90)).toBe("E");
    expect(degreesToCompassSector(108)).toBe("ESE");
    expect(degreesToCompassSector(315)).toBe("NW");
    expect(degreesToCompassSector(359)).toBe("N");
    expect(celsiusToKelvin(-75)).toBeCloseTo(198.15, 4);
    expect(kelvinToCelsius(273.15)).toBeCloseTo(0, 4);
  });

  test("generates distinct nominal, dust-storm, and cold-snap scenarios with explicit simulated tags", () => {
    const nominal = generateMartianWeather({
      site: "jezero",
      sol: 1900,
      lsDeg: 140,
      scenario: "nominal",
    });
    const storm = generateMartianWeather({
      site: "jezero",
      sol: 1900,
      lsDeg: 140,
      scenario: "dust-storm",
    });
    const cold = generateMartianWeather({
      site: "jezero",
      sol: 1900,
      lsDeg: 140,
      scenario: "cold-snap",
    });

    expect(nominal.hourly).toHaveLength(24);
    expect(nominal.isSimulated).toBe(true);
    expect(nominal.sourceType).toBe("simulated");
    expect(nominal.realChannels).toEqual([]);
    expect(nominal.simulatedChannels).toContain("airTemp");
    expect(nominal.disclaimer).toBeDefined();

    expect(storm.dustOpacityTau).toBeGreaterThan(2.0);
    expect(storm.wind.maxMps).toBeGreaterThan(15);
    expect(storm.pressure.swingPa).toBeGreaterThan(nominal.pressure.swingPa);
    expect(cold.airTemp.maxK).toBeLessThan(nominal.airTemp.maxK);
  });

  test("preserves real observations in hybrid mode and flags only modeled channels", () => {
    const hybrid = generateMartianWeather({
      site: "jezero",
      scenario: "auto",
      observedOverrides: {
        sol: 1859,
        lsDeg: 137.3,
        tempMinK: 186.44,
        tempAvgK: 216.04,
        tempMaxK: 271.85,
        pressureMinPa: 716.61,
        pressureAvgPa: 734.2,
        pressureMaxPa: 750.86,
        sourceLabel: "NASA PDS4 MEDA (Sol 1859)",
        realChannels: ["airTemp", "pressure", "pressureSwing", "ls"],
      },
    });

    expect(hybrid.sol).toBe(1859);
    expect(hybrid.sourceType).toBe("hybrid");
    expect(hybrid.isSimulated).toBe(true);
    expect(hybrid.airTemp.minK).toBe(186.44);
    expect(hybrid.pressure.avgPa).toBe(734.2);
    expect(hybrid.realChannels).toEqual(["airTemp", "pressure", "pressureSwing", "ls"]);
    expect(hybrid.simulatedChannels).toContain("windSpeed");
    expect(hybrid.simulatedChannels).not.toContain("airTemp");
  });
});

describe("EVA feasibility evaluator", () => {
  test("accounts for crater rim elevation drop in pressure check", () => {
    const weather = generateMartianWeather({
      site: "jezero",
      sol: 1859,
      lsDeg: 137,
      scenario: "nominal",
    });

    // At floor (-2500 m) pressure is ~722 Pa (> 685 Pa + 4% margin), while at rim (-1696 m) it drops below 685 Pa
    const floorPass = evaluateEvaWeather(weather, {
      elevationM: -2500,
      limits: { ...DEFAULT_EVA_LIMITS, minAirTempC: -95, minPressurePa: 685 },
    });
    const rimFail = evaluateEvaWeather(weather, {
      elevationM: -1696,
      limits: { ...DEFAULT_EVA_LIMITS, minAirTempC: -95, minPressurePa: 685 },
    });

    expect(floorPass.checks.find((c) => c.id === "pressure")?.status).toBe("GO");
    expect(rimFail.checks.find((c) => c.id === "pressure")?.status).toBe("NO-GO");
    expect(rimFail.status).toBe("NO-GO");
  });

  test("recommends safe daylight traverse window when thermally restricted", () => {
    const nominal = generateMartianWeather({
      site: "jezero",
      sol: 1133,
      lsDeg: 244,
      scenario: "nominal",
    });
    const degraded = evaluateEvaWeather(nominal, {
      limits: { ...DEFAULT_EVA_LIMITS, minAirTempC: -75 },
    });
    const allClear = evaluateEvaWeather(nominal, {
      limits: { ...DEFAULT_EVA_LIMITS, minAirTempC: -95 },
    });

    expect(degraded.status).toBe("DEGRADED");
    expect(degraded.checks.find((c) => c.id === "air_temp")?.status).toBe("DEGRADED");
    expect(degraded.safeWindow.durationHours).toBeGreaterThanOrEqual(4);
    expect(degraded.safeWindow.startLmst).not.toBeNull();
    expect(allClear.status).toBe("GO");
  });

  test("flags dust-storm wind/swing and excessive route duration as NO-GO", () => {
    const storm = generateMartianWeather({
      site: "jezero",
      sol: 1900,
      lsDeg: 250,
      scenario: "dust-storm",
    });
    const stormEval = evaluateEvaWeather(storm, { limits: DEFAULT_EVA_LIMITS });
    expect(stormEval.status).toBe("NO-GO");
    expect(stormEval.checks.find((c) => c.id === "wind_speed")?.status).toBe("NO-GO");
    expect(stormEval.checks.find((c) => c.id === "pressure_swing")?.status).toBe("NO-GO");

    const nominal = generateMartianWeather({
      site: "jezero",
      sol: 1900,
      lsDeg: 137,
      scenario: "nominal",
    });
    const longRouteEval = evaluateEvaWeather(nominal, {
      limits: { ...DEFAULT_EVA_LIMITS, minAirTempC: -95, maxEvaHours: 4 },
      route: { totalDistanceM: 12000, elevationGainM: 400, maxElevationM: -1800 },
    });
    expect(longRouteEval.estimatedRouteHours).toBeGreaterThan(4);
    expect(longRouteEval.checks.find((c) => c.id === "eva_duration")?.status).toBe("NO-GO");
    expect(longRouteEval.status).toBe("NO-GO");
  });
});

describe("WeatherService caching and fallbacks", () => {
  test("parses MEDA RSS skipping '--' entries and converts Celsius to Kelvin", () => {
    const parsed = parseMedaRssLatest({
      sols: [
        { sol: "1128", min_temp: "--", max_temp: "--", pressure: "--" },
        {
          sol: "1133",
          ls: "244.106",
          terrestrial_date: "2024-04-27",
          min_temp: -79.3,
          max_temp: -24.7,
          pressure: 778.9,
          sunrise: "06:18:07",
          sunset: "17:13:51",
        },
      ],
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.sol).toBe(1133);
    expect(parsed?.tempMinK).toBeCloseTo(193.85, 2);
    expect(parsed?.tempMaxK).toBeCloseTo(248.45, 2);
    expect(parsed?.pressureAvgPa).toBe(778.9);
  });

  test("caches live feed in memory and disk TTL and falls back cleanly when offline", async () => {
    const dir = makeTempDir();
    let fetchCalls = 0;
    const mockFetch = (async () => {
      fetchCalls += 1;
      return new Response(
        JSON.stringify({
          sols: [
            {
              sol: "1133",
              ls: "244.106",
              terrestrial_date: "2024-04-27",
              min_temp: -79.3,
              max_temp: -24.7,
              pressure: 778.9,
              sunrise: "06:18:07",
              sunset: "17:13:51",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const service = new WeatherService({
      cacheDir: join(dir, "cache"),
      siteWeatherPath: join(dir, "site-weather.json"),
      fetcher: mockFetch,
    });

    const first = await service.getWeather({ site: "jezero" });
    const second = await service.getWeather({ site: "jezero" });
    expect(fetchCalls).toBe(1);
    expect(first.sol).toBe(1133);
    expect(first.sourceType).toBe("hybrid");
    expect(second.sol).toBe(1133);

    // Now test fallback to site-weather.json when live network fails
    const dirFallback = makeTempDir();
    const persisted: SiteWeatherFile = {
      generatedAt: "2026-08-11T00:00:00Z",
      sites: {
        jezero: {
          siteId: "jezero",
          sol: 1859,
          lsDeg: 137.3,
          tempMinK: 186.44,
          tempAvgK: 216.04,
          tempMaxK: 271.85,
          pressureMinPa: 716.61,
          pressureAvgPa: 734.2,
          pressureMaxPa: 750.86,
          sourceLabel: "NASA PDS4 MEDA (Sol 1859)",
          realChannels: ["airTemp", "pressure", "pressureSwing", "ls"],
          fetchedAt: "2026-08-11T00:00:00Z",
        },
      },
    };
    writeFileSync(join(dirFallback, "site-weather.json"), JSON.stringify(persisted));

    const offlineService = new WeatherService({
      cacheDir: join(dirFallback, "cache"),
      siteWeatherPath: join(dirFallback, "site-weather.json"),
      fetcher: (async () => {
        throw new Error("Network down");
      }) as unknown as typeof fetch,
    });

    const fromFile = await offlineService.getWeather({ site: "jezero" });
    expect(fromFile.sol).toBe(1859);
    expect(fromFile.sourceType).toBe("hybrid");
    expect(fromFile.airTemp.minK).toBe(186.44);

    // Pure simulated fallback when neither live nor site-weather.json exists
    const pureFallbackService = new WeatherService({
      cacheDir: join(dirFallback, "cache2"),
      siteWeatherPath: join(dirFallback, "missing.json"),
      enableLiveFetch: false,
    });
    const sim = await pureFallbackService.getWeather({ site: "gale" });
    expect(sim.sourceType).toBe("simulated");
    expect(sim.isSimulated).toBe(true);
  });
});

describe("Weather HTTP API endpoints", () => {
  test("GET /api/weather and POST /api/weather/evaluate work with injected graph and sliders", async () => {
    const dir = makeTempDir();
    const service = new WeatherService({
      cacheDir: join(dir, "cache"),
      siteWeatherPath: join(dir, "missing.json"),
      enableLiveFetch: false,
    });
    const graph = makeTestGraph(-2550, -1680);
    const app = createApp(graph, service);

    const getRes = await app.request("/api/weather?scenario=nominal&sol=1859");
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      weather: { sol: number; sourceType: string; site: { maxElevationM: number } };
      evaluation: { evaluationElevationM: number; checks: Array<{ id: string }> };
    };
    expect(getBody.weather.sol).toBe(1859);
    expect(getBody.weather.sourceType).toBe("simulated");
    expect(getBody.evaluation.evaluationElevationM).toBe(-1680);
    expect(getBody.evaluation.checks).toHaveLength(5);

    const badQuery = await app.request("/api/weather?scenario=hurricane");
    expect(badQuery.status).toBe(400);

    const evalRes = await app.request("/api/weather/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scenario: "dust-storm",
        sol: 1859,
        limits: {
          minAirTempC: -75,
          maxWindSpeedMps: 15,
          minPressurePa: 650,
          maxPressureSwingPa: 35,
          maxEvaHours: 4,
        },
        route: {
          totalDistanceM: 4000,
          elevationGainM: 150,
          maxElevationM: -1750,
        },
      }),
    });
    expect(evalRes.status).toBe(200);
    const evalBody = (await evalRes.json()) as {
      evaluation: { status: string; estimatedRouteHours: number | null };
    };
    expect(evalBody.evaluation.status).toBe("NO-GO");
    expect(evalBody.evaluation.estimatedRouteHours).toBeGreaterThan(1.5);

    const badEval = await app.request("/api/weather/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limits: { maxEvaHours: -2 } }),
    });
    expect(badEval.status).toBe(400);

    const fastRoverEval = await app.request("/api/weather/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scenario: "nominal",
        sol: 1859,
        limits: {
          ...DEFAULT_EVA_LIMITS,
          minAirTempC: -110,
          maxEvaHours: 8,
          flatSpeedMPerH: 5000,
          climbSpeedMPerH: 700,
          descentSpeedMPerH: 1200,
        },
        route: {
          totalDistanceM: 5000,
          elevationGainM: 350,
          elevationLossM: 0,
          maxElevationM: -1750,
        },
      }),
    });
    expect(fastRoverEval.status).toBe(200);
    const fastBody = (await fastRoverEval.json()) as {
      evaluation: { estimatedRouteHours: number | null };
    };
    expect(fastBody.evaluation.estimatedRouteHours).toBe(1.5);

    const badSpeedEval = await app.request("/api/weather/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limits: { flatSpeedMPerH: 10 } }),
    });
    expect(badSpeedEval.status).toBe(400);
  });
});
