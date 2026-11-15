import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { currentWindowLabel } from "./lib/bridge";
import { initTheme } from "./lib/theme";

// The screenshot overlay runs in its own window ("snip"); `?snip` opens it in
// a plain browser for testing. It is loaded separately so the main window
// does not carry its code.
const SnipOverlay = lazy(() => import("./components/SnipOverlay"));
const ControlBar = lazy(() => import("./components/ControlBar"));
const params = new URLSearchParams(location.search);
const isSnip = currentWindowLabel() === "snip" || params.has("snip");
const isBar = currentWindowLabel() === "bar" || params.has("bar");

initTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      {isBar ? (
        <Suspense fallback={null}>
          <ControlBar />
        </Suspense>
      ) : isSnip ? (
        <Suspense fallback={<div className="fixed inset-0 bg-black" />}>
          <SnipOverlay />
        </Suspense>
      ) : (
        <App />
      )}
    </ErrorBoundary>
  </StrictMode>
);
