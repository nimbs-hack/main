/**
 * Extracts and normalizes CC0 1.0 FGDC planetary geology symbols from
 * afrigeri/geologic-symbols-qgis (`src/` only, avoiding GPL `collections/`).
 *
 * Usage:
 *   bun run scripts/assets/extract-fgdc-symbols.ts [--src=/tmp/geologic-symbols-qgis]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type FgdcThemeId = "tectonics" | "volcanic" | "craters" | "surface" | "eva";

interface ThemeSpec {
  id: FgdcThemeId;
  shortLabel: string;
  label: string;
}

interface SymbolSpec {
  id: string;
  fgdcCode: string;
  label: string;
  theme: FgdcThemeId;
  xmlFile: string;
  svgFile?: string;
  mode:
    | "svg-file"
    | "xml-markers"
    | "strike-dip"
    | "contact"
    | "fault"
    | "normal-fault"
    | "strike-slip"
    | "thrust-fault"
    | "graben"
    | "wrinkle-ridge"
    | "ridge-diamond"
    | "trough"
    | "unconformity"
    | "wind-streak"
    | "scarp"
    | "crater-rim"
    | "basin-ring"
    | "caldera"
    | "flow-front"
    | "landslide";
}

interface MarkerLayer {
  kind: "SimpleMarker" | "EllipseMarker";
  name: string;
  angleDeg: number;
  offsetX: number;
  offsetY: number;
  size: number;
  symbolWidth: number;
  symbolHeight: number;
  filled: boolean;
  isMaskFill: boolean;
  strokeWidth: number;
}

const DEFAULT_SOURCE_ROOT = "/tmp/geologic-symbols-qgis";
const OUTPUT_PATH = resolve(import.meta.dir, "../../apps/web/src/assets/fgdcSymbols.ts");

const THEMES: readonly ThemeSpec[] = [
  { id: "eva", shortLabel: "EVA", label: "EVA & sample" },
  { id: "tectonics", shortLabel: "FAULT", label: "Faults & contacts" },
  { id: "volcanic", shortLabel: "VOLC", label: "Volcanic & ridges" },
  { id: "craters", shortLabel: "CRAT", label: "Craters & basins" },
  { id: "surface", shortLabel: "SURF", label: "Scarps & surface" },
];

const SYMBOL_SPECS: readonly SymbolSpec[] = [
  // EVA & Sample
  {
    id: "fgdc-31-021",
    fgdcCode: "31.021",
    label: "Sample locality",
    theme: "eva",
    xmlFile: "31.021.xml",
    mode: "xml-markers",
  },
  // Tectonics & Contacts
  {
    id: "fgdc-06-002",
    fgdcCode: "06.002",
    label: "Strike & dip",
    theme: "tectonics",
    xmlFile: "06.002.xml",
    mode: "strike-dip",
  },
  {
    id: "fgdc-25-001",
    fgdcCode: "25.001",
    label: "Geologic contact",
    theme: "tectonics",
    xmlFile: "25.001.xml",
    mode: "contact",
  },
  {
    id: "fgdc-25-005",
    fgdcCode: "25.005",
    label: "Fault trace",
    theme: "tectonics",
    xmlFile: "25.005.xml",
    mode: "fault",
  },
  {
    id: "fgdc-25-009",
    fgdcCode: "25.009",
    label: "Normal fault",
    theme: "tectonics",
    xmlFile: "25.009.xml",
    mode: "normal-fault",
  },
  {
    id: "fgdc-25-013",
    fgdcCode: "25.013",
    label: "Right-lateral fault",
    theme: "tectonics",
    xmlFile: "25.013.xml",
    svgFile: "strike_slip_fault_arrows_r.svg",
    mode: "strike-slip",
  },
  {
    id: "fgdc-25-017",
    fgdcCode: "25.017",
    label: "Left-lateral fault",
    theme: "tectonics",
    xmlFile: "25.017.xml",
    svgFile: "strike_slip_fault_arrows_l.svg",
    mode: "strike-slip",
  },
  {
    id: "fgdc-25-021",
    fgdcCode: "25.021",
    label: "Thrust fault",
    theme: "tectonics",
    xmlFile: "25.021.xml",
    mode: "thrust-fault",
  },
  {
    id: "fgdc-25-025",
    fgdcCode: "25.025",
    label: "Graben trace",
    theme: "tectonics",
    xmlFile: "25.025.xml",
    mode: "graben",
  },
  // Volcanic & Ridges
  {
    id: "fgdc-25-037",
    fgdcCode: "25.037",
    label: "Wrinkle ridge",
    theme: "volcanic",
    xmlFile: "25.037.xml",
    mode: "wrinkle-ridge",
  },
  {
    id: "fgdc-25-042",
    fgdcCode: "25.042",
    label: "Ridge crest open",
    theme: "volcanic",
    xmlFile: "25.042.xml",
    svgFile: "fgdc-25.042_diamondWhite.svg",
    mode: "ridge-diamond",
  },
  {
    id: "fgdc-25-043",
    fgdcCode: "25.043",
    label: "Ridge crest solid",
    theme: "volcanic",
    xmlFile: "25.043.xml",
    svgFile: "fgdc-25.042_diamondBlack.svg",
    mode: "ridge-diamond",
  },
  {
    id: "fgdc-25-046",
    fgdcCode: "25.046",
    label: "Corona arrow",
    theme: "volcanic",
    xmlFile: "25.046.xml",
    svgFile: "fgdc-25.046_arrowCoronaAnnulus.svg",
    mode: "svg-file",
  },
  {
    id: "fgdc-25-076",
    fgdcCode: "25.076",
    label: "Volcanic shield",
    theme: "volcanic",
    xmlFile: "25.076.xml",
    mode: "xml-markers",
  },
  {
    id: "fgdc-25-085",
    fgdcCode: "25.085",
    label: "Steep edifice",
    theme: "volcanic",
    xmlFile: "25.085.xml",
    mode: "xml-markers",
  },
  {
    id: "fgdc-25-111",
    fgdcCode: "25.111",
    label: "Caldera rim",
    theme: "volcanic",
    xmlFile: "25.111.xml",
    mode: "caldera",
  },
  {
    id: "fgdc-25-114",
    fgdcCode: "25.114",
    label: "Flow front",
    theme: "volcanic",
    xmlFile: "25.114.xml",
    mode: "flow-front",
  },
  // Craters & Basins
  {
    id: "fgdc-25-094",
    fgdcCode: "25.094",
    label: "Crater rim",
    theme: "craters",
    xmlFile: "25.094.xml",
    mode: "crater-rim",
  },
  {
    id: "fgdc-25-100",
    fgdcCode: "25.100",
    label: "Basin ring",
    theme: "craters",
    xmlFile: "25.100.xml",
    mode: "basin-ring",
  },
  {
    id: "fgdc-25-101",
    fgdcCode: "25.101",
    label: "Central peak",
    theme: "craters",
    xmlFile: "25.101.xml",
    mode: "xml-markers",
  },
  {
    id: "fgdc-25-104",
    fgdcCode: "25.104",
    label: "Crater floor pit",
    theme: "craters",
    xmlFile: "25.104.xml",
    mode: "xml-markers",
  },
  {
    id: "fgdc-25-106",
    fgdcCode: "25.106",
    label: "Endogenic crater",
    theme: "craters",
    xmlFile: "25.106.xml",
    mode: "xml-markers",
  },
  // Scarps & Surface
  {
    id: "fgdc-17-001",
    fgdcCode: "17.001",
    label: "Landslide slip",
    theme: "surface",
    xmlFile: "17.001.xml",
    mode: "landslide",
  },
  {
    id: "fgdc-25-052",
    fgdcCode: "25.052",
    label: "Trough / graben",
    theme: "surface",
    xmlFile: "25.052.xml",
    mode: "trough",
  },
  {
    id: "fgdc-25-059",
    fgdcCode: "25.059",
    label: "Erosional edge",
    theme: "surface",
    xmlFile: "25.059.xml",
    svgFile: "fgdc-25.059_erosionalBoundary.svg",
    mode: "svg-file",
  },
  {
    id: "fgdc-25-060",
    fgdcCode: "25.060",
    label: "Unconformity",
    theme: "surface",
    xmlFile: "25.060.xml",
    mode: "unconformity",
  },
  {
    id: "fgdc-25-068",
    fgdcCode: "25.068",
    label: "Wind streak",
    theme: "surface",
    xmlFile: "25.068.xml",
    mode: "wind-streak",
  },
  {
    id: "fgdc-25-071",
    fgdcCode: "25.071",
    label: "Scarp hachures",
    theme: "surface",
    xmlFile: "25.071.xml",
    mode: "scarp",
  },
  {
    id: "fgdc-25-079",
    fgdcCode: "25.079",
    label: "Mesa / plateau",
    theme: "surface",
    xmlFile: "25.079.xml",
    mode: "xml-markers",
  },
  {
    id: "fgdc-25-082",
    fgdcCode: "25.082",
    label: "Knob / butte",
    theme: "surface",
    xmlFile: "25.082.xml",
    mode: "xml-markers",
  },
  {
    id: "fgdc-25-117",
    fgdcCode: "25.117",
    label: "Slide / slump",
    theme: "surface",
    xmlFile: "25.117.xml",
    svgFile: "25.117_arrow.svg",
    mode: "svg-file",
  },
];

function resolveSourceRoot(): string {
  const arg = process.argv.find((value) => value.startsWith("--src="));
  return arg ? resolve(arg.slice("--src=".length)) : DEFAULT_SOURCE_ROOT;
}

function round(value: number): string {
  return Number(value.toFixed(2)).toString();
}

function parseProps(block: string): Record<string, string> {
  const props: Record<string, string> = {};
  const attrPair = /<prop\s+([^>]+?)\/?\s*>/g;
  for (const match of block.matchAll(attrPair)) {
    const attrs = match[1] ?? "";
    const kMatch = attrs.match(/\bk="([^"]+)"/);
    const vMatch = attrs.match(/\bv="([^"]*)"/);
    if (kMatch && vMatch) {
      props[kMatch[1]] = vMatch[1];
    }
  }
  return props;
}

function parsePair(raw: string | undefined): [number, number] {
  if (!raw) return [0, 0];
  const parts = raw.split(",").map((part) => Number(part.trim()));
  return [Number.isFinite(parts[0]) ? parts[0] : 0, Number.isFinite(parts[1]) ? parts[1] : 0];
}

function parseRgbaAlpha(raw: string | undefined): { isWhite: boolean; alpha: number } {
  if (!raw) return { isWhite: false, alpha: 255 };
  const parts = raw.split(",").map((part) => Number(part.trim()));
  const r = parts[0] ?? 0;
  const g = parts[1] ?? 0;
  const b = parts[2] ?? 0;
  const alpha = parts[3] ?? 255;
  return {
    isWhite: r >= 230 && g >= 230 && b >= 230,
    alpha,
  };
}

function extractXmlDescription(xmlText: string, fallback: string): string {
  const match = xmlText.match(/<symbol[^>]*\bname="([^"]+)"/);
  return match?.[1]?.replace(/\s+/g, " ").trim() ?? fallback;
}

function parseTopLevelMarkerLayers(xmlText: string): MarkerLayer[] {
  const layers: MarkerLayer[] = [];
  const regex =
    /<layer[^>]*class="(SimpleMarker|EllipseMarker)"[^>]*>([\s\S]*?)(?=<data_defined_properties>|<\/layer>)/g;
  for (const match of xmlText.matchAll(regex)) {
    const kind = match[1] as "SimpleMarker" | "EllipseMarker";
    const props = parseProps(match[2] ?? "");
    const [offsetX, offsetY] = parsePair(props.offset);
    const { isWhite, alpha } = parseRgbaAlpha(props.color);
    const size = Number(props.size ?? "2") || 2;
    const symbolWidth = Number(props.symbol_width ?? props.size ?? "2") || size;
    const symbolHeight = Number(props.symbol_height ?? props.size ?? "2") || size;
    const strokeWidth = Number(props.outline_width ?? "0.25") || 0.25;
    layers.push({
      kind,
      name: props.name ?? "circle",
      angleDeg: Number(props.angle ?? "0") || 0,
      offsetX,
      offsetY,
      size,
      symbolWidth,
      symbolHeight,
      filled: alpha > 10 && !isWhite,
      isMaskFill: alpha > 10 && isWhite,
      strokeWidth,
    });
  }
  return layers;
}

function rotatePoint(x: number, y: number, angleDeg: number): [number, number] {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [x * cos - y * sin, x * sin + y * cos];
}

function compileXmlMarkersSvg(spec: SymbolSpec, xmlText: string): string {
  if (spec.id === "fgdc-31-021") {
    return [
      '<circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="1.5"/>',
      '<circle cx="12" cy="12" r="2.8" fill="currentColor" stroke="none"/>',
    ].join("");
  }
  if (spec.id === "fgdc-25-104") {
    return '<circle cx="12" cy="12" r="4.5" fill="none" stroke="currentColor" stroke-width="1.8"/>';
  }
  if (spec.id === "fgdc-25-106") {
    return [
      '<circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/>',
      '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2.5 2"/>',
    ].join("");
  }

  const layers = parseTopLevelMarkerLayers(xmlText);
  if (layers.length === 0) {
    return '<circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none"/>';
  }

  let maxExtent = 1.5;
  for (const layer of layers) {
    const reach =
      Math.hypot(layer.offsetX, layer.offsetY) +
      Math.max(layer.size, layer.symbolWidth, layer.symbolHeight) * 0.55;
    if (reach > maxExtent) maxExtent = reach;
  }

  const scale = 8.4 / maxExtent;
  const elements: string[] = [];

  for (const layer of layers) {
    const [cxRaw, cyRaw] = rotatePoint(layer.offsetX, layer.offsetY, layer.angleDeg);
    const cx = 12 + cxRaw * scale;
    const cy = 12 + cyRaw * scale;

    if (layer.kind === "EllipseMarker") {
      const rx = layer.symbolWidth * 0.5 * scale;
      const ry = layer.symbolHeight * 0.5 * scale;
      const fill = layer.isMaskFill ? "var(--color-bg)" : layer.filled ? "currentColor" : "none";
      const transform =
        layer.angleDeg !== 0
          ? ` transform="rotate(${round(layer.angleDeg)} ${round(cx)} ${round(cy)})"`
          : "";
      elements.push(
        `<ellipse cx="${round(cx)}" cy="${round(cy)}" rx="${round(rx)}" ry="${round(ry)}" fill="${fill}" stroke="currentColor" stroke-width="1.5"${transform}/>`,
      );
      continue;
    }

    if (layer.name === "line") {
      const half = layer.size * 0.5 * scale;
      const [dx, dy] = rotatePoint(0, half, layer.angleDeg);
      elements.push(
        `<line x1="${round(cx - dx)}" y1="${round(cy - dy)}" x2="${round(cx + dx)}" y2="${round(cy + dy)}" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>`,
      );
      continue;
    }

    if (layer.name === "cross_fill") {
      const radius = layer.size * 0.55 * scale;
      elements.push(
        `<circle cx="${round(cx)}" cy="${round(cy)}" r="${round(radius)}" fill="none" stroke="currentColor" stroke-width="1.5"/>`,
        `<line x1="${round(cx - radius)}" y1="${round(cy)}" x2="${round(cx + radius)}" y2="${round(cy)}" stroke="currentColor" stroke-width="1.4"/>`,
        `<line x1="${round(cx)}" y1="${round(cy - radius)}" x2="${round(cx)}" y2="${round(cy + radius)}" stroke="currentColor" stroke-width="1.4"/>`,
      );
      continue;
    }

    const r = Math.max(2, layer.size * 0.5 * scale);
    const fill = layer.isMaskFill ? "var(--color-bg)" : layer.filled ? "currentColor" : "none";
    elements.push(
      `<circle cx="${round(cx)}" cy="${round(cy)}" r="${round(r)}" fill="${fill}" stroke="currentColor" stroke-width="1.6"/>`,
    );
  }

  return elements.join("");
}

function parsePointsList(raw: string): Array<[number, number]> {
  const nums = raw
    .trim()
    .split(/[\s,]+/)
    .map(Number)
    .filter((value) => Number.isFinite(value));
  const points: Array<[number, number]> = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    points.push([nums[i], nums[i + 1]]);
  }
  return points;
}

function pointsToNormalizedSvg(
  shapes: Array<{
    kind: "polyline" | "polygon" | "line";
    points: Array<[number, number]>;
    fill: "none" | "currentColor" | "var(--color-bg)";
  }>,
): string {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const shape of shapes) {
    for (const [x, y] of shape.points) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const span = Math.max(maxX - minX, maxY - minY, 1);
  const scale = 15 / span;
  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const mapX = (x: number) => round(12 + (x - cx) * scale);
  const mapY = (y: number) => round(12 + (y - cy) * scale);

  return shapes
    .map((shape) => {
      if (shape.kind === "line" && shape.points.length >= 2) {
        const [x1, y1] = shape.points[0];
        const [x2, y2] = shape.points[1];
        return `<line x1="${mapX(x1)}" y1="${mapY(y1)}" x2="${mapX(x2)}" y2="${mapY(y2)}" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>`;
      }
      const pts = shape.points.map(([x, y]) => `${mapX(x)},${mapY(y)}`).join(" ");
      const tag = shape.kind === "polygon" ? "polygon" : "polyline";
      return `<${tag} points="${pts}" fill="${shape.fill}" stroke="currentColor" stroke-width="1.5" stroke-linejoin="miter"/>`;
    })
    .join("");
}

function compileSvgFileSymbol(spec: SymbolSpec, rawSvg: string): string {
  if (spec.id === "fgdc-25-117") {
    const pathMatch = rawSvg.match(/<path[^>]*\bd="([^"]+)"/);
    const d =
      pathMatch?.[1] ??
      "M6.66,5.77 L3.33,0 L0,5.77 L2.81,5.74 L2.88,15.21 L3.81,15.18 L3.84,5.77 Z";
    return [
      '<line x1="4" y1="19" x2="20" y2="19" stroke="currentColor" stroke-width="1.6"/>',
      `<g transform="translate(8.4 3.2) scale(1.08)"><path d="${d}" fill="currentColor" stroke="none"/></g>`,
    ].join("");
  }

  if (spec.id === "fgdc-25-013" || spec.id === "fgdc-25-017") {
    const shapes: Array<{
      kind: "polyline";
      points: Array<[number, number]>;
      fill: "none";
    }> = [];
    for (const match of rawSvg.matchAll(/<polyline[^>]*points="([^"]+)"/g)) {
      const pts = parsePointsList(match[1]);
      if (pts.length >= 2) {
        shapes.push({ kind: "polyline", points: pts, fill: "none" });
      }
    }
    const arrows = pointsToNormalizedSvg(shapes);
    return [
      '<line x1="2.5" y1="12" x2="21.5" y2="12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
      arrows,
    ].join("");
  }

  if (spec.id === "fgdc-25-042" || spec.id === "fgdc-25-043") {
    const polyMatch = rawSvg.match(/<polygon[^>]*points="([^"]+)"/);
    const pts = parsePointsList(
      polyMatch?.[1] ?? "2543.7,1567.2 1579.1,2996.3 614.5,1567.2 1579.1,138.1",
    );
    const isSolid = spec.id === "fgdc-25-043";
    const diamond = pointsToNormalizedSvg([
      {
        kind: "polygon",
        points: pts,
        fill: isSolid ? "currentColor" : "var(--color-bg)",
      },
    ]);
    return [
      '<line x1="2" y1="12" x2="22" y2="12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
      `<g transform="translate(12 12) rotate(90) scale(0.55) translate(-12 -12)">${diamond}</g>`,
    ].join("");
  }

  const lineShapes: Array<{
    kind: "line";
    points: Array<[number, number]>;
    fill: "none";
  }> = [];
  for (const match of rawSvg.matchAll(
    /<line[^>]*x1="([^"]+)"[^>]*y1="([^"]+)"[^>]*x2="([^"]+)"[^>]*y2="([^"]+)"/g,
  )) {
    const x1 = Number(match[1]);
    const y1 = Number(match[2]);
    const x2 = Number(match[3]);
    const y2 = Number(match[4]);
    if (Number.isFinite(x1) && Number.isFinite(y1) && Number.isFinite(x2) && Number.isFinite(y2)) {
      lineShapes.push({
        kind: "line",
        points: [
          [x1, y1],
          [x2, y2],
        ],
        fill: "none",
      });
    }
  }
  return lineShapes.length > 0 ? pointsToNormalizedSvg(lineShapes) : "";
}

function compileCartographicLineBadge(spec: SymbolSpec): string {
  switch (spec.mode) {
    case "strike-dip":
      return [
        '<line x1="12" y1="3" x2="12" y2="21" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
        '<line x1="12" y1="12" x2="19" y2="12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
      ].join("");
    case "contact":
      return '<line x1="3" y1="12" x2="21" y2="12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>';
    case "fault":
      return '<line x1="3" y1="16" x2="21" y2="8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>';
    case "normal-fault":
      return [
        '<line x1="3" y1="10" x2="21" y2="10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
        '<line x1="12" y1="10" x2="12" y2="15" stroke="currentColor" stroke-width="1.6"/>',
        '<circle cx="12" cy="17" r="2.2" fill="currentColor"/>',
      ].join("");
    case "thrust-fault":
      return [
        '<line x1="3" y1="15" x2="21" y2="15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
        '<polygon points="6,15 9,9 12,15" fill="currentColor"/>',
        '<polygon points="13,15 16,9 19,15" fill="currentColor"/>',
      ].join("");
    case "graben":
      return [
        '<line x1="3" y1="12" x2="21" y2="12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
        '<circle cx="8" cy="7.5" r="1.8" fill="currentColor"/>',
        '<circle cx="16" cy="16.5" r="1.8" fill="currentColor"/>',
      ].join("");
    case "wrinkle-ridge":
      return [
        '<path d="M3 16c4-4 7-4 9-8 2 4 5 4 9 8" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>',
        '<line x1="6" y1="18" x2="18" y2="18" stroke="currentColor" stroke-width="1.3"/>',
      ].join("");
    case "trough":
      return [
        '<line x1="3" y1="12" x2="21" y2="12" stroke="currentColor" stroke-width="1.8"/>',
        '<polygon points="9,6 15,6 12,11" fill="currentColor"/>',
        '<polygon points="9,18 15,18 12,13" fill="currentColor"/>',
      ].join("");
    case "unconformity":
      return [
        '<line x1="3" y1="14" x2="21" y2="14" stroke="currentColor" stroke-width="1.8"/>',
        '<line x1="7" y1="14" x2="5" y2="7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
        '<line x1="12" y1="14" x2="10" y2="7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
        '<line x1="17" y1="14" x2="15" y2="7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
      ].join("");
    case "wind-streak":
      return [
        '<line x1="3" y1="12" x2="18" y2="12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
        '<polygon points="15,8 21,12 15,16" fill="var(--color-bg)" stroke="currentColor" stroke-width="1.5"/>',
      ].join("");
    case "scarp":
      return [
        '<line x1="3" y1="9" x2="21" y2="9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
        '<line x1="6" y1="9" x2="6" y2="16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
        '<line x1="12" y1="9" x2="12" y2="16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
        '<line x1="18" y1="9" x2="18" y2="16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
      ].join("");
    case "crater-rim":
      return [
        '<circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="1.7"/>',
        '<line x1="12" y1="4.5" x2="12" y2="7.5" stroke="currentColor" stroke-width="1.5"/>',
        '<line x1="12" y1="16.5" x2="12" y2="19.5" stroke="currentColor" stroke-width="1.5"/>',
        '<line x1="4.5" y1="12" x2="7.5" y2="12" stroke="currentColor" stroke-width="1.5"/>',
        '<line x1="16.5" y1="12" x2="19.5" y2="12" stroke="currentColor" stroke-width="1.5"/>',
      ].join("");
    case "basin-ring":
      return '<circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-dasharray="3.5 2"/>';
    case "caldera":
      return [
        '<circle cx="12" cy="12" r="7.8" fill="none" stroke="currentColor" stroke-width="1.5"/>',
        '<circle cx="12" cy="12" r="5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="1.8 2"/>',
      ].join("");
    case "flow-front":
      return [
        '<path d="M4 17c4-2 12-2 16 0" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
        '<line x1="12" y1="15" x2="12" y2="7" stroke="currentColor" stroke-width="1.6"/>',
        '<polygon points="9,8 12,3 15,8" fill="currentColor"/>',
      ].join("");
    case "landslide":
      return '<path d="M4 17c0-6 3.5-10 8-10s8 4 8 10" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>';
    default:
      return '<circle cx="12" cy="12" r="4.5" fill="currentColor"/>';
  }
}

function main(): void {
  const sourceRoot = resolveSourceRoot();
  const licensePath = resolve(sourceRoot, "src/LICENSE.txt");
  const xmlDir = resolve(sourceRoot, "src/xml/fgdc");
  const svgDir = resolve(sourceRoot, "src/gsymblib-svg/symbols/fgdc");

  if (!existsSync(licensePath) || !existsSync(xmlDir) || !existsSync(svgDir)) {
    throw new Error(
      `Missing afrigeri/geologic-symbols-qgis CC0 source tree under ${sourceRoot}/src/`,
    );
  }

  const compiled = SYMBOL_SPECS.map((spec) => {
    const xmlPath = resolve(xmlDir, spec.xmlFile);
    if (!existsSync(xmlPath)) {
      throw new Error(`Missing FGDC XML recipe: ${xmlPath}`);
    }
    const xmlText = readFileSync(xmlPath, "utf8");
    const sourceName = extractXmlDescription(xmlText, spec.label);

    let innerSvg = "";
    if (spec.svgFile) {
      const svgPath = resolve(svgDir, spec.svgFile);
      if (!existsSync(svgPath)) {
        throw new Error(`Missing FGDC SVG asset: ${svgPath}`);
      }
      innerSvg = compileSvgFileSymbol(spec, readFileSync(svgPath, "utf8"));
    } else if (spec.mode === "xml-markers") {
      innerSvg = compileXmlMarkersSvg(spec, xmlText);
    } else {
      innerSvg = compileCartographicLineBadge(spec);
    }

    return {
      id: spec.id,
      fgdcCode: spec.fgdcCode,
      label: spec.label,
      sourceName,
      theme: spec.theme,
      innerSvg,
    };
  });

  const fileContent = [
    "// Generated by scripts/assets/extract-fgdc-symbols.ts from CC0 1.0 sources in",
    "// afrigeri/geologic-symbols-qgis (src/xml/fgdc & src/gsymblib-svg/symbols/fgdc).",
    "// Standard reference: FGDC-STD-013-2006 / Daven Quinn planetary geology symbology.",
    "",
    'export type FgdcThemeId = "eva" | "tectonics" | "volcanic" | "craters" | "surface";',
    "",
    "export interface FgdcTheme {",
    "  id: FgdcThemeId;",
    "  shortLabel: string;",
    "  label: string;",
    "}",
    "",
    "export interface FgdcSymbol {",
    "  id: string;",
    "  fgdcCode: string;",
    "  label: string;",
    "  sourceName: string;",
    "  theme: FgdcThemeId;",
    "  innerSvg: string;",
    "}",
    "",
    `export const FGDC_THEMES: readonly FgdcTheme[] = ${JSON.stringify(THEMES, null, 2)};`,
    "",
    `export const FGDC_SYMBOLS: readonly FgdcSymbol[] = ${JSON.stringify(compiled, null, 2)};`,
    "",
    "export const FGDC_SYMBOL_BY_ID: Readonly<Record<string, FgdcSymbol>> = Object.fromEntries(",
    "  FGDC_SYMBOLS.map((symbol) => [symbol.id, symbol]),",
    ");",
    "",
  ].join("\n");

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, fileContent, "utf8");
  console.log(`Extracted ${compiled.length} FGDC symbols into ${OUTPUT_PATH}`);
}

main();
