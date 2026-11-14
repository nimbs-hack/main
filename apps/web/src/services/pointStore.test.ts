import { describe, expect, test } from "bun:test";
import {
  MIL2525C_BY_ID,
  MIL2525C_SYMBOLS,
  MIL2525C_THEMES,
  resolveLegacyFgdcIcon,
} from "../assets/milStd2525c";
import {
  DEFAULT_POINT_CLASSES,
  createCustomPointClass,
  createMapPoint,
  filterVisiblePoints,
  isValidPointIconKey,
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

  test("validates MIL-STD-2525C catalog, 15-char SIDCs, and default classes", () => {
    expect(MIL2525C_SYMBOLS.length).toBeGreaterThanOrEqual(28);
    expect(MIL2525C_THEMES).toHaveLength(5);

    for (const theme of MIL2525C_THEMES) {
      const count = MIL2525C_SYMBOLS.filter((s) => s.theme === theme.id).length;
      expect(count).toBeGreaterThanOrEqual(5);
    }

    for (const symbol of MIL2525C_SYMBOLS) {
      expect(symbol.id.startsWith("mil2525c-")).toBe(true);
      expect(symbol.sidc).toHaveLength(15);
      expect(MIL2525C_BY_ID[symbol.id]).toBe(symbol);
      expect(isValidPointIconKey(symbol.id)).toBe(true);
    }

    for (const cls of DEFAULT_POINT_CLASSES) {
      expect(isValidPointIconKey(cls.icon)).toBe(true);
    }

    expect(isValidPointIconKey("mil2525c-nonexistent")).toBe(false);
    expect(isValidPointIconKey("fgdc-06-002")).toBe(false);
  });

  test("preserves valid MIL-STD-2525C icons, migrates legacy FGDC icons, and strips unknown icons", () => {
    const milPoint = createMapPoint(
      {
        name: "Rover Recon Ridge",
        classId: "science",
        icon: "mil2525c-rover",
        description: "Scout traverse waypoint.",
        coord: { lat: 18.68, lon: 77.46 },
      },
      [],
    );

    const restored = parsePointState(
      JSON.stringify({
        classes: [
          ...DEFAULT_POINT_CLASSES,
          {
            id: "legacy-geology",
            name: "Legacy Geo",
            shortCode: "GEO",
            color: "#38bdf8",
            icon: "fgdc-25-094",
          },
        ],
        points: [
          milPoint,
          {
            id: "pt-legacy-fgdc",
            name: "Marias Pass Dip",
            classId: "science",
            icon: "fgdc-06-002",
            description: "Dipping sedimentary bedding.",
            coord: { lat: 18.685, lon: 77.465 },
          },
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

    const migratedClass = restored.classes.find((c) => c.id === "legacy-geology");
    expect(migratedClass?.icon).toBe("mil2525c-crater");
    expect(migratedClass?.icon && isValidPointIconKey(migratedClass.icon)).toBe(true);

    expect(restored.points[0]?.icon).toBe("mil2525c-rover");
    expect(restored.points[1]?.icon).toBe("mil2525c-sensor");
    expect(restored.points[2]?.icon).toBeUndefined();
    expect(resolveLegacyFgdcIcon("fgdc-99-999")).toBe("mil2525c-sample");
    expect(resolveLegacyFgdcIcon("not-fgdc")).toBeUndefined();
  });
});
