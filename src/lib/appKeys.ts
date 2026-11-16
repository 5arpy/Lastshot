/**
 * App-wide keys (scope "global"): they work in every tab and every window.
 *
 * Policy, so tabs never fight the app:
 * - App-wide keys are reserved. They are the universal standards (F1, `?`,
 *   Ctrl+Tab and Ctrl+PageUp/PageDown, Ctrl+1…9 like browsers, Ctrl+Shift+P
 *   for commands like VS Code) and otherwise three-key Ctrl+Shift+letter
 *   combos. No Ctrl+Alt+letter defaults: AltGr types characters with them
 *   on many European layouts.
 * - Tabs (Clips, Viewer, Frames, Editor, Snip) use simple keys: single keys,
 *   Ctrl+key, Shift+key… anything not reserved here. The same key in two
 *   different tabs is fine.
 * - `src/lib/shortcutDefaults.test.ts` fails when a default breaks this.
 */
import { declareShortcuts } from "./shortcuts";
import { TAB_IDS, TAB_NAMES } from "./shell";

export const APP_SCOPE = "global";

export const APP_KEYS: { id: string; keys: string; label: string; group: string }[] = [
  ...Array.from({ length: 9 }, (_, i) => ({
    id: `tab-${i + 1}`,
    keys: `Ctrl+${i + 1}`,
    label: i === 8 ? "Last tab in this window" : `Tab ${i + 1} in this window`,
    group: "Tabs",
  })),
  { id: "next-tab", keys: "Ctrl+Tab | Ctrl+PageDown", label: "Next tab", group: "Tabs" },
  { id: "prev-tab", keys: "Ctrl+Shift+Tab | Ctrl+PageUp", label: "Previous tab", group: "Tabs" },
  // One key both ways: in the main window it undocks the tab, elsewhere it docks it back.
  { id: "tab-new-window", keys: "Ctrl+Shift+U", label: "Move this tab to its own window, or back to the main window", group: "Tabs" },
  { id: "close-window", keys: "", label: "Close this window (its tabs go back to the main window)", group: "Tabs" },
  ...TAB_IDS.map((t) => ({ id: `go-${t}`, keys: "", label: `Go to ${TAB_NAMES[t]}`, group: "Tabs" })),
  { id: "cheat-sheet", keys: "F1 | ?", label: "Keyboard shortcuts", group: "Help" },
  { id: "commands", keys: "Ctrl+Shift+P", label: "Find a command", group: "Help" },
  // Ctrl+Shift+= types "+", Ctrl+Shift+- types "_": that is how they arrive.
  { id: "ui-bigger", keys: "Ctrl++", label: "Bigger interface (Ctrl+Shift+=)", group: "View" },
  { id: "ui-smaller", keys: "Ctrl+_", label: "Smaller interface (Ctrl+Shift+-)", group: "View" },
  { id: "ui-reset", keys: "Ctrl+Shift+0", label: "Interface at 100%", group: "View" },
  { id: "screenshot", keys: "", label: "Take a screenshot", group: "Capture" },
  { id: "frames-panel", keys: "", label: "Pop-out frames panel", group: "View" },
];
declareShortcuts(APP_SCOPE, APP_KEYS);

/** One app-wide key by id (keys, label, group). */
export const ak = (id: string) => {
  const k = APP_KEYS.find((x) => x.id === id);
  if (!k) throw new Error(`no app key ${id}`);
  return k;
};
