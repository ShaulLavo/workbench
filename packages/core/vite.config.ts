import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const EXTERNALS = [
  "react",
  "react-dom",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react/compiler-runtime",
  "@shaulavo/hotkeys",
  "@shaulavo/hotkeys/react",
  "@shaulavo/workbench-tokens",
];

export default defineConfig({
  plugins: [react({ compiler: true })],
  build: {
    target: "esnext",
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: {
        index: path.resolve(import.meta.dirname, "src/index.ts"),
        "react/index": path.resolve(import.meta.dirname, "src/react/index.ts"),
      },
      formats: ["es"],
    },
    rolldownOptions: {
      external: (id) => EXTERNALS.some((pkg) => id === pkg || id.startsWith(`${pkg}/`)),
    },
  },
});
