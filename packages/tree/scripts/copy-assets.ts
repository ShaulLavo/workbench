import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const src = path.join(root, "src");
const dist = path.join(root, "dist");

mkdirSync(dist, { recursive: true });
cpSync(path.join(src, "tree.css"), path.join(dist, "tree.css"));
cpSync(path.join(root, "../../LICENSE"), path.join(root, "LICENSE"));
cpSync(path.join(root, "../../NOTICE"), path.join(root, "NOTICE"));
