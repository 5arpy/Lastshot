import { declareShortcuts } from "../lib/shortcuts";

/** The frame keys (rebindable in Settings → Shortcuts, listed in the cheat sheet). */
export const FRAME_KEYS: { id: string; keys: string; label: string; group: string }[] = [
  { id: "close", keys: "Ctrl+W", label: "Close this frame", group: "Frame" },
  { id: "full", keys: "F", label: "Full screen on or off", group: "Frame" },
  { id: "leave-full", keys: "Escape", label: "Leave full screen", group: "Frame" },
  { id: "on-top", keys: "T", label: "Always on top", group: "Frame" },
  { id: "through", keys: "X", label: "Click-through (clicks reach the app below)", group: "Frame" },
  { id: "opacity-down", keys: "Shift+-", label: "Less opaque", group: "Frame" },
  { id: "opacity-up", keys: "Shift+=", label: "More opaque", group: "Frame" },
  { id: "menu", keys: "Shift+F10", label: "The frame's menu", group: "Frame" },
];
declareShortcuts("frame", FRAME_KEYS);
export const fk = (id: string) => {
  const k = FRAME_KEYS.find((x) => x.id === id);
  if (!k) throw new Error(`no frame key ${id}`);
  return k;
};
