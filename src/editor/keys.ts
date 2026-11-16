/**
 * The editor's keyboard shortcuts, in the shape the app-wide shortcut
 * registry takes ({ keys, label, group, run, when }). Until that registry is
 * wired in, the editor handles them itself (scoped to the editor, never while
 * typing in a field).
 *
 * `keys` is one binding such as "Ctrl+Shift+Z", "Space", "S" or "=". Aliases
 * are separate entries with the same label; tooltips show the first one.
 */

export interface Shortcut {
  keys: string;
  label: string;
  group?: string;
  run: () => void;
  when?: () => boolean;
}

export interface EditorActions {
  togglePlay: () => void;
  shuttle: (dir: -1 | 0 | 1) => void;
  step: (frames: number) => void;
  stepSeconds: (s: number) => void;
  editPoint: (dir: -1 | 1) => void;
  home: () => void;
  end: () => void;
  loopPlay: () => void;
  markIn: () => void;
  markOut: () => void;
  clearInOut: () => void;
  split: () => void;
  splitAll: () => void;
  blade: () => void;
  select: () => void;
  del: () => void;
  rippleDelete: () => void;
  trimLeft: () => void;
  trimRight: () => void;
  undo: () => void;
  redo: () => void;
  copy: () => void;
  cut: () => void;
  paste: () => void;
  duplicate: () => void;
  selectAll: () => void;
  deselect: () => void;
  nudge: (frames: number) => void;
  toggleEnable: () => void;
  toggleSnap: () => void;
  toggleMagnet: () => void;
  marker: () => void;
  marker2: (dir: -1 | 1) => void;
  zoom: (f: number) => void;
  fit: () => void;
  tool: (t: string) => void;
  rotate: (deg: number) => void;
  flip: (axis: "x" | "y") => void;
  order: (dir: number) => void;
  lock: () => void;
  opacity: (v: number) => void;
  arrows: (dx: number, dy: number) => boolean;
  exportSave: () => void;
  exportShare: () => void;
  snapshot: () => void;
  importFiles: () => void;
  detachAudio: () => void;
  selectSide: (dir: -1 | 1) => void;
  editText: () => boolean;
  /** An overlay object is selected (keys act on it instead of clips). */
  objectFocus: () => boolean;
}

export function editorKeymap(a: EditorActions): Shortcut[] {
  const obj = a.objectFocus;
  const notObj = () => !a.objectFocus();
  return [
    // Transport
    { keys: "Space", label: "Play / pause", group: "Playback", run: a.togglePlay },
    { keys: "J", label: "Play backwards (again = faster)", group: "Playback", run: () => a.shuttle(-1) },
    { keys: "K", label: "Stop", group: "Playback", run: () => a.shuttle(0) },
    { keys: "L", label: "Play forwards (again = faster)", group: "Playback", run: () => a.shuttle(1) },
    { keys: "Shift+Space", label: "Loop play in → out", group: "Playback", run: a.loopPlay },
    { keys: "ArrowLeft", label: "Back one frame", group: "Playback", run: () => a.step(-1), when: notObj },
    { keys: "ArrowRight", label: "Forward one frame", group: "Playback", run: () => a.step(1), when: notObj },
    { keys: "Shift+ArrowLeft", label: "Back one second", group: "Playback", run: () => a.stepSeconds(-1), when: notObj },
    { keys: "Shift+ArrowRight", label: "Forward one second", group: "Playback", run: () => a.stepSeconds(1), when: notObj },
    { keys: "ArrowUp", label: "Previous cut", group: "Playback", run: () => a.editPoint(-1), when: notObj },
    { keys: "ArrowDown", label: "Next cut", group: "Playback", run: () => a.editPoint(1), when: notObj },
    { keys: "Home", label: "Go to start", group: "Playback", run: a.home },
    { keys: "End", label: "Go to end", group: "Playback", run: a.end },
    // Range
    { keys: "I", label: "Mark in", group: "Range", run: a.markIn },
    { keys: "O", label: "Mark out", group: "Range", run: a.markOut },
    { keys: "Alt+X", label: "Clear in and out", group: "Range", run: a.clearInOut },
    // Edit
    { keys: "S", label: "Split at playhead", group: "Edit", run: a.split },
    { keys: "C", label: "Split at playhead", group: "Edit", run: a.split },
    { keys: "Ctrl+K", label: "Split at playhead", group: "Edit", run: a.split },
    { keys: "Ctrl+B", label: "Split at playhead", group: "Edit", run: a.split },
    { keys: "Shift+S", label: "Split every track", group: "Edit", run: a.splitAll },
    { keys: "B", label: "Blade tool (click a clip to cut it)", group: "Tools", run: a.blade },
    { keys: "V", label: "Select / move tool", group: "Tools", run: a.select },
    { keys: "Delete", label: "Delete (leaves a gap)", group: "Edit", run: a.del },
    { keys: "Backspace", label: "Delete (leaves a gap)", group: "Edit", run: a.del },
    { keys: "Shift+Delete", label: "Ripple delete (closes the gap)", group: "Edit", run: a.rippleDelete },
    { keys: "Q", label: "Delete up to the playhead (ripple)", group: "Edit", run: a.trimLeft },
    { keys: "W", label: "Delete from the playhead (ripple)", group: "Edit", run: a.trimRight },
    { keys: "Ctrl+Z", label: "Undo", group: "Edit", run: a.undo },
    { keys: "Ctrl+Y", label: "Redo", group: "Edit", run: a.redo },
    { keys: "Ctrl+Shift+Z", label: "Redo", group: "Edit", run: a.redo },
    { keys: "Ctrl+C", label: "Copy", group: "Edit", run: a.copy },
    { keys: "Ctrl+X", label: "Cut", group: "Edit", run: a.cut },
    { keys: "Ctrl+V", label: "Paste at the playhead", group: "Edit", run: a.paste },
    { keys: "Ctrl+D", label: "Duplicate", group: "Edit", run: a.duplicate },
    { keys: "Ctrl+A", label: "Select all", group: "Edit", run: a.selectAll },
    { keys: "Escape", label: "Deselect / back to Select tool", group: "Edit", run: a.deselect },
    { keys: ",", label: "Nudge left one frame", group: "Edit", run: () => a.nudge(-1) },
    { keys: ".", label: "Nudge right one frame", group: "Edit", run: () => a.nudge(1) },
    { keys: "Shift+,", label: "Nudge left ten frames", group: "Edit", run: () => a.nudge(-10) },
    { keys: "Shift+.", label: "Nudge right ten frames", group: "Edit", run: () => a.nudge(10) },
    { keys: "D", label: "Turn the clip off / on", group: "Edit", run: a.toggleEnable },
    { keys: "Ctrl+Shift+D", label: "Detach audio", group: "Edit", run: a.detachAudio },
    { keys: "[", label: "Select everything left of the playhead", group: "Edit", run: () => a.selectSide(-1) },
    { keys: "]", label: "Select everything right of the playhead", group: "Edit", run: () => a.selectSide(1) },
    // Timeline
    { keys: "N", label: "Snapping on / off", group: "Timeline", run: a.toggleSnap },
    { keys: "Shift+N", label: "Magnetic main track on / off", group: "Timeline", run: a.toggleMagnet },
    { keys: "M", label: "Add a marker", group: "Timeline", run: a.marker },
    { keys: "Shift+M", label: "Next marker", group: "Timeline", run: () => a.marker2(1) },
    { keys: "Ctrl+Shift+M", label: "Previous marker", group: "Timeline", run: () => a.marker2(-1) },
    { keys: "=", label: "Zoom in", group: "Timeline", run: () => a.zoom(1.5) },
    { keys: "+", label: "Zoom in", group: "Timeline", run: () => a.zoom(1.5) },
    { keys: "-", label: "Zoom out", group: "Timeline", run: () => a.zoom(1 / 1.5) },
    { keys: "Shift+Z", label: "Zoom to fit", group: "Timeline", run: a.fit },
    { keys: "\\", label: "Zoom to fit", group: "Timeline", run: a.fit },
    // Annotate (on the picture)
    { keys: "T", label: "Text", group: "Annotate", run: () => a.tool("text") },
    { keys: "R", label: "Rectangle", group: "Annotate", run: () => a.tool("rect") },
    { keys: "E", label: "Ellipse", group: "Annotate", run: () => a.tool("ellipse") },
    { keys: "A", label: "Arrow", group: "Annotate", run: () => a.tool("arrow") },
    { keys: "Shift+A", label: "Line", group: "Annotate", run: () => a.tool("line") },
    { keys: "P", label: "Pen", group: "Annotate", run: () => a.tool("pen") },
    { keys: "H", label: "Highlighter", group: "Annotate", run: () => a.tool("highlight") },
    { keys: "Shift+B", label: "Pixelate (hide names)", group: "Annotate", run: () => a.tool("pixelate") },
    { keys: "U", label: "Number step", group: "Annotate", run: () => a.tool("step") },
    { keys: "Enter", label: "Edit the selected text", group: "Annotate", run: () => void a.editText(), when: obj },
    { keys: "Shift+R", label: "Turn 90° right", group: "Arrange", run: () => a.rotate(90) },
    { keys: "Ctrl+Shift+R", label: "Turn 90° left", group: "Arrange", run: () => a.rotate(-90) },
    { keys: "Shift+H", label: "Flip horizontally", group: "Arrange", run: () => a.flip("x") },
    { keys: "Shift+V", label: "Flip vertically", group: "Arrange", run: () => a.flip("y") },
    { keys: "Ctrl+]", label: "Bring forward", group: "Arrange", run: () => a.order(1), when: obj },
    { keys: "Ctrl+[", label: "Send backward", group: "Arrange", run: () => a.order(-1), when: obj },
    { keys: "Ctrl+Shift+]", label: "Bring to front", group: "Arrange", run: () => a.order(Infinity), when: obj },
    { keys: "Ctrl+Shift+[", label: "Send to back", group: "Arrange", run: () => a.order(-Infinity), when: obj },
    { keys: "Ctrl+Shift+L", label: "Lock / unlock", group: "Arrange", run: a.lock, when: obj },
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((n) => ({
      keys: String(n),
      label: `Opacity ${n === 0 ? 100 : n * 10} %`,
      group: "Arrange",
      run: () => a.opacity(n === 0 ? 1 : n / 10),
      when: obj,
    })),
    { keys: "ArrowLeft", label: "Nudge 1 px", group: "Arrange", run: () => void a.arrows(-1, 0), when: obj },
    { keys: "ArrowRight", label: "Nudge 1 px", group: "Arrange", run: () => void a.arrows(1, 0), when: obj },
    { keys: "ArrowUp", label: "Nudge 1 px", group: "Arrange", run: () => void a.arrows(0, -1), when: obj },
    { keys: "ArrowDown", label: "Nudge 1 px", group: "Arrange", run: () => void a.arrows(0, 1), when: obj },
    { keys: "Shift+ArrowLeft", label: "Nudge 10 px", group: "Arrange", run: () => void a.arrows(-10, 0), when: obj },
    { keys: "Shift+ArrowRight", label: "Nudge 10 px", group: "Arrange", run: () => void a.arrows(10, 0), when: obj },
    { keys: "Shift+ArrowUp", label: "Nudge 10 px", group: "Arrange", run: () => void a.arrows(0, -10), when: obj },
    { keys: "Shift+ArrowDown", label: "Nudge 10 px", group: "Arrange", run: () => void a.arrows(0, 10), when: obj },
    // File
    { keys: "Ctrl+E", label: "Export (save as a new clip)", group: "File", run: a.exportSave },
    { keys: "Ctrl+Shift+E", label: "Shrink and copy for Discord", group: "File", run: a.exportShare },
    { keys: "Ctrl+I", label: "Add files", group: "File", run: a.importFiles },
    { keys: "Ctrl+Shift+S", label: "Save the frame as a picture", group: "File", run: a.snapshot },
  ];
}

/** "Ctrl+Shift+Z" style name of a key press. */
export function keyName(e: KeyboardEvent): string {
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  let k = e.key;
  if (k === " ") k = "Space";
  else if (k.length === 1) k = k.toUpperCase();
  // Shift is part of the name for letters, arrows and named keys; for
  // symbols the key itself already says it ("+" not "Shift+=").
  const sym = k.length === 1 && !/[A-Z0-9]/.test(k);
  if (e.shiftKey && (!sym || k === "," || k === "." || k === "<" || k === ">" || k === "{" || k === "}")) mods.push("Shift");
  // Shift+, arrives as "<" and Shift+. as ">", Ctrl+Shift+] as "}".
  const map: Record<string, string> = { "<": ",", ">": ".", "{": "[", "}": "]" };
  if (map[k]) k = map[k];
  const order = ["Ctrl", "Shift", "Alt"].filter((m) => mods.includes(m));
  return [...order, k].join("+");
}

/** Normalised binding name (so "shift+ctrl+z" equals "Ctrl+Shift+Z"). */
export function normKeys(keys: string): string {
  const parts = keys.split("+").map((p) => p.trim());
  const key = parts.pop() ?? "";
  const mods = ["Ctrl", "Shift", "Alt"].filter((m) => parts.some((p) => p.toLowerCase() === m.toLowerCase()));
  const k = key.length === 1 ? key.toUpperCase() : key;
  return [...mods, k].join("+");
}

export function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/** Runs the first matching shortcut; true when one ran. */
export function runShortcut(list: Shortcut[], e: KeyboardEvent): boolean {
  if (isTyping(e.target)) return false;
  const name = keyName(e);
  for (const s of list) {
    if (normKeys(s.keys) !== name) continue;
    if (s.when && !s.when()) continue;
    e.preventDefault();
    s.run();
    return true;
  }
  return false;
}

/** "Split (S)" style tooltip from the keymap. */
export function tip(list: Shortcut[], label: string, text?: string): string {
  const s = list.find((x) => x.label === label);
  const k = s?.keys.replace("ArrowLeft", "←").replace("ArrowRight", "→").replace("ArrowUp", "↑").replace("ArrowDown", "↓");
  return `${text ?? label}${k ? ` (${k})` : ""}`;
}
