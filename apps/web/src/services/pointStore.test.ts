import { describe, expect, test } from "bun:test";
import {
  DEFAULT_POINT_CLASSES,
  createCustomPointClass,
  createMapPoint,
  filterVisiblePoints,
  parsePointState,
  setAllClassesVisible,
  toggleClassVisibility,
} from "./pointStore";

describe("pointStore classification and filtering", () => {
  test("creates points and filters them when a class is hidden", () => {
    const p1 = createMapPoint(
      {
        name: "Boxwork Ridge",
        classId: "science",
        description: "Layered carbonate fractures for spectroscopy.",
        coord: { lat: 18.65, lon: 77.45 },
        elevationM: -2410.5,
      },
      [],
    );
    const p2 = createMapPoint(
      {
        name: "Solar Relay 01",
        classId: "supply",
        description: "Reserve battery charger and comms transponder.",
        coord: { lat: 18.67, lon: 77.48 },
      },
      [p1],
    );

    const points = [p1, p2];
    expect(filterVisiblePoints(points, [])).toHaveLength(2);

    const hidden = toggleClassVisibility([], "science");
    expect(hidden).toEqual(["science"]);
    const afterHide = filterVisiblePoints(points, hidden);
    expect(afterHide).toHaveLength(1);
    expect(afterHide[0]?.id).toBe(p2.id);

    const unhidden = toggleClassVisibility(hidden, "science");
    expect(unhidden).toEqual([]);
    expect(filterVisiblePoints(points, unhidden, "carbonate")).toHaveLength(1);
  });

  test("supports custom point classes and persists/parses cleanly", () => {
    const customClass = createCustomPointClass(
      {
        name: "Landing Pad",
        shortCode: "PAD",
        color: "#60a5fa",
        icon: "beacon",
      },
      DEFAULT_POINT_CLASSES,
    );
    expect(customClass.id).toBe("landing-pad");
    expect(customClass.shortCode).toBe("PAD");
    expect(customClass.builtIn).toBe(false);

    const classes = [...DEFAULT_POINT_CLASSES, customClass];
    const point = createMapPoint(
      {
        name: "Pad Alpha",
        classId: customClass.id,
        description: "Flat basalt apron.",
        coord: { lat: 18.66, lon: 77.44 },
      },
      [],
    );

    const serialized = JSON.stringify({
      classes,
      points: [point],
      hiddenClassIds: [customClass.id],
    });
    const restored = parsePointState(serialized);
    expect(restored.classes.some((c) => c.id === customClass.id)).toBe(true);
    expect(restored.points).toHaveLength(1);
    expect(restored.points[0]?.classId).toBe(customClass.id);
    expect(restored.hiddenClassIds).toEqual([customClass.id]);

    const allHidden = setAllClassesVisible(classes, false);
    expect(allHidden).toHaveLength(classes.length);
    expect(filterVisiblePoints([point], allHidden)).toHaveLength(0);

    const allShown = setAllClassesVisible(classes, true);
    expect(allShown).toEqual([]);
    expect(filterVisiblePoints([point], allShown)).toHaveLength(1);
  });

  test("repairs corrupted storage payloads safely", () => {
    const invalidJson = parsePointState("{broken");
    expect(invalidJson.classes).toHaveLength(DEFAULT_POINT_CLASSES.length);
    expect(invalidJson.points).toEqual([]);

    const missingClass = parsePointState(
      JSON.stringify({
        classes: [],
        points: [
          {
            id: "pt-1",
            name: "Orphan Outcrop",
            classId: "deleted-class",
            description: "Still keeps valid coords.",
            coord: { lat: 18.5, lon: 77.4 },
          },
        ],
        hiddenClassIds: ["non-existent", "hazard"],
      }),
    );
    expect(missingClass.points[0]?.classId).toBe("science");
    expect(missingClass.hiddenClassIds).toEqual(["hazard"]);
  });

  test("preserves valid FGDC geologic point icons and strips unknown icons", () => {
    const fgdcPoint = createMapPoint(
      {
        name: "Marias Pass Dip",
        classId: "science",
        icon: "fgdc-06-002",
        description: "Dipping sedimentary bedding.",
        coord: { lat: 18.68, lon: 77.46 },
      },
      [],
    );

    const restored = parsePointState(
      JSON.stringify({
        classes: DEFAULT_POINT_CLASSES,
        points: [
          fgdcPoint,
          {
            id: "pt-bad-icon",
            name: "Bad Icon Spot",
            classId: "hazard",
            icon: "unknown-icon",
            description: "Fallback expected.",
            coord: { lat: 18.69, lon: 77.47 },
          },
        ],
        hiddenClassIds: [],
      }),
    );

    expect(restored.points[0]?.icon).toBe("fgdc-06-002");
    expect(restored.points[1]?.icon).toBeUndefined();
  });
});
