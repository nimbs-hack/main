import { expect, test } from "bun:test";
import { resampleElevGrid } from "./fetch-site";

function sampleCenter(values: number[]) {
  return resampleElevGrid(
    values,
    2,
    2,
    [0, 0, 2, 2],
    [1, 1, 1, 1],
    [0, 0, 2, 2],
    2,
    2,
    1,
    1,
    -32767,
  );
}

test("bilinear DEM interpolation ignores non-finite missing samples", () => {
  const result = sampleCenter([10, 20, Number.NaN, Number.NEGATIVE_INFINITY]);
  expect(result.validCount).toBe(1);
  expect(result.grid[0]).toBe(15);
});

test("bilinear DEM interpolation leaves entirely unknown terrain blocked", () => {
  const result = sampleCenter([-32767, Number.NaN, Number.POSITIVE_INFINITY, -32767]);
  expect(result.validCount).toBe(0);
  expect(result.grid[0]).toBe(-32767);
});

test("bilinear DEM interpolation preserves the mean of four valid samples", () => {
  expect(sampleCenter([10, 20, 30, 40]).grid[0]).toBe(25);
});
