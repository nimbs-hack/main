import "leaflet/dist/leaflet.css";
import "./styles/tokens.css";
import "./styles/app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Missing #root mount element");
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
