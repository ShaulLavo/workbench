import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const EXTERNAL_PACKAGES = [
  "react",
  "react-dom",
  "@base-ui/react",
  "@shaulavo/hotkeys",
  "ghostty-webgpu",
  "@singapore-editor/",
  "@dnd-kit/core",
  "@dnd-kit/sortable",
  "@dnd-kit/utilities",
] as const;

function isExternal(id: string): boolean {
  if (id.endsWith(".css")) return true;
  return EXTERNAL_PACKAGES.some((pkg) => {
    if (pkg.endsWith("/")) return id.startsWith(pkg);
    return id === pkg || id.startsWith(`${pkg}/`);
  });
}

export default defineConfig({
  plugins: [react({ compiler: true })],
  build: {
    target: "esnext",
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: {
        index: path.resolve(import.meta.dirname, "src/index.ts"),
        "core/index": path.resolve(import.meta.dirname, "src/core/index.ts"),
        "tokens/index": path.resolve(import.meta.dirname, "src/tokens/index.ts"),
        "icons/core": path.resolve(import.meta.dirname, "src/icons/core.ts"),
        "icons/index": path.resolve(import.meta.dirname, "src/icons/index.ts"),
        "tree/model": path.resolve(import.meta.dirname, "src/tree/model.ts"),
        "tree/index": path.resolve(import.meta.dirname, "src/tree/index.ts"),
        "terminal/index": path.resolve(import.meta.dirname, "src/terminal/index.ts"),
        "preview/index": path.resolve(import.meta.dirname, "src/preview/index.ts"),
        "editor/index": path.resolve(import.meta.dirname, "src/editor/index.ts"),
        "editor/groups/index": path.resolve(import.meta.dirname, "src/editor/groups/index.ts"),
        "editor/lsp/index": path.resolve(import.meta.dirname, "src/editor/lsp/index.ts"),
        "editor/composer/index": path.resolve(import.meta.dirname, "src/editor/composer/index.ts"),
        "editor/diff/index": path.resolve(import.meta.dirname, "src/editor/diff/index.ts"),
      },
      formats: ["es"],
    },
    rolldownOptions: {
      external: isExternal,
    },
  },
});
