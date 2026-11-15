import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type SiteDataset,
  type StaticSiteManifest,
  encodeSoilBinary,
  encodeTerrainBinary,
} from "../../packages/shared/src";

const ROOT_DIR = resolve(import.meta.dir, "../..");
const DATA_DIR = resolve(ROOT_DIR, "data");
const TERRAIN_JSON_PATH = resolve(DATA_DIR, "site-terrain.json");
const HILLSHADE_SRC_PATH = resolve(DATA_DIR, "site-hillshade.png");
const WEATHER_SRC_PATH = resolve(DATA_DIR, "site-weather.json");

const PUBLIC_DATA_DIR = resolve(ROOT_DIR, "apps/web/public/data");
const MANIFEST_DST_PATH = resolve(PUBLIC_DATA_DIR, "site-meta.json");
const TERRAIN_BIN_DST_PATH = resolve(PUBLIC_DATA_DIR, "site-terrain.bin");
const SOIL_BIN_DST_PATH = resolve(PUBLIC_DATA_DIR, "site-soil.bin");
const HILLSHADE_DST_PATH = resolve(PUBLIC_DATA_DIR, "site-hillshade.png");
const WEATHER_DST_PATH = resolve(PUBLIC_DATA_DIR, "site-weather.json");

async function runScript(scriptRelPath: string): Promise<void> {
  const proc = Bun.spawn(["bun", "run", resolve(ROOT_DIR, scriptRelPath)], {
    cwd: ROOT_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`${scriptRelPath} failed with exit code ${code}`);
  }
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");

  if (!existsSync(TERRAIN_JSON_PATH) || !existsSync(HILLSHADE_SRC_PATH)) {
    console.log("Local DEM dataset missing. Running scripts/data/fetch-site.ts...");
    await runScript("scripts/data/fetch-site.ts");
  }

  if (!existsSync(WEATHER_SRC_PATH)) {
    console.log("Local weather snapshot missing. Running scripts/data/fetch-weather.ts...");
    await runScript("scripts/data/fetch-weather.ts");
  }

  await mkdir(PUBLIC_DATA_DIR, { recursive: true });

  const hasOutputs =
    existsSync(MANIFEST_DST_PATH) &&
    existsSync(TERRAIN_BIN_DST_PATH) &&
    existsSync(SOIL_BIN_DST_PATH) &&
    existsSync(HILLSHADE_DST_PATH) &&
    existsSync(WEATHER_DST_PATH);

  if (!force && hasOutputs) {
    const [srcTerrainStat, dstBinStat, dstSoilStat, srcHsStat, dstHsStat, srcWxStat, dstWxStat] =
      await Promise.all([
        stat(TERRAIN_JSON_PATH),
        stat(TERRAIN_BIN_DST_PATH),
        stat(SOIL_BIN_DST_PATH),
        stat(HILLSHADE_SRC_PATH),
        stat(HILLSHADE_DST_PATH),
        stat(WEATHER_SRC_PATH),
        stat(WEATHER_DST_PATH),
      ]);
    const isFresh =
      dstBinStat.mtimeMs >= srcTerrainStat.mtimeMs &&
      dstSoilStat.mtimeMs >= srcTerrainStat.mtimeMs &&
      dstHsStat.mtimeMs >= srcHsStat.mtimeMs &&
      dstWxStat.mtimeMs >= srcWxStat.mtimeMs;
    if (isFresh) {
      return;
    }
  }

  console.log("Packaging static site assets into apps/web/public/data...");
  const rawTerrain = await readFile(TERRAIN_JSON_PATH, "utf8");
  const dataset = JSON.parse(rawTerrain) as SiteDataset;
  const binBytes = encodeTerrainBinary(dataset.elevationsM);
  const soilBytes = dataset.soilTypes?.length ? encodeSoilBinary(dataset.soilTypes) : null;

  const manifest: StaticSiteManifest = {
    version: 2,
    generatedAt: new Date().toISOString(),
    meta: dataset.meta,
    terrainBinFile: "site-terrain.bin",
    terrainByteLength: binBytes.byteLength,
    ...(soilBytes
      ? {
          soilBinFile: "site-soil.bin",
          soilByteLength: soilBytes.byteLength,
        }
      : {}),
    hillshadeFile: "site-hillshade.png",
    weatherFallbackFile: "site-weather.json",
  };

  const writes: Array<Promise<void>> = [
    writeFile(MANIFEST_DST_PATH, JSON.stringify(manifest), "utf8"),
    writeFile(TERRAIN_BIN_DST_PATH, binBytes),
    copyFile(HILLSHADE_SRC_PATH, HILLSHADE_DST_PATH),
    copyFile(WEATHER_SRC_PATH, WEATHER_DST_PATH),
  ];
  if (soilBytes) {
    writes.push(writeFile(SOIL_BIN_DST_PATH, soilBytes));
  }
  await Promise.all(writes);

  const sizeMb = (binBytes.byteLength / (1024 * 1024)).toFixed(2);
  const soilMb = soilBytes ? `, ${(soilBytes.byteLength / (1024 * 1024)).toFixed(2)} MiB soil` : "";
  console.log(
    `Prepared static site data: ${dataset.meta.cols}x${dataset.meta.rows} DEM (${sizeMb} MiB binary${soilMb}), hillshade, and weather fallback.`,
  );
}

main().catch((err: unknown) => {
  console.error("Failed to prepare static site data:", err);
  process.exit(1);
});
