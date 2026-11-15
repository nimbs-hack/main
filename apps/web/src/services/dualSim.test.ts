import { describe, expect, it } from "bun:test";
import {
  type ComputedRoute,
  DEFAULT_EVA_WEATHER_LIMITS,
  TRAVERSE_PRESETS,
  buildUnitTraverseTimeline,
} from "@nimbs/shared";
import { buildDualSimBundle, evaluateDualSimFrame } from "./dualSim";

const ROUTE_A1_B1: ComputedRoute = {
  id: "u1-short",
  label: "Shortest Safe",
  strategy: "shortest",
  totalDistanceM: 2500,
  elevationGainM: 40,
  elevationLossM: 0,
  maxSlopeDeg: 4.5,
  meanSlopeDeg: 2.2,
  points: [
    {
      lat: 18.6,
      lon: 77.4,
      elevationM: -2500,
      distanceM: 0,
      slopeDeg: 0,
      soilType: "bedrock",
      soilSpeedFactor: 1,
    },
    {
      lat: 18.615,
      lon: 77.415,
      elevationM: -2460,
      distanceM: 2500,
      slopeDeg: 4.5,
      soilType: "fine-regolith",
      soilSpeedFactor: 0.7,
    },
  ],
};

const ROUTE_A2_B2: ComputedRoute = {
  id: "u2-short",
  label: "Shortest Safe",
  strategy: "shortest",
  totalDistanceM: 12000,
  elevationGainM: 120,
  elevationLossM: 20,
  maxSlopeDeg: 8.2,
  meanSlopeDeg: 4.1,
  points: [
    {
      lat: 18.58,
      lon: 77.38,
      elevationM: -2550,
      distanceM: 0,
      slopeDeg: 0,
      soilType: "coarse-regolith",
      soilSpeedFactor: 0.88,
    },
    {
      lat: 18.64,
      lon: 77.48,
      elevationM: -2450,
      distanceM: 12000,
      slopeDeg: 8.2,
      soilType: "loose-sand",
      soilSpeedFactor: 0.42,
    },
  ],
};

describe("dualSim synchronized timeline", () => {
  it("runs simultaneous start and finishes when the slower unit reaches B", () => {
    const t1 = buildUnitTraverseTimeline(1, ROUTE_A1_B1, DEFAULT_EVA_WEATHER_LIMITS);
    const t2 = buildUnitTraverseTimeline(2, ROUTE_A2_B2, TRAVERSE_PRESETS.rover.limits);
    expect(t2.totalDurationHours).toBeGreaterThan(t1.totalDurationHours);

    const bundle = buildDualSimBundle({
      timeline1: t1,
      timeline2: t2,
      departureLmstHour: 9,
      weather: null,
      sampleCount: 40,
    });
    expect(bundle.totalDurationHours).toBeCloseTo(t2.totalDurationHours, 5);
    expect(bundle.unit1?.samples.length).toBe(40);
    expect(bundle.unit2?.samples.length).toBe(40);

    const mid = evaluateDualSimFrame(t1, t2, t1.totalDurationHours + 0.1, 9, null);
    expect(mid.unit1.sample?.arrived).toBe(true);
    expect(mid.unit2.sample?.arrived).toBe(false);
    expect(mid.bothArrived).toBe(false);

    const done = evaluateDualSimFrame(t1, t2, bundle.totalDurationHours, 9, null);
    expect(done.unit1.sample?.arrived).toBe(true);
    expect(done.unit2.sample?.arrived).toBe(true);
    expect(done.bothArrived).toBe(true);
  });
});
