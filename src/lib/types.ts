/**
 * TypeScript mirrors of the Rust structs in `src-tauri/src/media/*` and
 * `src-tauri/src/settings.rs`. Keep the two in sync — serde uses these exact
 * field names.
 */

export type EncoderVendor =
  | "nvenc"
  | "amd-amf"
  | "intel-qsv"
  | "media-foundation-software"
  | "unavailable";

export type EngineStateName =
  | "idle"
  | "starting"
  | "buffering"
  | "flushing"
  | "recovering"
  | "error";

export interface EncoderInfo {
  vendor: EncoderVendor;
  friendly_name: string;
  codec: string;
  hardware: boolean;
  adapter_name: string;
  dedicated_vram_mb: number;
}

export interface EngineStats {
  state: EngineStateName;
  encoder: EncoderInfo;
  width: number;
  height: number;
  target_fps: number;
  /** Configured encode bitrate (kbps). */
  bitrate_kbps: number;
  /** Whether the running engine was started in Game Mode. */
  performance_mode: boolean;
  /** Adapter is an integrated GPU that shares memory with the CPU. */
  integrated_gpu: boolean;
  capture_fps: number;
  buffer_seconds: number;
  buffered_seconds: number;
  ring_bytes: number;
  ring_frames: number;
  process_rss_bytes: number;
  encode_ms_avg: number;
  gpu_submit_ms_avg: number;
  dropped_frames: number;
  device_resets: number;
  audio_system: boolean;
  audio_mic: boolean;
  audio_drift_ms: number;
  /** Why audio is missing (device in exclusive mode, AAC failure...), if any. */
  audio_error: string | null;
  /** Privacy mode: no game is focused, so capture is paused (ring empty). */
  privacy_active: boolean;
  uptime_seconds: number;
  last_error: string | null;
}

export interface ClipMetadata {
  id: string;
  path: string;
  file_name: string;
  title: string;
  duration_seconds: number;
  size_bytes: number;
  created_unix_ms: number;
  width: number;
  height: number;
  fps: number;
  has_audio: boolean;
  /** Per-game folder tag (e.g. "cs2"), null for clips at the output root. */
  game: string | null;
  thumbnail: string | null;
  /** Starred by the user (persisted in the local sidecar store). */
  favorite: boolean;
  /** User-added tags (persisted in the local sidecar store). */
  tags: string[];
  /** The extra library folder this clip is in; null/absent = the save folder. */
  folder?: string | null;
  /** Browser-simulation only: object URL for the preview player. */
  preview_url?: string;
}

export interface TrimResult {
  path: string;
  file_name: string;
  duration_seconds: number;
  size_bytes: number;
  elapsed_ms: number;
  snapped_start_seconds: number;
}

/** A clip re-encoded to fit a size limit. */
export interface ShrinkResult {
  path: string;
  file_name: string;
  size_bytes: number;
  duration_seconds: number;
  width: number;
  height: number;
  fps: number;
  video_kbps: number;
  elapsed_ms: number;
  attempts: number;
}

/** One piece of an export: `path` from `start` to `end` seconds (null = to the end). */
export interface ExportSegment {
  path: string;
  start: number;
  end: number | null;
}

/** Part of the picture to keep, as fractions (0-1) of the frame. */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ShrinkProgress {
  path: string;
  progress: number;
}

/** A window outline on the snipped monitor (physical px, front-most first). */
export interface SnipWindowRect {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
}

export interface SnipCapture {
  image: string;
  width: number;
  height: number;
  windows: SnipWindowRect[];
}

export interface SnipDone {
  path: string | null;
  copied: boolean;
}

/** Result of splitting a clip in two at the playhead. */
export interface SplitResult {
  partA: TrimResult;
  partB: TrimResult;
}

export interface ClipSavedPayload {
  clip: ClipMetadata;
  flushMs: number;
  triggeredBy: "hotkey" | "ui" | "tray" | string;
  /**
   * Whether the deck should open the trimmer. The Rust side sets this to
   * false when a hotkey save happens while a game has focus (raising the
   * deck would steal focus and minimise the game). Undefined = fall back to
   * the user's `openTrimmerAfterSave` setting (browser sim).
   */
  openTrimmer?: boolean;
}

export interface MonitorInfo {
  index: number;
  name: string;
  width: number;
  height: number;
  refresh_hz: number;
  primary: boolean;
  adapter: string;
}

export interface AudioDevice {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface AppSettings {
  bufferSeconds: number;
  targetFps: number;
  bitrateKbps: number;
  codec: "h264" | "hevc";
  monitorIndex: number;
  captureSystemAudio: boolean;
  captureMicrophone: boolean;
  outputDir: string;
  hotkeySave: string;
  hotkeyToggle: string;
  openTrimmerAfterSave: boolean;
  minimizeToTray: boolean;
  autostartBuffer: boolean;
  playSaveSound: boolean;
  /** Pin the control deck above full-screen games. */
  alwaysOnTop: boolean;
  /** Per-game capture presets (ShadowPlay style). */
  profiles: CaptureProfile[];
  /** Foreground exe → profile mapping (auto-switch). */
  profileMap: ProfileMapEntry[];
  /** When on, the mapped profile follows the game that has focus. */
  autoSwitchProfiles: boolean;
  /** Launch Lastshot hidden to tray at Windows sign-in. */
  launchAtStartup: boolean;
  /** Delete clips older than N days at launch (0 = keep everything). */
  autoCleanupDays: number;
  /** Save clips into per-game subfolders and tag them with the game. */
  organizeByGame: boolean;
  /** When the foreground game leaves focus, save its last 30 s automatically. */
  autosaveOnGameExit: boolean;
  /**
   * Game Mode: cap capture at 1080p/60, tune the encoder for speed and keep
   * background UI work quiet while a game is running. Applies on engine start.
   */
  performanceMode: boolean;
  /**
   * Privacy mode: when no game has the foreground focus the buffer stops
   * accumulating (and is cleared), so clips can never contain desktop content.
   */
  privacyPauseWhenUnfocused: boolean;
  /** System (game) audio volume in the mix, 0-100. Applies live. */
  gameVolume: number;
  /** Microphone volume in the mix, 0-100. Applies live. */
  micVolume: number;
  /** Specific microphone device ID, or null for Windows default console device. */
  micDeviceId?: string | null;
  /**
   * Adaptive capture (ECO): on battery or under memory pressure the deck
   * shrinks the rolling buffer live and caps the fps. Invisible when off.
   */
  adaptiveEco: boolean;
  /** Battery % at or below which ECO kicks in while on battery. */
  ecoBatteryThresholdPct: number;
  /** Free physical RAM (GiB) below which ECO kicks in. */
  ecoRamFreeGbs: number;
  /**
   * Check GitHub for a newer signed release at startup.
   *
   * Default `false`: Lastshot promises "no telemetry, no background network",
   * so the silent startup probe is opt-in. The manual button in Settings
   * always works.
   */
  checkUpdatesOnStartup: boolean;
  /** "Shrink & copy" size limit in MB (Discord's free cap is 10). */
  shareSizeMb: number;
  /** Hotkey that opens the snipping overlay. */
  hotkeySnip: string;
  /** Also save every snip as a PNG in <clips folder>\Screenshots. */
  snipSaveToFolder: boolean;
  /**
   * Extra folders whose videos show up in Clips too. Lastshot only saves to
   * outputDir; auto-cleanup and "Delete all" never touch these.
   */
  libraryFolders: string[];
  /** Starts / stops a screen recording. */
  hotkeyRecord: string;
  /** On-screen control bar: while recording, always, or never. */
  controlBar: "recording" | "always" | "off";
  /** "Open with Lastshot" on MP4 files in Explorer. */
  explorerOpenWith: boolean;
  /** Screenshot folder; empty = `<save location>\Screenshots`. */
  screenshotDir: string;
  screenshotFormat: "png" | "jpg";
  /** JPG quality, 50-100. */
  screenshotQuality: number;
  /** Put screenshots on the clipboard. */
  screenshotCopy: boolean;
  /** Screen recording folder; empty = the save location. */
  recordingDir: string;
  /** Hides folder paths on screen. */
  streamerMode: boolean;
}

/** A running screen recording. */
export interface RecordingStatus {
  path: string;
  file_name: string;
  seconds: number;
  paused: boolean;
  /** False once it ended on its own; collect it with stopRecording. */
  active: boolean;
}

/** What the control bar and Home show. */
export interface BarState {
  recording: RecordingStatus | null;
  micMuted: boolean;
  micOn: boolean;
  replayOn: boolean;
  hotkeyRecord: string;
  hotkeySave: string;
  hotkeySnip: string;
}

/** Space on one drive. */
export interface DiskInfo {
  root: string;
  totalBytes: number;
  freeBytes: number;
}

/** A point-in-time snapshot of the machine's power / memory state. */
export interface PowerState {
  /** True when running on battery (DC power). */
  onBattery: boolean;
  /** 0-100 remaining battery (100 when on AC or unknown). */
  batteryPercent: number;
  /** Available physical memory in bytes. */
  availableRamBytes: number;
  /** Total physical memory in bytes. */
  totalRamBytes: number;
}

/** One per-game capture preset. `id` is a stable slug like "competitivo". */
export interface CaptureProfile {
  id: string;
  name: string;
  bufferSeconds: number;
  targetFps: number;
  bitrateKbps: number;
  codec: "h264" | "hevc";
}

/** Maps a foreground executable (lowercase, e.g. "cs2.exe") to a profile. */
export interface ProfileMapEntry {
  profileId: string;
  exeName: string;
}

/** The window currently owning focus, as reported by the native backend. */
export interface ForegroundGame {
  exe: string;
  title: string;
}

/** Live download state surfaced by the auto-updater (About & Updates). */
export interface UpdateProgress {
  phase: "PENDING" | "DOWNLOADING" | "INSTALLING";
  downloaded: number;
  total: number;
}

export const VENDOR_LABEL: Record<EncoderVendor, string> = {
  nvenc: "NVIDIA NVENC",
  "amd-amf": "AMD AMF",
  "intel-qsv": "Intel Quick Sync",
  "media-foundation-software": "MF Software",
  unavailable: "Unavailable",
};

export const VENDOR_ACCENT: Record<EncoderVendor, string> = {
  nvenc: "#76ff9c",
  "amd-amf": "#ff5f6d",
  "intel-qsv": "#4fc3ff",
  "media-foundation-software": "#ffc94f",
  unavailable: "#64748b",
};
