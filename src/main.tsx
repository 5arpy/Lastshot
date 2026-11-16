import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { currentWindowLabel } from "./lib/bridge";
import { initTheme } from "./lib/theme";
import { popViewOf } from "./lib/audio";

// The screenshot overlay runs in its own window ("snip"); `?snip` opens it in
// a plain browser for testing. It is loaded separately so the main window
// does not carry its code.
const SnipOverlay = lazy(() => import("./components/SnipOverlay"));
const ControlBar = lazy(() => import("./components/ControlBar"));
const DrawLayer = lazy(() => import("./components/DrawLayer"));
const SceneWindow = lazy(() => import("./components/StudioLayers"));
const PopoutView = lazy(() => import("./components/PopoutView"));
const params = new URLSearchParams(location.search);
const isSnip = currentWindowLabel() === "snip" || params.has("snip");
const isBar = currentWindowLabel() === "bar" || params.has("bar");
const isDraw = currentWindowLabel() === "annot" || params.has("draw");
const isScene = currentWindowLabel() === "scene" || params.has("scene");
// A tab popped out into its own window (`pop-audio`), or `?view=audio`.
const popView = popViewOf(currentWindowLabel(), location.search);

initTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      {popView ? (
        <Suspense fallback={<div className="fixed inset-0 bg-app" />}>
          <PopoutView view={popView} />
        </Suspense>
      ) : isScene ? (
        <Suspense fallback={null}>
          <SceneWindow />
        </Suspense>
      ) : isDraw ? (
        <Suspense fallback={null}>
          <DrawLayer />
        </Suspense>
      ) : isBar ? (
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
