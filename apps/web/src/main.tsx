/**
 * Browser entry point: mounts the React app inside index.html’s root element.
 * Also loads global styles and starts production PWA registration.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./app/index.css";
import "@material/web/chips/filter-chip.js";
import "@material/web/button/filled-tonal-button.js";
import App from "./app/App.tsx";
import "./shared/pwa/pwa";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
