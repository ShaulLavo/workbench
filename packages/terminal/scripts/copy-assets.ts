import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const pkgRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(pkgRoot, "../..");
mkdirSync(path.join(pkgRoot, "dist"), { recursive: true });
copyFileSync(path.join(pkgRoot, "src/terminal.css"), path.join(pkgRoot, "dist/terminal.css"));
copyFileSync(path.join(repoRoot, "LICENSE"), path.join(pkgRoot, "LICENSE"));
copyFileSync(path.join(repoRoot, "NOTICE"), path.join(pkgRoot, "NOTICE"));
