import { describe, expect, it } from "bun:test";
import {
  buildUnitTraverseTimeline,
  computeSegmentHours,
  findBestWaypointInsertIndex,
  sampleUnitTimelineAt,
} from "./traverse";
import { type ComputedRoute, DEFAULT_EVA_WEATHER_LIMITS, TRAVERSE_PRESETS } from "./types";

const SAMPLE_ROUTE: ComputedRoute = {
  id: "r1",
  label: "Shortest Safe",
  strategy: "shortest",
  totalDistanceM: 3000,
  elevationGainM: 100,
  elevationLossM: 0,
  maxSlopeDeg: 5,
  meanSlopeDeg: 3,
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
      lat: 18.61,
      lon: 77.41,
      elevationM: -2450,
      distanceM: 1500,
      slopeDeg: 4,
      soilType: "loose-sand",
      soilSpeedFactor: 0.45,
    },
    {
      lat: 18.62,
      lon: 77.42,
      elevationM: -2400,
      distanceM: 3000,
      slopeDeg: 5,
      soilType: "loose-sand",
      soilSpeedFactor: 0.45,
    },
  ],
};

describe("dual-unit traverse timeline integration", () => {
  it("computes soil-scaled traverse duration and interpolates until arrival", () => {
    const timeline = buildUnitTraverseTimeline(1, SAMPLE_ROUTE, DEFAULT_EVA_WEATHER_LIMITS);
    const seg1 = computeSegmentHours(1500, 50, 0, DEFAULT_EVA_WEATHER_LIMITS, (1 + 0.45) / 2);
    const seg2 = computeSegmentHours(1500, 50, 0, DEFAULT_EVA_WEATHER_LIMITS, 0.45);
    expect(timeline.totalDurationHours).toBeCloseTo(seg1 + seg2, 5);

    const start = sampleUnitTimelineAt(timeline, 0);
    expect(start).not.toBeNull();
    if (!start) return;
    expect(start.arrived).toBe(false);
    expect(start.progressRatio).toBe(0);
    expect(start.lat).toBe(18.6);

    const mid = sampleUnitTimelineAt(timeline, seg1);
    expect(mid).not.toBeNull();
    if (!mid) return;
    expect(mid.arrived).toBe(false);
    expect(mid.distanceM).toBeCloseTo(1500, 1);
    expect(mid.elevationM).toBeCloseTo(-2450, 1);

    const afterDone = sampleUnitTimelineAt(timeline, timeline.totalDurationHours + 2);
    expect(afterDone).not.toBeNull();
    if (!afterDone) return;
    expect(afterDone.arrived).toBe(true);
    expect(afterDone.progressRatio).toBe(1);
    expect(afterDone.speedMPerH).toBe(0);
    expect(afterDone.lat).toBe(18.62);
  });

  it("models faster rover vs human ending simultaneously when slower unit reaches B", () => {
    const tHuman = buildUnitTraverseTimeline(1, SAMPLE_ROUTE, TRAVERSE_PRESETS.human.limits);
    const tRover = buildUnitTraverseTimeline(2, SAMPLE_ROUTE, TRAVERSE_PRESETS.rover.limits);
    expect(tRover.totalDurationHours).toBeLessThan(tHuman.totalDurationHours);

    const roverAtEnd = sampleUnitTimelineAt(tRover, tHuman.totalDurationHours);
    const humanAtEnd = sampleUnitTimelineAt(tHuman, tHuman.totalDurationHours);
    expect(roverAtEnd).not.toBeNull();
    expect(humanAtEnd).not.toBeNull();
    if (!roverAtEnd || !humanAtEnd) return;
    expect(roverAtEnd.arrived).toBe(true);
    expect(humanAtEnd.arrived).toBe(true);
  });

  it("picks closest leg index when inserting intermediate waypoints", () => {
    const p1 = { lat: 18.6, lon: 77.4 };
    const p2 = { lat: 18.6, lon: 77.5 };
    const p3 = { lat: 18.7, lon: 77.5 };

    expect(findBestWaypointInsertIndex([], p1)).toBe(0);
    expect(findBestWaypointInsertIndex([p1], p2)).toBe(1);
    expect(findBestWaypointInsertIndex([p1, p3], p2)).toBe(1);
    expect(findBestWaypointInsertIndex([p1, p2, p3], { lat: 18.605, lon: 77.45 })).toBe(1);
    expect(findBestWaypointInsertIndex([p1, p2, p3], { lat: 18.65, lon: 77.495 })).toBe(2);
  });
});
