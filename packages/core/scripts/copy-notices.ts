import { cpSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
cpSync(path.join(root, "../../LICENSE"), path.join(root, "LICENSE"));
cpSync(path.join(root, "../../NOTICE"), path.join(root, "NOTICE"));
