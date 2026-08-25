import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";

import "../excalidraw-app/sentry";

// Side-effect import: registers the Lawha @font-face declarations.
import "./lawha/fonts";
import "./lawha/mermaid/register";

import { LawhaRouter } from "./routes/router";

window.__EXCALIDRAW_SHA__ = import.meta.env.VITE_APP_GIT_SHA;
const rootElement = document.getElementById("root")!;
const root = createRoot(rootElement);
registerSW();
root.render(
  <StrictMode>
    <LawhaRouter />
  </StrictMode>,
);
