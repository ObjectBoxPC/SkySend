import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { registerDownloadSw } from "./lib/sw-download";
import { applyRewrittenShareLinkFix } from "./lib/rewritten-link";
import "./i18n";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./index.css";
import "flag-icons/css/flag-icons.min.css";

// Repair share links whose "#" was percent-encoded by a mail security gateway.
// Must run before the router reads the location.
applyRewrittenShareLinkFix();

// Register the download Service Worker early, so tier 1 finds it active. It covers only the
// URLs of tier 1, see DOWNLOAD_SW_SCOPE, and comes under the version of this release, see
// DOWNLOAD_SW_URL.
if ("serviceWorker" in navigator) {
  registerDownloadSw().catch(() => {});
}

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
