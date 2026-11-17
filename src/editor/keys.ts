/**
 * Keyboard shortcuts of the editor and snip tabs (and Draw on screen), as plain data lists
 * ({ id, keys, label, group, run, when, context }). `keyTables.ts` turns them
 * into the app-wide registry's scopes "editor", "snip" and "draw" (rebinding, the
 * cheat sheet, the palette, Settings → Shortcuts and the clash test).
 *
 * Shortcut policy: app-wide keys are a small reserved set (`src/lib/appKeys.ts`:
 * the command palette, the cheat sheet, tab switching, interface size). Tab
 * scopes use simple keys and never one of those; `shortcutDefaults.test.ts`
 * checks it.
 *
 * `keys` is one binding such as "Ctrl+Shift+Z", "Space", "S" or "=". Aliases
 * are separate entries with the same label; tooltips show the first one.
 *
 * Entries with `mouse: true` (group "Mouse") list the timeline's mouse
 * gestures for the cheat sheet; they never run from the keyboard.
 */

export interface Shortcut {
  /** Stable id, "<scope>.<action>" (aliases add ".2", ".3"…). */
  id: string;
  keys: string;
  label: string;
  group?: string;
  run: () => void;
  when?: () => boolean;
  /** "object": only while a picture object is selected (keys may repeat outside it). */
  context?: string;
  /** A mouse gesture, shown in the cheat sheet only (never matched to a key press). */
  mouse?: boolean;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);

/** Gives each entry its id: "<scope>.<label slug>", aliases numbered. */
export function withIds(scope: string, list: Omit<Shortcut, "id">[]): Shortcut[] {
  const seen = new Map<string, number>();
  return list.map((s) => {
    const base = `${scope}.${slug(s.label)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { id: n === 1 ? base : `${base}.${n}`, ...s };
  });
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
  slip: () => void;
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
  /** Selects nothing (keeps the tool). */
  deselectAll: () => void;
  nudge: (frames: number) => void;
  /** Moves the selected clips to the next track of their kind up (-1) or down (1). */
  moveTrack: (dir: -1 | 1) => void;
  /** Follow the playhead while playing: off → page → smooth → off. */
  toggleFollow: () => void;
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
  /** Cuts out in → out (closes the gap), or keeps only in → out. */
  cutRange: (keepOnly: boolean) => void;
  /** Copies the frame as a picture. */
  copyFrame: () => void;
  selectSide: (dir: -1 | 1) => void;
  editText: () => boolean;
  /** An overlay object is selected (keys act on it instead of clips). */
  objectFocus: () => boolean;
}

const noop = () => undefined;

/** The timeline's mouse gestures (cheat sheet only). */
export const MOUSE_GESTURES: { keys: string; label: string }[] = [
  { keys: "Wheel", label: "Scroll the timeline sideways" },
  { keys: "Shift+Wheel", label: "Scroll the tracks up and down" },
  { keys: "Ctrl+Wheel", label: "Zoom at the pointer" },
  { keys: "Alt+Wheel", label: "Zoom at the pointer" },
  { keys: "Z+Wheel", label: "Zoom at the pointer (hold Z; Z with + or - zooms too)" },
  { keys: "Ctrl+Shift+Wheel", label: "Track taller / shorter" },
  { keys: "Middle-drag", label: "Pan the timeline" },
  { keys: "Drag the overview", label: "Scroll (the strip above the ruler)" },
  { keys: "Drag the overview box edge", label: "Zoom to that span" },
  { keys: "Ctrl+drag the overview", label: "Zoom around the pointer (or drag up / down)" },
  { keys: "Drag the ruler", label: "Move the playhead (snaps to cuts and markers)" },
  { keys: "Ctrl+drag the ruler", label: "Zoom (right or down = closer)" },
  { keys: "Drag the playhead", label: "Move the playhead (grab it anywhere on the line)" },
  { keys: "Shift+drag the playhead", label: "Move the playhead without snapping" },
  { keys: "Click an empty track", label: "Playhead there; selects the gap (Delete closes it)" },
  { keys: "Double-click a clip edge", label: "Playhead to that cut" },
  { keys: "Double-click a clip", label: "Select it and show its settings" },
  { keys: "Double-click a marker", label: "Rename the marker" },
  { keys: "Drag a clip", label: "Move (snaps; drag to the side to scroll)" },
  { keys: "Alt+drag a clip", label: "Move a copy" },
  { keys: "Shift+drag a clip", label: "Change track only, keep the time (no snapping)" },
  { keys: "Ctrl+drag a clip", label: "Insert (pushes clips right)" },
  { keys: "Drag a clip edge", label: "Trim" },
  { keys: "Ctrl+drag a clip edge", label: "Ripple trim" },
  { keys: "Alt+drag a cut", label: "Roll the cut" },
  { keys: "Shift while dragging", label: "Snapping off for this drag" },
  { keys: "Drag empty space", label: "Select with a box (Shift adds)" },
  { keys: "Drag a track's bottom border", label: "Track taller / shorter" },
  { keys: "Right-click", label: "Menu for the clip, gap, track or ruler" },
];

export function editorKeymap(a: EditorActions): Shortcut[] {
  const obj = a.objectFocus;
  const notObj = () => !a.objectFocus();
  const list = withIds("editor", [
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
    { keys: "X", label: "Cut out in → out (closes the gap)", group: "Range", run: () => a.cutRange(false) },
    { keys: "Shift+X", label: "Keep only in → out", group: "Range", run: () => a.cutRange(true) },
    // Edit
    { keys: "S", label: "Split at playhead", group: "Edit", run: a.split },
    { keys: "C", label: "Split at playhead", group: "Edit", run: a.split },
    { keys: "Ctrl+K", label: "Split at playhead", group: "Edit", run: a.split },
    { keys: "Ctrl+B", label: "Split at playhead", group: "Edit", run: a.split },
    { keys: "Shift+S", label: "Split every track", group: "Edit", run: a.splitAll },
    { keys: "B", label: "Blade tool (click a clip to cut it)", group: "Tools", run: a.blade },
    { keys: "Y", label: "Slip tool (drag what a clip shows; Alt+drag a cut rolls it)", group: "Tools", run: a.slip },
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
    { keys: "Ctrl+Shift+A", label: "Select none", group: "Edit", run: a.deselectAll },
    { keys: "Escape", label: "Deselect / back to Select tool", group: "Edit", run: a.deselect },
    { keys: ",", label: "Nudge left one frame", group: "Edit", run: () => a.nudge(-1) },
    { keys: ".", label: "Nudge right one frame", group: "Edit", run: () => a.nudge(1) },
    { keys: "Shift+,", label: "Nudge left ten frames", group: "Edit", run: () => a.nudge(-10) },
    { keys: "Shift+.", label: "Nudge right ten frames", group: "Edit", run: () => a.nudge(10) },
    { keys: "Alt+ArrowLeft", label: "Nudge left one frame", group: "Edit", run: () => a.nudge(-1), when: notObj },
    { keys: "Alt+ArrowRight", label: "Nudge right one frame", group: "Edit", run: () => a.nudge(1), when: notObj },
    { keys: "Alt+ArrowUp", label: "Move to the track above", group: "Edit", run: () => a.moveTrack(-1), when: notObj },
    { keys: "Alt+ArrowDown", label: "Move to the track below", group: "Edit", run: () => a.moveTrack(1), when: notObj },
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
    { keys: "Shift+F", label: "Follow the playhead (off, page, smooth)", group: "Timeline", run: a.toggleFollow },
    ...MOUSE_GESTURES.map((m) => ({ ...m, group: "Mouse", run: noop, mouse: true })),
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
    { keys: "ArrowLeft", label: "Nudge left 1 px", group: "Arrange", run: () => void a.arrows(-1, 0), when: obj },
    { keys: "ArrowRight", label: "Nudge right 1 px", group: "Arrange", run: () => void a.arrows(1, 0), when: obj },
    { keys: "ArrowUp", label: "Nudge up 1 px", group: "Arrange", run: () => void a.arrows(0, -1), when: obj },
    { keys: "ArrowDown", label: "Nudge down 1 px", group: "Arrange", run: () => void a.arrows(0, 1), when: obj },
    { keys: "Shift+ArrowLeft", label: "Nudge left 10 px", group: "Arrange", run: () => void a.arrows(-10, 0), when: obj },
    { keys: "Shift+ArrowRight", label: "Nudge right 10 px", group: "Arrange", run: () => void a.arrows(10, 0), when: obj },
    { keys: "Shift+ArrowUp", label: "Nudge up 10 px", group: "Arrange", run: () => void a.arrows(0, -10), when: obj },
    { keys: "Shift+ArrowDown", label: "Nudge down 10 px", group: "Arrange", run: () => void a.arrows(0, 10), when: obj },
    // File
    { keys: "Ctrl+E", label: "Export (save as a new clip)", group: "File", run: a.exportSave },
    { keys: "Ctrl+Shift+E", label: "Shrink and copy for Discord", group: "File", run: a.exportShare },
    { keys: "Ctrl+I", label: "Add files", group: "File", run: a.importFiles },
    { keys: "Ctrl+Shift+S", label: "Save the frame as a picture", group: "File", run: a.snapshot },
    { keys: "Ctrl+Shift+C", label: "Copy the frame as a picture", group: "File", run: a.copyFrame },
  ]);
  // Keys that act on a selected object share keys with the timeline's.
  return list.map((s) => (s.when === obj ? { ...s, context: "object" } : s));
}

// ------------------------------------------------------------------ snip

/** Snip tools and their keys (tooltips show them). */
export const SNIP_TOOL_KEYS: { keys: string; tool: string; label: string }[] = [
  { keys: "V", tool: "select", label: "Select / move" },
  { keys: "T", tool: "text", label: "Text" },
  { keys: "R", tool: "rect", label: "Rectangle" },
  { keys: "E", tool: "ellipse", label: "Ellipse" },
  { keys: "A", tool: "arrow", label: "Arrow" },
  { keys: "Shift+A", tool: "line", label: "Line" },
  { keys: "P", tool: "pen", label: "Pen" },
  { keys: "H", tool: "highlight", label: "Highlighter" },
  { keys: "U", tool: "step", label: "Number step" },
  { keys: "B", tool: "blur", label: "Blur" },
  { keys: "Shift+B", tool: "pixelate", label: "Pixelate" },
  { keys: "K", tool: "redact", label: "Black box" },
  { keys: "L", tool: "spotlight", label: "Spotlight" },
];

export interface SnipActions {
  undo: () => void;
  redo: () => void;
  copy: () => void;
  save: () => void;
  toEditor: () => void;
  popOut: () => void;
  selectAll: () => void;
  duplicate: () => void;
  lock: () => void;
  order: (dir: number) => void;
  rotate: (deg: number) => void;
  flip: (axis: "x" | "y") => void;
  /** Edits the selected text, else copies and closes. */
  enter: () => void;
  del: () => void;
  /** Moves the selected objects by 1 (or 10) screen pixels. */
  nudge: (dx: number, dy: number) => void;
  opacity: (v: number) => void;
  tool: (t: string) => void;
  /** Objects are selected. */
  picked: () => boolean;
  /** Copies the text in the area (Windows' own text recognition). */
  copyText: () => void;
  /** Drops the selected objects or the tool, else cancels the snip. */
  escape: () => void;
  /** Moves the area (or with `resize`, sizes it from its right / bottom edge) by screen pixels. */
  area: (dx: number, dy: number, resize: boolean) => void;
  // Before an area is picked (context "pick").
  screen: () => void;
  allScreens: () => void;
  hovered: () => void;
  draw: () => void;
  textMode: () => void;
  colourMode: () => void;
  lastArea: () => void;
  magnifier: () => void;
  hints: () => void;
  cancel: () => void;
  // Record mode, once the area is picked (context "rec").
  record: () => void;
}

/**
 * The snip's keys (scope "snip"). Context "pick": before an area is picked;
 * "rec": the area is picked for a recording; none or "area": marking up a
 * screenshot ("area": the arrows move the area while no object is selected).
 */
export function snipKeymap(a: SnipActions): Shortcut[] {
  const one = a.picked;
  const none = () => !a.picked();
  const arrows = [
    ["ArrowLeft", -1, 0, "left", "narrower"],
    ["ArrowRight", 1, 0, "right", "wider"],
    ["ArrowUp", 0, -1, "up", "shorter"],
    ["ArrowDown", 0, 1, "down", "taller"],
  ] as const;
  return withIds("snip", [
    { keys: "F", label: "This whole screen", group: "Pick", context: "pick", run: a.screen },
    { keys: "Shift+F", label: "Every screen at once", group: "Pick", context: "pick", run: a.allScreens },
    { keys: "Enter", label: "The window under the mouse", group: "Pick", context: "pick", run: a.hovered },
    { keys: "L", label: "The last area again", group: "Pick", context: "pick", run: a.lastArea },
    { keys: "T", label: "Copy text: drag a box over it", group: "Pick", context: "pick", run: a.textMode },
    { keys: "C", label: "Pick a colour", group: "Pick", context: "pick", run: a.colourMode },
    { keys: "D", label: "Draw on the screen", group: "Pick", context: "pick", run: a.draw },
    { keys: "M", label: "Magnifier on / off", group: "Pick", context: "pick", run: a.magnifier },
    { keys: "H", label: "Key hints on / off", group: "Pick", context: "pick", run: a.hints },
    { keys: "Escape", label: "Cancel the snip", group: "Pick", context: "pick", run: a.cancel },
    { keys: "Enter", label: "Start recording", group: "Record", context: "rec", run: a.record },
    { keys: "Escape", label: "Cancel the recording", group: "Record", context: "rec", run: a.cancel },
    { keys: "Escape", label: "Drop the selection, or cancel", group: "Edit", run: a.escape },
    { keys: "Ctrl+Shift+C", label: "Copy the text in it", group: "File", run: a.copyText },
    ...arrows.flatMap(([k, dx, dy, dir, size]) => [
      { keys: k, label: `Move the area ${dir} 1 px`, group: "Area", context: "area", run: () => a.area(dx, dy, false), when: none },
      { keys: `Shift+${k}`, label: `Move the area ${dir} 10 px`, group: "Area", context: "area", run: () => a.area(dx * 10, dy * 10, false), when: none },
      { keys: `Ctrl+${k}`, label: `Area 1 px ${size}`, group: "Area", context: "area", run: () => a.area(dx, dy, true), when: none },
      { keys: `Ctrl+Shift+${k}`, label: `Area 10 px ${size}`, group: "Area", context: "area", run: () => a.area(dx * 10, dy * 10, true), when: none },
    ]),
    { keys: "Ctrl+Z", label: "Undo", group: "Edit", run: a.undo },
    { keys: "Ctrl+Y", label: "Redo", group: "Edit", run: a.redo },
    { keys: "Ctrl+Shift+Z", label: "Redo", group: "Edit", run: a.redo },
    { keys: "Ctrl+C", label: "Copy and close", group: "File", run: a.copy },
    { keys: "Ctrl+S", label: "Save, copy and close", group: "File", run: a.save },
    { keys: "Ctrl+E", label: "Open in the editor", group: "File", run: a.toEditor },
    { keys: "Ctrl+P", label: "Pop out as a frame", group: "File", run: a.popOut },
    { keys: "Enter", label: "Edit the selected text, or copy and close", group: "File", run: a.enter },
    { keys: "Ctrl+A", label: "Select all objects", group: "Edit", run: a.selectAll },
    { keys: "Ctrl+D", label: "Duplicate", group: "Edit", run: a.duplicate, when: one },
    { keys: "Delete", label: "Delete", group: "Edit", run: a.del, when: one },
    { keys: "Backspace", label: "Delete", group: "Edit", run: a.del, when: one },
    { keys: "Ctrl+Shift+L", label: "Lock / unlock", group: "Arrange", run: a.lock, when: one },
    { keys: "Ctrl+]", label: "Bring forward", group: "Arrange", run: () => a.order(1), when: one },
    { keys: "Ctrl+[", label: "Send backward", group: "Arrange", run: () => a.order(-1), when: one },
    { keys: "Ctrl+Shift+]", label: "Bring to front", group: "Arrange", run: () => a.order(Infinity), when: one },
    { keys: "Ctrl+Shift+[", label: "Send to back", group: "Arrange", run: () => a.order(-Infinity), when: one },
    { keys: "Shift+R", label: "Turn 90° right", group: "Arrange", run: () => a.rotate(90), when: one },
    { keys: "Ctrl+Shift+R", label: "Turn 90° left", group: "Arrange", run: () => a.rotate(-90), when: one },
    { keys: "Shift+H", label: "Flip horizontally", group: "Arrange", run: () => a.flip("x"), when: one },
    { keys: "Shift+V", label: "Flip vertically", group: "Arrange", run: () => a.flip("y"), when: one },
    ...(
      [
        ["ArrowLeft", -1, 0],
        ["ArrowRight", 1, 0],
        ["ArrowUp", 0, -1],
        ["ArrowDown", 0, 1],
      ] as const
    ).flatMap(([k, dx, dy]) => {
      const dir = dx < 0 ? "left" : dx > 0 ? "right" : dy < 0 ? "up" : "down";
      return [
        { keys: k, label: `Nudge ${dir} 1 px`, group: "Arrange", run: () => a.nudge(dx, dy), when: one },
        { keys: `Shift+${k}`, label: `Nudge ${dir} 10 px`, group: "Arrange", run: () => a.nudge(dx * 10, dy * 10), when: one },
      ];
    }),
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((n) => ({
      keys: String(n),
      label: `Opacity ${n === 0 ? 100 : n * 10} %`,
      group: "Arrange",
      run: () => a.opacity(n === 0 ? 1 : n / 10),
      when: one,
    })),
    ...SNIP_TOOL_KEYS.map((t) => ({ keys: t.keys, label: t.label, group: "Tools", run: () => a.tool(t.tool) })),
  ]);
}

// ------------------------------------------------------------------ draw on screen

/** Tools of Draw on screen (the snip's keys; no blur / pixelate / black box: there is no picture under them). */
export const DRAW_TOOL_KEYS = [...SNIP_TOOL_KEYS.filter((t) => !["blur", "pixelate", "redact"].includes(t.tool)), { keys: "X", tool: "eraser", label: "Eraser" }];

export interface DrawActions {
  undo: () => void;
  redo: () => void;
  selectAll: () => void;
  duplicate: () => void;
  del: () => void;
  nudge: (dx: number, dy: number) => void;
  tool: (t: string) => void;
  /** Removes every drawing (one undo step). */
  clear: () => void;
  /** Hides / shows the drawing. */
  ink: () => void;
  /** Click-through: the drawing stays, the mouse works the apps under it. */
  mouse: () => void;
  board: (b: "white" | "black") => void;
  /** Pen width a step thinner (-1) or thicker (1). */
  width: (dir: number) => void;
  /** The n-th palette colour (0-based). */
  colour: (n: number) => void;
  snip: () => void;
  /** Esc: closes a menu, drops the selection, else stops drawing. */
  escape: () => void;
  picked: () => boolean;
}

/** Keys of Draw on screen (scope "draw"; from the snip bar, D). */
export function drawKeymap(a: DrawActions): Shortcut[] {
  const one = a.picked;
  const colours = ["red", "yellow", "green", "blue", "purple", "white", "black"];
  return withIds("draw", [
    { keys: "Ctrl+Z", label: "Undo", group: "Edit", run: a.undo },
    { keys: "Ctrl+Y", label: "Redo", group: "Edit", run: a.redo },
    { keys: "Ctrl+Shift+Z", label: "Redo", group: "Edit", run: a.redo },
    { keys: "C", label: "Clear the drawing", group: "Edit", run: a.clear },
    { keys: "Ctrl+A", label: "Select all", group: "Edit", run: a.selectAll },
    { keys: "Ctrl+D", label: "Duplicate", group: "Edit", run: a.duplicate, when: one },
    { keys: "Delete", label: "Delete", group: "Edit", run: a.del, when: one },
    { keys: "Backspace", label: "Delete", group: "Edit", run: a.del, when: one },
    { keys: "I", label: "Hide / show the drawing", group: "View", run: a.ink },
    { keys: "M", label: "Use the mouse (click-through)", group: "View", run: a.mouse },
    { keys: "W", label: "Whiteboard", group: "View", run: () => a.board("white") },
    { keys: "K", label: "Blackboard", group: "View", run: () => a.board("black") },
    { keys: "Ctrl+S", label: "Snip the screen with the drawing", group: "File", run: a.snip },
    { keys: "Escape", label: "Drop the selection, or stop drawing", group: "File", run: a.escape },
    { keys: "[", label: "Thinner", group: "Style", run: () => a.width(-1) },
    { keys: "]", label: "Thicker", group: "Style", run: () => a.width(1) },
    ...colours.map((c, i) => ({ keys: String(i + 1), label: `Colour ${i + 1} (${c})`, group: "Style", run: () => a.colour(i) })),
    ...(
      [
        ["ArrowLeft", -1, 0],
        ["ArrowRight", 1, 0],
        ["ArrowUp", 0, -1],
        ["ArrowDown", 0, 1],
      ] as const
    ).flatMap(([k, dx, dy]) => {
      const dir = dx < 0 ? "left" : dx > 0 ? "right" : dy < 0 ? "up" : "down";
      return [
        { keys: k, label: `Nudge ${dir} 1 px`, group: "Arrange", run: () => a.nudge(dx, dy), when: one },
        { keys: `Shift+${k}`, label: `Nudge ${dir} 10 px`, group: "Arrange", run: () => a.nudge(dx * 10, dy * 10), when: one },
      ];
    }),
    ...DRAW_TOOL_KEYS.map((t) => ({ keys: t.keys, label: t.label, group: "Tools", run: () => a.tool(t.tool) })),
  ]);
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

/** Normalised binding name (so "shift+ctrl+z" equals "Ctrl+Shift+Z"; "+" and "Ctrl++" work). */
export function normKeys(keys: string): string {
  const plus = keys === "+" || keys.endsWith("++");
  const parts = (plus ? keys.slice(0, -1) : keys)
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  const key = plus ? "+" : (parts.pop() ?? "");
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

/** The first shortcut that takes this key press now (none while typing). */
export function findShortcut(list: Shortcut[], e: KeyboardEvent): Shortcut | null {
  if (isTyping(e.target)) return null;
  const name = keyName(e);
  for (const s of list) {
    if (s.mouse || normKeys(s.keys) !== name) continue;
    if (s.when && !s.when()) continue;
    return s;
  }
  return null;
}

/** Runs the first matching shortcut; true when one ran. */
export function runShortcut(list: Shortcut[], e: KeyboardEvent): boolean {
  const s = findShortcut(list, e);
  if (!s) return false;
  e.preventDefault();
  s.run();
  return true;
}

/** "Split (S)" style tooltip from the keymap. */
export function tip(list: Shortcut[], label: string, text?: string): string {
  const s = list.find((x) => x.label === label);
  const k = s?.keys.replace("ArrowLeft", "←").replace("ArrowRight", "→").replace("ArrowUp", "↑").replace("ArrowDown", "↓");
  return `${text ?? label}${k ? ` (${k})` : ""}`;
}
