import { readFileSync } from "node:fs";
import path from "node:path";
import * as simpleIcons from "simple-icons";
import { EXCLUDED_VSCODE_ICON_SOURCES, FILE_ICON_MANIFEST, type FileIconGlyphName } from "../src/manifest";

export interface GeneratedGlyph {
  readonly viewBox: string;
  readonly paths: string;
}

interface IconifyPayload {
  readonly icons: Readonly<
    Record<string, { readonly body: string; readonly width?: number; readonly height?: number }>
  >;
}

interface SimpleIconEntry {
  readonly path: string;
}

const PKG_ROOT = path.resolve(import.meta.dirname, "..");
const VSCODE_SVG_DIR = path.join(PKG_ROOT, "node_modules/@pierre/vscode-icons/svgs");
const CATPPUCCIN_JSON = path.join(PKG_ROOT, "node_modules/@iconify-json/catppuccin/icons.json");
const EXCLUDED_SET = new Set<string>(EXCLUDED_VSCODE_ICON_SOURCES);

const ALLOWED_SVG_TAGS = new Set([
  "g",
  "path",
  "circle",
  "ellipse",
  "rect",
  "line",
  "polyline",
  "polygon",
  "defs",
  "clipPath",
  "linearGradient",
  "radialGradient",
  "stop",
  "mask",
  "use",
]);

const ALLOWED_SVG_ATTRS = new Set([
  "class",
  "clip-path",
  "clip-rule",
  "cx",
  "cy",
  "d",
  "fill",
  "fill-opacity",
  "fill-rule",
  "gradientTransform",
  "gradientUnits",
  "height",
  "href",
  "id",
  "mask",
  "offset",
  "opacity",
  "points",
  "r",
  "rx",
  "ry",
  "stop-color",
  "stop-opacity",
  "stroke",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-opacity",
  "stroke-width",
  "transform",
  "width",
  "x",
  "x1",
  "x2",
  "y",
  "y1",
  "y2",
]);

const VIEWBOX_RE = /^-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?\s+\d+(?:\.\d+)?\s+\d+(?:\.\d+)?$/;

function validateSafeUrlReference(glyphName: string, attrName: string, value: string): void {
  if (attrName === "href") {
    if (!value.startsWith(`#wb-icon-${glyphName}-`)) {
      throw new Error(`Unsafe SVG href "${value}" in glyph "${glyphName}"`);
    }
    return;
  }
  const urlMatches = value.matchAll(/url\(\s*([^)]+)\s*\)/gi);
  for (const match of urlMatches) {
    const target = (match[1] ?? "").replaceAll(/^['"]|['"]$/g, "");
    if (!target.startsWith(`#wb-icon-${glyphName}-`)) {
      throw new Error(`Unsafe SVG url() reference "${target}" in glyph "${glyphName}"`);
    }
  }
}

/** Validates generated SVG markup against strict element, attribute, and local-ID allowlists. */
export function validateSafeSvgGlyph(glyphName: string, glyph: GeneratedGlyph): void {
  if (!VIEWBOX_RE.test(glyph.viewBox)) {
    throw new Error(`Invalid SVG viewBox "${glyph.viewBox}" in glyph "${glyphName}"`);
  }
  if (/<!--|<!\[CDATA\[|<\?|&|javascript:|data:/i.test(glyph.paths)) {
    throw new Error(`Disallowed SVG construct, entity, or URI scheme in glyph "${glyphName}"`);
  }
  const stripped = glyph.paths.replaceAll(/<\/?[a-zA-Z][\w:-]*(?:\s+[^<>]*)?\/?>/g, "").trim();
  if (stripped.length > 0) {
    throw new Error(`Unexpected text node "${stripped.slice(0, 40)}" in glyph "${glyphName}"`);
  }

  const tagRe = /<(\/?)([a-zA-Z][\w:-]*)([^<>]*?)(\/?)>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(glyph.paths)) !== null) {
    const isClosing = match[1] === "/";
    const tagName = match[2] ?? "";
    const rawAttrs = match[3] ?? "";
    if (!ALLOWED_SVG_TAGS.has(tagName)) {
      throw new Error(`Disallowed SVG element <${tagName}> in glyph "${glyphName}"`);
    }
    if (isClosing) continue;

    let remaining = rawAttrs.trim();
    const attrRe = /^([a-zA-Z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')\s*/;
    while (remaining.length > 0) {
      const attrMatch = attrRe.exec(remaining);
      if (!attrMatch) {
        throw new Error(`Malformed SVG attribute "${remaining.slice(0, 40)}" in glyph "${glyphName}"`);
      }
      const attrName = attrMatch[1] ?? "";
      const attrValue = attrMatch[2] ?? attrMatch[3] ?? "";
      if (!ALLOWED_SVG_ATTRS.has(attrName) || attrName.toLowerCase().startsWith("on")) {
        throw new Error(`Disallowed SVG attribute "${attrName}" in glyph "${glyphName}"`);
      }
      if (attrName === "id" && !attrValue.startsWith(`wb-icon-${glyphName}-`)) {
        throw new Error(`Unscoped SVG id "${attrValue}" in glyph "${glyphName}"`);
      }
      validateSafeUrlReference(glyphName, attrName, attrValue);
      remaining = remaining.slice(attrMatch[0].length);
    }
  }
}

function extractVscodeSvg(glyphName: string, sourceName: string): GeneratedGlyph {
  if (EXCLUDED_SET.has(sourceName)) {
    throw new Error(`Refusing to ingest excluded @pierre/vscode-icons source: ${sourceName}`);
  }
  const svgPath = path.join(VSCODE_SVG_DIR, `${sourceName}.svg`);
  const raw = readFileSync(svgPath, "utf8").trim();
  const viewBoxMatch = /viewBox="([^"]+)"/.exec(raw);
  const viewBox = viewBoxMatch?.[1] ?? "0 0 16 16";
  const innerMatch = /<svg[^>]*>([\s\S]*?)<\/svg>/i.exec(raw);
  if (!innerMatch?.[1]) {
    throw new Error(`Could not parse SVG inner markup for ${sourceName}.svg`);
  }
  const prefix = `wb-icon-${glyphName}-`;
  const inner = innerMatch[1]
    .replaceAll(/\bid="([^"]+)"/g, (_m, id: string) => `id="${prefix}${id}"`)
    .replaceAll(/url\(#([^)]+)\)/g, (_m, id: string) => `url(#${prefix}${id})`)
    .replaceAll(/(?:xlink:)?href="#([^"]+)"/g, (_m, id: string) => `href="#${prefix}${id}"`)
    .replaceAll(/\s+/g, " ")
    .trim();
  return { viewBox, paths: inner };
}

function extractCatppuccinSvg(payload: IconifyPayload, sourceName: string): GeneratedGlyph {
  const icon = payload.icons[sourceName];
  if (!icon) {
    throw new Error(`Missing @iconify-json/catppuccin icon: ${sourceName}`);
  }
  const width = icon.width ?? 16;
  const height = icon.height ?? 16;
  const normalized = icon.body
    .replaceAll(
      /stroke="#(?:cad3f5|c6d0f5|cdd6f4|a5adcb|b8c0e0|8087a2)"/gi,
      'stroke="var(--wb-icon-neutral, currentColor)"',
    )
    .replaceAll(
      /fill="#(?:cad3f5|c6d0f5|cdd6f4|a5adcb|b8c0e0|8087a2)"/gi,
      'fill="var(--wb-icon-neutral, currentColor)"',
    )
    .replaceAll(/stroke="#[0-9a-f]{3,8}"/gi, 'stroke="currentColor"')
    .replaceAll(/fill="#[0-9a-f]{3,8}"/gi, 'fill="currentColor"')
    .replaceAll(/\s+/g, " ")
    .trim();
  return { viewBox: `0 0 ${width} ${height}`, paths: normalized };
}

function extractSimpleIconSvg(sourceName: string): GeneratedGlyph {
  const record = simpleIcons as unknown as Readonly<Record<string, SimpleIconEntry | undefined>>;
  const entry = record[sourceName];
  if (!entry?.path) {
    throw new Error(`Missing simple-icons export: ${sourceName}`);
  }
  return {
    viewBox: "0 0 24 24",
    paths: `<path fill="currentColor" d="${entry.path}"/>`,
  };
}

/** Generates and validates every approved icon glyph directly from pinned icon packages. */
export function generateApprovedGlyphs(): Readonly<Record<FileIconGlyphName, GeneratedGlyph>> {
  const catppuccin = JSON.parse(readFileSync(CATPPUCCIN_JSON, "utf8")) as IconifyPayload;
  const manifestEntries = (
    Object.entries(FILE_ICON_MANIFEST) as [
      FileIconGlyphName,
      (typeof FILE_ICON_MANIFEST)[FileIconGlyphName],
    ][]
  ).toSorted(([a], [b]) => a.localeCompare(b));

  const out: [FileIconGlyphName, GeneratedGlyph][] = [];
  for (const [name, spec] of manifestEntries) {
    let glyph: GeneratedGlyph;
    if (spec.source === "vscode-icons") {
      glyph = extractVscodeSvg(name, spec.sourceName);
    } else if (spec.source === "catppuccin") {
      glyph = extractCatppuccinSvg(catppuccin, spec.sourceName);
    } else {
      glyph = extractSimpleIconSvg(spec.sourceName);
    }
    validateSafeSvgGlyph(name, glyph);
    out.push([name, glyph]);
  }
  return Object.fromEntries(out) as Readonly<Record<FileIconGlyphName, GeneratedGlyph>>;
}
