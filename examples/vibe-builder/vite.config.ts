import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react({ compiler: true })],
  resolve: {
    dedupe: [
      "react",
      "react-dom",
      "@shaulavo/hotkeys",
      "@base-ui/react",
      "ghostty-webgpu",
      "@singapore-editor/core",
      "@singapore-editor/react",
    ],
  },
  optimizeDeps: {
    exclude: ["ghostty-webgpu"],
  },
  build: {
    target: "esnext",
  },
});
