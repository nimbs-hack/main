import { type ReactNode, createElement } from "react";
import { MIL2525C_BY_ID, type Mil2525cSymbol, resolveLegacyFgdcIcon } from "../assets/milStd2525c";
import type { CorePointIconKey, PointIconKey } from "../services/pointStore";

interface PointClassIconProps {
  icon: PointIconKey;
  color?: string;
  size?: number;
  className?: string;
}

interface ParsedSvgNode {
  tag: string;
  attrs: Record<string, string>;
  children: ParsedSvgNode[];
}

const DEFAULT_TRP_MARKUP =
  '<line x1="12" y1="3.5" x2="12" y2="9" stroke="currentColor" stroke-width="1.6"/><line x1="12" y1="15" x2="12" y2="20.5" stroke="currentColor" stroke-width="1.6"/><line x1="3.5" y1="12" x2="9" y2="12" stroke="currentColor" stroke-width="1.6"/><line x1="15" y1="12" x2="20.5" y2="12" stroke="currentColor" stroke-width="1.6"/><rect x="10.5" y="10.5" width="3" height="3" fill="currentColor"/>';

export const CORE_TO_MIL2525C_ID: Readonly<Record<CorePointIconKey, Mil2525cSymbol["id"]>> = {
  science: "mil2525c-sensor",
  sample: "mil2525c-sample",
  habitat: "mil2525c-habitat",
  supply: "mil2525c-supply",
  hazard: "mil2525c-hazard",
  beacon: "mil2525c-relay",
  marker: "mil2525c-trp",
};

const CORE_ICON_MARKUP: Record<CorePointIconKey, string> = {
  science: MIL2525C_BY_ID[CORE_TO_MIL2525C_ID.science]?.svgInner ?? DEFAULT_TRP_MARKUP,
  sample: MIL2525C_BY_ID[CORE_TO_MIL2525C_ID.sample]?.svgInner ?? DEFAULT_TRP_MARKUP,
  habitat: MIL2525C_BY_ID[CORE_TO_MIL2525C_ID.habitat]?.svgInner ?? DEFAULT_TRP_MARKUP,
  supply: MIL2525C_BY_ID[CORE_TO_MIL2525C_ID.supply]?.svgInner ?? DEFAULT_TRP_MARKUP,
  hazard: MIL2525C_BY_ID[CORE_TO_MIL2525C_ID.hazard]?.svgInner ?? DEFAULT_TRP_MARKUP,
  beacon: MIL2525C_BY_ID[CORE_TO_MIL2525C_ID.beacon]?.svgInner ?? DEFAULT_TRP_MARKUP,
  marker: MIL2525C_BY_ID[CORE_TO_MIL2525C_ID.marker]?.svgInner ?? DEFAULT_TRP_MARKUP,
};

/** Returns MIL-STD-2525C symbol metadata for any core, mil2525c-*, or legacy fgdc-* key. */
export function resolvePointSymbolMeta(icon: PointIconKey): Mil2525cSymbol | undefined {
  const direct = MIL2525C_BY_ID[icon];
  if (direct) return direct;

  const coreMapped = CORE_TO_MIL2525C_ID[icon as CorePointIconKey];
  if (coreMapped) return MIL2525C_BY_ID[coreMapped];

  const legacyMapped = resolveLegacyFgdcIcon(icon);
  if (legacyMapped) return MIL2525C_BY_ID[legacyMapped];

  return MIL2525C_BY_ID[CORE_TO_MIL2525C_ID.marker];
}

const SVG_ATTR_TO_REACT: Record<string, string> = {
  "stroke-width": "strokeWidth",
  "stroke-linecap": "strokeLinecap",
  "stroke-linejoin": "strokeLinejoin",
  "stroke-dasharray": "strokeDasharray",
  "fill-rule": "fillRule",
};

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of raw.matchAll(/([a-zA-Z0-9-]+)="([^"]*)"/g)) {
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined) {
      attrs[key] = value;
    }
  }
  return attrs;
}

/** Parses simple self-closing SVG primitives and `<g>` wrappers from static icon definitions. */
function parseStaticSvgNodes(markup: string): ParsedSvgNode[] {
  const nodes: ParsedSvgNode[] = [];
  let cursor = 0;

  while (cursor < markup.length) {
    const openIdx = markup.indexOf("<", cursor);
    if (openIdx === -1) break;
    const closeIdx = markup.indexOf(">", openIdx);
    if (closeIdx === -1) break;

    const rawTag = markup.slice(openIdx + 1, closeIdx).trim();
    if (rawTag.startsWith("/")) {
      cursor = closeIdx + 1;
      continue;
    }

    const selfClosing = rawTag.endsWith("/");
    const clean = selfClosing ? rawTag.slice(0, -1).trim() : rawTag;
    const spaceIdx = clean.search(/\s/);
    const tag = spaceIdx === -1 ? clean : clean.slice(0, spaceIdx);
    const attrStr = spaceIdx === -1 ? "" : clean.slice(spaceIdx + 1);
    const attrs = parseAttrs(attrStr);

    if (!selfClosing && tag === "g") {
      const endTag = markup.indexOf("</g>", closeIdx + 1);
      if (endTag !== -1) {
        const inner = markup.slice(closeIdx + 1, endTag);
        nodes.push({ tag: "g", attrs, children: parseStaticSvgNodes(inner) });
        cursor = endTag + 4;
        continue;
      }
    }

    nodes.push({ tag, attrs, children: [] });
    cursor = closeIdx + 1;
  }

  return nodes;
}

const ICON_SPEC_CACHE = new Map<string, { viewBox: string; nodes: ParsedSvgNode[] }>();

function getIconSpec(icon: PointIconKey): { viewBox: string; nodes: ParsedSvgNode[] } {
  const cached = ICON_SPEC_CACHE.get(icon);
  if (cached) return cached;

  const direct = MIL2525C_BY_ID[icon];
  const legacyId = !direct ? resolveLegacyFgdcIcon(icon) : undefined;
  const legacySymbol = legacyId ? MIL2525C_BY_ID[legacyId] : undefined;
  const markup =
    direct?.svgInner ??
    legacySymbol?.svgInner ??
    CORE_ICON_MARKUP[icon as CorePointIconKey] ??
    CORE_ICON_MARKUP.marker;

  const spec = { viewBox: "0 0 24 24", nodes: parseStaticSvgNodes(markup) };
  ICON_SPEC_CACHE.set(icon, spec);
  return spec;
}

function appendDomSvgNodes(ns: string, parent: Element, nodes: ParsedSvgNode[]): void {
  for (const node of nodes) {
    const el = document.createElementNS(ns, node.tag);
    for (const [key, val] of Object.entries(node.attrs)) {
      el.setAttribute(key, val);
    }
    if (node.children.length > 0) {
      appendDomSvgNodes(ns, el, node.children);
    }
    parent.appendChild(el);
  }
}

function renderReactSvgNodes(nodes: ParsedSvgNode[], prefix: string): ReactNode[] {
  return nodes.map((node, idx) => {
    const reactProps: Record<string, string> = { key: `${prefix}-${idx}` };
    for (const [key, val] of Object.entries(node.attrs)) {
      reactProps[SVG_ATTR_TO_REACT[key] ?? key] = val;
    }
    return node.children.length > 0
      ? createElement(
          node.tag,
          reactProps,
          ...renderReactSvgNodes(node.children, `${prefix}-${idx}`),
        )
      : createElement(node.tag, reactProps);
  });
}

export function createPointIconSvgElement(
  icon: PointIconKey,
  color: string,
  size = 14,
): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const { viewBox, nodes } = getIconSpec(icon);
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.style.color = color;
  svg.style.display = "block";
  svg.style.flexShrink = "0";
  appendDomSvgNodes(ns, svg, nodes);
  return svg;
}

export function PointClassIcon({
  icon,
  color = "currentColor",
  size = 14,
  className,
}: PointClassIconProps) {
  const { viewBox, nodes } = getIconSpec(icon);
  return (
    <svg
      viewBox={viewBox}
      width={size}
      height={size}
      className={className}
      style={{ color, flexShrink: 0 }}
      aria-hidden="true"
    >
      {renderReactSvgNodes(nodes, icon)}
    </svg>
  );
}
