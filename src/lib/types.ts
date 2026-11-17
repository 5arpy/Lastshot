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
  /** How the picture is captured right now, in plain words. */
  capture_method?: string;
  /** Something to know that is not an error (e.g. a black screen). */
  notice?: string | null;
  /** Engine clock, for latency tests: QPC at engine time 0 and QPC ticks per second. */
  clock_origin_qpc?: number;
  qpc_freq?: number;
  /** Engine time (100 ns) of the first frame of the last instant replay saved. */
  last_save_start_hns?: number;
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
  /** Moments marked while recording, seconds. */
  markers?: number[];
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
  /** Tab the snip bar opens on: "shot" (screenshot) or "rec" (record an area). */
  start_mode?: "shot" | "rec";
  /** The monitors in the picture (physical px, relative to it); black between them. */
  monitors?: SnipWindowRectNoTitle[];
  /** The monitor the cursor was on: the bar opens there. */
  home?: number;
}

export type SnipWindowRectNoTitle = Omit<SnipWindowRect, "title">;

/** Draw on screen's window: its size and monitors (physical px, relative to it). */
export interface PresentInfo {
  width: number;
  height: number;
  monitors: SnipWindowRectNoTitle[];
  home: number;
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

/** What Lastshot records (instant replay and recordings alike). */
export type CaptureSource =
  | { kind: "display" }
  | { kind: "window"; hwnd: number; exe: string; title: string; method?: WindowMethod };

/** How a window is captured: crop it out of the screen while it is visible
 * (never touches the app), Windows Graphics Capture, or automatic. */
export type WindowMethod = "auto" | "crop" | "capture";

/** Full-screen capture method (hidden setting). */
export type DisplayMethod = "auto" | "duplication" | "graphics-capture";

/** A camera for the Studio webcam layer (`id` = Media Foundation link). */
export interface CameraInfo {
  id: string;
  name: string;
}

/** Whose sound the PC-sound track records. */
export type AppAudio =
  | { kind: "all" }
  | { kind: "only"; exe: string }
  | { kind: "except"; exe: string };

/** A window that can be recorded on its own. */
export interface WindowInfo {
  hwnd: number;
  title: string;
  exe: string;
  pid: number;
  width: number;
  height: number;
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

/** Video codecs the encoder can write. AV1 needs an RTX 40, RX 7000 or Intel Arc GPU. */
export type VideoCodec = "h264" | "hevc" | "av1";
/** VBR = around the bitrate; CBR = constant bitrate; CQP = constant quality. */
export type RateControl = "vbr" | "cbr" | "cqp";
/** "auto" follows Game Mode (speed when it is on). */
export type EncoderPreset = "auto" | "speed" | "balanced" | "quality";
/** "auto" = the GPU that draws the screen, then any other GPU, then software. */
export type EncoderBackend = "auto" | "nvidia" | "amd" | "intel" | "software";

export interface AppSettings {
  bufferSeconds: number;
  targetFps: number;
  /** Target bitrate for VBR and CBR (kbps). */
  bitrateKbps: number;
  /** Falls back to HEVC, then H.264, when the PC cannot encode it (and says so). */
  codec: VideoCodec;
  /** Screen recording container. MP4 is crash-safe; MKV is there for OBS habits. */
  recordingFormat: "mp4" | "mkv";
  /** MKV only: convert to MP4 after the recording stops (the MKV goes once the MP4 is checked). */
  remuxMkv: boolean;
  rateControl: RateControl;
  /** CQP only: 1-51, lower = better quality and bigger files. */
  cqpLevel: number;
  /** Seconds between keyframes, 0.25-10. */
  keyframeSeconds: number;
  encoderPreset: EncoderPreset;
  encoderBackend: EncoderBackend;
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
  /** "Clean up my voice": low cut, noise gate, compressor, limiter on the mic. Applies live. */
  cleanVoice?: boolean;
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
  /** Which screens a snip freezes: "all" (default), "cursor", or "monitor:<index>". */
  snipScope: string;
  /**
   * Extra folders whose videos show up in Clips too. Lastshot only saves to
   * outputDir; auto-cleanup and "Delete all" never touch these.
   */
  libraryFolders: string[];
  /** Starts / stops a screen recording. */
  hotkeyRecord: string;
  /** Pauses / resumes the running screen recording. */
  hotkeyPause: string;
  /** Seconds counted down before a recording starts (0 = off). */
  recordCountdown: number;
  /** The recording stops and saves after this many minutes, pauses not counted (0 = no limit). */
  recordMaxMinutes: number;
  /** The recording stops and saves at this file size in GB (0 = no limit). */
  recordMaxGb: number;
  /** File name template, e.g. "{app} Recording {date} {time}" (no extension). */
  recordFileName: string;
  /** A file with that name exists: add " 2", " 3"… or replace it (old one to the Recycle Bin). */
  recordIfExists: "number" | "overwrite";
  /** The recording stops (and keeps what it has) when the drive has less free space than this. */
  diskReserveMb: number;
  /** On-screen control bar: while recording, always, or never. */
  controlBar: "recording" | "always" | "off";
  /** Studio layers on the recorded screen. */
  studioLayers: "recording" | "always" | "off";
  /** What the engine captures: the monitor above, or one window / app. */
  captureSource: CaptureSource;
  /** PC sound: everything, only one app, or everything except one app. */
  appAudio: AppAudio;
  /** Draw the mouse pointer into recordings and replays. */
  captureCursor: boolean;
  /** Full-screen capture method; "auto" for nearly everyone. */
  displayMethod?: DisplayMethod;
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
  /** In-app shortcut rebindings: "scope:id" -> keys ("" = no key). */
  shortcuts: Record<string, string>;
  /** UI scale of the app windows (1 = 100 %). */
  uiScale: number;
  /** The app's windows and their tabs (written by the shell commands). */
  shell?: { windows: { label: string; tabs: string[]; active: string }[] };
}

/** A running screen recording. */
export interface RecordingStatus {
  path: string;
  file_name: string;
  seconds: number;
  paused: boolean;
  /** False once it ended on its own; collect it with stopRecording. */
  active: boolean;
  /** File size so far. */
  bytes: number;
  /** Something to know while recording, e.g. "Disk almost full: about 6 minutes left". */
  notice: string | null;
  /** Why it stopped by itself, if it did. */
  ended: string | null;
  /** Seconds until the time or size limit or a full disk, whichever comes first. */
  seconds_left: number | null;
  /** Engine time (100 ns) at file time 0, for latency tests. */
  start_hns?: number | null;
}

/** What the control bar and Home show. */
export interface BarState {
  recording: RecordingStatus | null;
  /** Seconds left before a recording starts (it has not started yet). */
  countdown: number | null;
  micMuted: boolean;
  micOn: boolean;
  replayOn: boolean;
  hotkeyRecord: string;
  hotkeyPause: string;
  hotkeySave: string;
  hotkeySnip: string;
  /** Size of the recorded area ("1280×720"); null = whole screen. */
  area?: string | null;
  /** Moments marked so far in this recording. */
  markers?: number;
  /** Recording file size so far. */
  bytes?: number;
  /** 0-1 while a stopped recording is being finished. */
  finishing?: number | null;
  /** "Saving the recording" / "Cutting the recording to the area". */
  finishingLabel?: string | null;
  /** The control bar window is open. */
  barOpen?: boolean;
  /** Drawing on the screen is on. */
  drawing?: boolean;
}

/** What this PC can encode: hardware encoder names per codec, and software. */
export interface EncoderCaps {
  codecs: { codec: VideoCodec; hardware: string[]; software: boolean }[];
  sessions: number;
}

/** What a video file needs to play everywhere. */
export interface Diagnosis {
  need: "nothing" | "repair-in-place" | "remux" | "unfixable";
  container: string;
  seconds: number;
  video: string | null;
  audio: string | null;
  /** Written by Lastshot. */
  ours: boolean;
  message: string;
}

/** Result of a repair or a convert to MP4. */
export interface FixResult {
  path: string;
  newFile: boolean;
  seconds: number;
  message: string;
}

export interface RepairProgress {
  path: string;
  /** 0-1 */
  progress: number;
}

/** Something the backend wants the user to know (toast). */
export interface Notice {
  message: string;
  level: "info" | "warning";
}

/** Small picture of the recorded screen (Studio preview). */
export interface ScreenShot {
  image: string;
  width: number;
  height: number;
  name: string;
}

/** A file added to the Editor: what it is. */
export interface MediaInfo {
  kind: "video" | "audio";
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

/** What the Editor sends to be rendered (see `media/compose.rs`). */
export interface RenderProject {
  width: number;
  height: number;
  fps: number;
  video: { path?: string; png?: string; start: number; duration: number; srcIn: number }[];
  overlays: { png: string; start: number; duration: number; x: number; y: number; opacity: number }[];
  audio: {
    path: string;
    start: number;
    duration: number;
    srcIn: number;
    volume: number;
    fadeIn: number;
    fadeOut: number;
  }[];
  targetMb?: number | null;
}

/** Message from the control bar to the drawing layer. */
export type DrawCommand =
  | { kind: "tool"; tool: "pen" | "marker" | "arrow" | "box"; color: string }
  | { kind: "undo" }
  | { kind: "clear" };

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
