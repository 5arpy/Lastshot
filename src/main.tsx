import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { currentWindowLabel, lastshot } from "./lib/bridge";
import { setShortcutOverrides } from "./lib/shortcuts";
import { initTheme } from "./lib/theme";
import { installBrowserKeyGuard } from "./lib/browserKeys";
import { frameIdOf } from "./popout/frames";

// The screenshot overlay runs in its own window ("snip"); `?snip` opens it in
// a plain browser for testing. It is loaded separately so the main window
// does not carry its code.
const SnipOverlay = lazy(() => import("./components/SnipOverlay"));
const ControlBar = lazy(() => import("./components/ControlBar"));
const DrawLayer = lazy(() => import("./components/DrawLayer"));
const SceneWindow = lazy(() => import("./components/StudioLayers"));
const FrameWindow = lazy(() => import("./popout/FrameWindow"));
const params = new URLSearchParams(location.search);
const isSnip = currentWindowLabel() === "snip" || params.has("snip");
const isBar = currentWindowLabel() === "bar" || params.has("bar");
const isDraw = currentWindowLabel() === "annot" || params.has("draw");
const isScene = currentWindowLabel() === "scene" || params.has("scene");
// A pop-out frame (`frame-<id>`), or `?frame=<id>` in a browser.
const frameId = frameIdOf(currentWindowLabel(), location.search);

initTheme();
// Every window: no browser keys or menus (reload, print, zoom, devtools…).
installBrowserKeyGuard();
// Windows with keys (the app's, frames): the user's rebound shortcuts, kept current.
if (lastshot.isTauri() && !isSnip && !isBar && !isDraw && !isScene) {
  void lastshot.getSettings().then((s) => setShortcutOverrides(s.shortcuts)).catch(() => undefined);
  void lastshot.onSettings((s) => setShortcutOverrides(s.shortcuts));
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      {frameId ? (
        <Suspense fallback={null}>
          <FrameWindow id={frameId} />
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
        // The main window and windows of tabs dragged out of it (`shell-<n>`).
        <App />
      )}
    </ErrorBoundary>
  </StrictMode>
);
