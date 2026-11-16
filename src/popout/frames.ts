/**
 * Pop-out frames: the frontend side of `src-tauri/src/frames.rs`.
 * A frame is a borderless window (`frame-<id>`) showing a picture, a clip
 * frame, a playing clip (or, in Lastshot Pro, a reference board or a live
 * view). These helpers open, list and change frames from any window.
 */
import type { View } from "../viewer/math";
import { DEFAULT_SETTINGS, type ViewerSettings } from "../viewer/Viewer";

export type FrameKind = "image" | "video" | "board" | "live";

export interface Frame {
  id: string;
  kind: FrameKind;
  src: string;
  title: string;
  /** Outer rectangle, physical px. */
  x: number;
  y: number;
  w: number;
  h: number;
  opacity: number;
  onTop: boolean;
  clickThrough: boolean;
  hidden: boolean;
  /** Only shown while this app (exe name) or Lastshot is in front; "" = always. */
  onlyWith: string;
  view: unknown;
  owned: boolean;
  createdMs: number;
}

export interface FramePatch {
  opacity?: number;
  onTop?: boolean;
  clickThrough?: boolean;
  hidden?: boolean;
  view?: unknown;
  title?: string;
  onlyWith?: string;
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
}

/** What an image/video frame remembers (stored in `Frame.view`). */
export interface FrameViewState {
  v?: View | null;
  s?: ViewerSettings;
  /** Video: where it was and whether it played. */
  t?: number;
  playing?: boolean;
  muted?: boolean;
}

export const EVT_FRAMES = "lastshot://frames";
export const EVT_PANEL = "lastshot://frames-panel";
export const LABEL_PREFIX = "frame-";
/** The Pop-outs panel drives a frame's view: `{ id, cmd }`. */
export const EVT_CMD = "lastshot://frame-cmd";

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
  close: (id: string) => invoke<void>("frame_close", { id }),
  closeAll: () => invoke<void>("frame_close_all"),
  clickThroughAll: (on?: boolean) => invoke<boolean>("frame_click_through_all", { on }),
  hideAll: (hidden?: boolean) => invoke<boolean>("frame_hide_all", { hidden }),
  layout: (id: string) => invoke<Layout>("frame_layout", { id }),
  getHotkey: () => invoke<string>("frame_get_hotkey"),
  setHotkey: (hotkey: string) => invoke<string>("frame_set_hotkey", { hotkey }),
  fromClipboard: () => invoke<Frame>("frame_from_clipboard"),
  showPanel: () => invoke<void>("frame_show_panel"),
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
};

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

/** Pops out a picture file that is already on disk (a drop from Explorer). */
export function popOutPicturePath(path: string): Promise<Frame> {
  return frames.open({ kind: "image", path });
}

export const PICTURE_FILE = /\.(png|jpe?g|gif|webp|bmp)$/i;

/** Settings that show what the panel's toggles mean for this frame. */
export function viewFlags(f: Frame): { gray: boolean; grid: boolean; flipH: boolean; flipV: boolean; zoom: number | null } {
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
