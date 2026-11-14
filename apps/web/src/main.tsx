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

if (
  typeof window !== "undefined" &&
  "serviceWorker" in navigator &&
  (window.location.protocol === "https:" || window.location.protocol === "http:")
) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => {
      // Non-fatal if Service Worker is blocked in private mode
    });
  });
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
