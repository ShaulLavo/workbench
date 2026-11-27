import "@shaulavo/workbench-tokens/tokens.css";
import "@shaulavo/workbench-tokens/reset.css";
import "@shaulavo/workbench-tokens/themes/sprockt.css";
import "@shaulavo/workbench-tokens/themes/fregat.css";
import "@shaulavo/workbench-icons/icons.css";
import "@shaulavo/workbench-ui/ui.css";
import "@shaulavo/workbench-tree/tree.css";
import "@shaulavo/workbench-terminal/terminal.css";
import "@shaulavo/workbench-preview/preview.css";
import "@shaulavo/workbench-editor/editor.css";
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
