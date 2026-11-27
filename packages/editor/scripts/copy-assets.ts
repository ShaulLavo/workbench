import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const PKG_DIR = path.resolve(import.meta.dirname, "..");
const DIST_DIR = path.join(PKG_DIR, "dist");

mkdirSync(DIST_DIR, { recursive: true });
copyFileSync(path.join(PKG_DIR, "src/editor.css"), path.join(DIST_DIR, "editor.css"));
copyFileSync(path.join(PKG_DIR, "LICENSE"), path.join(DIST_DIR, "LICENSE"));
copyFileSync(path.join(PKG_DIR, "NOTICE"), path.join(DIST_DIR, "NOTICE"));
