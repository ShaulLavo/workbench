export { FILE_ICON_GLYPHS, type FileIconGlyph } from "./generated/glyphs.js";
export {
  EXCLUDED_VSCODE_ICON_SOURCES,
  FILE_ICON_MANIFEST,
  type ApprovedGlyphSpec,
  type CatppuccinGlyphName,
  type FileIconGlyphName,
  type IconLicenseId,
  type IconSourceKind,
  type VscodeGlyphName,
} from "./manifest.js";
export {
  buildFileIconSpriteMarkup,
  fileIconSymbolHref,
  getFileIconRule,
  resolveFileIcon,
  resolveFileIconName,
  type FileIconEntry,
  type ResolvedFileIcon,
} from "./resolver.js";
export {
  FILE_ICON_EXTENSIONS,
  FILE_ICON_FILE_NAMES,
  FILE_ICON_RULES,
  type FileIconHue,
  type FileIconRule,
  type FileIconRuleName,
} from "./rules.js";
export { STROKE_ICON_GLYPHS, type StrokeGlyph, type StrokeIconName } from "./stroke-glyphs.js";
