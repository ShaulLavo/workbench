import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const PKG_ROOT = path.resolve(import.meta.dirname, "..");
const REPO_ROOT = path.resolve(PKG_ROOT, "../..");
const SRC_STYLES = path.join(PKG_ROOT, "src/styles");
const DIST_DIR = path.join(PKG_ROOT, "dist");
const DIST_STYLES = path.join(DIST_DIR, "styles");
const DIST_THEMES = path.join(DIST_DIR, "themes");

const INTERNAL_STYLES = [
  "tokens.css",
  "icons.css",
  "ui.css",
  "tree.css",
  "terminal.css",
  "preview.css",
  "editor.css",
] as const;

const OPT_IN_STYLES = ["layers.css", "reset.css", "tailwind.css"] as const;
const THEME_STYLES = ["fregat.css", "sprockt.css"] as const;

mkdirSync(DIST_STYLES, { recursive: true });
mkdirSync(DIST_THEMES, { recursive: true });

for (const file of INTERNAL_STYLES) {
  copyFileSync(path.join(SRC_STYLES, file), path.join(DIST_STYLES, file));
}

for (const file of OPT_IN_STYLES) {
  copyFileSync(path.join(SRC_STYLES, file), path.join(DIST_DIR, file));
}

for (const file of THEME_STYLES) {
  copyFileSync(path.join(SRC_STYLES, "themes", file), path.join(DIST_THEMES, file));
}

for (const noticeFile of ["LICENSE", "NOTICE"]) {
  copyFileSync(path.join(REPO_ROOT, noticeFile), path.join(PKG_ROOT, noticeFile));
}
