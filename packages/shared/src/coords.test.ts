import { describe, expect, test } from "bun:test";
import {
  MARS_RADIUS_M,
  coordToEquirectangular,
  equirectangularToCoord,
  lon180To360,
  metersToLatDeg,
  metersToLonDeg,
  normalizeLon180,
  surfaceDistanceMeters,
} from "./coords";

describe("Mars coordinate helpers", () => {
  test("normalizes east-positive 0..360 longitudes to [-180, 180)", () => {
    expect(normalizeLon180(0)).toBe(0);
    expect(normalizeLon180(180)).toBe(-180);
    expect(normalizeLon180(270)).toBe(-90);
    expect(normalizeLon180(360)).toBe(0);
    expect(normalizeLon180(-180)).toBe(-180);
    expect(lon180To360(-90)).toBe(270);
  });

  test("matches USGS Jezero HiRISE equirectangular origin transform", () => {
    // From USGS STAC DTEEC_048842_1985_048908_1985_U01 proj:transform
    const coord = equirectangularToCoord(4591503.886588774, 1101835.3429085817);
    expect(coord.lon).toBeCloseTo(77.4615, 3);
    expect(coord.lat).toBeCloseTo(18.5883, 3);

    const roundTrip = coordToEquirectangular(coord);
    expect(roundTrip.xMeters).toBeCloseTo(4591503.89, 1);
    expect(roundTrip.yMeters).toBeCloseTo(1101835.34, 1);
  });

  test("computes surface distance on the Mars sphere", () => {
    const oneDegLatMeters = (Math.PI / 180) * MARS_RADIUS_M;
    const d = surfaceDistanceMeters({ lat: 0, lon: 0 }, { lat: 1, lon: 0 });
    expect(d).toBeCloseTo(oneDegLatMeters, 1);

    const latDelta = metersToLatDeg(3000);
    const northSouth = surfaceDistanceMeters(
      { lat: 18.4, lon: 77.5 },
      { lat: 18.4 + latDelta, lon: 77.5 },
    );
    expect(northSouth).toBeCloseTo(3000, 1);

    const lonDelta = metersToLonDeg(3000, 18.4);
    const eastWest = surfaceDistanceMeters(
      { lat: 18.4, lon: 77.5 },
      { lat: 18.4, lon: 77.5 + lonDelta },
    );
    expect(eastWest).toBeCloseTo(3000, 1);
  });
});
