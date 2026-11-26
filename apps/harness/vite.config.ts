import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react({ compiler: true }), tailwindcss()],
  resolve: {
    dedupe: ["react", "react-dom", "@shaulavo/hotkeys"],
  },
  build: {
    target: "esnext",
    rollupOptions: {
      input: {
        plain: path.resolve(import.meta.dirname, "index.html"),
        tailwind: path.resolve(import.meta.dirname, "tailwind.html"),
      },
    },
  },
});
