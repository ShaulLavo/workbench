import type { EditorSyntaxLanguageId } from "@singapore-editor/core/syntax";

const EXTENSION_TO_LANGUAGE: Readonly<Record<string, EditorSyntaxLanguageId>> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "jsonc",
  css: "css",
  scss: "scss",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  md: "markdown",
  markdown: "markdown",
  mdx: "mdx",
  svelte: "svelte",
  astro: "astro",
  vue: "html",
  py: "python",
  rs: "rust",
  go: "go",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  ksh: "shellscript",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sql: "sql",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cc: "cpp",
  java: "java",
  swift: "swift",
  zig: "zig",
};

/** Maps a workspace file path to its Singapore `EditorSyntaxLanguageId`, or `null` for plain text. */
export function languageIdForPath(filePath: string | undefined): EditorSyntaxLanguageId | null {
  if (!filePath) return null;
  const slash = filePath.lastIndexOf("/");
  const name = (slash >= 0 ? filePath.slice(slash + 1) : filePath).toLowerCase();
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile") return "makefile";
  if (name === ".bashrc" || name === ".zshrc") return "shellscript";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  const ext = name.slice(dot + 1);
  return Object.hasOwn(EXTENSION_TO_LANGUAGE, ext) ? (EXTENSION_TO_LANGUAGE[ext] ?? null) : null;
}

const EXTENSION_TO_LABEL: Readonly<Record<string, string>> = {
  ts: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  tsx: "TypeScript JSX",
  js: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  jsx: "JavaScript JSX",
  json: "JSON",
  jsonc: "JSON with Comments",
  css: "CSS",
  scss: "SCSS",
  html: "HTML",
  htm: "HTML",
  xml: "XML",
  svg: "SVG",
  md: "Markdown",
  markdown: "Markdown",
  mdx: "MDX",
  svelte: "Svelte",
  astro: "Astro",
  vue: "Vue",
  py: "Python",
  rs: "Rust",
  go: "Go",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  ksh: "Shell",
  toml: "TOML",
  yaml: "YAML",
  yml: "YAML",
  sql: "SQL",
  c: "C",
  h: "C",
  cpp: "C++",
  hpp: "C++",
  cc: "C++",
  java: "Java",
  swift: "Swift",
  zig: "Zig",
};

/** Returns a human-readable language label for a workspace path, defaulting to `"Plain Text"`. */
export function languageLabelForPath(filePath: string | undefined): string {
  if (!filePath) return "Plain Text";
  const slash = filePath.lastIndexOf("/");
  const name = (slash >= 0 ? filePath.slice(slash + 1) : filePath).toLowerCase();
  if (name === "dockerfile") return "Dockerfile";
  if (name === "makefile") return "Makefile";
  if (name === ".bashrc" || name === ".zshrc") return "Shell";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "Plain Text";
  const ext = name.slice(dot + 1);
  return Object.hasOwn(EXTENSION_TO_LABEL, ext) ? (EXTENSION_TO_LABEL[ext] ?? "Plain Text") : "Plain Text";
}
