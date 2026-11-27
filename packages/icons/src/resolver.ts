import { FILE_ICON_GLYPHS } from "./generated/glyphs";
import type { FileIconGlyphName } from "./manifest";
import {
  FILE_ICON_EXTENSIONS,
  FILE_ICON_FILE_NAMES,
  FILE_ICON_RULES,
  type FileIconRule,
  type FileIconRuleName,
} from "./rules";

export interface FileIconEntry {
  readonly name: string;
  readonly type: "file" | "directory" | "symlink" | "other";
}

export interface ResolvedFileIcon {
  readonly name: FileIconRuleName;
  readonly rule: FileIconRule;
}

const FILE_SYMBOL_PREFIX = "wb-file-icon-";
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
  return `#${FILE_SYMBOL_PREFIX}${glyph}`;
}

/** Builds `<symbol>` markup for the document-wide sprite so virtualized lists draw one `<use>` per row. */
export function buildFileIconSpriteMarkup(): string {
  return (Object.keys(FILE_ICON_GLYPHS) as FileIconGlyphName[])
    .map((name) => {
      const glyph = FILE_ICON_GLYPHS[name];
      return `<symbol id="${FILE_SYMBOL_PREFIX}${name}" viewBox="${glyph.viewBox}">${glyph.paths}</symbol>`;
    })
    .join("");
}
