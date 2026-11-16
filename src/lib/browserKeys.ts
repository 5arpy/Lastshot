/**
 * Lastshot windows are an app, not a browser. WebView2's own browser keys
 * are off (src-tauri/src/browser_keys.rs); this guard is the second line for
 * every window: reload, print, view source, history, downloads, caret
 * browsing, devtools (release), page zoom, back/forward and the browser's
 * right-click menu never act.
 *
 * It only cancels the browser's default action. The event still reaches the
 * app, marked `__lsGuard`, so app shortcuts on the same keys (Ctrl+F search,
 * Alt+Left back, Ctrl+0 viewer reset, Ctrl+Shift+= interface size) keep working.
 */
import { comboFromEvent, isTextField } from "./shortcuts";

const ALWAYS = new Set([
  "F5",
  "Ctrl+R",
  "Ctrl+Shift+R",
  "Ctrl+F5",
  "Shift+F5",
  "Ctrl+P",
  "Ctrl+Shift+P",
  "Ctrl+U",
  "Ctrl+H",
  "Ctrl+J",
  "Ctrl+D",
  "Ctrl+Shift+Delete",
  "Ctrl+Shift+B",
  "Ctrl+Shift+O",
  "F7",
  "Ctrl+F",
  "F3",
  "Shift+F3",
  "Ctrl+G",
  "Ctrl+Shift+G",
  "Alt+Left",
  "Alt+Right",
  "Alt+Home",
  "Ctrl+=",
  "Ctrl++",
  "Ctrl+-",
  "Ctrl+Shift+=",
  "Ctrl+Shift+-",
  "Ctrl+_",
  "Ctrl+0",
  "Ctrl+N",
  "Ctrl+Shift+N",
  "Ctrl+T",
  "Ctrl+Shift+T",
  "Ctrl+W",
  "Ctrl+Shift+W",
  "Ctrl+O",
  "Ctrl+S",
  "Ctrl+Shift+S",
  "F11",
]);
const DEVTOOLS = new Set(["F12", "Ctrl+Shift+I", "Ctrl+Shift+J", "Ctrl+Shift+C", "Ctrl+Shift+K"]);

/** Whether the browser must not act on this key (exported for tests). */
export function isBrowserKey(combo: string, prod: boolean, inText: boolean): boolean {
  if (!combo) return false;
  if (DEVTOOLS.has(combo)) return prod;
  // Typing keeps its own editing keys; these do nothing useful in a field.
  if (inText && (combo === "Alt+Left" || combo === "Alt+Right")) return false;
  return ALWAYS.has(combo);
}

type Marked = Event & { __lsGuard?: boolean };

let installed = false;

export function installBrowserKeyGuard(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const prod = !!import.meta.env?.PROD;
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "BrowserBack" || e.key === "BrowserForward" || e.key === "BrowserRefresh" || e.key === "BrowserSearch") {
        e.preventDefault();
        (e as Marked).__lsGuard = true;
        return;
      }
      if (isBrowserKey(comboFromEvent(e), prod, isTextField(e.target))) {
        e.preventDefault();
        (e as Marked).__lsGuard = true;
      }
    },
    true,
  );
  // Mouse back / forward buttons never navigate the page (the explorer uses
  // them for its own history).
  const noNav = (e: MouseEvent) => {
    if (e.button === 3 || e.button === 4) e.preventDefault();
  };
  window.addEventListener("mouseup", noNav, true);
  window.addEventListener("auxclick", noNav, true);
  // Ctrl+wheel never zooms the page (parts of the app zoom their own way).
  window.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey) e.preventDefault();
    },
    { passive: false },
  );
  // No browser menu (Back, Reload, Save as, Print, Inspect); text fields keep
  // theirs (cut, copy, paste), and app menus open on their own.
  window.addEventListener("contextmenu", (e) => {
    if (!e.defaultPrevented && !isTextField(e.target)) e.preventDefault();
  });
}
