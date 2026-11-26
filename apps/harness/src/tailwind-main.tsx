import "./tailwind.css";
import "./harness.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HarnessApp } from "./HarnessApp";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <HarnessApp hostKind="tailwind" initialPreset="fregat" initialMode="dark" />
    </StrictMode>,
  );
}
