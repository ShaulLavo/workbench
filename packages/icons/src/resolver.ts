import { FILE_ICON_GLYPHS } from "./generated/glyphs";
import type { FileIconGlyphName } from "./manifest";
import {
  FILE_ICON_EXTENSIONS,
  FILE_ICON_FILE_NAMES,
  FILE_ICON_RULES,
  type FileIconRule,
  type FileIconRuleName,
} from "./rules";
import { STROKE_ICON_GLYPHS, type StrokeIconName } from "./stroke-glyphs";

export type FileIconPreset = "rich" | "stroke";

export interface FileIconEntry {
  readonly name: string;
  readonly type: "file" | "directory" | "symlink" | "other";
}

export interface ResolvedFileIcon {
  readonly name: FileIconRuleName;
  readonly rule: FileIconRule;
}

const RICH_SYMBOL_PREFIX = "wb-file-icon-";
const STROKE_SYMBOL_PREFIX = "wb-stroke-icon-";
const RESOLVED_CACHE = new Map<FileIconRuleName, ResolvedFileIcon>();

function cachedResult(name: FileIconRuleName): ResolvedFileIcon {
  const existing = RESOLVED_CACHE.get(name);
  if (existing) return existing;
  const rule = Object.hasOwn(FILE_ICON_RULES, name) ? FILE_ICON_RULES[name] : FILE_ICON_RULES["file-duo"];
  const resolved = Object.freeze({ name, rule });
  RESOLVED_CACHE.set(name, resolved);
  return resolved;
}

function basenameOf(input: string): string {
  const trimmed = input.trim();
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function extensionCandidates(normalized: string): readonly string[] {
  const candidates: string[] = [];
  let cursor = normalized.indexOf(".");
  while (cursor >= 0) {
    candidates.push(normalized.slice(cursor));
    cursor = normalized.indexOf(".", cursor + 1);
  }
  return candidates;
}

/** Resolves a filename or path to a `FileIconRuleName`, preferring exact filenames and longest multi-dot suffixes. */
export function resolveFileIconName(fileName: string): FileIconRuleName {
  const normalized = basenameOf(fileName).toLocaleLowerCase();
  if (Object.hasOwn(FILE_ICON_FILE_NAMES, normalized)) {
    const exact = FILE_ICON_FILE_NAMES[normalized];
    if (exact) return exact;
  }
  for (const suffix of extensionCandidates(normalized)) {
    if (Object.hasOwn(FILE_ICON_EXTENSIONS, suffix)) {
      const matched = FILE_ICON_EXTENSIONS[suffix];
      if (matched) return matched;
    }
  }
  return "file-duo";
}

/** Resolves a tree or tab entry into a frozen, referentially stable icon descriptor. */
export function resolveFileIcon(
  entry: FileIconEntry,
  options?: { readonly open?: boolean },
): ResolvedFileIcon {
  if (entry.type === "directory") {
    return cachedResult(options?.open ? "folder-open-duo" : "folder-duo");
  }
  if (entry.type === "symlink") return cachedResult("file-symlink-duo");
  if (entry.type !== "file") return cachedResult("file-duo");
  return cachedResult(resolveFileIconName(entry.name));
}

export function getFileIconRule(name: FileIconRuleName): FileIconRule {
  return Object.hasOwn(FILE_ICON_RULES, name) ? FILE_ICON_RULES[name] : FILE_ICON_RULES["file-duo"];
}

export function fileIconSymbolHref(glyph: FileIconGlyphName): string {
  return `#${RICH_SYMBOL_PREFIX}${glyph}`;
}

export function strokeIconSymbolHref(glyph: StrokeIconName): string {
  return `#${STROKE_SYMBOL_PREFIX}${glyph}`;
}

/** Builds `<symbol>` markup for the document-wide sprite so virtualized lists draw one `<use>` per row. */
export function buildFileIconSpriteMarkup(preset: FileIconPreset = "rich"): string {
  if (preset === "stroke") {
    return (Object.keys(STROKE_ICON_GLYPHS) as StrokeIconName[])
      .map((name) => {
        const glyph = STROKE_ICON_GLYPHS[name];
        const paths = glyph.paths.map((d) => `<path d="${d}"/>`).join("");
        const label =
          "label" in glyph && glyph.label
            ? `<text x="12" y="15.6" text-anchor="middle" font-size="8.6" font-weight="700" fill="currentColor" stroke="none">${glyph.label}</text>`
            : "";
        return `<symbol id="${STROKE_SYMBOL_PREFIX}${name}" viewBox="0 0 24 24">${paths}${label}</symbol>`;
      })
      .join("");
  }
  return (Object.keys(FILE_ICON_GLYPHS) as FileIconGlyphName[])
    .map((name) => {
      const glyph = FILE_ICON_GLYPHS[name];
      return `<symbol id="${RICH_SYMBOL_PREFIX}${name}" viewBox="${glyph.viewBox}">${glyph.paths}</symbol>`;
    })
    .join("");
}
