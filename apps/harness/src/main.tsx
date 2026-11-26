import "@shaulavo/workbench-tokens/tokens.css";
import "@shaulavo/workbench-tokens/reset.css";
import "@shaulavo/workbench-tokens/themes/sprockt.css";
import "@shaulavo/workbench-tokens/themes/fregat.css";
import "./harness.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HarnessApp } from "./HarnessApp";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <HarnessApp hostKind="plain" initialPreset="sprockt" initialMode="light" />
    </StrictMode>,
  );
}
