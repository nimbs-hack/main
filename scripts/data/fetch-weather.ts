import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  INSIGHT_RSS_URL,
  MEDA_RSS_URL,
  type PersistedSiteWeatherRecord,
  REMS_RSS_URL,
  type SiteWeatherFile,
  parseMedaRssLatest,
  parseRemsRssLatest,
} from "../../apps/api/src/weather/service";

const INSIGHT_API_URL =
  "https://api.nasa.gov/insight_weather/?api_key=DEMO_KEY&feedtype=json&ver=1.0";
const MEDA_PDS4_DERIVED_ROOT =
  "https://atmos.nmsu.edu/PDS/data/PDS4/Mars2020/mars2020_meda/data_derived_env/";
const MEDA_PDS4_CALIBRATED_ROOT =
  "https://atmos.nmsu.edu/PDS/data/PDS4/Mars2020/mars2020_meda/data_calibrated_env/";
const REMS_PDS3_ROOT = "https://atmos.nmsu.edu/PDS/data/mslrem_1001/DATA/";

interface ProbeResult {
  id: string;
  url: string;
  ok: boolean;
  status: number;
  elapsedMs: number;
  note: string;
}

function parseArg(prefix: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function extractDirHrefs(html: string, pattern: RegExp): string[] {
  const matches = new Set<string>();
  for (const m of html.matchAll(/href="([^"]+)"/g)) {
    const href = m[1];
    if (href && pattern.test(href)) {
      matches.add(href);
    }
  }
  return Array.from(matches).sort();
}

/**
 * Sample N evenly spaced byte slices across a chronologically ordered CSV/TAB file
 * so we capture all 24 Mars hours in seconds instead of downloading multi-MB files.
 */
async function fetchRangeSamples(
  url: string,
  timeoutMs: number,
  sliceCount = 12,
  sliceBytes = 12_288,
): Promise<string[]> {
  const head = await fetchWithTimeout(url, timeoutMs, { method: "HEAD" });
  if (!head.ok) {
    throw new Error(`HEAD ${head.status}`);
  }
  const lenHeader = head.headers.get("content-length");
  const totalBytes = lenHeader ? Number(lenHeader) : 0;

  if (!Number.isFinite(totalBytes) || totalBytes <= sliceBytes * 2) {
    const full = await fetchWithTimeout(url, timeoutMs);
    if (!full.ok) throw new Error(`GET ${full.status}`);
    return (await full.text()).split(/\r?\n/);
  }

  const lines: string[] = [];
  const step = Math.floor((totalBytes - sliceBytes) / Math.max(1, sliceCount - 1));
  const offsets: number[] = [];
  for (let i = 0; i < sliceCount; i += 1) {
    offsets.push(Math.min(totalBytes - sliceBytes, i * step));
  }

  const batchSize = 4;
  for (let i = 0; i < offsets.length; i += batchSize) {
    const batch = offsets.slice(i, i + batchSize);
    const chunks = await Promise.all(
      batch.map(async (start) => {
        const end = Math.min(totalBytes - 1, start + sliceBytes - 1);
        const res = await fetchWithTimeout(url, timeoutMs, {
          headers: { Range: `bytes=${start}-${end}` },
        });
        if (!res.ok) return "";
        return res.text();
      }),
    );
    for (const chunk of chunks) {
      if (!chunk) continue;
      const chunkLines = chunk.split(/\r?\n/);
      // Trim partial boundary lines
      const inner = chunkLines.slice(1, -1);
      for (const line of inner) {
        if (line.trim()) lines.push(line);
      }
    }
  }
  return lines;
}

async function probeMedaPds4(timeoutMs: number): Promise<{
  probe: ProbeResult;
  record: PersistedSiteWeatherRecord | null;
}> {
  const t0 = Date.now();
  try {
    const rootRes = await fetchWithTimeout(MEDA_PDS4_DERIVED_ROOT, timeoutMs);
    if (!rootRes.ok) {
      return {
        probe: {
          id: "meda-pds4",
          url: MEDA_PDS4_DERIVED_ROOT,
          ok: false,
          status: rootRes.status,
          elapsedMs: Date.now() - t0,
          note: `HTTP ${rootRes.status}`,
        },
        record: null,
      };
    }

    const rootHtml = await rootRes.text();
    const rangeDirs = extractDirHrefs(rootHtml, /^sol_\d+_\d+\/$/);
    const latestRange = rangeDirs[rangeDirs.length - 1];
    if (!latestRange) {
      return {
        probe: {
          id: "meda-pds4",
          url: MEDA_PDS4_DERIVED_ROOT,
          ok: false,
          status: 200,
          elapsedMs: Date.now() - t0,
          note: "No sol range directories found",
        },
        record: null,
      };
    }

    const rangeRes = await fetchWithTimeout(`${MEDA_PDS4_DERIVED_ROOT}${latestRange}`, timeoutMs);
    const rangeHtml = await rangeRes.text();
    const solDirs = extractDirHrefs(rangeHtml, /^sol_\d+\/$/);
    const latestSolDir = solDirs[solDirs.length - 1];
    if (!latestSolDir) {
      return {
        probe: {
          id: "meda-pds4",
          url: `${MEDA_PDS4_DERIVED_ROOT}${latestRange}`,
          ok: false,
          status: rangeRes.status,
          elapsedMs: Date.now() - t0,
          note: "No sol directory found",
        },
        record: null,
      };
    }

    const solNum = Number(latestSolDir.replace(/\D/g, ""));
    const solUrl = `${MEDA_PDS4_DERIVED_ROOT}${latestRange}${latestSolDir}`;
    const solHtml = await (await fetchWithTimeout(solUrl, timeoutMs)).text();
    const derFiles = extractDirHrefs(solHtml, /\.CSV$/i);
    const psFile = derFiles.find((f) => f.includes("DER_PS"));
    const ancFile = derFiles.find((f) => f.includes("DER_ANCILLARY"));

    const calSolUrl = `${MEDA_PDS4_CALIBRATED_ROOT}${latestRange}${latestSolDir}`;
    const calRes = await fetchWithTimeout(calSolUrl, timeoutMs).catch(() => null);
    const calFiles = calRes?.ok ? extractDirHrefs(await calRes.text(), /\.CSV$/i) : [];
    const atsFile = calFiles.find((f) => f.includes("CAL_ATS"));

    let lsDeg: number | undefined;
    if (ancFile) {
      const ancRes = await fetchWithTimeout(`${solUrl}${ancFile}`, timeoutMs, {
        headers: { Range: "bytes=0-4096" },
      }).catch(() => null);
      if (ancRes?.ok) {
        const ancLines = (await ancRes.text()).split(/\r?\n/);
        const firstData = ancLines[1]?.split(",");
        const lsVal = Number(firstData?.[3]);
        if (Number.isFinite(lsVal) && lsVal >= 0 && lsVal <= 360) {
          lsDeg = Math.round(lsVal * 100) / 100;
        }
      }
    }

    let pMin = Number.POSITIVE_INFINITY;
    let pMax = Number.NEGATIVE_INFINITY;
    let pSum = 0;
    let pCount = 0;
    if (psFile) {
      const psLines = await fetchRangeSamples(`${solUrl}${psFile}`, timeoutMs);
      for (const line of psLines) {
        const cols = line.split(",");
        const val = Number(cols[3]);
        if (Number.isFinite(val) && val > 100 && val < 2000) {
          if (val < pMin) pMin = val;
          if (val > pMax) pMax = val;
          pSum += val;
          pCount += 1;
        }
      }
    }

    let tMin = Number.POSITIVE_INFINITY;
    let tMax = Number.NEGATIVE_INFINITY;
    let tSum = 0;
    let tCount = 0;
    if (atsFile) {
      const atsLines = await fetchRangeSamples(`${calSolUrl}${atsFile}`, timeoutMs);
      for (const line of atsLines) {
        const cols = line.split(",");
        for (let c = 3; c <= 7; c += 1) {
          const val = Number(cols[c]);
          if (Number.isFinite(val) && val > 100 && val < 350) {
            if (val < tMin) tMin = val;
            if (val > tMax) tMax = val;
            tSum += val;
            tCount += 1;
          }
        }
      }
    }

    const realChannels: string[] = [];
    if (tCount > 0) realChannels.push("airTemp");
    if (pCount > 0) realChannels.push("pressure", "pressureSwing");
    if (lsDeg !== undefined) realChannels.push("ls");

    if (realChannels.length === 0) {
      return {
        probe: {
          id: "meda-pds4",
          url: solUrl,
          ok: false,
          status: 200,
          elapsedMs: Date.now() - t0,
          note: `Sol ${solNum} reachable but no valid PS/ATS rows parsed`,
        },
        record: null,
      };
    }

    const record: PersistedSiteWeatherRecord = {
      siteId: "jezero",
      sol: solNum,
      lsDeg,
      tempMinK: tCount > 0 ? Math.round(tMin * 100) / 100 : undefined,
      tempAvgK: tCount > 0 ? Math.round((tSum / tCount) * 100) / 100 : undefined,
      tempMaxK: tCount > 0 ? Math.round(tMax * 100) / 100 : undefined,
      pressureMinPa: pCount > 0 ? Math.round(pMin * 100) / 100 : undefined,
      pressureAvgPa: pCount > 0 ? Math.round((pSum / pCount) * 100) / 100 : undefined,
      pressureMaxPa: pCount > 0 ? Math.round(pMax * 100) / 100 : undefined,
      sourceLabel: `NASA PDS4 MEDA (Sol ${solNum})`,
      sourceUrl: solUrl,
      realChannels,
      fetchedAt: new Date().toISOString(),
    };

    return {
      probe: {
        id: "meda-pds4",
        url: solUrl,
        ok: true,
        status: 200,
        elapsedMs: Date.now() - t0,
        note: `Sol ${solNum}: ${pCount} PS samples, ${tCount} ATS samples`,
      },
      record,
    };
  } catch (err) {
    return {
      probe: {
        id: "meda-pds4",
        url: MEDA_PDS4_DERIVED_ROOT,
        ok: false,
        status: 0,
        elapsedMs: Date.now() - t0,
        note: err instanceof Error ? err.message : "Request failed",
      },
      record: null,
    };
  }
}

async function probeRemsPds3(timeoutMs: number): Promise<{
  probe: ProbeResult;
  record: PersistedSiteWeatherRecord | null;
}> {
  const t0 = Date.now();
  try {
    const rootRes = await fetchWithTimeout(REMS_PDS3_ROOT, timeoutMs);
    if (!rootRes.ok) {
      return {
        probe: {
          id: "rems-pds3",
          url: REMS_PDS3_ROOT,
          ok: false,
          status: rootRes.status,
          elapsedMs: Date.now() - t0,
          note: `HTTP ${rootRes.status}`,
        },
        record: null,
      };
    }

    const rootHtml = await rootRes.text();
    const rangeDirs = extractDirHrefs(rootHtml, /^SOL_\d+_\d+\/$/);
    const latestRange = rangeDirs[rangeDirs.length - 1];
    if (!latestRange) throw new Error("No SOL range directory found");

    const rangeHtml = await (
      await fetchWithTimeout(`${REMS_PDS3_ROOT}${latestRange}`, timeoutMs)
    ).text();
    const solDirs = extractDirHrefs(rangeHtml, /^SOL\d+\/$/);
    const latestSolDir = solDirs[solDirs.length - 1];
    if (!latestSolDir) throw new Error("No SOL directory found");

    const solNum = Number(latestSolDir.replace(/\D/g, ""));
    const solUrl = `${REMS_PDS3_ROOT}${latestRange}${latestSolDir}`;
    const solHtml = await (await fetchWithTimeout(solUrl, timeoutMs)).text();
    const files = extractDirHrefs(solHtml, /\.(TAB|LBL)$/i);
    const rmdTab = files.find((f) => f.includes("RMD") && f.endsWith(".TAB"));
    const rmdLbl = files.find((f) => f.includes("RMD") && f.endsWith(".LBL"));

    let terrestrialDate: string | undefined;
    if (rmdLbl) {
      const lblText = await (await fetchWithTimeout(`${solUrl}${rmdLbl}`, timeoutMs)).text();
      const dateMatch = lblText.match(/START_TIME\s*=\s*(\d{4}-\d{2}-\d{2})/);
      if (dateMatch?.[1]) terrestrialDate = dateMatch[1];
    }

    if (!rmdTab) {
      return {
        probe: {
          id: "rems-pds3",
          url: solUrl,
          ok: false,
          status: 200,
          elapsedMs: Date.now() - t0,
          note: `Sol ${solNum} has no RMD .TAB file`,
        },
        record: null,
      };
    }

    const lines = await fetchRangeSamples(`${solUrl}${rmdTab}`, timeoutMs);
    let pMin = Number.POSITIVE_INFINITY;
    let pMax = Number.NEGATIVE_INFINITY;
    let pSum = 0;
    let pCount = 0;
    let tMin = Number.POSITIVE_INFINITY;
    let tMax = Number.NEGATIVE_INFINITY;
    let tSum = 0;
    let tCount = 0;

    // Verified column indices from RME_*RMD*.xml: col 15 (0-based) = AMBIENT_TEMP (K), col 37 = PRESSURE (Pa)
    for (const line of lines) {
      const cols = line.split(",");
      const tempVal = Number(cols[15]);
      if (Number.isFinite(tempVal) && tempVal > 100 && tempVal < 350) {
        if (tempVal < tMin) tMin = tempVal;
        if (tempVal > tMax) tMax = tempVal;
        tSum += tempVal;
        tCount += 1;
      }
      const pressVal = Number(cols[37]);
      if (Number.isFinite(pressVal) && pressVal > 200 && pressVal < 2000) {
        if (pressVal < pMin) pMin = pressVal;
        if (pressVal > pMax) pMax = pressVal;
        pSum += pressVal;
        pCount += 1;
      }
    }

    const realChannels: string[] = [];
    if (tCount > 0) realChannels.push("airTemp");
    if (pCount > 0) realChannels.push("pressure", "pressureSwing");

    if (realChannels.length === 0) {
      return {
        probe: {
          id: "rems-pds3",
          url: solUrl,
          ok: false,
          status: 200,
          elapsedMs: Date.now() - t0,
          note: `Sol ${solNum} RMD sampled with 0 valid rows`,
        },
        record: null,
      };
    }

    const record: PersistedSiteWeatherRecord = {
      siteId: "gale",
      sol: solNum,
      terrestrialDate,
      tempMinK: tCount > 0 ? Math.round(tMin * 100) / 100 : undefined,
      tempAvgK: tCount > 0 ? Math.round((tSum / tCount) * 100) / 100 : undefined,
      tempMaxK: tCount > 0 ? Math.round(tMax * 100) / 100 : undefined,
      pressureMinPa: pCount > 0 ? Math.round(pMin * 100) / 100 : undefined,
      pressureAvgPa: pCount > 0 ? Math.round((pSum / pCount) * 100) / 100 : undefined,
      pressureMaxPa: pCount > 0 ? Math.round(pMax * 100) / 100 : undefined,
      sourceLabel: `NASA PDS3 MSL REMS (Sol ${solNum})`,
      sourceUrl: `${solUrl}${rmdTab}`,
      realChannels,
      fetchedAt: new Date().toISOString(),
    };

    return {
      probe: {
        id: "rems-pds3",
        url: `${solUrl}${rmdTab}`,
        ok: true,
        status: 200,
        elapsedMs: Date.now() - t0,
        note: `Sol ${solNum}: ${pCount} PS samples, ${tCount} AT samples`,
      },
      record,
    };
  } catch (err) {
    return {
      probe: {
        id: "rems-pds3",
        url: REMS_PDS3_ROOT,
        ok: false,
        status: 0,
        elapsedMs: Date.now() - t0,
        note: err instanceof Error ? err.message : "Request failed",
      },
      record: null,
    };
  }
}

async function probeJsonEndpoint(
  id: string,
  url: string,
  timeoutMs: number,
): Promise<{ probe: ProbeResult; json: unknown | null }> {
  const t0 = Date.now();
  try {
    const res = await fetchWithTimeout(url, timeoutMs, {
      headers: { Accept: "application/json" },
    });
    const elapsedMs = Date.now() - t0;
    if (!res.ok) {
      return {
        probe: { id, url, ok: false, status: res.status, elapsedMs, note: `HTTP ${res.status}` },
        json: null,
      };
    }
    const json = (await res.json()) as unknown;
    return {
      probe: { id, url, ok: true, status: res.status, elapsedMs, note: "JSON received" },
      json,
    };
  } catch (err) {
    return {
      probe: {
        id,
        url,
        ok: false,
        status: 0,
        elapsedMs: Date.now() - t0,
        note: err instanceof Error ? err.message : "Request failed",
      },
      json: null,
    };
  }
}

function pickNewerRecord(
  a: PersistedSiteWeatherRecord | null | undefined,
  b: PersistedSiteWeatherRecord | null | undefined,
): PersistedSiteWeatherRecord | undefined {
  if (a && b) return a.sol >= b.sol ? a : b;
  return a ?? b ?? undefined;
}

async function main(): Promise<void> {
  const probeOnly = hasFlag("--probe-only");
  const siteArg = parseArg("--site=") ?? "all";
  const timeoutMs = Number(parseArg("--timeout-ms=") ?? "5000");
  const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 500 ? timeoutMs : 5000;

  const [medaRss, remsRss, insightRss, insightApi] = await Promise.all([
    probeJsonEndpoint("mars2020-rss", MEDA_RSS_URL, effectiveTimeout),
    probeJsonEndpoint("msl-rss", REMS_RSS_URL, effectiveTimeout),
    probeJsonEndpoint("insight-rss", INSIGHT_RSS_URL, effectiveTimeout),
    probeJsonEndpoint("insight-api", INSIGHT_API_URL, effectiveTimeout),
  ]);

  const probes: ProbeResult[] = [medaRss.probe, remsRss.probe, insightRss.probe, insightApi.probe];

  const medaRssRecord = medaRss.json ? parseMedaRssLatest(medaRss.json) : null;
  const remsRssRecord = remsRss.json ? parseRemsRssLatest(remsRss.json) : null;

  if (insightRss.json && typeof insightRss.json === "object") {
    const keys = (insightRss.json as { sol_keys?: unknown[] }).sol_keys;
    if (Array.isArray(keys) && keys.length === 0) {
      insightRss.probe.note = "Empty sol_keys[] (mission ended)";
    }
  }

  let medaPdsRecord: PersistedSiteWeatherRecord | null = null;
  let remsPdsRecord: PersistedSiteWeatherRecord | null = null;

  if (siteArg === "all" || siteArg === "jezero") {
    const res = await probeMedaPds4(effectiveTimeout);
    probes.push(res.probe);
    medaPdsRecord = res.record;
  }
  if (siteArg === "all" || siteArg === "gale" || siteArg === "mount-sharp") {
    const res = await probeRemsPds3(effectiveTimeout);
    probes.push(res.probe);
    remsPdsRecord = res.record;
  }

  for (const p of probes) {
    console.log(`[${p.ok ? "OK" : "FAIL"}] ${p.id} (${p.status}, ${p.elapsedMs}ms): ${p.note}`);
  }

  if (probeOnly) return;

  const outPath = resolve(process.cwd(), "data/site-weather.json");
  let existing: SiteWeatherFile | null = null;
  if (existsSync(outPath)) {
    try {
      existing = JSON.parse(await readFile(outPath, "utf8")) as SiteWeatherFile;
    } catch {
      existing = null;
    }
  }

  const jezero = pickNewerRecord(
    pickNewerRecord(medaPdsRecord, medaRssRecord),
    existing?.sites?.jezero,
  );
  const gale = pickNewerRecord(
    pickNewerRecord(remsPdsRecord, remsRssRecord),
    existing?.sites?.gale,
  );

  const output: SiteWeatherFile = {
    generatedAt: new Date().toISOString(),
    sites: {
      ...(jezero ? { jezero } : {}),
      ...(gale ? { gale } : {}),
    },
    probes,
  };

  await mkdir(resolve(process.cwd(), "data"), { recursive: true });
  await writeFile(outPath, JSON.stringify(output, null, 2), "utf8");
  console.log(`Saved ${outPath}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
