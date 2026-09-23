/**
 * Browser entry point: mounts the React app inside index.html’s root element.
 * Also loads global styles and starts production PWA registration.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./lib/materialWebFallback";
import App from "./App.tsx";
import "./pwa";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
