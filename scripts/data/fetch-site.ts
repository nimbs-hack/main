import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  MARS_RADIUS_M,
  SOIL_TYPE_CATALOG,
  SOIL_TYPE_ORDER,
  classifyMarsSoilMatrix,
  coordToEquirectangular,
  equirectangularToCoord,
  normalizeLon180,
  surfaceDistanceMeters,
  type MarsBBox,
  type MarsCoord,
  type SiteDataset,
  type SiteMetadata,
} from "../../packages/shared/src";
import { type GeoTIFF, type GeoTIFFImage, fromUrl } from "geotiff";
import { encodeRgbaPng } from "../../apps/api/src/utils/png";

interface SitePreset {
  id: string;
  name: string;
  sourceItemId: string;
  sourceTitle: string;
  dtmUrl: string;
  hillshadeUrl: string;
  soilSourceTitle: string;
  themisNirUrl: string;
  centerHint: MarsCoord;
}

const PRESETS: Record<string, SitePreset> = {
  jezero: {
    id: "jezero-ctx-20km",
    name: "Jezero Crater Delta & Rim (MRO CTX)",
    sourceItemId: "K23_062385_1988_XN_18N282W__K23_062451_1988_XN_18N282W",
    sourceTitle: "MRO CTX Controlled USGS DTM (Jezero Crater)",
    dtmUrl:
      "https://astrogeo-ard.s3-us-west-2.amazonaws.com/mars/mro/ctx/controlled/usgs/K23_062385_1988_XN_18N282W__K23_062451_1988_XN_18N282W/K23_062385_1988_XN_18N282W__K23_062451_1988_XN_18N282W_dtm.tif",
    hillshadeUrl:
      "https://astrogeo-ard.s3-us-west-2.amazonaws.com/mars/mro/ctx/controlled/usgs/K23_062385_1988_XN_18N282W__K23_062451_1988_XN_18N282W/K23_062385_1988_XN_18N282W__K23_062451_1988_XN_18N282W_hillshade.tif",
    soilSourceTitle: "Mars Odyssey THEMIS Nighttime IR Controlled Mosaic (MC-13 Syrtis Major) + CTX Slope/TPI",
    themisNirUrl:
      "https://astrogeo-ard.s3-us-west-2.amazonaws.com/mars/mo/themis/controlled_mosaics/mc13_syrtis_major_nir/mc13_syrtis_major_nir.tif",
    centerHint: { lat: 18.664, lon: 77.502 },
  },
  "mount-sharp": {
    id: "mount-sharp-ctx-20km",
    name: "Gale Crater / Mount Sharp (MRO CTX)",
    sourceItemId: "T01_000881_1752_XI_04S223W__P02_001752_1753_XI_04S222W",
    sourceTitle: "MRO CTX Controlled USGS DTM (Gale Crater)",
    dtmUrl:
      "https://astrogeo-ard.s3-us-west-2.amazonaws.com/mars/mro/ctx/controlled/usgs/T01_000881_1752_XI_04S223W__P02_001752_1753_XI_04S222W/T01_000881_1752_XI_04S223W__P02_001752_1753_XI_04S222W-DEM-geoid-adj.tif",
    hillshadeUrl:
      "https://astrogeo-ard.s3-us-west-2.amazonaws.com/mars/mro/ctx/controlled/usgs/T01_000881_1752_XI_04S223W__P02_001752_1753_XI_04S222W/T01_000881_1752_XI_04S223W__P02_001752_1753_XI_04S222W-DEM-geoid-hs.tif",
    soilSourceTitle: "Mars Odyssey THEMIS Nighttime IR Controlled Mosaic (MC-23 Aeolis) + CTX Slope/TPI",
    themisNirUrl:
      "https://astrogeo-ard.s3-us-west-2.amazonaws.com/mars/mo/themis/controlled_mosaics/mc23_aeolis_nir/mc23_aeolis_nir.tif",
    centerHint: { lat: -4.81, lon: 137.16 },
  },
};

function parseCliArg(prefix: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

const DEFAULT_SITE_SIZE_KM = 20;
const DEFAULT_CELL_SIZE_M = 20;
const DEFAULT_HILLSHADE_SIZE = 1000;

/** Select coarsest COG overview whose ground resolution is <= targetResM (or full image if needed). */
async function pickOverviewImage(
  tiff: GeoTIFF,
  targetResM: number,
): Promise<{ img: GeoTIFFImage; index: number; resM: number }> {
  const count = await tiff.getImageCount();
  const baseImg = await tiff.getImage(0);
  const baseRes = Math.abs(baseImg.getResolution()[0] ?? 1);

  let chosenImg = baseImg;
  let chosenIdx = 0;
  let chosenRes = baseRes;

  for (let i = 1; i < count; i += 1) {
    const img = await tiff.getImage(i);
    const scaleX = baseImg.getWidth() / img.getWidth();
    const approxRes = baseRes * scaleX;
    if (approxRes <= targetResM && approxRes >= chosenRes) {
      chosenImg = img;
      chosenIdx = i;
      chosenRes = approxRes;
    }
  }

  return { img: chosenImg, index: chosenIdx, resM: chosenRes };
}

function clampWindowToBbox(
  cx: number,
  cy: number,
  widthProjM: number,
  heightProjM: number,
  [minX, minY, maxX, maxY]: [number, number, number, number],
): [number, number, number, number] {
  const halfW = widthProjM / 2;
  const halfH = heightProjM / 2;
  const clampedCx = Math.max(minX + halfW, Math.min(maxX - halfW, cx));
  const clampedCy = Math.max(minY + halfH, Math.min(maxY - halfH, cy));
  return [clampedCx - halfW, clampedCy - halfH, clampedCx + halfW, clampedCy + halfH];
}

function projBoxToPixelWindow(
  projWin: [number, number, number, number],
  imgBbox: [number, number, number, number],
  imgW: number,
  imgH: number,
): [number, number, number, number] {
  const [wx0, wy0, wx1, wy1] = projWin;
  const [minX, minY, maxX, maxY] = imgBbox;
  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);

  const pxLeft = Math.max(0, Math.floor(((wx0 - minX) / spanX) * imgW));
  const pxRight = Math.min(imgW, Math.ceil(((wx1 - minX) / spanX) * imgW));
  const pxTop = Math.max(0, Math.floor(((maxY - wy1) / spanY) * imgH));
  const pxBottom = Math.min(imgH, Math.ceil(((maxY - wy0) / spanY) * imgH));

  return [pxLeft, pxTop, Math.max(pxLeft + 1, pxRight), Math.max(pxTop + 1, pxBottom)];
}

/** Nodata-aware bilinear resample of a GeoTIFF pixel window into a north-up grid. */
function resampleElevGrid(
  src: ArrayLike<number>,
  srcW: number,
  srcH: number,
  pxWin: [number, number, number, number],
  projWin: [number, number, number, number],
  imgBbox: [number, number, number, number],
  fullW: number,
  fullH: number,
  outCols: number,
  outRows: number,
  nodataValue: number,
  minValid = nodataValue + 10,
): { grid: Float32Array; validCount: number } {
  const [pxLeft, pxTop] = pxWin;
  const [wx0, wy0, wx1, wy1] = projWin;
  const [minX, minY, maxX, maxY] = imgBbox;
  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);
  const nodataCutoff = minValid;

  const grid = new Float32Array(outRows * outCols);
  let validCount = 0;

  for (let r = 0; r < outRows; r += 1) {
    const wy = wy1 - (r / Math.max(1, outRows - 1)) * (wy1 - wy0);
    const fyFull = ((maxY - wy) / spanY) * fullH - 0.5;
    const ly = Math.max(0, Math.min(srcH - 1, fyFull - pxTop));
    const y0 = Math.floor(ly);
    const y1 = Math.min(srcH - 1, y0 + 1);
    const dy = ly - y0;

    for (let c = 0; c < outCols; c += 1) {
      const wx = wx0 + (c / Math.max(1, outCols - 1)) * (wx1 - wx0);
      const fxFull = ((wx - minX) / spanX) * fullW - 0.5;
      const lx = Math.max(0, Math.min(srcW - 1, fxFull - pxLeft));
      const x0 = Math.floor(lx);
      const x1 = Math.min(srcW - 1, x0 + 1);
      const dx = lx - x0;

      const s00 = src[y0 * srcW + x0] ?? nodataValue;
      const s01 = src[y0 * srcW + x1] ?? nodataValue;
      const s10 = src[y1 * srcW + x0] ?? nodataValue;
      const s11 = src[y1 * srcW + x1] ?? nodataValue;

      const w00 = Number.isFinite(s00) && s00 >= nodataCutoff ? (1 - dx) * (1 - dy) : 0;
      const w01 = Number.isFinite(s01) && s01 >= nodataCutoff ? dx * (1 - dy) : 0;
      const w10 = Number.isFinite(s10) && s10 >= nodataCutoff ? (1 - dx) * dy : 0;
      const w11 = Number.isFinite(s11) && s11 >= nodataCutoff ? dx * dy : 0;
      const wSum = w00 + w01 + w10 + w11;

      const outIdx = r * outCols + c;
      if (wSum > 1e-6) {
        grid[outIdx] = (s00 * w00 + s01 * w01 + s10 * w10 + s11 * w11) / wSum;
        validCount += 1;
      } else {
        grid[outIdx] = nodataValue;
      }
    }
  }

  return { grid, validCount };
}

/** Iteratively interpolate small nodata pockets from valid local neighbors (radius up to 5 px). */
function fillIsolatedNodata(
  grid: Float32Array,
  rows: number,
  cols: number,
  nodataValue: number,
): number {
  const nodataCutoff = nodataValue + 10;
  let filled = 0;

  for (let pass = 0; pass < 3; pass += 1) {
    const updates: Array<{ idx: number; val: number }> = [];
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const idx = r * cols + c;
        const cur = grid[idx] ?? nodataValue;
        if (Number.isFinite(cur) && cur > nodataCutoff) continue;

        let sum = 0;
        let wSum = 0;
        for (let dr = -4; dr <= 4; dr += 1) {
          const nr = r + dr;
          if (nr < 0 || nr >= rows) continue;
          for (let dc = -4; dc <= 4; dc += 1) {
            if (dr === 0 && dc === 0) continue;
            const nc = c + dc;
            if (nc < 0 || nc >= cols) continue;
            const nv = grid[nr * cols + nc] ?? nodataValue;
            if (!Number.isFinite(nv) || nv <= nodataCutoff) continue;
            const w = 1 / Math.hypot(dr, dc);
            sum += nv * w;
            wSum += w;
          }
        }
        if (wSum > 0) {
          updates.push({ idx, val: sum / wSum });
        }
      }
    }
    if (updates.length === 0) break;
    for (const u of updates) {
      grid[u.idx] = u.val;
    }
    filled += updates.length;
  }

  return filled;
}

/** Compute normalized 0..255 Horn hillshade value directly from the local elevation grid. */
function computeDemHillshadeByte(
  grid: Float32Array,
  rows: number,
  cols: number,
  r: number,
  c: number,
  cellSizeM: number,
  nodataValue: number,
): number {
  const center = grid[r * cols + c] ?? nodataValue;
  if (!Number.isFinite(center) || center <= nodataValue + 10) return 0;

  const sample = (rr: number, cc: number): number => {
    const cr = Math.max(0, Math.min(rows - 1, rr));
    const ccClamped = Math.max(0, Math.min(cols - 1, cc));
    const v = grid[cr * cols + ccClamped] ?? center;
    return Number.isFinite(v) && v > nodataValue + 10 ? v : center;
  };

  const dzdx =
    (sample(r - 1, c + 1) +
      2 * sample(r, c + 1) +
      sample(r + 1, c + 1) -
      (sample(r - 1, c - 1) + 2 * sample(r, c - 1) + sample(r + 1, c - 1))) /
    (8 * cellSizeM);
  const dzdy =
    (sample(r + 1, c - 1) +
      2 * sample(r + 1, c) +
      sample(r + 1, c + 1) -
      (sample(r - 1, c - 1) + 2 * sample(r - 1, c) + sample(r - 1, c + 1))) /
    (8 * cellSizeM);

  // Sun from NW (azimuth 315 deg, altitude 38 deg)
  const alt = (38 * Math.PI) / 180;
  const az = (315 * Math.PI) / 180;
  const zenith = Math.PI / 2 - alt;
  const slope = Math.atan(Math.hypot(dzdx, dzdy));
  const aspect = Math.atan2(dzdy, -dzdx);

  const shade =
    Math.cos(zenith) * Math.cos(slope) +
    Math.sin(zenith) * Math.sin(slope) * Math.cos(az - aspect);
  return Math.max(20, Math.min(245, Math.round(shade * 235)));
}

/** Build a warm-tinted RGBA PNG buffer from raster hillshade + DEM fallback relief. */
function buildHillshadeRgba(
  src: ArrayLike<number>,
  srcW: number,
  srcH: number,
  pxWin: [number, number, number, number],
  projWin: [number, number, number, number],
  imgBbox: [number, number, number, number],
  fullW: number,
  fullH: number,
  hsNodata: number,
  elevGrid: Float32Array,
  elevRows: number,
  elevCols: number,
  cellSizeM: number,
  elevNodata: number,
  outSize: number,
): Uint8Array {
  const [pxLeft, pxTop] = pxWin;
  const [wx0, wy0, wx1, wy1] = projWin;
  const [minX, minY, maxX, maxY] = imgBbox;
  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);

  // Detect float normalized reflectance (<= 2.0) vs 0..255 byte hillshade
  const validSamples: number[] = [];
  const sampleStep = Math.max(1, Math.floor(src.length / 4096));
  for (let i = 0; i < src.length; i += sampleStep) {
    const v = src[i] ?? 0;
    if (Number.isFinite(v) && v !== hsNodata && v > 0) {
      validSamples.push(v);
    }
  }
  validSamples.sort((a, b) => a - b);
  const p98 = validSamples[Math.floor(validSamples.length * 0.98)] ?? 255;
  const isFloatNormalized = p98 <= 2.5;
  const lo = validSamples[Math.floor(validSamples.length * 0.02)] ?? 0;
  const hi = Math.max(lo + 1e-4, p98);

  const rgba = new Uint8Array(outSize * outSize * 4);
  for (let r = 0; r < outSize; r += 1) {
    const wy = wy1 - (r / Math.max(1, outSize - 1)) * (wy1 - wy0);
    const fyFull = ((maxY - wy) / spanY) * fullH - 0.5;
    const ly = Math.max(0, Math.min(srcH - 1, Math.round(fyFull - pxTop)));

    const er = Math.min(elevRows - 1, Math.round((r / Math.max(1, outSize - 1)) * (elevRows - 1)));

    for (let c = 0; c < outSize; c += 1) {
      const wx = wx0 + (c / Math.max(1, outSize - 1)) * (wx1 - wx0);
      const fxFull = ((wx - minX) / spanX) * fullW - 0.5;
      const lx = Math.max(0, Math.min(srcW - 1, Math.round(fxFull - pxLeft)));
      const ec = Math.min(
        elevCols - 1,
        Math.round((c / Math.max(1, outSize - 1)) * (elevCols - 1)),
      );

      const raw = src[ly * srcW + lx] ?? hsNodata;
      const hasValidSrc = Number.isFinite(raw) && raw !== hsNodata && raw > 0;
      const demShade = computeDemHillshadeByte(
        elevGrid,
        elevRows,
        elevCols,
        er,
        ec,
        cellSizeM,
        elevNodata,
      );

      let gray = demShade;
      if (hasValidSrc) {
        const mapped = isFloatNormalized
          ? Math.max(0, Math.min(255, Math.round(((raw - lo) / (hi - lo)) * 255)))
          : Math.max(0, Math.min(255, Math.round(raw)));
        gray = demShade > 0 ? Math.round(mapped * 0.8 + demShade * 0.2) : mapped;
      }

      if (gray <= 0) continue;
      const p = (r * outSize + c) * 4;
      rgba[p] = Math.min(255, Math.round(gray * 0.94));
      rgba[p + 1] = Math.min(255, Math.round(gray * 0.86));
      rgba[p + 2] = Math.min(255, Math.round(gray * 0.78));
      rgba[p + 3] = 255;
    }
  }

  return rgba;
}

async function main() {
  const siteKey = parseCliArg("--site=") ?? "jezero";
  const preset = PRESETS[siteKey];
  if (!preset) {
    throw new Error(`Unknown site "${siteKey}". Available: ${Object.keys(PRESETS).join(", ")}`);
  }

  const sizeKm = Number(parseCliArg("--size-km=") ?? DEFAULT_SITE_SIZE_KM);
  if (!Number.isFinite(sizeKm) || sizeKm <= 0) {
    throw new Error(`Invalid --size-km="${sizeKm}"`);
  }
  const siteSizeM = Math.round(sizeKm * 1000);
  const defaultGrid = Math.round(siteSizeM / DEFAULT_CELL_SIZE_M) + 1;
  const gridSize = Number(parseCliArg("--grid=") ?? defaultGrid);
  if (!Number.isFinite(gridSize) || gridSize < 11) {
    throw new Error(`Invalid --grid="${gridSize}"`);
  }
  const cellSizeM = Math.round((siteSizeM / (gridSize - 1)) * 100) / 100;
  const hillshadeSize = DEFAULT_HILLSHADE_SIZE;

  const sizeTag = `${Math.round(sizeKm)}x${Math.round(sizeKm)} km`;
  console.log(
    `Fetching ${preset.name} (${sizeTag}, ${gridSize}x${gridSize} @ ${cellSizeM} m/node)...`,
  );

  const dtmTiff = await fromUrl(preset.dtmUrl);
  const dtmBase = await dtmTiff.getImage(0);
  const dtmFullW = dtmBase.getWidth();
  const dtmFullH = dtmBase.getHeight();
  const dtmBbox = dtmBase.getBoundingBox() as [number, number, number, number];
  const nodataValue = Number(dtmBase.getGDALNoData() ?? -32767);
  const baseRes = Math.abs(dtmBase.getResolution()[0] ?? 20);
  console.log(
    `Full DTM: ${dtmFullW}x${dtmFullH} px, native res ${baseRes.toFixed(2)} m/px, nodata ${nodataValue}`,
  );

  // Convert desired 20x20 km patch to equirectangular window using Mars sphere scale at centerHint
  const centerProj = coordToEquirectangular(preset.centerHint);
  const heightProjM = siteSizeM;
  const widthProjM = siteSizeM / Math.max(1e-6, Math.cos((preset.centerHint.lat * Math.PI) / 180));

  const bboxSpanX = dtmBbox[2] - dtmBbox[0];
  const bboxSpanY = dtmBbox[3] - dtmBbox[1];
  if (bboxSpanX < widthProjM * 0.99 || bboxSpanY < heightProjM * 0.99) {
    throw new Error(
      `Source DTM bbox (${Math.round(bboxSpanX)}x${Math.round(bboxSpanY)} m) is smaller than requested ${sizeTag}.`,
    );
  }

  // Probe candidate windows on fast coarse overview (~180 m/px)
  const probeOv = await pickOverviewImage(dtmTiff, 180);
  const probeW = probeOv.img.getWidth();
  const probeH = probeOv.img.getHeight();
  console.log(`Candidate search overview #${probeOv.index}: ${probeW}x${probeH}`);

  const candidateCenters: Array<[number, number]> = [
    [centerProj.xMeters, centerProj.yMeters],
    [(dtmBbox[0] + dtmBbox[2]) / 2, (dtmBbox[1] + dtmBbox[3]) / 2],
    [centerProj.xMeters - 0.1 * bboxSpanX, centerProj.yMeters],
    [centerProj.xMeters + 0.1 * bboxSpanX, centerProj.yMeters],
    [centerProj.xMeters, centerProj.yMeters - 0.1 * bboxSpanY],
    [centerProj.xMeters, centerProj.yMeters + 0.1 * bboxSpanY],
  ];

  let bestProjWin: [number, number, number, number] | null = null;
  let bestScore = -1;

  for (const [cx, cy] of candidateCenters) {
    const win = clampWindowToBbox(cx, cy, widthProjM, heightProjM, dtmBbox);
    const pxWin = projBoxToPixelWindow(win, dtmBbox, probeW, probeH);
    const rasters = await probeOv.img.readRasters({ window: pxWin, interleave: true });
    const data = rasters as unknown as ArrayLike<number>;
    let valid = 0;
    let minV = Number.POSITIVE_INFINITY;
    let maxV = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < data.length; i += 1) {
      const v = data[i] ?? nodataValue;
      if (Number.isFinite(v) && v > nodataValue + 10) {
        valid += 1;
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
      }
    }
    const validRatio = valid / Math.max(1, data.length);
    const relief = valid > 0 ? maxV - minV : 0;
    // Strongly favor near-100% valid windows; break ties by topographic relief
    const score = validRatio >= 0.99 ? 100_000 + relief : validRatio * 10_000 + relief * 0.1;
    if (score > bestScore) {
      bestScore = score;
      bestProjWin = win;
    }
    console.log(
      `  Probe center (${Math.round(cx)}, ${Math.round(cy)}): valid ${(validRatio * 100).toFixed(2)}%, relief ${Math.round(relief)} m`,
    );
  }

  if (!bestProjWin) {
    throw new Error("Could not select a valid elevation window.");
  }

  // Recompute exact projection width at chosen window latitude so ground E-W span equals siteSizeM
  const chosenMidY = (bestProjWin[1] + bestProjWin[3]) / 2;
  const chosenMidLat = equirectangularToCoord(0, chosenMidY).lat;
  const exactWidthProjM = siteSizeM / Math.max(1e-6, Math.cos((chosenMidLat * Math.PI) / 180));
  const chosenMidX = (bestProjWin[0] + bestProjWin[2]) / 2;
  const finalProjWin = clampWindowToBbox(
    chosenMidX,
    chosenMidY,
    exactWidthProjM,
    siteSizeM,
    dtmBbox,
  );

  // Read DTM from appropriate overview near target cell spacing
  const dtmOv = await pickOverviewImage(dtmTiff, Math.max(baseRes, cellSizeM * 0.95));
  const dtmOvW = dtmOv.img.getWidth();
  const dtmOvH = dtmOv.img.getHeight();
  const dtmPxWin = projBoxToPixelWindow(finalProjWin, dtmBbox, dtmOvW, dtmOvH);
  const dtmSrcW = dtmPxWin[2] - dtmPxWin[0];
  const dtmSrcH = dtmPxWin[3] - dtmPxWin[1];
  console.log(
    `Reading DTM overview #${dtmOv.index} (~${dtmOv.resM.toFixed(1)} m/px) window ${dtmSrcW}x${dtmSrcH}...`,
  );

  const dtmRaster = await dtmOv.img.readRasters({ window: dtmPxWin, interleave: true });
  const { grid, validCount } = resampleElevGrid(
    dtmRaster as unknown as ArrayLike<number>,
    dtmSrcW,
    dtmSrcH,
    dtmPxWin,
    finalProjWin,
    dtmBbox,
    dtmOvW,
    dtmOvH,
    gridSize,
    gridSize,
    nodataValue,
  );

  const filled = fillIsolatedNodata(grid, gridSize, gridSize, nodataValue);
  let minElevationM = Number.POSITIVE_INFINITY;
  let maxElevationM = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < grid.length; i += 1) {
    const v = grid[i] ?? nodataValue;
    if (Number.isFinite(v) && v > nodataValue + 10) {
      const rounded = Math.round(v * 100) / 100;
      grid[i] = rounded;
      if (rounded < minElevationM) minElevationM = rounded;
      if (rounded > maxElevationM) maxElevationM = rounded;
    } else {
      grid[i] = nodataValue;
    }
  }
  console.log(
    `Resampled ${gridSize}x${gridSize} (${(gridSize * gridSize).toLocaleString()} nodes), valid initially ${validCount}/${grid.length}, filled ${filled} isolated pixels. Elevation ${minElevationM.toFixed(1)}..${maxElevationM.toFixed(1)} m`,
  );

  // Convert final equirectangular window to planetocentric bbox
  const sw = equirectangularToCoord(finalProjWin[0], finalProjWin[1]);
  const ne = equirectangularToCoord(finalProjWin[2], finalProjWin[3]);
  const bbox: MarsBBox = [normalizeLon180(sw.lon), sw.lat, normalizeLon180(ne.lon), ne.lat];
  const center: MarsCoord = {
    lat: (bbox[1] + bbox[3]) / 2,
    lon: normalizeLon180((bbox[0] + bbox[2]) / 2),
  };

  const widthMeters = surfaceDistanceMeters(
    { lat: center.lat, lon: bbox[0] },
    { lat: center.lat, lon: bbox[2] },
  );
  const heightMeters = surfaceDistanceMeters(
    { lat: bbox[1], lon: center.lon },
    { lat: bbox[3], lon: center.lon },
  );

  // Sanity check that physical ground span uses Mars sphere radius cleanly
  console.log(
    `BBox [${bbox.map((n) => n.toFixed(5)).join(", ")}] -> ${Math.round(widthMeters)} m x ${Math.round(heightMeters)} m (R=${MARS_RADIUS_M} m)`,
  );

  // Read hillshade raster and build tinted RGBA PNG
  const hsTiff = await fromUrl(preset.hillshadeUrl);
  const hsBase = await hsTiff.getImage(0);
  const hsBbox = hsBase.getBoundingBox() as [number, number, number, number];
  const hsNodata = Number(hsBase.getGDALNoData() ?? 0);
  const hsOv = await pickOverviewImage(hsTiff, Math.max(baseRes, cellSizeM * 0.9));
  const hsOvW = hsOv.img.getWidth();
  const hsOvH = hsOv.img.getHeight();
  const hsPxWin = projBoxToPixelWindow(finalProjWin, hsBbox, hsOvW, hsOvH);
  const hsSrcW = hsPxWin[2] - hsPxWin[0];
  const hsSrcH = hsPxWin[3] - hsPxWin[1];
  console.log(
    `Reading hillshade overview #${hsOv.index} window ${hsSrcW}x${hsSrcH} -> ${hillshadeSize}x${hillshadeSize} PNG...`,
  );

  const hsRaster = await hsOv.img.readRasters({ window: hsPxWin, interleave: true });
  const hsRgba = buildHillshadeRgba(
    hsRaster as unknown as ArrayLike<number>,
    hsSrcW,
    hsSrcH,
    hsPxWin,
    finalProjWin,
    hsBbox,
    hsOvW,
    hsOvH,
    hsNodata,
    grid,
    gridSize,
    gridSize,
    cellSizeM,
    nodataValue,
    hillshadeSize,
  );
  const hillshadePng = encodeRgbaPng(hillshadeSize, hillshadeSize, hsRgba, 6);

  // Sample Mars Odyssey THEMIS Nighttime IR thermal-inertia mosaic and classify 4 Martian soil types
  console.log(`Sampling THEMIS Nighttime IR mosaic from ${preset.themisNirUrl}...`);
  const nirTiff = await fromUrl(preset.themisNirUrl);
  const nirImg = await nirTiff.getImage(0);
  const nirBbox = nirImg.getBoundingBox() as [number, number, number, number];
  const nirFullW = nirImg.getWidth();
  const nirFullH = nirImg.getHeight();
  const nirPxWin = projBoxToPixelWindow(finalProjWin, nirBbox, nirFullW, nirFullH);
  const nirSrcW = nirPxWin[2] - nirPxWin[0];
  const nirSrcH = nirPxWin[3] - nirPxWin[1];
  const nirRaster = await nirImg.readRasters({ window: nirPxWin, interleave: true });
  const { grid: themisGrid, validCount: nirValid } = resampleElevGrid(
    nirRaster as unknown as ArrayLike<number>,
    nirSrcW,
    nirSrcH,
    nirPxWin,
    finalProjWin,
    nirBbox,
    nirFullW,
    nirFullH,
    gridSize,
    gridSize,
    0,
    1,
  );
  console.log(
    `THEMIS NIR window ${nirSrcW}x${nirSrcH} px -> resampled ${gridSize}x${gridSize} (${nirValid}/${themisGrid.length} valid).`,
  );

  const dxM = widthMeters / Math.max(1, gridSize - 1);
  const dyM = heightMeters / Math.max(1, gridSize - 1);
  const soilMatrix = classifyMarsSoilMatrix({
    elevationsM: grid,
    rows: gridSize,
    cols: gridSize,
    dxM,
    dyM,
    nodataValue,
    themisDn: themisGrid,
  });

  const soilCounts = [0, 0, 0, 0];
  for (let i = 0; i < soilMatrix.length; i += 1) {
    const code = soilMatrix[i] ?? 1;
    if (code >= 0 && code < soilCounts.length) {
      soilCounts[code] = (soilCounts[code] ?? 0) + 1;
    }
  }
  const soilSummary = SOIL_TYPE_ORDER.map((id, idx) => {
    const pct = (((soilCounts[idx] ?? 0) / soilMatrix.length) * 100).toFixed(1);
    return `${SOIL_TYPE_CATALOG[id].shortLabel}:${pct}%`;
  }).join(", ");
  console.log(`Classified 4-class Martian soil matrix: ${soilSummary}`);

  const meta: SiteMetadata = {
    id: preset.id,
    name: preset.name,
    sourceItemId: preset.sourceItemId,
    sourceTitle: preset.sourceTitle,
    dtmUrl: preset.dtmUrl,
    hillshadeUrl: preset.hillshadeUrl,
    bbox,
    center,
    widthMeters: Math.round(widthMeters * 100) / 100,
    heightMeters: Math.round(heightMeters * 100) / 100,
    rows: gridSize,
    cols: gridSize,
    cellSizeMeters: cellSizeM,
    minElevationM,
    maxElevationM,
    nodataValue,
    soilSourceTitle: preset.soilSourceTitle,
    soilUrl: preset.themisNirUrl,
  };

  const dataset: SiteDataset = {
    meta,
    elevationsM: Array.from(grid),
    soilTypes: Array.from(soilMatrix),
  };

  const dataDir = resolve(process.cwd(), "data");
  await mkdir(dataDir, { recursive: true });
  const jsonPath = resolve(dataDir, "site-terrain.json");
  const pngPath = resolve(dataDir, "site-hillshade.png");

  await writeFile(jsonPath, JSON.stringify(dataset), "utf8");
  await writeFile(pngPath, hillshadePng);

  console.log(`Saved ${jsonPath} and ${pngPath} cleanly.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
