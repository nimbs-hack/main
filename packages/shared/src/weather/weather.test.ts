import { describe, expect, test } from "bun:test";
import { TerrainGraph } from "../terrain/engine";
import { buildDirectMarsTileUrl } from "../tiles";
import type { SiteDataset } from "../types";
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
import { parseMedaRssLatest, parseRemsRssLatest, persistedWeatherToObservedInput } from "./rss";

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

describe("Weather RSS parsing, hybrid adaptation, and tile URLs", () => {
  test("parses MEDA and REMS RSS skipping '--' entries and converts Celsius to Kelvin", () => {
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

    if (parsed) {
      const obs = persistedWeatherToObservedInput(parsed);
      const hybrid = generateMartianWeather({ site: "jezero", observedOverrides: obs });
      expect(hybrid.sourceType).toBe("hybrid");
      expect(hybrid.sol).toBe(1133);
    }

    const rems = parseRemsRssLatest({
      soles: [
        {
          sol: "4001",
          ls: "180.5",
          min_temp: -74.0,
          max_temp: -5.5,
          pressure: 810.0,
          sunrise: "05:30",
          sunset: "17:45",
        },
      ],
    });
    expect(rems?.siteId).toBe("gale");
    expect(rems?.sol).toBe(4001);
  });

  test("evaluates fast rover speed parameters and builds direct Mars basemap URLs", () => {
    const graph = makeTestGraph(-2550, -1680);
    const snapshot = generateMartianWeather({
      site: "jezero",
      scenario: "nominal",
      sol: 1859,
      siteMeta: graph.meta,
    });
    const fastEval = evaluateEvaWeather(snapshot, {
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
      siteMeta: graph.meta,
    });
    expect(fastEval.estimatedRouteHours).toBe(1.5);

    const wmsUrl = buildDirectMarsTileUrl("usgs-mdim", 2, 1, 1);
    expect(wmsUrl).toContain("planetarymaps.usgs.gov/cgi-bin/mapserv");
    expect(wmsUrl).toContain("LAYERS=MDIM21_color");
    expect(wmsUrl).toContain("SRS=EPSG%3A4326");

    const trekUrl = buildDirectMarsTileUrl("mola-trek", 5, 10, 12);
    expect(trekUrl).toContain("trek.nasa.gov/tiles/Mars/");
    expect(buildDirectMarsTileUrl("mola-trek", 9, 0, 0)).toBeNull();

    // 4 soil type speed coefficients scale traverse hours accurately
    const soilEval = evaluateEvaWeather(snapshot, {
      limits: {
        ...DEFAULT_EVA_LIMITS,
        flatSpeedMPerH: 2000,
        soilSpeedFactors: {
          bedrock: 1.0,
          "coarse-regolith": 0.8,
          "fine-regolith": 0.5,
          "loose-sand": 0.25,
        },
      },
      route: {
        totalDistanceM: 2500,
        elevationGainM: 0,
        elevationLossM: 0,
        maxElevationM: -2000,
        soilBreakdown: {
          bedrock: 1000,
          "coarse-regolith": 0,
          "fine-regolith": 1000,
          "loose-sand": 500,
        },
      },
      siteMeta: graph.meta,
    });
    expect(soilEval.estimatedRouteHours).toBe(2.5);
  });
});
