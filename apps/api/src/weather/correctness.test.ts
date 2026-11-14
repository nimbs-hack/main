import { describe, expect, test } from "bun:test";
import {
  MARS_SOL_EARTH_HOURS,
  computeTraverseWindows,
  estimateLsFromDate,
  evaluateEvaWeather,
  generateMartianWeather,
} from "./generator";
import { parseRemsRssLatest } from "./service";

function constantWeather() {
  const snapshot = generateMartianWeather({ sol: 100, lsDeg: 90 });
  snapshot.site.minElevationM = 0;
  snapshot.site.maxElevationM = 0;
  snapshot.airTemp = { minK: 250, avgK: 250, maxK: 250 };
  snapshot.pressure = { minPa: 1000, avgPa: 1000, maxPa: 1000, swingPa: 0, referenceElevationM: 0 };
  snapshot.wind = { ...snapshot.wind, minMps: 1, avgMps: 1, maxMps: 1 };
  snapshot.daylight = { ...snapshot.daylight, sunriseLmst: "00:00:00", sunsetLmst: "24:00:00" };
  snapshot.hourly = snapshot.hourly.map((point) => ({
    ...point,
    tempK: 250,
    pressurePa: 1000,
    windSpeedMps: 1,
    isDaylight: true,
  }));
  snapshot.nextSol = undefined;
  return snapshot;
}

describe("weather correctness", () => {
  test("explicit sols and historical observations determine the date used for Ls", () => {
    const landing = generateMartianWeather({ site: "jezero", sol: 0 });
    expect(landing.terrestrialDate).toBe("2021-02-18");
    const historical = generateMartianWeather({ terrestrialDate: "2022-01-01" });
    expect(historical.lsDeg).toBeCloseTo(estimateLsFromDate(new Date("2022-01-01T12:00:00Z")), 1);
  });

  test("nominal dust increases in the modeled perihelion season", () => {
    const clear = generateMartianWeather({ sol: 100, lsDeg: 75 });
    const dusty = generateMartianWeather({ sol: 100, lsDeg: 255 });
    expect(dusty.dustOpacityTau).toBeGreaterThan(clear.dustOpacityTau);
  });

  test("modeled channels keep a snapshot hybrid even with observed core channels", () => {
    const snapshot = generateMartianWeather({
      observedOverrides: {
        sol: 100,
        sourceLabel: "test",
        realChannels: ["airTemp", "pressure", "windSpeed"],
      },
    });
    expect(snapshot.sourceType).toBe("hybrid");
    expect(snapshot.isSimulated).toBe(true);
  });

  test("REMS selects the newest usable sol regardless of feed ordering", () => {
    expect(
      parseRemsRssLatest({
        soles: [
          { sol: 1, pressure: 700 },
          { sol: 3, pressure: "--" },
          { sol: 2, pressure: 710 },
        ],
      })?.sol,
    ).toBe(2);
  });

  test("Earth-hour walk durations advance by the corresponding LMST interval", () => {
    const result = computeTraverseWindows(constantWeather(), {
      route: { totalDistanceM: 10000 },
      stepHours: 1,
    });
    const slot = result.departureSlots.find((entry) => entry.offsetHours === 12);
    expect(slot?.durationHours).toBe(4);
    expect(slot?.endLmstHour).toBeCloseTo(12 + (4 * 24) / MARS_SOL_EARTH_HOURS, 2);
    expect(result.departureSlots.find((entry) => entry.offsetHours === 45)?.status).toBe("NO-GO");
    expect(result.recommendedWindows.every((entry) => entry.endOffsetHours <= 44)).toBe(true);
  });

  test("threshold checks retain sub-display precision", () => {
    const snapshot = constantWeather();
    snapshot.hourly = snapshot.hourly.map((point) => ({ ...point, pressurePa: 649.96 }));
    expect(computeTraverseWindows(snapshot).departureSlots[0]?.status).toBe("NO-GO");
    const duration = evaluateEvaWeather(constantWeather(), { route: { totalDistanceM: 10010 } });
    expect(duration.checks.find((check) => check.id === "eva_duration")?.status).toBe("NO-GO");
  });

  test("hourly wind peaks between walk samples still block departure", () => {
    const snapshot = constantWeather();
    const peak = snapshot.hourly[1];
    if (peak) peak.windSpeedMps = 15.01;
    const result = computeTraverseWindows(snapshot, { route: { totalDistanceM: 10000 } });
    expect(result.departureSlots[0]?.maxEncounteredWindMps).toBe(15.01);
    expect(result.departureSlots[0]?.status).toBe("NO-GO");
  });

  test("long routes retain isolated elevation extrema", () => {
    const points = Array.from({ length: 201 }, (_, i) => ({
      distanceM: i * 10,
      elevationM: i === 1 ? 600 : 0,
    }));
    const result = computeTraverseWindows(constantWeather(), {
      route: { points },
      limits: { minAirTempC: -24 },
    });
    expect(result.departureSlots[0]?.minEncounteredTempC).toBeCloseTo(-24.65, 6);
    expect(result.departureSlots[0]?.status).toBe("NO-GO");
  });

  test("safe windows clip at thermal crossings and express durations in Earth hours", () => {
    const snapshot = constantWeather();
    snapshot.daylight.sunriseLmst = "06:30:00";
    snapshot.daylight.sunsetLmst = "18:30:00";
    snapshot.hourly = snapshot.hourly.map((point) => ({
      ...point,
      tempK: point.lmstHour === 12 ? 250 : 230,
    }));
    const result = evaluateEvaWeather(snapshot, {
      limits: { minAirTempC: -33.15 },
      route: { totalDistanceM: 2500 },
    });
    expect(result.safeWindow.startLmstHour).toBeCloseTo(11.5, 6);
    expect(result.safeWindow.endLmstHour).toBeCloseTo(12.5, 6);
    expect(result.safeWindow.durationHours).toBeCloseTo(MARS_SOL_EARTH_HOURS / 24, 6);
  });

  test("daylight fraction uses elapsed time instead of sample counts", () => {
    const snapshot = constantWeather();
    snapshot.daylight.sunriseLmst = "06:30:00";
    snapshot.daylight.sunsetLmst = "18:30:00";
    const result = computeTraverseWindows(snapshot, {
      route: { totalDistanceM: (2500 * MARS_SOL_EARTH_HOURS) / 24 },
      stepHours: 1,
    });
    expect(
      result.departureSlots.find((slot) => slot.offsetHours === 6)?.daylightFraction,
    ).toBeCloseTo(0.5, 8);
  });

  test("cross-midnight walks check next-sol pressure swings", () => {
    const snapshot = constantWeather();
    const nextSol = generateMartianWeather({ sol: 100 }).nextSol;
    if (!nextSol) throw new Error("Missing forecast fixture");
    snapshot.nextSol = {
      ...nextSol,
      hourly: snapshot.hourly,
      daylight: snapshot.daylight,
      pressure: { ...snapshot.pressure, swingPa: 100 },
    };
    const result = computeTraverseWindows(snapshot, {
      route: { totalDistanceM: 5000 },
      stepHours: 1,
    });
    expect(result.departureSlots.find((slot) => slot.offsetHours === 23)?.reason).toContain(
      "baro swing",
    );
  });
});
