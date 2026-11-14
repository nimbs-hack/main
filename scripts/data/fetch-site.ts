import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  MARS_RADIUS_M,
  type SiteDataset,
  equirectangularToCoord,
  normalizeLon180,
} from "../../packages/shared/src/index";
import { type GeoTIFF, type GeoTIFFImage, fromUrl } from "geotiff";
import { encodeRgbaPng } from "../../apps/api/src/utils/png";

interface SitePreset {
  id: string;
  name: string;
  sourceItemId: string;
  sourceTitle: string;
  dtmUrl: string;
  hillshadeUrl: string;
  centerHint: { lat: number; lon: number };
}

const PRESETS: Record<string, SitePreset> = {
  jezero: {
    id: "jezero-delta-3km",
    name: "Jezero Crater Delta",
    sourceItemId: "DTEEC_048842_1985_048908_1985_U01",
    sourceTitle: "MRO HiRISE DTM; ESP_048842_1985_ESP_048908_1985",
    dtmUrl:
      "https://astrogeo-ard.s3-us-west-2.amazonaws.com/mars/mro/hirise/controlled/dtm/ESP_048842_1985_ESP_048908_1985/DTEEC_048842_1985_048908_1985_U01.tif",
    hillshadeUrl:
      "https://astrogeo-ard.s3-us-west-2.amazonaws.com/mars/mro/hirise/controlled/dtm/ESP_048842_1985_ESP_048908_1985/DTEEC_048842_1985_048908_1985_U01_hillshade.tif",
    centerHint: { lat: 18.46, lon: 77.523 },
  },
  "mount-sharp": {
    id: "mount-sharp-3km",
    name: "Aeolis Mons (Mount Sharp)",
    sourceItemId: "DTEEC_063319_1745_052242_1745_A01",
    sourceTitle: "MRO HiRISE DTM; ESP_063319_1745_ESP_052242_1745",
    dtmUrl:
      "https://astrogeo-ard.s3-us-west-2.amazonaws.com/mars/mro/hirise/controlled/dtm/ESP_063319_1745_ESP_052242_1745/DTEEC_063319_1745_052242_1745_A01.tif",
    hillshadeUrl:
      "https://astrogeo-ard.s3-us-west-2.amazonaws.com/mars/mro/hirise/controlled/dtm/ESP_063319_1745_ESP_052242_1745/DTEEC_063319_1745_052242_1745_A01_hillshade.tif",
    centerHint: { lat: -5.48, lon: 137.316 },
  },
};

const SITE_SIZE_M = 3000;
const GRID_SIZE = 151; // 20 m spacing over 3000 m (150 intervals)
const HILLSHADE_SIZE = 600; // 5 m/px visual overlay

/** Pick a COG overview image whose pixel size is closest to targetResM without exceeding it too much. */
async function pickOverviewImage(
  tiff: GeoTIFF,
  fullImg: GeoTIFFImage,
  targetResM: number,
): Promise<GeoTIFFImage> {
  const count = await tiff.getImageCount();
  let chosen = fullImg;
  for (let i = 0; i < count; i += 1) {
    const img = await tiff.getImage(i);
    const resX = Math.abs(img.getResolution(fullImg)[0] ?? 1);
    if (resX <= targetResM) {
      chosen = img;
    }
  }
  return chosen;
}

function isValidElevation(val: number, nodata: number | null): boolean {
  if (!Number.isFinite(val)) return false;
  if (nodata !== null && Math.abs(val - nodata) < 1e-3) return false;
  if (val < -20000 || val > 30000) return false;
  return true;
}

async function main(): Promise<void> {
  const siteArg = Bun.argv.find((a) => a.startsWith("--site="))?.split("=")[1] ?? "jezero";
  const preset = PRESETS[siteArg] ?? PRESETS.jezero;
  if (!preset) {
    throw new Error(`Unknown site preset: ${siteArg}`);
  }

  const { dtmUrl, hillshadeUrl, sourceItemId, sourceTitle } = preset;

  console.log(`Opening DTM COG header for ${preset.name}: ${dtmUrl}`);
  const dtmTiff = await fromUrl(dtmUrl);
  const fullImg = await dtmTiff.getImage(0);
  const overviewImg = await pickOverviewImage(dtmTiff, fullImg, 12);

  const [originX, originY] = fullImg.getOrigin();
  const [resX, resY] = overviewImg.getResolution(fullImg);
  const width = overviewImg.getWidth();
  const height = overviewImg.getHeight();
  const nodata = fullImg.getGDALNoData();

  const latRad = (preset.centerHint.lat * Math.PI) / 180;
  const widthProjM = SITE_SIZE_M / Math.max(0.1, Math.cos(latRad));
  const heightProjM = SITE_SIZE_M;

  // Read center overview patch to verify valid non-nodata 3x3 km window
  const halfWinX = Math.ceil(widthProjM / Math.abs(resX) / 2);
  const halfWinY = Math.ceil(heightProjM / Math.abs(resY) / 2);
  const centerCol = Math.floor(width / 2);
  const centerRow = Math.floor(height / 2);

  // Try small row/col offsets around center if any edge touches nodata
  const candidateOffsets: Array<[number, number]> = [
    [0, 0],
    [0, -Math.floor(height * 0.1)],
    [0, Math.floor(height * 0.1)],
    [-Math.floor(width * 0.08), 0],
    [Math.floor(width * 0.08), 0],
  ];

  let chosenBounds: { left: number; top: number; right: number; bottom: number } | null = null;
  let bestElevSpan = -1;

  for (const [dx, dy] of candidateOffsets) {
    const cx = centerCol + dx;
    const cy = centerRow + dy;
    const left = Math.max(0, cx - halfWinX);
    const right = Math.min(width, cx + halfWinX);
    const top = Math.max(0, cy - halfWinY);
    const bottom = Math.min(height, cy + halfWinY);
    if (right - left < 20 || bottom - top < 20) continue;

    const rasters = await overviewImg.readRasters({
      window: [left, top, right, bottom],
      samples: [0],
    });
    const arr = rasters[0] as Float32Array | number[];
    let validCount = 0;
    let minE = Number.POSITIVE_INFINITY;
    let maxE = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < arr.length; i += 1) {
      const v = arr[i] ?? Number.NaN;
      if (isValidElevation(v, nodata)) {
        validCount += 1;
        if (v < minE) minE = v;
        if (v > maxE) maxE = v;
      }
    }
    const validRatio = validCount / arr.length;
    const span = maxE - minE;
    if (validRatio >= 0.995 && span > bestElevSpan) {
      bestElevSpan = span;
      chosenBounds = { left, top, right, bottom };
    }
  }

  if (!chosenBounds) {
    throw new Error("Could not find a 3x3 km window with >= 99.5% valid DTM pixels near center");
  }

  // Convert chosen overview pixel bounds into exact equirectangular coordinates
  const projWest = (originX ?? 0) + chosenBounds.left * resX;
  const projEast = (originX ?? 0) + chosenBounds.right * resX;
  const projNorth = (originY ?? 0) + chosenBounds.top * resY;
  const projSouth = (originY ?? 0) + chosenBounds.bottom * resY;

  const projCenterX = (projWest + projEast) / 2;
  const projCenterY = (projNorth + projSouth) / 2;
  const centerCoord = equirectangularToCoord(projCenterX, projCenterY);

  // Enforce exact 3000 m x 3000 m Martian surface dimensions around projCenter
  const exactHalfX = SITE_SIZE_M / Math.max(0.1, Math.cos((centerCoord.lat * Math.PI) / 180)) / 2;
  const exactHalfY = SITE_SIZE_M / 2;

  const exactWestM = projCenterX - exactHalfX;
  const exactEastM = projCenterX + exactHalfX;
  const exactNorthM = projCenterY + exactHalfY;
  const exactSouthM = projCenterY - exactHalfY;

  const pxLeft = (exactWestM - (originX ?? 0)) / resX;
  const pxRight = (exactEastM - (originX ?? 0)) / resX;
  const pxTop = (exactNorthM - (originY ?? 0)) / resY;
  const pxBottom = (exactSouthM - (originY ?? 0)) / resY;

  console.log(
    `Reading ${GRID_SIZE}x${GRID_SIZE} DTM grid around lat=${centerCoord.lat.toFixed(4)}, lon=${centerCoord.lon.toFixed(4)}...`,
  );
  const dtmRasters = await overviewImg.readRasters({
    window: [Math.floor(pxLeft), Math.floor(pxTop), Math.ceil(pxRight), Math.ceil(pxBottom)],
    width: GRID_SIZE,
    height: GRID_SIZE,
    resampleMethod: "bilinear",
    samples: [0],
  });
  const rawElev = dtmRasters[0] as Float32Array | number[];

  // Clean up any isolated nodata edge via nearest neighbor fill
  const elevationsM: number[] = new Array(GRID_SIZE * GRID_SIZE);
  let minElevationM = Number.POSITIVE_INFINITY;
  let maxElevationM = Number.NEGATIVE_INFINITY;
  let validTotal = 0;

  for (let i = 0; i < elevationsM.length; i += 1) {
    const v = rawElev[i] ?? Number.NaN;
    if (isValidElevation(v, nodata)) {
      const rounded = Math.round(v * 100) / 100;
      elevationsM[i] = rounded;
      if (rounded < minElevationM) minElevationM = rounded;
      if (rounded > maxElevationM) maxElevationM = rounded;
      validTotal += 1;
    } else {
      elevationsM[i] = -99999;
    }
  }

  // Fill any rare edge nodata cell from valid neighbors
  for (let r = 0; r < GRID_SIZE; r += 1) {
    for (let c = 0; c < GRID_SIZE; c += 1) {
      const idx = r * GRID_SIZE + c;
      if ((elevationsM[idx] ?? -99999) <= -99990) {
        let sum = 0;
        let cnt = 0;
        for (let dr = -2; dr <= 2; dr += 1) {
          for (let dc = -2; dc <= 2; dc += 1) {
            const nr = r + dr;
            const nc = c + dc;
            if (nr >= 0 && nr < GRID_SIZE && nc >= 0 && nc < GRID_SIZE) {
              const nv = elevationsM[nr * GRID_SIZE + nc] ?? -99999;
              if (nv > -99990) {
                sum += nv;
                cnt += 1;
              }
            }
          }
        }
        elevationsM[idx] = cnt > 0 ? Math.round((sum / cnt) * 100) / 100 : minElevationM;
      }
    }
  }

  const sw = equirectangularToCoord(exactWestM, exactSouthM);
  const ne = equirectangularToCoord(exactEastM, exactNorthM);

  const dataset: SiteDataset = {
    meta: {
      id: preset.id,
      name: preset.name,
      sourceItemId,
      sourceTitle,
      dtmUrl,
      hillshadeUrl,
      bbox: [normalizeLon180(sw.lon), sw.lat, normalizeLon180(ne.lon), ne.lat],
      center: centerCoord,
      widthMeters: SITE_SIZE_M,
      heightMeters: SITE_SIZE_M,
      rows: GRID_SIZE,
      cols: GRID_SIZE,
      cellSizeMeters: SITE_SIZE_M / (GRID_SIZE - 1),
      minElevationM: Math.round(minElevationM * 100) / 100,
      maxElevationM: Math.round(maxElevationM * 100) / 100,
      nodataValue: -99999,
    },
    elevationsM,
  };

  console.log(
    `Fetched ${validTotal}/${elevationsM.length} valid elevation nodes. Elevation range: ${dataset.meta.minElevationM} m to ${dataset.meta.maxElevationM} m.`,
  );

  // Fetch matching hillshade COG crop
  console.log(`Reading ${HILLSHADE_SIZE}x${HILLSHADE_SIZE} HiRISE hillshade crop...`);
  const hsTiff = await fromUrl(hillshadeUrl);
  const hsFull = await hsTiff.getImage(0);
  const hsImg = await pickOverviewImage(hsTiff, hsFull, 6);
  const [hsOriginX, hsOriginY] = hsFull.getOrigin();
  const [hsResX, hsResY] = hsImg.getResolution(hsFull);

  const hsLeft = Math.max(0, Math.floor((exactWestM - (hsOriginX ?? 0)) / hsResX));
  const hsRight = Math.min(hsImg.getWidth(), Math.ceil((exactEastM - (hsOriginX ?? 0)) / hsResX));
  const hsTop = Math.max(0, Math.floor((exactNorthM - (hsOriginY ?? 0)) / hsResY));
  const hsBottom = Math.min(hsImg.getHeight(), Math.ceil((exactSouthM - (hsOriginY ?? 0)) / hsResY));

  const hsRasters = await hsImg.readRasters({
    window: [hsLeft, hsTop, hsRight, hsBottom],
    width: HILLSHADE_SIZE,
    height: HILLSHADE_SIZE,
    resampleMethod: "bilinear",
    samples: [0],
  });
  const hsBytes = hsRasters[0] as Uint8Array | Uint16Array | Float32Array;
  const rgba = new Uint8Array(HILLSHADE_SIZE * HILLSHADE_SIZE * 4);
  for (let i = 0; i < HILLSHADE_SIZE * HILLSHADE_SIZE; i += 1) {
    const shade = Math.max(0, Math.min(255, Math.round(hsBytes[i] ?? 0)));
    // Subtle dark-console warm tint so hillshade integrates cleanly with #050709 map canvas
    const p = i * 4;
    rgba[p] = Math.round(shade * 0.88);
    rgba[p + 1] = Math.round(shade * 0.83);
    rgba[p + 2] = Math.round(shade * 0.78);
    rgba[p + 3] = shade === 0 ? 180 : 225;
  }

  const outDir = resolve(import.meta.dir, "../../data");
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, "site-terrain.json"), JSON.stringify(dataset));
  await writeFile(
    resolve(outDir, "site-hillshade.png"),
    encodeRgbaPng(HILLSHADE_SIZE, HILLSHADE_SIZE, rgba),
  );

  console.log(`Saved data/site-terrain.json and data/site-hillshade.png (Mars R=${MARS_RADIUS_M} m).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
