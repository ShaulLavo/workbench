import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const EXTERNAL_PREFIXES = [
  "react",
  "react-dom",
  "@base-ui/react",
  "@shaulavo/",
  "@singapore-editor/",
  "@dnd-kit/",
];

function isExternal(id: string): boolean {
  return EXTERNAL_PREFIXES.some(
    (prefix) => id === prefix || id.startsWith(prefix) || id.startsWith(`${prefix}/`),
  );
}

export default defineConfig({
  plugins: [react()],
  build: {
    emptyOutDir: false,
    sourcemap: true,
    target: "es2023",
    lib: {
      entry: {
        index: resolve(import.meta.dirname, "src/index.ts"),
        "groups/index": resolve(import.meta.dirname, "src/groups/index.ts"),
        "lsp/index": resolve(import.meta.dirname, "src/lsp/index.ts"),
        "composer/index": resolve(import.meta.dirname, "src/composer/index.ts"),
        "diff/index": resolve(import.meta.dirname, "src/diff/index.ts"),
      },
      formats: ["es"],
    },
    rolldownOptions: {
      external: isExternal,
    },
  },
});
