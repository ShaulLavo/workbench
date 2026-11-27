import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@shaulavo/workbench/reset.css";
import "@shaulavo/workbench/themes/fregat.css";
import "./vibe.css";
import { VibeBuilderApp } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <VibeBuilderApp />
  </StrictMode>,
);
