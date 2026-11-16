import { declareShortcuts } from "../lib/shortcuts";

/**
 * The Clips explorer's keys (scope "clips", stable ids for rebinding).
 * Declared when the app loads so Settings > Shortcuts and the cheat sheet
 * list them even while Clips is closed.
 */
export const NAV_KEYS = ["Left", "Right", "Up", "Down", "Home", "End", "PageUp", "PageDown"] as const;
const NAV_LABEL: Record<(typeof NAV_KEYS)[number], string> = {
  Left: "Left",
  Right: "Right",
  Up: "Up",
  Down: "Down",
  Home: "First item",
  End: "Last item",
  PageUp: "Page up",
  PageDown: "Page down",
};
export const CLIPS_KEYS: { id: string; keys: string; label: string; group: string }[] = [
  { id: "back", keys: "Alt+Left | BrowserBack", label: "Back", group: "Folders" },
  { id: "forward", keys: "Alt+Right | BrowserForward", label: "Forward", group: "Folders" },
  { id: "up", keys: "Alt+Up | Backspace", label: "Up a folder", group: "Folders" },
  { id: "address", keys: "Ctrl+L | Alt+D | F4", label: "Type a path", group: "Folders" },
  { id: "search", keys: "Ctrl+F | Ctrl+E | F3", label: "Search", group: "Folders" },
  { id: "refresh", keys: "F5 | Ctrl+R", label: "Refresh", group: "Folders" },
  { id: "new-folder", keys: "Ctrl+Shift+N", label: "New folder", group: "Files" },
  { id: "open", keys: "Enter", label: "Open", group: "Files" },
  { id: "open-default", keys: "Ctrl+Enter", label: "Open in its default app", group: "Files" },
  { id: "rename", keys: "F2", label: "Rename", group: "Files" },
  { id: "delete", keys: "Delete", label: "Delete (to the Recycle Bin)", group: "Files" },
  { id: "copy", keys: "Ctrl+C", label: "Copy", group: "Files" },
  { id: "cut", keys: "Ctrl+X", label: "Cut", group: "Files" },
  { id: "paste", keys: "Ctrl+V", label: "Paste", group: "Files" },
  { id: "copy-path", keys: "Ctrl+Shift+C", label: "Copy path", group: "Files" },
  { id: "undo", keys: "Ctrl+Z", label: "Undo", group: "Files" },
  { id: "properties", keys: "Alt+Enter", label: "Properties", group: "Files" },
  { id: "select-all", keys: "Ctrl+A", label: "Select all", group: "Select" },
  { id: "toggle-select", keys: "Ctrl+Space", label: "Select or unselect", group: "Select" },
  { id: "menu", keys: "Shift+F10 | ContextMenu", label: "Menu", group: "Select" },
  { id: "escape", keys: "Escape", label: "Cancel / clear", group: "Select" },
  ...NAV_KEYS.flatMap((k) => [
    { id: `focus-${k.toLowerCase()}`, keys: k, label: NAV_LABEL[k], group: "Move around" },
    { id: `extend-${k.toLowerCase()}`, keys: `Shift+${k}`, label: `${NAV_LABEL[k]}, selecting`, group: "Move around" },
  ]),
  { id: "preview", keys: "Alt+P", label: "Preview pane", group: "View" },
  { id: "view-grid", keys: "Ctrl+Shift+2", label: "Pictures view", group: "View" },
  { id: "view-details", keys: "Ctrl+Shift+6", label: "Details view", group: "View" },
];
declareShortcuts("clips", CLIPS_KEYS);
