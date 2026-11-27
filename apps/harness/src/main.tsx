import "@shaulavo/workbench/reset.css";
import "@shaulavo/workbench/themes/sprockt.css";
import "@shaulavo/workbench/themes/fregat.css";
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
