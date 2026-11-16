/**
 * The file-explorer side of the bridge: list folders, search names, copy and
 * move like File Explorer, put deleted items back, Windows' "Open with" and
 * Properties, native file drags out, and the real paths of dropped files.
 */
import { isTauri } from "./bridge";

export interface FsEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  modifiedMs: number;
  hidden: boolean;
  readonly: boolean;
}

export interface DroppedItem {
  path: string;
  dir: boolean;
}

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const t = window.__TAURI__;
  if (!t) return Promise.reject(new Error("Tauri API unavailable"));
  return t.core.invoke<T>(cmd, args);
}

export const EVT_DROP_PATHS = "lastshot://drop-paths";
const DROP_MESSAGE = "lastshot-drop:";

export const fs = {
  listDir: (path: string, showHidden = false): Promise<FsEntry[]> =>
    isTauri() ? invoke("fs_list_dir", { path, showHidden }) : Promise.resolve([]),
  search: (roots: string[], query: string, limit = 500): Promise<FsEntry[]> =>
    isTauri() ? invoke("fs_search", { roots, query, limit }) : Promise.resolve([]),
  /** Copies or moves into `dest` (a clips folder). Returns [from, to] pairs. */
  transfer: (paths: string[], dest: string, mode: "copy" | "move"): Promise<[string, string][]> =>
    invoke("fs_transfer", { paths, dest, mode }),
  /** Puts deleted items back from the Recycle Bin; returns where they landed. */
  restore: (paths: string[]): Promise<string[]> => invoke("fs_restore", { paths }),
  openWith: (path: string): Promise<void> => invoke("fs_open_with", { path }),
  properties: (path: string): Promise<void> => invoke("fs_properties", { path }),
  /** Undo of a move: puts `[from, to]` items back at `from`. */
  moveBack: (pairs: [string, string][]): Promise<number> => invoke("fs_move_back", { pairs }),
  /** Files on the clipboard as File Explorer sees them (cut = move on paste). */
  setClipboard: (paths: string[], cut: boolean): Promise<void> => invoke("fs_set_clipboard", { paths, cut }),
  clipboardFiles: (): Promise<{ paths: string[]; cut: boolean }> =>
    isTauri() ? invoke("fs_clipboard_files") : Promise.resolve({ paths: [], cut: false }),
  /** Native drag of real files (call in `dragstart` after `preventDefault`). */
  startDrag: (paths: string[]): Promise<void> => (isTauri() ? invoke("start_file_drag", { paths }) : Promise.resolve()),
};

type WebviewBridge = { postMessageWithAdditionalObjects?: (msg: string, objs: unknown) => void };

/**
 * The real paths of files and folders dropped on the page (an HTML `File`
 * has none). Empty when the window cannot tell (a browser, an old WebView2).
 */
export function droppedPaths(dt: DataTransfer | null): Promise<DroppedItem[]> {
  const files = Array.from(dt?.files ?? []);
  const wv = (window as unknown as { chrome?: { webview?: WebviewBridge } }).chrome?.webview;
  const t = window.__TAURI__;
  if (!files.length || !wv?.postMessageWithAdditionalObjects || !t) return Promise.resolve([]);
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return new Promise((resolve) => {
    let off: (() => void) | undefined;
    let done = false;
    const finish = (items: DroppedItem[]) => {
      if (done) return;
      done = true;
      off?.();
      resolve(items);
    };
    const timer = window.setTimeout(() => finish([]), 3000);
    void t.event
      .listen<{ id: string; items: DroppedItem[] }>(EVT_DROP_PATHS, (e) => {
        if (e.payload?.id !== id) return;
        window.clearTimeout(timer);
        finish(e.payload.items ?? []);
      })
      .then((u) => {
        off = u;
        if (done) u();
        try {
          wv.postMessageWithAdditionalObjects?.(DROP_MESSAGE + id, files);
        } catch {
          window.clearTimeout(timer);
          finish([]);
        }
      });
  });
}

/** Does this drag carry files or folders from outside the page? */
export const dragHasFiles = (dt: DataTransfer | null) => !!dt && Array.from(dt.types).includes("Files");

// ------------------------------------------------------------------ kinds

export type FileKind = "video" | "picture" | "audio" | "doc" | "archive" | "other";
const KINDS: [FileKind, RegExp][] = [
  ["video", /\.(mp4|m4v|mov|mkv|webm|avi|wmv|flv|ts|mts)$/i],
  ["picture", /\.(png|jpe?g|gif|webp|bmp|tiff?|ico|avif|heic)$/i],
  ["audio", /\.(wav|mp3|m4a|aac|flac|ogg|opus|wma)$/i],
  ["doc", /\.(txt|md|pdf|docx?|xlsx?|pptx?|json|csv|log|rtf)$/i],
  ["archive", /\.(zip|7z|rar|tar|gz|xz)$/i],
];
export function fileKind(name: string): FileKind {
  for (const [k, re] of KINDS) if (re.test(name)) return k;
  return "other";
}
/** Pictures the WebView can show as thumbnails. */
export const isShowablePicture = (name: string) => /\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i.test(name);
/** Videos the library treats as clips (scanned, with thumbnails and the editor). */
export const isClipVideo = (name: string) => /\.(mp4|mov|m4v)$/i.test(name);

/** "name.ext" → [stem, ".ext"] (folders and dot-files keep their whole name). */
export function splitExt(name: string, dir = false): [string, string] {
  if (dir) return [name, ""];
  const i = name.lastIndexOf(".");
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ""];
}

/**
 * What a drop does, like File Explorer: Ctrl copies, Shift moves, otherwise
 * move on the same drive and copy to another drive.
 */
export function dropMode(src: string, dest: string, keys: { ctrlKey: boolean; shiftKey: boolean }): "copy" | "move" {
  if (keys.ctrlKey && !keys.shiftKey) return "copy";
  if (keys.shiftKey && !keys.ctrlKey) return "move";
  const drive = (p: string) => (/^[a-z]:/i.test(p) ? p.slice(0, 2).toLowerCase() : p.replace(/\//g, "\\").split("\\").slice(0, 4).join("\\").toLowerCase());
  return drive(src) === drive(dest) ? "move" : "copy";
}
