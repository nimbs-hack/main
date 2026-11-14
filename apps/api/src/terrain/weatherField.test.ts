import { expect, test } from "bun:test";
import { generateMartianWeather, sampleWeatherAtOffset } from "../weather/generator";
import { interpolateWeatherAtHour } from "./weatherField";

test("map interpolation agrees with EVA sampling at sunrise, midnight and the horizon", () => {
  const snapshot = generateMartianWeather({ sol: 100, lsDeg: 359.8 });
  snapshot.daylight.sunriseLmst = "06:45:00";
  for (const point of snapshot.hourly) {
    point.isDaylight = point.lmstHour >= 7 && point.lmstHour <= 18;
    point.solarIrradianceWm2 = point.isDaylight ? 100 : 0;
  }
  for (const hour of [6.25, 6.8, 23.5, 24, 47.5, 48]) {
    const map = interpolateWeatherAtHour(snapshot, hour);
    const eva = sampleWeatherAtOffset(snapshot, hour);
    expect(map.tempK).toBe(eva.tempK);
    expect(map.pressurePa).toBe(eva.pressurePa);
    expect(map.isDaylight).toBe(eva.isDaylight);
    expect(map.sol).toBe(eva.sol);
    expect(map.lmstLabel).toBe(eva.lmstLabel);
  }
  expect(interpolateWeatherAtHour(snapshot, 6.25).isDaylight).toBe(false);
  expect(interpolateWeatherAtHour(snapshot, 24).lsDeg).toBe(snapshot.nextSol?.lsDeg ?? 0);
});
