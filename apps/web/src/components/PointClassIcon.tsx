import { type ReactNode, createElement } from "react";
import { FGDC_SYMBOL_BY_ID } from "../assets/fgdcSymbols";
import type { CorePointIconKey, PointIconKey } from "../services/pointStore";

interface PointClassIconProps {
  icon: PointIconKey;
  color?: string;
  size?: number;
}

interface ParsedSvgNode {
  tag: string;
  attrs: Record<string, string>;
  children: ParsedSvgNode[];
}

const CORE_ICON_MARKUP: Record<CorePointIconKey, string> = {
  science:
    '<polygon points="8,1 14.5,8 8,15 1.5,8" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="6.5" y="6.5" width="3" height="3" fill="currentColor"/>',
  sample:
    '<rect x="3" y="3" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6"/><line x1="3" y1="8" x2="13" y2="8" stroke="currentColor" stroke-width="1.4"/><line x1="8" y1="3" x2="8" y2="13" stroke="currentColor" stroke-width="1.4"/>',
  habitat:
    '<polygon points="2,8 8,2 14,8 14,14 2,14" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="6.5" y="9" width="3" height="5" fill="currentColor"/>',
  supply: '<polygon points="9.5,1 4,9 8,9 6.5,15 12,7 8,7" fill="currentColor"/>',
  hazard:
    '<polygon points="8,2 14.5,14 1.5,14" fill="none" stroke="currentColor" stroke-width="1.6"/><line x1="8" y1="6" x2="8" y2="10" stroke="currentColor" stroke-width="1.6"/><rect x="7.2" y="11.2" width="1.6" height="1.6" fill="currentColor"/>',
  beacon:
    '<line x1="8" y1="4" x2="8" y2="14" stroke="currentColor" stroke-width="1.6"/><polygon points="8,1.5 10.5,4.5 5.5,4.5" fill="currentColor"/><line x1="4" y1="14" x2="12" y2="14" stroke="currentColor" stroke-width="1.6"/>',
  marker:
    '<rect x="3.5" y="3.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="6.5" y="6.5" width="3" height="3" fill="currentColor"/>',
};

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

  const fgdc = FGDC_SYMBOL_BY_ID[icon];
  const viewBox = fgdc ? "0 0 24 24" : "0 0 16 16";
  const markup =
    fgdc?.innerSvg ?? CORE_ICON_MARKUP[icon as CorePointIconKey] ?? CORE_ICON_MARKUP.marker;

  const spec = { viewBox, nodes: parseStaticSvgNodes(markup) };
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

export function PointClassIcon({ icon, color = "currentColor", size = 14 }: PointClassIconProps) {
  const { viewBox, nodes } = getIconSpec(icon);
  return (
    <svg
      viewBox={viewBox}
      width={size}
      height={size}
      style={{ color, flexShrink: 0 }}
      aria-hidden="true"
    >
      {renderReactSvgNodes(nodes, icon)}
    </svg>
  );
}
