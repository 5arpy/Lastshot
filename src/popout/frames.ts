/**
 * Pop-out frames: the frontend side of `src-tauri/src/frames.rs`.
 * A frame is a borderless window (`frame-<id>`) showing a picture, a clip
 * frame, a playing clip (or, in Lastshot Pro, a reference board or a live
 * view). These helpers open, list and change frames from any window.
 */
import type { Size, View } from "../viewer/math";
import { DEFAULT_SETTINGS, type ViewerSettings } from "../viewer/Viewer";

export type FrameKind = "image" | "video" | "board" | "live";

export interface Frame {
  id: string;
  kind: FrameKind;
  src: string;
  title: string;
  /** The content's rectangle (the picture; tools grow outside it), physical px. */
  x: number;
  y: number;
  w: number;
  h: number;
  opacity: number;
  onTop: boolean;
  clickThrough: boolean;
  hidden: boolean;
  /** Only shown while one of these apps (exe names) or Lastshot is in front;
   *  empty = over every app (but not over a full-screen one). */
  showOver: string[];
  /** The frame's own view (zoom, settings, a board's pictures). Only
   *  `frames.list()` has it; change events leave it out (null). */
  view: unknown;
  owned: boolean;
  createdMs: number;
  /** How many things the user put in it (a board's pictures); null = never reported. */
  items?: number | null;
  /** Short view flags for the Pop-outs panel ("gray", "grid", "flipH", "flipV"). */
  badges?: string[];
  /** Background, outline and edge shadow (older builds send none: the default). */
  look?: FrameLook;
}

/** How a frame stands out from the screen behind it. */
export interface FrameLook {
  /** Behind the picture (letterbox, see-through pixels). */
  bg: "none" | "dark" | "light" | "checker" | "custom";
  /** "#rrggbb" for `bg: "custom"`. */
  color: string;
  /** Outline width in px; 0 = none. */
  border: number;
  /** "" = automatic (a light and a dark line, seen on any background). */
  borderColor: string;
  /** A soft shade along the edges. */
  shadow: boolean;
}

export const DEFAULT_LOOK: FrameLook = { bg: "none", color: "#1e1f24", border: 1, borderColor: "", shadow: false };

const CHECKER = "repeating-conic-gradient(#8a8a8a 0% 25%, #b9b9b9 0% 50%) 50% / 16px 16px";

/** The CSS for a look: the background behind the content, and the outline and shade drawn over its edges. */
export function lookCss(l?: Partial<FrameLook> | null): { background?: string; boxShadow?: string } {
  const k = { ...DEFAULT_LOOK, ...(l ?? {}) };
  const background =
    k.bg === "dark" ? "#121318" : k.bg === "light" ? "#f3f3f5" : k.bg === "checker" ? CHECKER : k.bg === "custom" && /^#[0-9a-f]{6}$/i.test(k.color) ? k.color : undefined;
  const sh: string[] = [];
  const b = Math.max(0, Math.min(12, Math.round(k.border || 0)));
  if (b > 0) {
    if (/^#[0-9a-f]{6}$/i.test(k.borderColor)) sh.push(`inset 0 0 0 ${b}px ${k.borderColor}`);
    // Automatic: a light line outside a dark one, so it shows on any screen.
    else sh.push(`inset 0 0 0 ${b}px rgba(255,255,255,0.6)`, `inset 0 0 0 ${b * 2}px rgba(0,0,0,0.55)`);
  }
  if (k.shadow) sh.push("inset 0 0 18px 2px rgba(0,0,0,0.55)");
  return { background, boxShadow: sh.length ? sh.join(", ") : undefined };
}

/** A recently closed frame that owned files (kept 7 days). */
export interface ClosedFrame {
  key: string;
  id: string;
  kind: FrameKind;
  title: string;
  closedMs: number;
  pictures: number;
}

export interface FramePatch {
  opacity?: number;
  onTop?: boolean;
  clickThrough?: boolean;
  hidden?: boolean;
  view?: unknown;
  title?: string;
  showOver?: string[];
  items?: number;
  badges?: string[];
  look?: FrameLook;
}

export interface OpenFrame {
  kind: FrameKind;
  path?: string;
  /** A data URL (or base64) of a PNG, JPG, GIF, WebP or BMP. */
  data?: string;
  title?: string;
  width?: number;
  height?: number;
  view?: unknown;
  x?: number;
  y?: number;
}

export interface Layout {
  screens: [number, number, number, number][];
  frames: [string, number, number, number, number][];
  me: [number, number, number, number] | null;
  scale: number;
  /** The cursor, physical px. */
  cursor: [number, number] | null;
}

/** What an image/video frame remembers (stored in `Frame.view`). */
export interface FrameViewState {
  v?: View | null;
  /** The stage (CSS px) `v` was made for: a restored view is scaled to the stage it gets. */
  st?: Size | null;
  /** `v` was the fitted placement: it is fitted again (keeping its turn and flips). */
  fit?: boolean;
  s?: ViewerSettings;
  /** Video: where it was and whether it played. */
  t?: number;
  playing?: boolean;
  muted?: boolean;
}

export const EVT_FRAMES = "lastshot://frames";
export const EVT_PANEL = "lastshot://frames-panel";
export const EVT_NOTICE = "lastshot://frames-notice";
/** To one frame: Alt+F4 was pressed and the frame holds things, so it asks. */
export const EVT_ASK_CLOSE = "lastshot://frame-ask-close";
export const LABEL_PREFIX = "frame-";
/** The Pop-outs panel drives a frame's view: `{ id, cmd }`. */
export const EVT_CMD = "lastshot://frame-cmd";
/** To one frame: its content size (physical px) and where its tools are. */
export const EVT_CONTENT = "lastshot://frame-content";
/** To one frame: Ctrl+Alt held over it made it clickable for now (true), or that ended. */
export const EVT_PEEK = "lastshot://frame-peek";

export interface ContentInfo {
  w: number;
  h: number;
  side: "top" | "bottom" | "none";
  chrome: number;
}

/** What the Pop-outs panel can ask a frame's viewer to do. */
export type FrameCmd = "zoomIn" | "zoomOut" | "fit" | "actual" | "flipH" | "flipV" | "gray" | "grid" | "reset";

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const t = window.__TAURI__;
  if (!t) return Promise.reject(new Error("Pop-out frames work in the desktop app"));
  return t.core.invoke<T>(cmd, args);
}

export const inApp = () => typeof window !== "undefined" && !!window.__TAURI__;

export const frames = {
  open: (req: OpenFrame) => invoke<Frame>("frame_open", { req }),
  list: () => (inApp() ? invoke<Frame[]>("frame_list") : Promise.resolve([] as Frame[])),
  update: (id: string, patch: FramePatch) => invoke<Frame>("frame_update", { id, patch }),
  setRect: (id: string, x: number, y: number, w: number, h: number) =>
    invoke<void>("frame_set_rect", { id, x: Math.round(x), y: Math.round(y), w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) }),
  fullscreen: (id: string, on?: boolean) => invoke<boolean>("frame_fullscreen", { id, on }),
  raise: (id: string) => invoke<void>("frame_raise", { id }),
  /** False (and still open) when the frame holds things and `force` is not set: ask, then force. */
  close: (id: string, force?: boolean) => invoke<boolean>("frame_close", { id, force }),
  /** Without `force`, frames that hold things stay open (`kept`). */
  closeAll: (force?: boolean) => invoke<{ closed: number; kept: number }>("frame_close_all", { force }),
  /** Recently closed frames that owned files, newest first. */
  closed: () => (inApp() ? invoke<ClosedFrame[]>("frame_closed") : Promise.resolve([] as ClosedFrame[])),
  reopen: (key: string) => invoke<Frame>("frame_reopen", { key }),
  /** The cursor in physical screen px. */
  cursor: () => invoke<[number, number]>("frame_cursor"),
  clickThroughAll: (on?: boolean) => invoke<boolean>("frame_click_through_all", { on }),
  hideAll: (hidden?: boolean) => invoke<boolean>("frame_hide_all", { hidden }),
  layout: (id: string) => invoke<Layout>("frame_layout", { id }),
  getHotkey: () => invoke<string>("frame_get_hotkey"),
  /** The look new frames start with, and making a look that default. */
  defaultLook: () => (inApp() ? invoke<FrameLook>("frame_default_look") : Promise.resolve(DEFAULT_LOOK)),
  setDefaultLook: (look: FrameLook) => invoke<FrameLook>("frame_set_default_look", { look }),
  setHotkey: (hotkey: string) => invoke<string>("frame_set_hotkey", { hotkey }),
  fromClipboard: () => invoke<Frame>("frame_from_clipboard"),
  showPanel: () => invoke<void>("frame_show_panel"),
  /** Shows the tools strip outside the content (`height` CSS px) or removes it (0). */
  chrome: (id: string, height: number) => invoke<"top" | "bottom" | "none">("frame_chrome", { id, height }),
  onContent(handler: (c: ContentInfo) => void): Promise<() => void> {
    const t = window.__TAURI__;
    if (!t) return Promise.resolve(() => undefined);
    return t.event.listen<ContentInfo>(EVT_CONTENT, (e) => handler(e.payload));
  },
  onPeek(handler: (on: boolean) => void): Promise<() => void> {
    const t = window.__TAURI__;
    if (!t) return Promise.resolve(() => undefined);
    return t.event.listen<boolean>(EVT_PEEK, (e) => handler(!!e.payload));
  },
  onChange(handler: (list: Frame[]) => void): Promise<() => void> {
    const t = window.__TAURI__;
    if (!t) return Promise.resolve(() => undefined);
    return t.event.listen<Frame[]>(EVT_FRAMES, (e) => handler(e.payload));
  },
  /** Sends a view command to one frame window. */
  command(id: string, cmd: FrameCmd): Promise<void> {
    const t = window.__TAURI__;
    if (!t) return Promise.resolve();
    return t.event.emitTo(LABEL_PREFIX + id, EVT_CMD, { id, cmd });
  },
  onCommand(id: string, handler: (cmd: FrameCmd) => void): Promise<() => void> {
    const t = window.__TAURI__;
    if (!t) return Promise.resolve(() => undefined);
    return t.event.listen<{ id: string; cmd: FrameCmd }>(EVT_CMD, (e) => {
      if (e.payload?.id === id) handler(e.payload.cmd);
    });
  },
  onPanel(handler: () => void): Promise<() => void> {
    const t = window.__TAURI__;
    if (!t) return Promise.resolve(() => undefined);
    return t.event.listen<unknown>(EVT_PANEL, () => handler());
  },
  onNotice(handler: (msg: string) => void): Promise<() => void> {
    const t = window.__TAURI__;
    if (!t) return Promise.resolve(() => undefined);
    return t.event.listen<string>(EVT_NOTICE, (e) => handler(String(e.payload ?? "")));
  },
  /** Alt+F4 on this frame window while it holds things. */
  onAskClose(handler: () => void): Promise<() => void> {
    const t = window.__TAURI__;
    if (!t) return Promise.resolve(() => undefined);
    return t.event.listen<unknown>(EVT_ASK_CLOSE, () => handler());
  },
};

// ---------------------------------------------------------------- saving before a close

const flushers = new Set<() => Promise<unknown> | void>();

/** A frame body's "save now" (its view waits a moment before saving). */
export function onFlush(f: () => Promise<unknown> | void): () => void {
  flushers.add(f);
  return () => void flushers.delete(f);
}

/** Saves every pending view change of this window now. */
export async function flushAll(): Promise<void> {
  await Promise.all([...flushers].map((f) => Promise.resolve().then(f).catch(() => undefined)));
}

/** Saves, then closes; false when the frame holds things and must ask first. */
export async function closeFrame(id: string, force = false): Promise<boolean> {
  await flushAll();
  return frames.close(id, force);
}

// ---------------------------------------------------------------- echoes

/** How long a local change wins over values coming back from the app. */
export const ECHO_MS = 600;

/**
 * A slider sends its value, and the change comes back to every window a
 * moment later. Values that arrive within `ECHO_MS` of the latest local
 * change are older echoes (or the same value): the local value stays.
 */
export function pickEcho<T>(local: T, remote: T, localAt: number, now: number, ms = ECHO_MS): T {
  return now - localAt < ms ? local : remote;
}

/** The frame id of this window (`frame-<id>`), or `?frame=<id>` in a browser. */
export function frameIdOf(label: string | null, search: string): string | null {
  if (label?.startsWith(LABEL_PREFIX)) return label.slice(LABEL_PREFIX.length) || null;
  const q = new URLSearchParams(search).get("frame");
  return q || null;
}

/** Reads a File / Blob as a data URL. */
export function readDataUrl(f: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}

/** Natural size of a picture blob (for the frame's shape). */
export function pictureSize(f: Blob): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      resolve({ w: img.naturalWidth, h: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve({ w: 800, h: 600 });
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}

const PICTURE = /^image\/(png|jpe?g|gif|webp|bmp)$/i;
export const isPictureType = (type: string) => PICTURE.test(type);

/** Pops out a picture file or blob (a drop, a paste, a file picker). */
export async function popOutPicture(f: Blob, title?: string): Promise<Frame> {
  const [data, size] = await Promise.all([readDataUrl(f), pictureSize(f)]);
  return frames.open({ kind: "image", data, title: title ?? ((f as File).name || "Picture"), width: size.w, height: size.h });
}

/** Pops out a canvas (a clip frame, a snip) as a picture; `at` = screen px. */
export async function popOutCanvas(
  c: HTMLCanvasElement,
  title: string,
  view?: FrameViewState,
  at?: { x: number; y: number },
): Promise<Frame> {
  const data = c.toDataURL("image/png");
  return frames.open({ kind: "image", data, title, width: c.width, height: c.height, view, x: at?.x, y: at?.y });
}

/** The badges for an image/video frame's view (see `viewFlags`). */
export function badgesOf(st: FrameViewState): string[] {
  const b: string[] = [];
  if ((st.s?.adjust?.grayscale ?? 0) >= 0.5) b.push("gray");
  if (st.s?.grid && st.s.grid.kind !== "off") b.push("grid");
  if (st.v?.flipH) b.push("flipH");
  if (st.v?.flipV) b.push("flipV");
  return b;
}

/** More pictures than this at once ask before opening that many windows. */
export const MANY_FRAMES = 8;

/**
 * Pops out several pictures (files or paths). Above `MANY_FRAMES` it asks
 * first (`ask` returns false: nothing opens). Every failure is reported
 * through `onError`; returns how many opened.
 */
export async function popOutMany<T>(
  items: T[],
  open: (item: T) => Promise<unknown>,
  ask: (n: number) => boolean | Promise<boolean>,
  onError: (msg: string) => void,
): Promise<number> {
  if (!items.length) return 0;
  if (items.length > MANY_FRAMES && !(await ask(items.length))) return 0;
  let ok = 0;
  const errors: string[] = [];
  for (const it of items) {
    try {
      await open(it);
      ok++;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (errors.length) {
    const first = errors[0];
    onError(errors.length === 1 ? first : `${errors.length} of ${items.length} pictures did not open. First: ${first}`);
  }
  return ok;
}

/** Pops out a picture file that is already on disk (a drop from Explorer). */
export function popOutPicturePath(path: string): Promise<Frame> {
  return frames.open({ kind: "image", path });
}

export const PICTURE_FILE = /\.(png|jpe?g|gif|webp|bmp)$/i;

/** Settings that show what the panel's toggles mean for this frame. */
export function viewFlags(f: Frame): { gray: boolean; grid: boolean; flipH: boolean; flipV: boolean; zoom: number | null } {
  if (f.badges) {
    const b = new Set(f.badges);
    return { gray: b.has("gray"), grid: b.has("grid"), flipH: b.has("flipH"), flipV: b.has("flipV"), zoom: null };
  }
  const st = (f.view ?? {}) as FrameViewState;
  return {
    gray: (st.s?.adjust?.grayscale ?? 0) >= 0.5,
    grid: !!st.s?.grid && st.s.grid.kind !== "off",
    flipH: !!st.v?.flipH,
    flipV: !!st.v?.flipV,
    zoom: null,
  };
}

/** Pops out a clip that keeps playing in its own window. */
export function popOutClip(
  clip: { path: string; file_name?: string; title?: string; width?: number; height?: number },
  view?: FrameViewState,
): Promise<Frame> {
  return frames.open({
    kind: "video",
    path: clip.path,
    title: clip.title || clip.file_name || "Clip",
    width: clip.width || 1920,
    height: clip.height || 1080,
    view: { ...view, s: { ...(view?.s ?? DEFAULT_SETTINGS), loopAll: true } },
  });
}
