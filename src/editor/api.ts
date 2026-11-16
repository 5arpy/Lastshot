/**
 * Editor-only backend calls (kept out of lib/bridge.ts so merges stay easy).
 * In a plain browser they fail politely; the editor still works with the
 * simulated library.
 */
import { isTauri } from "../lib/bridge";
import type { ClipMetadata, ShrinkResult } from "../lib/types";
import type { RenderAudio, RenderJob } from "./project";

type Unlisten = () => void;
interface TauriLike {
  core: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
  event: { listen: <T>(e: string, h: (ev: { payload: T }) => void) => Promise<Unlisten> };
  webviewWindow?: { getCurrentWebviewWindow: () => { label: string; listen: <T>(e: string, h: (ev: { payload: T }) => void) => Promise<Unlisten> } };
}
const T = () => (window as unknown as { __TAURI__: TauriLike }).__TAURI__;

function invoke<R>(cmd: string, args?: Record<string, unknown>): Promise<R> {
  if (!isTauri()) return Promise.reject(new Error("This works in the installed app."));
  return T().core.invoke<R>(cmd, args);
}

export interface MediaInfo {
  kind: "video" | "audio";
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  fps?: number;
}

export interface Peaks {
  /** Buckets per second. */
  rate: number;
  /** Peak level per bucket, 0-255 (linear). */
  data: number[];
}

export const editorApi = {
  mediaInfo: (path: string) => invoke<MediaInfo>("media_info", { path }),
  allowMedia: (paths: string[]) => (isTauri() ? invoke<void>("allow_media", { paths }) : Promise.resolve()),
  peaks: (path: string) => invoke<Peaks>("audio_peaks", { path }),
  thumbs: (path: string, times: number[], height: number) => invoke<string[]>("video_thumbs", { path, times, height }),
  render: (project: RenderJob, mode: "save" | "share", name: string) =>
    invoke<ClipMetadata | ShrinkResult>("render_project", { project, mode, name }),
  exportAudio: (items: RenderAudio[], duration: number, dest: string) => invoke<string>("export_audio", { items, duration, dest }),
  audioFormats: () => invoke<string[]>("audio_formats"),
  onRenderProgress(h: (p: number) => void): Promise<Unlisten> {
    if (!isTauri()) return Promise.resolve(() => undefined);
    return T().event.listen<number>("lastshot://render-progress", (e) => h(e.payload));
  },
  /**
   * Full paths of files dropped on the page (HTML drops carry no paths).
   * WebView2 hands the File objects to the app, which answers with paths.
   */
  async dropPaths(files: File[]): Promise<string[]> {
    const wv = (window as unknown as { chrome?: { webview?: { postMessageWithAdditionalObjects?: (m: string, o: unknown) => void } } }).chrome?.webview;
    if (!isTauri() || !wv?.postMessageWithAdditionalObjects || !files.length) return [];
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const win = T().webviewWindow?.getCurrentWebviewWindow();
    return new Promise<string[]>((resolve) => {
      let off: Unlisten | null = null;
      let done = false;
      const finish = (paths: string[]) => {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        // The listener may still be on its way: drop it as soon as it is.
        off?.();
        resolve(paths);
      };
      const timer = window.setTimeout(() => finish([]), 4000);
      const listen = win ? win.listen.bind(win) : T().event.listen;
      void listen<{ id: string; paths: string[] }>("lastshot://drop-paths", (e) => {
        if (e.payload.id === id) finish(e.payload.paths);
      })
        .then((u) => {
          off = u;
          if (done) u();
          else wv.postMessageWithAdditionalObjects!(JSON.stringify({ lastshotDrop: id }), files);
        })
        .catch(() => finish([]));
    });
  },
};
