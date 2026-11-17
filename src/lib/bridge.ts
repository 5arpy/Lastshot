/**
 * Single typed entry point for everything the UI needs from the backend.
 *
 * Under Tauri v2 (`withGlobalTauri: true`) it calls the Rust commands through
 * `window.__TAURI__`. In a plain browser it transparently drives `simEngine`,
 * so the exact same components run in both environments with no branching in
 * the view layer.
 */

import { simEngine } from "./simEngine";
import type {
  AppSettings,
  AudioDevice,
  CaptureProfile,
  ClipMetadata,
  ClipSavedPayload,
  EngineStats,
  ForegroundGame,
  MonitorInfo,
  CaptureSource,
  CameraInfo,
  WindowInfo,
  PowerState,
  ProfileMapEntry,
  ShrinkProgress,
  ShrinkResult,
  ExportSegment,
  CropRect,
  SnipCapture,
  SnipDone,
  BarState,
  DrawCommand,
  MediaInfo,
  RenderProject,
  ScreenShot,
  DiskInfo,
  RecordingStatus,
  SplitResult,
  TrimResult,
} from "./types";

type TauriGlobal = {
  core: {
    invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
    convertFileSrc?: (filePath: string, protocol?: string) => string;
  };
  event: {
    listen: <T>(
      event: string,
      handler: (e: { payload: T }) => void,
    ) => Promise<() => void>;
    emitTo: (target: string, event: string, payload?: unknown) => Promise<void>;
    emit?: (event: string, payload?: unknown) => Promise<void>;
  };
  window?: {
    getCurrentWindow: () => {
      minimize: () => Promise<void>;
      toggleMaximize: () => Promise<void>;
      hide: () => Promise<void>;
      show: () => Promise<void>;
      setFocus: () => Promise<void>;
      startDragging: () => Promise<void>;
      label: string;
    };
  };
};

declare global {
  interface Window {
    __TAURI__?: TauriGlobal;
    __TAURI_INTERNALS__?: unknown;
  }
}

export const isTauri = (): boolean =>
  typeof window !== "undefined" &&
  (typeof window.__TAURI__ !== "undefined" ||
    typeof window.__TAURI_INTERNALS__ !== "undefined");

/** Label of the window this page runs in ("main", "snip"), or null in a browser. */
export function currentWindowLabel(): string | null {
  try {
    return window.__TAURI__?.window?.getCurrentWindow().label ?? null;
  } catch {
    return null;
  }
}

/** Shows and focuses the window this page runs in (no-op in a browser). */
export async function showCurrentWindow(): Promise<void> {
  const w = window.__TAURI__?.window?.getCurrentWindow();
  if (!w) return;
  // Shown and brought to the front by the app, never with an injected key
  // press (tao's setFocus fallback sends a fake Alt).
  await window.__TAURI__!.core.invoke("shell_focus_self").catch(async () => {
    await w.show();
  });
}

function tauri(): TauriGlobal {
  const t = window.__TAURI__;
  if (!t) throw new Error("Tauri API unavailable");
  return t;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return tauri().core.invoke<T>(cmd, args);
}

/**
 * Converts an absolute Windows path into something the webview may load.
 * Under Tauri this is the `asset:` custom protocol (scoped to the Lastshot
 * output folder in `tauri.conf.json`); in the browser there is no such thing,
 * so callers fall back to the simulated blob URL.
 */
export function assetUrl(path: string): string {
  if (!path) return "";
  if (isTauri()) {
    const convert = window.__TAURI__?.core.convertFileSrc;
    if (convert) return convert(path);
    return `http://asset.localhost/${encodeURIComponent(path)}`;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Browser-side event fan-out (mirrors the Rust `app.emit` channels)
// ---------------------------------------------------------------------------

type Handler<T> = (payload: T) => void;
const localBus = new Map<string, Set<Handler<unknown>>>();

function emitLocal<T>(channel: string, payload: T) {
  localBus.get(channel)?.forEach((h) => h(payload as unknown));
}

function onLocal<T>(channel: string, handler: Handler<T>): () => void {
  const set = localBus.get(channel) ?? new Set();
  set.add(handler as Handler<unknown>);
  localBus.set(channel, set);
  return () => set.delete(handler as Handler<unknown>);
}

async function listen<T>(channel: string, handler: Handler<T>): Promise<() => void> {
  if (isTauri()) {
    const unlisten = await tauri().event.listen<T>(channel, (e) => handler(e.payload));
    return unlisten;
  }
  return onLocal(channel, handler);
}

export const CHANNELS = {
  draw: "lastshot://draw",
  renderProgress: "lastshot://render-progress",
  clipSaved: "lastshot://clip-saved",
  stats: "lastshot://stats",
  error: "lastshot://error",
  hotkey: "lastshot://hotkey",
  bufferState: "lastshot://buffer-state",
  shrinkProgress: "lastshot://shrink-progress",
  snipDone: "lastshot://snip-done",
  recording: "lastshot://recording",
  openFile: "lastshot://open-file",
  libraryChanged: "lastshot://library-changed",
  dragDrop: "tauri://drag-drop",
} as const;

export const RELEASES_URL = "https://github.com/5arpy/Lastshot/releases";
const LATEST_RELEASE_API = "https://api.github.com/repos/5arpy/Lastshot/releases/latest";

/** Compares dotted versions ("1.10.0" > "1.9.2"). */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/i, "").split(/[.-]/).map((p) => parseInt(p, 10) || 0);
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Default settings used before the backend answers (and in the browser)
// ---------------------------------------------------------------------------

export const DEFAULT_SETTINGS: AppSettings = {
  bufferSeconds: 60,
  targetFps: 60,
  bitrateKbps: 12_000,
  codec: "h264",
  monitorIndex: 0,
  captureSystemAudio: true,
  captureMicrophone: false,
  outputDir: "C:\\Users\\You\\Videos\\Lastshot",
  hotkeySave: "Alt+C",
  hotkeyToggle: "Alt+Shift+C",
  openTrimmerAfterSave: true,
  minimizeToTray: true,
  autostartBuffer: true,
  playSaveSound: true,
  alwaysOnTop: false,
  profiles: [
    {
      id: "default",
      name: "Default",
      bufferSeconds: 60,
      targetFps: 60,
      bitrateKbps: 12_000,
      codec: "h264",
    },
    {
      id: "competitivo",
      name: "Competitivo",
      bufferSeconds: 30,
      targetFps: 60,
      bitrateKbps: 12_000,
      codec: "h264",
    },
    {
      id: "cine",
      name: "Cine",
      bufferSeconds: 120,
      targetFps: 60,
      bitrateKbps: 25_000,
      codec: "hevc",
    },
  ],
  profileMap: [],
  autoSwitchProfiles: false,
  launchAtStartup: false,
  autoCleanupDays: 0,
  organizeByGame: true,
  autosaveOnGameExit: false,
  performanceMode: true,
  privacyPauseWhenUnfocused: false,
  gameVolume: 100,
  micVolume: 100,
  micDeviceId: null,
  cleanVoice: false,
  adaptiveEco: false,
  ecoBatteryThresholdPct: 30,
  ecoRamFreeGbs: 4,
  checkUpdatesOnStartup: false,
  shareSizeMb: 10,
  hotkeySnip: "Alt+S",
  snipSaveToFolder: true,
  snipScope: "all",
  libraryFolders: [],
  hotkeyRecord: "Alt+R",
  controlBar: "recording",
  studioLayers: "recording",
  captureSource: { kind: "display" },
  appAudio: { kind: "all" },
  captureCursor: true,
  explorerOpenWith: false,
  screenshotDir: "",
  screenshotFormat: "png",
  screenshotQuality: 90,
  screenshotCopy: true,
  recordingDir: "",
  streamerMode: false,
  shortcuts: {},
  uiScale: 1,
};

// Browser preview stand-in for screen recording.
const simRec = { startedAt: 0, pausedAt: 0, pausedMs: 0, on: false, muted: false };
function simBarState(): BarState {
  const now = Date.now();
  const ms = simRec.on
    ? (simRec.pausedAt || now) - simRec.startedAt - simRec.pausedMs
    : 0;
  return {
    recording: simRec.on
      ? {
          path: "C:\\Users\\You\\Videos\\Lastshot\\Lastshot_Recording.mp4",
          file_name: "Lastshot_Recording.mp4",
          seconds: ms / 1000,
          paused: simRec.pausedAt > 0,
          active: true,
        }
      : null,
    micMuted: simRec.muted,
    micOn: browserSettings.captureMicrophone,
    replayOn: simEngine.isRunning(),
    hotkeyRecord: browserSettings.hotkeyRecord,
    hotkeySave: browserSettings.hotkeySave,
    hotkeySnip: browserSettings.hotkeySnip,
  };
}

let browserSettings: AppSettings = { ...DEFAULT_SETTINGS };

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export const lastshot = {
  isTauri,

  async startBuffer(bufferSeconds: number, targetFps: number): Promise<EngineStats> {
    if (isTauri()) {
      return invoke<EngineStats>("start_replay_buffer", { bufferSeconds, targetFps });
    }
    const stats = await simEngine.start(bufferSeconds, targetFps);
    emitLocal(CHANNELS.bufferState, stats);
    return stats;
  },

  async stopBuffer(): Promise<EngineStats> {
    if (isTauri()) return invoke<EngineStats>("stop_replay_buffer");
    const stats = simEngine.stop();
    emitLocal(CHANNELS.bufferState, stats);
    return stats;
  },

  async getStats(): Promise<EngineStats> {
    if (isTauri()) return invoke<EngineStats>("get_engine_stats");
    return simEngine.stats();
  },

  async setBufferSeconds(seconds: number): Promise<void> {
    if (isTauri()) {
      await invoke("set_buffer_seconds", { seconds });
      return;
    }
    simEngine.setBufferSeconds(seconds);
    browserSettings = { ...browserSettings, bufferSeconds: seconds };
  },

  /**
   * The Alt+C flush. Returns the freshly written clip. `gameOverride` tags the
   * clip to a specific game (used by auto-save-on-game-exit, when the game is
   * no longer focused at flush time).
   */
  async saveInstantReplay(
    maxSeconds?: number,
    triggeredBy: string = "ui",
    gameOverride?: string,
  ): Promise<ClipMetadata> {
    if (isTauri()) {
      return invoke<ClipMetadata>("save_instant_replay", {
        maxSeconds,
        triggeredBy,
        gameOverride,
      });
    }
    const { clip, flushMs } = await simEngine.save(maxSeconds, gameOverride);
    emitLocal<ClipSavedPayload>(CHANNELS.clipSaved, { clip, flushMs, triggeredBy });
    return clip;
  },

  async getClips(withThumbnails = true): Promise<ClipMetadata[]> {
    if (isTauri()) return invoke<ClipMetadata[]>("get_recorded_clips", { withThumbnails });
    return simEngine.list();
  },

  /**
   * Decodes one clip's thumbnail on demand (hardware decode in Rust). The
   * gallery calls this lazily per visible card instead of baking every
   * thumbnail into the initial scan — thousands of clips stay instant.
   */
  async getClipThumbnail(path: string, atSeconds = 1): Promise<string | null> {
    if (isTauri()) {
      return invoke<string>("get_clip_thumbnail", { path, atSeconds }).catch(() => null);
    }
    // Browser sim: thumbnails are already inlined by simEngine.save().
    return simEngine.find(path)?.thumbnail ?? null;
  },

  /** Splits a clip in two at `atSeconds` (two stream-copy trims, one task). */
  async splitClip(sourcePath: string, atSeconds: number): Promise<SplitResult> {
    if (isTauri()) {
      return invoke<SplitResult>("split_clip", { sourcePath, atSeconds });
    }
    // Browser sim: two in-memory trims, mirroring the native result shape.
    const a = simEngine.trim(sourcePath, 0, atSeconds);
    const b = simEngine.trim(sourcePath, atSeconds, simEngine.find(sourcePath)?.duration_seconds ?? atSeconds + 1);
    return {
      partA: {
        path: a.path,
        file_name: a.file_name,
        duration_seconds: a.duration_seconds,
        size_bytes: a.size_bytes,
        elapsed_ms: 0,
        snapped_start_seconds: 0,
      },
      partB: {
        path: b.path,
        file_name: b.file_name,
        duration_seconds: b.duration_seconds,
        size_bytes: b.size_bytes,
        elapsed_ms: 0,
        snapped_start_seconds: atSeconds,
      },
    };
  },

  async trimClip(
    sourcePath: string,
    startTime: number,
    endTime: number,
    overwrite = false,
  ): Promise<TrimResult> {
    if (isTauri()) {
      return invoke<TrimResult>("trim_clip", {
        sourcePath,
        startTime,
        endTime,
        overwrite,
      });
    }
    const t0 = performance.now();
    const clip = simEngine.trim(sourcePath, startTime, endTime);
    return {
      path: clip.path,
      file_name: clip.file_name,
      duration_seconds: clip.duration_seconds,
      size_bytes: clip.size_bytes,
      elapsed_ms: performance.now() - t0,
      snapped_start_seconds: startTime,
    };
  },

  async deleteClip(path: string): Promise<void> {
    if (isTauri()) {
      await invoke("delete_clip", { path });
      return;
    }
    simEngine.delete(path);
  },

  /** Deletes many clips at once; resolves to how many were removed. */
  async deleteClips(paths: string[]): Promise<number> {
    if (isTauri()) return invoke<number>("delete_clips", { paths });
    let n = 0;
    for (const p of paths) {
      simEngine.delete(p);
      n += 1;
    }
    return n;
  },

  /** Puts several clips on the clipboard as one multi-file drop (batch). */
  async copyClips(paths: string[]): Promise<void> {
    if (isTauri()) {
      await invoke("copy_clips_to_clipboard", { paths });
      return;
    }
    await navigator.clipboard?.writeText(paths.join("\n"));
  },

  /** Stars / unstars many clips; resolves to how many changed. */
  async setClipsFavorite(paths: string[], favorite: boolean): Promise<number> {
    if (isTauri()) return invoke<number>("set_clips_favorite", { paths, favorite });
    let n = 0;
    for (const p of paths) {
      simEngine.setFavorite(p, favorite);
      n += 1;
    }
    return n;
  },

  /** Adds one tag to many clips; resolves to how many gained it. */
  async addClipsTag(paths: string[], tag: string): Promise<number> {
    if (isTauri()) return invoke<number>("add_clips_tag", { paths, tag });
    let n = 0;
    for (const p of paths) {
      const clip = simEngine.find(p);
      if (!clip || clip.tags.includes(tag)) continue;
      simEngine.setTags(p, [...clip.tags, tag]);
      n += 1;
    }
    return n;
  },

  /** Removes one tag from many clips; resolves to how many lost it. */
  async removeClipsTag(paths: string[], tag: string): Promise<number> {
    if (isTauri()) return invoke<number>("remove_clips_tag", { paths, tag });
    let n = 0;
    for (const p of paths) {
      const clip = simEngine.find(p);
      if (!clip || !clip.tags.includes(tag)) continue;
      simEngine.setTags(p, clip.tags.filter((t) => t !== tag));
      n += 1;
    }
    return n;
  },

  /** Removes every clip; resolves to the number deleted. */
  async deleteAllClips(): Promise<number> {
    if (isTauri()) return invoke<number>("delete_all_clips");
    return simEngine.clearAll();
  },

  // ------------------------------------------------- library (file manager)
  /** All folders under the save folder and the extra folders (also empty ones). */
  async libraryDirs(): Promise<string[]> {
    if (isTauri()) return invoke<string[]>("library_dirs");
    return [];
  },
  async createClipFolder(parent: string, name: string): Promise<string> {
    if (isTauri()) return invoke<string>("create_clip_folder", { parent, name });
    return `${parent}\\${name}`;
  },
  /** Moves clips or folders into a folder; resolves to the new paths. */
  async moveClips(paths: string[], dest: string): Promise<string[]> {
    if (isTauri()) return invoke<string[]>("move_clips", { paths, dest });
    return paths;
  },
  async copyClipsTo(paths: string[], dest: string): Promise<string[]> {
    if (isTauri()) return invoke<string[]>("copy_clips_to", { paths, dest });
    return paths;
  },
  /** Renames a clip or folder (never replaces another file). */
  async renameLibraryItem(path: string, newName: string): Promise<string> {
    if (isTauri()) return invoke<string>("rename_library_item", { path, newName });
    return simEngine.rename(path, newName);
  },
  /** Clips or folders to the Recycle Bin. */
  async recycleItems(paths: string[]): Promise<number> {
    if (isTauri()) return invoke<number>("recycle_items", { paths });
    for (const p of paths) simEngine.delete(p);
    return paths.length;
  },
  /** Files or folders changed under the save folder (debounced). */
  /** Whether each global shortcut is ours (test copies register none). */
  async getHotkeyStatus(): Promise<HotkeyStatus> {
    if (isTauri()) return invoke<HotkeyStatus>("get_hotkey_status");
    return { skipped: false, keys: [] };
  },
  async retryHotkeys(): Promise<HotkeyStatus> {
    if (isTauri()) return invoke<HotkeyStatus>("retry_hotkeys");
    return { skipped: false, keys: [] };
  },
  onHotkeyStatus(handler: (s: HotkeyStatus) => void): Promise<() => void> {
    return listen<HotkeyStatus>("lastshot://hotkeys-status", handler);
  },
  onLibraryChanged(handler: () => void): Promise<() => void> {
    return listen<null>(CHANNELS.libraryChanged, () => handler());
  },

  /** Renames a clip file on disk; resolves to the new path. */
  async renameClip(path: string, newName: string): Promise<string> {
    if (isTauri()) return invoke<string>("rename_clip", { path, newName });
    return simEngine.rename(path, newName);
  },

  /**
   * Grabs a frame of a clip as a PNG data URL. Native: hardware decode in
   * Rust (maxWidth 0 = native resolution). Browser: canvas from the preview.
   */
  async extractFramePng(
    path: string,
    atSeconds: number,
    maxWidth = 0,
  ): Promise<string> {
    if (isTauri()) {
      return invoke<string>("extract_png_frame", {
        path,
        atSeconds,
        maxWidth,
      });
    }
    const clip = simEngine.find(path);
    const src = clip?.preview_url;
    if (!src) throw new Error("no preview stream available for this clip");
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = src;
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error("could not load clip preview"));
      video.load();
    });
    video.currentTime = Math.min(Math.max(atSeconds, 0), video.duration || 0);
    await new Promise<void>((resolve) => {
      video.onseeked = () => resolve();
      window.setTimeout(resolve, 800);
    });
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas unavailable");
    ctx.drawImage(video, 0, 0);
    return canvas.toDataURL("image/png");
  },

  /** Persists a PNG data URL into the output folder (native) or downloads it. */
  async snapshotToOutput(pngBase64: string, baseName: string): Promise<string> {
    if (isTauri()) {
      return invoke<string>("save_png_snapshot", { pngBase64, baseName });
    }
    const a = document.createElement("a");
    a.href = pngBase64;
    a.download = `${baseName.replace(/\.png$/i, "") || "snapshot"}.png`;
    a.click();
    return `downloaded ${a.download}`;
  },

  /** Manual check for updates — opens the GitHub Releases page, nothing else. */
  async openReleasesPage(): Promise<void> {
    if (isTauri()) {
      await invoke("open_releases_page");
      return;
    }
    window.open(RELEASES_URL, "_blank");
  },

  /**
   * Asks GitHub for the newest Lastshot release. Returns its version when it
   * is newer than `current`, otherwise null. One HTTPS request, only when
   * called; nothing is installed automatically.
   */
  async checkLatestRelease(current: string): Promise<string | null> {
    const res = await fetch(LATEST_RELEASE_API, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (res.status === 404) return null; // no release published yet
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const body = (await res.json()) as { tag_name?: string };
    const tag = body.tag_name ?? "";
    return tag && isNewerVersion(tag, current) ? tag.replace(/^v/i, "") : null;
  },

  // ------------------------------------------------------------- sharing
  /**
   * Re-encodes a clip (or part of it) under the size limit from Settings.
   * `copy` puts it on the clipboard; `keep` saves it next to the original.
   */
  async shrinkClip(
    path: string,
    opts: { start?: number; end?: number; copy: boolean; keep: boolean },
  ): Promise<ShrinkResult> {
    if (isTauri()) {
      return invoke<ShrinkResult>("shrink_clip", {
        path,
        start: opts.start ?? null,
        end: opts.end ?? null,
        copy: opts.copy,
        keep: opts.keep,
      });
    }
    // Browser preview: pretend, with progress, so the UI flow is testable.
    for (let i = 1; i <= 10; i++) {
      await new Promise((r) => setTimeout(r, 120));
      emitLocal(CHANNELS.shrinkProgress, { path, progress: i / 10 });
    }
    const mb = browserSettings.shareSizeMb;
    return {
      path: path.replace(/\.mp4$/i, `_${Math.round(mb)}MB.mp4`),
      file_name: `clip_${Math.round(mb)}MB.mp4`,
      size_bytes: Math.round(mb * 0.9 * 1_000_000),
      duration_seconds: 30,
      width: 1280,
      height: 720,
      fps: 30,
      video_kbps: 2400,
      elapsed_ms: 1200,
      attempts: 1,
    };
  },

  /**
   * The clip editor's export: joins `segments` in order, optionally crops,
   * and re-encodes. `save` keeps full quality as a new clip; `share` fits the
   * size limit from Settings (and `copy` puts it on the clipboard).
   * Progress arrives on onShrinkProgress under `progressKey`.
   */
  async exportClip(opts: {
    segments: ExportSegment[];
    crop: CropRect | null;
    mode: "save" | "share";
    copy: boolean;
    progressKey: string;
  }): Promise<ShrinkResult> {
    if (isTauri()) {
      return invoke<ShrinkResult>("export_clip", {
        segments: opts.segments,
        crop: opts.crop,
        mode: opts.mode,
        copy: opts.copy,
        progressKey: opts.progressKey,
      });
    }
    for (let i = 1; i <= 10; i++) {
      await new Promise((r) => setTimeout(r, 150));
      emitLocal(CHANNELS.shrinkProgress, { path: opts.progressKey, progress: i / 10 });
    }
    const first = opts.segments[0]?.path ?? "clip.mp4";
    const secs = opts.segments.reduce((t, s) => t + ((s.end ?? s.start + 30) - s.start), 0);
    const name = opts.mode === "save" ? first.replace(/\.mp4$/i, "_edit.mp4") : first.replace(/\.mp4$/i, "_share.mp4");
    return {
      path: name,
      file_name: name.split(/[\\/]/).pop() ?? name,
      size_bytes: Math.round(secs * 1_000_000),
      duration_seconds: secs,
      width: opts.crop ? 608 : 1920,
      height: 1080,
      fps: 60,
      video_kbps: 11000,
      elapsed_ms: 1500,
      attempts: 1,
    };
  },

  // ---------------------------------------------------- screen recording
  /** Windows that can be recorded on their own, front-most first. */
  async listWindows(): Promise<WindowInfo[]> {
    if (isTauri()) return invoke<WindowInfo[]>("list_windows");
    return [
      { hwnd: 1, title: "Roblox", exe: "RobloxPlayerBeta.exe", pid: 1, width: 1920, height: 1080 },
      { hwnd: 2, title: "Discord", exe: "Discord.exe", pid: 2, width: 1280, height: 800 },
    ];
  },
  /** Records the full screen or one window / app (it also becomes what instant replay captures). */
  async startRecordingSource(source: CaptureSource): Promise<RecordingStatus> {
    if (isTauri()) return invoke<RecordingStatus>("start_recording_source", { source });
    browserSettings.captureSource = source;
    return this.startRecording();
  },
  /** Changes what Lastshot captures (instant replay and recordings). */
  async setCaptureSource(source: CaptureSource): Promise<void> {
    if (isTauri()) await invoke("set_capture_source", { source });
    else browserSettings.captureSource = source;
  },
  async startRecording(): Promise<RecordingStatus> {
    if (isTauri()) return invoke<RecordingStatus>("start_recording");
    if (!simEngine.isRunning()) await simEngine.start(browserSettings.bufferSeconds, browserSettings.targetFps);
    Object.assign(simRec, { on: true, startedAt: Date.now(), pausedAt: 0, pausedMs: 0 });
    emitLocal(CHANNELS.recording, simBarState());
    return simBarState().recording!;
  },
  async stopRecording(): Promise<ClipMetadata> {
    if (isTauri()) return invoke<ClipMetadata>("stop_recording");
    const secs = simBarState().recording?.seconds ?? 5;
    simRec.on = false;
    const { clip } = await simEngine.save(Math.max(2, secs));
    emitLocal(CHANNELS.recording, simBarState());
    return clip;
  },
  async pauseRecording(paused: boolean): Promise<void> {
    if (isTauri()) return invoke("pause_recording", { paused });
    if (paused && !simRec.pausedAt) simRec.pausedAt = Date.now();
    if (!paused && simRec.pausedAt) {
      simRec.pausedMs += Date.now() - simRec.pausedAt;
      simRec.pausedAt = 0;
    }
    emitLocal(CHANNELS.recording, simBarState());
  },
  /** Stops the running recording and deletes it. */
  async discardRecording(): Promise<void> {
    if (isTauri()) return invoke("discard_recording");
    simRec.on = false;
    emitLocal(CHANNELS.recording, simBarState());
  },
  /** Marks this moment of the recording; returns how many marks there are. */
  async addMarker(): Promise<number> {
    if (isTauri()) return invoke<number>("add_marker");
    return 1;
  },
  /** Hides the control bar until the next recording. */
  async hideBar(): Promise<void> {
    if (isTauri()) await invoke("hide_bar");
  },
  /** Opens the control bar again (also when the setting is off). */
  async showBar(): Promise<void> {
    if (isTauri()) await invoke("show_bar");
  },
  /** Small pill (timer + expand) or the full bar. */
  async setBarCompact(compact: boolean): Promise<void> {
    if (isTauri()) await invoke("set_bar_compact", { compact });
  },
  /** Drawing on the recorded screen (the drawings are in the recording). */
  async setDrawing(on: boolean): Promise<void> {
    if (isTauri()) await invoke("set_drawing", { on });
  },
  /** Drawings stay but the mouse goes through to the apps below. */
  async setDrawingPassthrough(on: boolean): Promise<void> {
    if (isTauri()) await invoke("set_drawing_passthrough", { on });
  },
  // --------------------------------------------------------------- studio
  async screenSnapshot(): Promise<ScreenShot> {
    if (isTauri()) return invoke<ScreenShot>("screen_snapshot");
    return { image: "", width: 1920, height: 1080, name: "Screen" };
  },
  async syncLayers(): Promise<void> {
    if (isTauri()) await invoke("sync_layers");
  },
  /** Studio layers drawn by the engine into the video. */
  async setStudioLayers(layers: unknown[]): Promise<void> {
    if (isTauri()) await invoke("set_studio_layers", { layers });
  },
  /** Layers the engine has (null when Studio never saved any). */
  async getStudioLayers<T>(): Promise<T[] | null> {
    if (isTauri()) return invoke<T[] | null>("get_studio_layers");
    return null;
  },
  /** Loudest PC sound / mic level since the last call, in dBFS (-100 = silence). */
  async getAudioLevels(): Promise<{ gameDb: number; micDb: number }> {
    if (isTauri()) return invoke<{ gameDb: number; micDb: number }>("get_audio_levels");
    return { gameDb: -100, micDb: -100 };
  },
  async getScenes<T>(): Promise<T> {
    if (isTauri()) return invoke<T>("get_scenes");
    return { active: null, scenes: [] } as T;
  },
  async saveScenes<T>(scenes: T): Promise<T> {
    if (isTauri()) return invoke<T>("save_scenes", { scenes });
    return scenes;
  },
  /** Switches scene; resolves to a note when the source could not change. */
  async switchScene(id: string): Promise<string | null> {
    if (isTauri()) return invoke<string | null>("switch_scene", { id });
    return null;
  },
  async listCameras(): Promise<CameraInfo[]> {
    if (isTauri()) return invoke<CameraInfo[]>("list_cameras");
    return [];
  },
  /** Newest live preview frame (RGBA) from the engine, or null. */
  async getPreviewFrame(): Promise<{ width: number; height: number; seq: number; rgba: Uint8ClampedArray<ArrayBuffer> } | null> {
    if (!isTauri()) return null;
    const buf = await invoke<ArrayBuffer | number[]>("get_preview_frame");
    const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf);
    if (bytes.length < 12) return null;
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = v.getUint32(0, true);
    const height = v.getUint32(4, true);
    const seq = v.getUint32(8, true);
    if (bytes.length < 12 + width * height * 4) return null;
    return { width, height, seq, rgba: new Uint8ClampedArray(bytes.slice(12, 12 + width * height * 4).buffer) };
  },

  // --------------------------------------------------------------- editor
  /** What a file is (video/audio, length, size); also lets the window play it. */
  async mediaInfo(path: string): Promise<MediaInfo> {
    if (isTauri()) return invoke<MediaInfo>("media_info", { path });
    throw new Error("Adding files works in the installed app.");
  },
  /** Lets the window show pictures picked from anywhere. */
  async allowMedia(paths: string[]): Promise<void> {
    if (isTauri()) await invoke("allow_media", { paths });
  },
  /** Renders the timeline into a new clip (lands in Clips). */
  async renderProject(project: RenderProject): Promise<ClipMetadata> {
    if (isTauri()) return invoke<ClipMetadata>("render_project", { project });
    throw new Error("Rendering works in the installed app.");
  },
  onRenderProgress(handler: Handler<number>) {
    return listen<number>(CHANNELS.renderProgress, handler);
  },

  /** Control bar → drawing layer. */
  async sendDraw(cmd: DrawCommand): Promise<void> {
    if (isTauri()) await tauri().event.emitTo("annot", CHANNELS.draw, cmd);
  },
  onDraw(handler: Handler<DrawCommand>) {
    return listen<DrawCommand>(CHANNELS.draw, handler);
  },
  async getBarState(): Promise<BarState> {
    if (isTauri()) return invoke<BarState>("get_bar_state");
    return simBarState();
  },
  async setMicMuted(muted: boolean): Promise<void> {
    if (isTauri()) return invoke("set_mic_muted", { muted });
    simRec.muted = muted;
    emitLocal(CHANNELS.recording, simBarState());
  },
  async showMainWindow(): Promise<void> {
    if (isTauri()) await invoke("show_main_window");
  },
  onRecording(handler: Handler<BarState>) {
    return listen<BarState>(CHANNELS.recording, handler);
  },

  // ---------------------------------------------------------- files/disk
  async getDiskInfo(paths: string[]): Promise<DiskInfo[]> {
    if (isTauri()) return invoke<DiskInfo[]>("get_disk_info", { paths });
    return [{ root: "C:\\", totalBytes: 512e9, freeBytes: 143e9 }];
  },
  /** Moves a clip from an extra folder into the save folder; returns the new path. */
  async moveClipToLibrary(path: string): Promise<string> {
    if (isTauri()) return invoke<string>("move_clip_to_library", { path });
    return path;
  },
  /** Clip info for any video file (drag & drop, Open with Lastshot). */
  async openVideoFile(path: string): Promise<ClipMetadata> {
    if (isTauri()) return invoke<ClipMetadata>("open_video_file", { path });
    throw new Error("Opening files works in the installed app.");
  },
  async takePendingOpen(): Promise<string | null> {
    if (isTauri()) return invoke<string | null>("take_pending_open");
    return null;
  },
  onOpenFile(handler: Handler<string>) {
    return listen<string>(CHANNELS.openFile, handler);
  },
  /** Files dropped onto the window from Explorer. */
  onFilesDropped(handler: Handler<string[]>) {
    return listen<{ paths: string[] }>(CHANNELS.dragDrop, (p) => handler(p?.paths ?? []));
  },

  /** Native file drag (call from `dragstart`, after `preventDefault`). */
  async startClipDrag(path: string): Promise<void> {
    if (isTauri()) await invoke("start_clip_drag", { paths: [path] });
  },

  onShrinkProgress(handler: Handler<ShrinkProgress>) {
    return listen<ShrinkProgress>(CHANNELS.shrinkProgress, handler);
  },

  // ------------------------------------------------------------ snipping
  /** `mode` "rec" opens the snip bar on Record (pick an area to record). */
  async startSnip(mode: "shot" | "rec" = "shot"): Promise<void> {
    if (isTauri()) {
      await invoke("start_snip", { mode });
      return;
    }
    emitLocal(
      CHANNELS.error,
      "The snipping tool works in the installed app, not in the browser preview.",
    );
  },
  async snipGetCapture(): Promise<SnipCapture> {
    return invoke<SnipCapture>("snip_get_capture");
  },
  /** `jpg` (optional) is what gets saved when the format is JPG; `png` goes on the clipboard. */
  async snipFinish(png: string, copy: boolean, save: boolean, jpg?: string): Promise<SnipDone> {
    return invoke<SnipDone>("snip_finish", { png, copy, save, jpg: jpg ?? null });
  },
  /** Records the picked area (snip picture pixels). */
  async snipRecord(region: { x: number; y: number; w: number; h: number }): Promise<RecordingStatus> {
    return invoke<RecordingStatus>("snip_record", { region });
  },
  async snipCancel(): Promise<void> {
    if (isTauri()) await invoke("snip_cancel");
  },
  async openScreenshotsFolder(): Promise<void> {
    if (isTauri()) await invoke("open_screenshots_folder");
  },
  onSnipDone(handler: Handler<SnipDone>) {
    return listen<SnipDone>(CHANNELS.snipDone, handler);
  },

  async copyClip(path: string): Promise<void> {
    if (isTauri()) {
      await invoke("copy_clip_to_clipboard", { path });
      return;
    }
    // Browsers cannot put a file on the OS clipboard; copy the path instead so
    // the interaction still completes end to end.
    await navigator.clipboard?.writeText(path);
  },

  async revealClip(path: string): Promise<void> {
    if (isTauri()) {
      await invoke("reveal_clip_in_folder", { path });
      return;
    }
    await navigator.clipboard?.writeText(path);
  },

  async openOutputFolder(): Promise<void> {
    if (isTauri()) {
      await invoke("open_output_folder");
      return;
    }
    await navigator.clipboard?.writeText(browserSettings.outputDir);
  },

  /** Opens a folder in Explorer. */
  async openFolder(path: string): Promise<void> {
    if (isTauri()) {
      await invoke("open_clip_external", { path });
      return;
    }
    await navigator.clipboard?.writeText(path);
  },

  async openClip(path: string): Promise<void> {
    if (isTauri()) {
      await invoke("open_clip_external", { path });
    }
  },

  async getSettings(): Promise<AppSettings> {
    if (isTauri()) return invoke<AppSettings>("get_settings");
    return browserSettings;
  },

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    if (isTauri()) return invoke<AppSettings>("update_settings", { patch });
    browserSettings = { ...browserSettings, ...patch };
    if (patch.bufferSeconds) simEngine.setBufferSeconds(patch.bufferSeconds);
    return browserSettings;
  },

  // ------------------------------------------------------ capture profiles
  /**
   * The game currently in the foreground. Native: Windows focus query. Browser:
   * a deterministic cycle (cs2 → desktop → dota2 → desktop) so the auto-switch
   * flow can be demoed without a real game.
   */
  async getForegroundGame(): Promise<ForegroundGame | null> {
    if (isTauri()) return invoke<ForegroundGame | null>("get_foreground_game");
    return simEngine.foregroundGame();
  },

  async getProfiles(): Promise<CaptureProfile[]> {
    if (isTauri()) return invoke<CaptureProfile[]>("get_profiles");
    return browserSettings.profiles;
  },

  /** Creates or updates a profile; resolves to the fresh full settings. */
  async saveProfile(profile: CaptureProfile): Promise<AppSettings> {
    if (isTauri()) return invoke<AppSettings>("save_profile", { profile });
    simEngine.saveProfile(profile);
    browserSettings = { ...browserSettings, profiles: simEngine.getProfiles() };
    return browserSettings;
  },

  async deleteProfile(profileId: string): Promise<AppSettings> {
    if (isTauri()) return invoke<AppSettings>("delete_profile", { profileId });
    simEngine.deleteProfile(profileId);
    browserSettings = { ...browserSettings, profiles: simEngine.getProfiles() };
    return browserSettings;
  },

  async setProfileMap(map: ProfileMapEntry[]): Promise<AppSettings> {
    if (isTauri()) return invoke<AppSettings>("set_profile_map", { map });
    simEngine.setProfileMap(map);
    browserSettings = { ...browserSettings, profileMap: simEngine.getProfileMap() };
    return browserSettings;
  },

  /**
   * Applies a profile now: the buffer window changes live; fps/bitrate/codec
   * persist and apply on the next engine start (same contract as APPLY &
   * RESTART ENGINE).
   */
  async applyProfile(profileId: string): Promise<AppSettings> {
    if (isTauri()) return invoke<AppSettings>("apply_profile", { profileId });
    simEngine.applyProfile(profileId);
    const profile = simEngine.getProfiles().find((p) => p.id === profileId);
    browserSettings = {
      ...browserSettings,
      bufferSeconds: simEngine.bufferSeconds,
      targetFps: simEngine.targetFps,
      bitrateKbps: simEngine.bitrateKbps,
      codec: profile?.codec ?? browserSettings.codec,
    };
    return browserSettings;
  },

  /** Removes clips older than `days`; resolves to the number deleted. */
  async cleanupOldClips(days: number): Promise<number> {
    if (isTauri()) return invoke<number>("cleanup_old_clips", { days });
    return simEngine.cleanupOldClips(days);
  },

  /**
   * Privacy mode: tells the engine whether a game currently owns the focus.
   * While gated, the ring is cleared and capture stops — the deck surface for
   * "only record gameplay".
   */
  async setPrivacyGate(gate: boolean): Promise<void> {
    if (isTauri()) {
      await invoke("set_privacy_gate", { gate });
      return;
    }
    simEngine.setPrivacyGate(gate);
  },

  /** Stars / unstars a clip; persists in the local sidecar store. */
  async setClipFavorite(path: string, favorite: boolean): Promise<void> {
    if (isTauri()) {
      await invoke("set_clip_favorite", { path, favorite });
      return;
    }
    simEngine.setFavorite(path, favorite);
  },

  /**
   * Battery + RAM snapshot for the adaptive ECO mode. Native: two cheap local
   * reads. Browser: a steady AC / healthy-RAM snapshot (ECO stays inert).
   */
  async getPowerState(): Promise<PowerState> {
    if (isTauri()) return invoke<PowerState>("get_power_state");
    return {
      onBattery: false,
      batteryPercent: 100,
      availableRamBytes: 8 * 1024 * 1024 * 1024,
      totalRamBytes: 16 * 1024 * 1024 * 1024,
    };
  },

  /** Replaces the custom tags of a clip; persists in the local sidecar store. */
  async setClipTags(path: string, tags: string[]): Promise<void> {
    if (isTauri()) {
      await invoke("set_clip_tags", { path, tags });
      return;
    }
    simEngine.setTags(path, tags);
  },

  /**
   * Posts a native Windows toast (best-effort). Browser preview no-ops.
   */
  async notify(title: string, body?: string): Promise<void> {
    if (!isTauri()) return;
    try {
      const mod = await import("@tauri-apps/plugin-notification");
      let granted = await mod.isPermissionGranted();
      if (!granted) {
        granted = (await mod.requestPermission()) === "granted";
      }
      if (granted) {
        mod.sendNotification({ title, body });
      }
    } catch {
      /* notification unavailable — the in-app toast already covers it */
    }
  },

  async getMonitors(): Promise<MonitorInfo[]> {
    if (isTauri()) return invoke<MonitorInfo[]>("get_monitors");
    return [
      {
        index: 0,
        name: "\\\\.\\DISPLAY1",
        width: 2560,
        height: 1440,
        refresh_hz: 165,
        primary: true,
        adapter: "Simulated RTX Adapter",
      },
      {
        index: 1,
        name: "\\\\.\\DISPLAY2",
        width: 1920,
        height: 1080,
        refresh_hz: 60,
        primary: false,
        adapter: "Simulated RTX Adapter",
      },
    ];
  },

  async getAudioInputDevices(): Promise<AudioDevice[]> {
    if (isTauri()) return invoke<AudioDevice[]>("get_audio_input_devices");
    return [
      { id: "default", name: "Default (System Default)", isDefault: true },
      { id: "mock_wo_mic", name: "Microphone (WO Mic Device)", isDefault: false },
      { id: "mock_realtek", name: "Microphone (Realtek(R) Audio)", isDefault: false },
      { id: "mock_array", name: "Microphone Array (Intel® Smart Sound)", isDefault: true },
    ];
  },

  async minimize(): Promise<void> {
    if (isTauri()) await tauri().window?.getCurrentWindow().minimize();
  },

  async toggleMaximize(): Promise<void> {
    if (isTauri()) await tauri().window?.getCurrentWindow().toggleMaximize();
  },

  async hideToTray(): Promise<void> {
    if (isTauri()) {
      await invoke("hide_main_window");
      return;
    }
  },

  async startDragging(): Promise<void> {
    if (isTauri()) await tauri().window?.getCurrentWindow().startDragging();
  },

  async quit(): Promise<void> {
    if (isTauri()) await invoke("quit_app");
  },

  simulateDeviceLoss(): void {
    if (isTauri()) {
      void invoke("simulate_device_loss");
      return;
    }
    simEngine.simulateDeviceLoss();
  },

  // ----------------------------------------------------------- listeners
  onStats(handler: Handler<EngineStats>) {
    if (isTauri()) return listen<EngineStats>(CHANNELS.stats, handler);
    const off = simEngine.onStats(handler);
    return Promise.resolve(off);
  },
  /** The settings changed (in any window). */
  onSettings(handler: Handler<AppSettings>) {
    return listen<AppSettings>("lastshot://settings", handler);
  },
  onClipSaved(handler: Handler<ClipSavedPayload>) {
    return listen<ClipSavedPayload>(CHANNELS.clipSaved, handler);
  },
  onError(handler: Handler<string>) {
    return listen<string>(CHANNELS.error, handler);
  },
  onHotkey(handler: Handler<string>) {
    return listen<string>(CHANNELS.hotkey, handler);
  },
  onBufferState(handler: Handler<EngineStats>) {
    return listen<EngineStats>(CHANNELS.bufferState, handler);
  },

  /** Local emit used by the browser hotkey shim. */
  emitLocalHotkey(accelerator: string) {
    emitLocal(CHANNELS.hotkey, accelerator);
  },
  emitLocalError(message: string) {
    emitLocal(CHANNELS.error, message);
  },
};

export type LastshotApi = typeof lastshot;

export interface HotkeyStatus {
  skipped: boolean;
  keys: { action: "save" | "toggle" | "snip" | "record"; accel: string; ok: boolean; error: string | null }[];
}
