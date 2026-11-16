import { declareShortcuts } from "../lib/shortcuts";

/** The viewer keys (rebindable in Settings → Shortcuts, listed in the cheat sheet). */
export const VIEWER_KEYS: { id: string; keys: string; label: string; group: string }[] = [
  { id: "fit", keys: "0", label: "Fit the whole picture", group: "Zoom" },
  { id: "actual", keys: "1", label: "100 % (one picture pixel per screen pixel)", group: "Zoom" },
  { id: "fill", keys: "2", label: "Fill the view", group: "Zoom" },
  { id: "zoom-in", keys: "+ | =", label: "Zoom in", group: "Zoom" },
  { id: "zoom-out", keys: "- | _", label: "Zoom out", group: "Zoom" },
  { id: "turn-right", keys: "R | ]", label: "Turn right 90°", group: "Turn and mirror" },
  { id: "turn-left", keys: "Shift+R | [", label: "Turn left 90°", group: "Turn and mirror" },
  { id: "turn-right-15", keys: "}", label: "Turn right 15°", group: "Turn and mirror" },
  { id: "turn-left-15", keys: "{", label: "Turn left 15°", group: "Turn and mirror" },
  { id: "mirror", keys: "H", label: "Mirror left↔right", group: "Turn and mirror" },
  { id: "flip", keys: "Shift+H", label: "Flip upside down", group: "Turn and mirror" },
  { id: "value", keys: "M", label: "Value check (grey)", group: "Inspect" },
  { id: "grid", keys: "G", label: "Grid: thirds · custom · off", group: "Inspect" },
  { id: "picker", keys: "C", label: "Colour picker", group: "Inspect" },
  { id: "crop", keys: "Shift+C", label: "Crop", group: "Inspect" },
  { id: "measure", keys: "D", label: "Measure", group: "Inspect" },
  { id: "compare", keys: "W", label: "Compare: set B, then cycle wipe · difference · side by side", group: "Inspect" },
  { id: "colour", keys: "E", label: "Colour adjustments", group: "Inspect" },
  { id: "copy", keys: "Ctrl+C", label: "Copy this frame as a picture", group: "Picture" },
  { id: "save", keys: "Ctrl+S", label: "Save this frame as PNG", group: "Picture" },
  { id: "reset", keys: "Ctrl+0", label: "Reset zoom, turn, flip, colour and crop", group: "Picture" },
  { id: "undo", keys: "Ctrl+Z", label: "Undo (turn, flip, crop, colour, grid)", group: "Picture" },
  { id: "redo", keys: "Ctrl+Y | Ctrl+Shift+Z", label: "Redo", group: "Picture" },
  { id: "play", keys: "K", label: "Play / pause at normal speed", group: "Video" },
  { id: "slower", keys: "J", label: "Slower", group: "Video" },
  { id: "faster", keys: "L", label: "Faster", group: "Video" },
  { id: "frame-back", keys: ",", label: "One frame back", group: "Video" },
  { id: "frame-on", keys: ".", label: "One frame on", group: "Video" },
  { id: "frame-back-10", keys: "<", label: "10 frames back", group: "Video" },
  { id: "frame-on-10", keys: ">", label: "10 frames on", group: "Video" },
  { id: "loop", keys: "Shift+L", label: "Loop the whole clip", group: "Video" },
  { id: "loop-a", keys: "A", label: "Loop from here (A)", group: "Video" },
  { id: "loop-b", keys: "B", label: "Loop to here (B)", group: "Video" },
  { id: "loop-clear", keys: "Shift+A", label: "Clear the A–B loop", group: "Video" },
  { id: "onion", keys: "N", label: "Onion skin: off · 1 · 2 frames", group: "Video" },
];
declareShortcuts("viewer", VIEWER_KEYS);
export const vk = (id: string) => {
  const k = VIEWER_KEYS.find((x) => x.id === id);
  if (!k) throw new Error(`no viewer key ${id}`);
  return k;
};
