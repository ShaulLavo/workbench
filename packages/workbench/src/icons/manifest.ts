export type IconSourceKind = "vscode-icons" | "catppuccin" | "simple-icons";
export type IconLicenseId = "MIT" | "CC0-1.0";

export interface ApprovedGlyphSpec {
  readonly source: IconSourceKind;
  readonly sourceName: string;
  readonly license: IconLicenseId;
}

/**
 * Source names explicitly banned from `@pierre/vscode-icons` ingestion.
 * `claude` is sourced from `simple-icons` (CC0-1.0) instead.
 */
export const EXCLUDED_VSCODE_ICON_SOURCES = ["claude"] as const;

const APPROVED_VSCODE_ICONS = [
  "IconLayers3Middle",
  "astro",
  "babel",
  "bash",
  "bash-duo",
  "biome",
  "bootstrap",
  "bootstrap-duo",
  "braces",
  "browserslist-duo",
  "bun",
  "bun-duo",
  "code",
  "code-block-duo",
  "css",
  "docker",
  "eslint",
  "extension",
  "file",
  "file-duo",
  "file-plus-duo",
  "file-symlink",
  "file-symlink-duo",
  "file-table",
  "file-table-duo",
  "file-text",
  "file-text-duo",
  "file-zip",
  "file-zip-duo",
  "folder",
  "folder-duo",
  "folder-open",
  "folder-open-duo",
  "folder-plus-duo",
  "folder-zip",
  "folder-zip-duo",
  "folders",
  "font",
  "gear",
  "git",
  "graphql",
  "html",
  "image",
  "image-duo",
  "javascript",
  "lang-c",
  "lang-css",
  "lang-css-duo",
  "lang-go",
  "lang-html",
  "lang-html-duo",
  "lang-html5",
  "lang-html5-duo",
  "lang-javascript",
  "lang-javascript-duo",
  "lang-markdown",
  "lang-python",
  "lang-ruby",
  "lang-rust",
  "lang-swift",
  "lang-typescript",
  "lang-typescript-duo",
  "markdown",
  "mcp",
  "nextjs",
  "npm",
  "npm-duo",
  "oxc",
  "oxc-fill",
  "postcss",
  "prettier",
  "react",
  "rss",
  "sass",
  "server",
  "server-duo",
  "stylelint",
  "svelte",
  "svg",
  "svg-2",
  "svgo",
  "tailwind",
  "terraform",
  "typescript",
  "vite",
  "vscode",
  "vue",
  "wasm",
  "wasm-duo",
  "webpack",
  "yml",
  "zig",
] as const;

const APPROVED_CATPPUCCIN_ICONS = [
  "audio",
  "bazel",
  "certificate",
  "clojure",
  "cmake",
  "dart",
  "elixir",
  "erlang",
  "fsharp",
  "groovy",
  "haskell",
  "java",
  "julia",
  "key",
  "kotlin",
  "latex",
  "lua",
  "makefile",
  "pdf",
  "perl",
  "php",
  "proto",
  "r",
  "scala",
  "shader",
  "video",
] as const;

export type VscodeGlyphName = (typeof APPROVED_VSCODE_ICONS)[number];
export type CatppuccinGlyphName = `catppuccin-${(typeof APPROVED_CATPPUCCIN_ICONS)[number]}`;
export type FileIconGlyphName = VscodeGlyphName | CatppuccinGlyphName | "claude";

function buildManifest(): Readonly<Record<FileIconGlyphName, ApprovedGlyphSpec>> {
  const entries: [FileIconGlyphName, ApprovedGlyphSpec][] = [];
  for (const name of APPROVED_VSCODE_ICONS) {
    entries.push([name, { source: "vscode-icons", sourceName: name, license: "MIT" }]);
  }
  for (const name of APPROVED_CATPPUCCIN_ICONS) {
    entries.push([`catppuccin-${name}`, { source: "catppuccin", sourceName: name, license: "MIT" }]);
  }
  entries.push(["claude", { source: "simple-icons", sourceName: "siClaude", license: "CC0-1.0" }]);
  return Object.fromEntries(entries) as Readonly<Record<FileIconGlyphName, ApprovedGlyphSpec>>;
}

/** Explicit per-glyph allowlist audited by `bun run license:check` and consumed by `build-icons.ts`. */
export const FILE_ICON_MANIFEST: Readonly<Record<FileIconGlyphName, ApprovedGlyphSpec>> = buildManifest();
