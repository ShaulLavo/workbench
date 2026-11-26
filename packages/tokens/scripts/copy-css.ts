import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const src = path.join(root, "src");
const dist = path.join(root, "dist");

mkdirSync(path.join(dist, "themes"), { recursive: true });
for (const relative of [
  "tokens.css",
  "reset.css",
  "tailwind-bridge.css",
  "themes/fregat.css",
  "themes/sprockt.css",
]) {
  cpSync(path.join(src, relative), path.join(dist, relative));
}
cpSync(path.join(root, "../../LICENSE"), path.join(root, "LICENSE"));
cpSync(path.join(root, "../../NOTICE"), path.join(root, "NOTICE"));
