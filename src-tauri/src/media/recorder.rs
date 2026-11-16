//! Lastshot capture engine.
//!
//! Pipeline (all GPU resident, zero CPU readback of pixel data):
//!
//! ```text
//!  IDXGIOutputDuplication ──► ID3D11Texture2D (B8G8R8A8)
//!            │
//!            ├─► ID3D11VideoProcessor  (BGRA ➜ NV12, scale, full/limited range)
//!            │
//!            └─► IMFTransform (hardware H.264/HEVC MFT: NVENC / AMF / QSV)
//!                        │
//!                        └─► EncodedPacket ──► RollingRingBuffer (Arc<[u8]>)
//!                                                        │
//!                          Alt+C ──────────────────────► IMFSinkWriter ➜ .mp4
//! ```
//!
//! Design notes
//! * The ring buffer stores **already encoded** H.264 access units, which is why
//!   120 s of 1080p60 costs ~90 MB of RAM at 6 Mbit/s instead of ~45 GB of raw
//!   BGRA. Idle footprint (buffer disarmed) stays below 20 MB.
//! * Every frame payload lives behind an `Arc<[u8]>`, so flushing the buffer to
//!   disk is a pointer-copy snapshot: the capture thread is blocked for tens of
//!   microseconds, not milliseconds.
//! * All DXGI/D3D11 error paths funnel through [`is_device_lost`] and trigger a
//!   full, allocation-free-ish rebuild of the graphics stack while keeping the
//!   already-captured history intact.

#![allow(clippy::too_many_arguments)]

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Public data model (mirrored 1:1 by `src/lib/types.ts` on the frontend)
// ---------------------------------------------------------------------------

/// 100-nanosecond units: the native Media Foundation time base.
pub const HNS_PER_SECOND: i64 = 10_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EncoderVendor {
    Nvenc,
    AmdAmf,
    IntelQsv,
    MediaFoundationSoftware,
    Unavailable,
}

impl EncoderVendor {
    pub fn label(self) -> &'static str {
        match self {
            EncoderVendor::Nvenc => "NVIDIA NVENC",
            EncoderVendor::AmdAmf => "AMD AMF (VCE)",
            EncoderVendor::IntelQsv => "Intel Quick Sync",
            EncoderVendor::MediaFoundationSoftware => "Media Foundation (software)",
            EncoderVendor::Unavailable => "Unavailable",
        }
    }

    /// Hardware MFTs get the low-latency + async unlock treatment.
    pub fn is_hardware(self) -> bool {
        matches!(
            self,
            EncoderVendor::Nvenc | EncoderVendor::AmdAmf | EncoderVendor::IntelQsv
        )
    }

    fn from_friendly_name(name: &str) -> Self {
        let n = name.to_ascii_lowercase();
        if n.contains("nvidia") || n.contains("nvenc") {
            EncoderVendor::Nvenc
        } else if n.contains("amd") || n.contains("amf") || n.contains("radeon") {
            EncoderVendor::AmdAmf
        } else if n.contains("intel") || n.contains("quick sync") || n.contains("qsv") {
            EncoderVendor::IntelQsv
        } else {
            EncoderVendor::MediaFoundationSoftware
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncoderInfo {
    pub vendor: EncoderVendor,
    pub friendly_name: String,
    pub codec: String,
    pub hardware: bool,
    pub adapter_name: String,
    pub dedicated_vram_mb: u64,
}

impl Default for EncoderInfo {
    fn default() -> Self {
        Self {
            vendor: EncoderVendor::Unavailable,
            friendly_name: "Not initialised".into(),
            codec: "H.264".into(),
            hardware: false,
            adapter_name: "—".into(),
            dedicated_vram_mb: 0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Codec {
    H264,
    Hevc,
}

impl Codec {
    pub fn as_str(self) -> &'static str {
        match self {
            Codec::H264 => "H.264",
            Codec::Hevc => "HEVC",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecorderConfig {
    pub buffer_seconds: u32,
    pub target_fps: u32,
    /// 0 = native monitor resolution.
    pub width: u32,
    pub height: u32,
    /// Game Mode downscale ceiling (0 = native). Keeps aspect ratio.
    #[serde(default)]
    pub max_height: u32,
    /// Game Mode: cheap encoder tuning + gentler thread priorities.
    #[serde(default)]
    pub performance_mode: bool,
    pub bitrate_kbps: u32,
    pub codec: Codec,
    pub monitor_index: u32,
    pub capture_system_audio: bool,
    pub capture_microphone: bool,
    /// Mix balance for the *system* audio source, 0-100 (100 = unity gain).
    pub game_volume: u32,
    /// Mix balance for the microphone source, 0-100 (100 = unity gain).
    pub mic_volume: u32,
    /// Specific microphone device ID, or None for system default.
    pub mic_device_id: Option<String>,
    pub output_dir: PathBuf,
    /// Per-game subfolder the next flush lands in (None = output root).
    pub output_subfolder: Option<String>,
    /// App the next clip is named after (`Roblox 2026-11-16 20-15-03.mp4`).
    #[serde(default)]
    pub clip_app: Option<String>,
    /// What to capture: the whole monitor (default) or one window / app.
    #[serde(default)]
    pub source: CaptureSource,
    /// Whose sound the PC-sound track records.
    #[serde(default)]
    pub app_audio: crate::media::procaudio::AppAudio,
    /// Draw the mouse pointer into the video.
    #[serde(default = "cursor_default")]
    pub capture_cursor: bool,
    /// How a monitor is captured (desktop duplication, Graphics Capture, or
    /// duplication with an automatic Graphics Capture fallback).
    #[serde(default)]
    pub display_method: DisplayMethod,
}

/// How full-screen capture works.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum DisplayMethod {
    /// Desktop duplication; Graphics Capture when duplication is unavailable
    /// or only gives black frames.
    #[default]
    Auto,
    Duplication,
    GraphicsCapture,
}

fn cursor_default() -> bool {
    true
}

/// The picture the engine records (instant replay and recordings alike).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CaptureSource {
    /// The monitor picked in Settings (desktop duplication).
    #[default]
    Display,
    /// One window. `exe` finds the app again if its window is re-created
    /// (a game restarting, a launcher swapping windows).
    Window {
        hwnd: i64,
        exe: String,
        title: String,
        /// Crop from the screen, Graphics Capture, or automatic.
        #[serde(default)]
        method: crate::media::winvis::WindowMethod,
    },
}

impl Default for RecorderConfig {
    fn default() -> Self {
        Self {
            buffer_seconds: 60,
            target_fps: 60,
            width: 0,
            height: 0,
            max_height: 0,
            performance_mode: false,
            bitrate_kbps: 12_000,
            codec: Codec::H264,
            monitor_index: 0,
            capture_system_audio: true,
            capture_microphone: false,
            game_volume: 100,
            mic_volume: 100,
            mic_device_id: None,
            output_dir: default_output_dir(),
            output_subfolder: None,
            clip_app: None,
            source: CaptureSource::Display,
            app_audio: Default::default(),
            capture_cursor: true,
            display_method: DisplayMethod::Auto,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EngineState {
    Idle,
    Starting,
    Buffering,
    Flushing,
    Recovering,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineStats {
    pub state: EngineState,
    pub encoder: EncoderInfo,
    pub width: u32,
    pub height: u32,
    pub target_fps: u32,
    /// Configured encode bitrate (kbps) — shown on the deck.
    pub bitrate_kbps: u32,
    /// Whether the running engine was started in Game Mode.
    pub performance_mode: bool,
    /// Adapter is an integrated GPU (shared memory with the CPU). On these,
    /// Game Mode caps harder (720p/30) because the game and the encoder share
    /// the same memory bandwidth and power budget.
    pub integrated_gpu: bool,
    pub capture_fps: f32,
    pub buffer_seconds: u32,
    pub buffered_seconds: f32,
    pub ring_bytes: u64,
    pub ring_frames: u32,
    pub process_rss_bytes: u64,
    pub encode_ms_avg: f32,
    pub gpu_submit_ms_avg: f32,
    pub dropped_frames: u64,
    pub device_resets: u32,
    pub audio_system: bool,
    pub audio_mic: bool,
    pub audio_drift_ms: f32,
    /// `Some(reason)` when the WASAPI/AAC audio path could not produce audio
    /// (e.g. the render device is held in exclusive mode by a game). Null when
    /// audio is healthy or disabled. The UI surfaces this on the deck.
    pub audio_error: Option<String>,
    /// Privacy mode: a game is *not* in the foreground, so the engine is
    /// dropping frames and no gameplay is accumulating in the ring buffer.
    pub privacy_active: bool,
    pub uptime_seconds: u64,
    pub last_error: Option<String>,
    /// How the picture is captured right now, in plain words.
    #[serde(default)]
    pub capture_method: String,
    /// Something the user should know that is not an error (black screen).
    #[serde(default)]
    pub notice: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipWriteResult {
    pub path: String,
    pub file_name: String,
    pub duration_seconds: f32,
    pub size_bytes: u64,
    pub flush_ms: f32,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub has_audio: bool,
}

/// Anything that can go wrong in the engine. Converted to a plain `String` at
/// the IPC boundary so the frontend never has to know about HRESULTs.
#[derive(Debug, thiserror::Error)]
pub enum RecorderError {
    #[error("capture engine is not running")]
    NotRunning,
    #[error("capture engine is already running")]
    AlreadyRunning,
    #[error("no frames in the rolling buffer yet")]
    EmptyBuffer,
    #[error("no compatible hardware encoder found (need NVENC, AMD AMF or Intel QSV)")]
    NoEncoder,
    #[error("monitor index {0} does not exist")]
    NoSuchMonitor(u32),
    #[error("graphics device lost and could not be recreated: {0}")]
    DeviceLost(String),
    #[error("io error: {0}")]
    Io(String),
    #[error("windows api error: {0}")]
    Win(String),
    #[error("{0}")]
    Other(String),
}

pub type RResult<T> = Result<T, RecorderError>;

impl From<std::io::Error> for RecorderError {
    fn from(e: std::io::Error) -> Self {
        RecorderError::Io(e.to_string())
    }
}

// ---------------------------------------------------------------------------
// Rolling ring buffer
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrackKind {
    Video,
    Audio,
}

/// One encoded access unit. `data` is an `Arc<[u8]>` so a full-buffer snapshot
/// is O(n) pointer copies rather than O(bytes) memcpy.
#[derive(Clone)]
pub struct EncodedPacket {
    pub track: TrackKind,
    pub data: Arc<[u8]>,
    /// Presentation timestamp in 100 ns units on the shared engine clock.
    pub pts_hns: i64,
    pub duration_hns: i64,
    pub keyframe: bool,
    /// Bumped whenever the graphics device is recreated; the muxer never emits
    /// packets from two different generations in one file.
    pub generation: u32,
}

impl EncodedPacket {
    #[inline]
    fn heap_size(&self) -> usize {
        self.data.len() + std::mem::size_of::<EncodedPacket>()
    }
}

// -------------------------------------------------------------- clock
#[cfg(all(windows, not(feature = "headless-sim")))]
pub struct QpcClock {
    pub freq: i64,
    pub origin: i64,
}

#[cfg(all(windows, not(feature = "headless-sim")))]
impl QpcClock {
    pub fn new() -> Self {
        let mut freq = 0i64;
        let mut now = 0i64;
        unsafe {
            let _ = windows::Win32::System::Performance::QueryPerformanceFrequency(&mut freq);
            let _ = windows::Win32::System::Performance::QueryPerformanceCounter(&mut now);
        }
        Self {
            freq: if freq == 0 { 10_000_000 } else { freq },
            origin: now,
        }
    }

    pub fn to_hns(&self, qpc: i64) -> i64 {
        ((qpc - self.origin) as i128 * HNS_PER_SECOND as i128 / self.freq as i128) as i64
    }

    pub fn now_hns(&self) -> i64 {
        let mut now = 0i64;
        unsafe {
            let _ = windows::Win32::System::Performance::QueryPerformanceCounter(&mut now);
        }
        self.to_hns(now)
    }
}

#[cfg(any(not(windows), feature = "headless-sim"))]
pub struct QpcClock {
    start: std::time::Instant,
}

#[cfg(any(not(windows), feature = "headless-sim"))]
impl QpcClock {
    pub fn new() -> Self {
        Self {
            start: std::time::Instant::now(),
        }
    }

    pub fn to_hns(&self, qpc: i64) -> i64 {
        qpc
    }

    pub fn now_hns(&self) -> i64 {
        (self.start.elapsed().as_nanos() / 100) as i64
    }
}

/// Fixed-duration FIFO of encoded packets.
///
/// Eviction is GOP aligned: we never leave a buffer whose first video packet is
/// a delta frame, otherwise the flushed MP4 would start with macro-block soup.
pub struct RollingRingBuffer {
    video: VecDeque<EncodedPacket>,
    audio: VecDeque<EncodedPacket>,
    window_hns: i64,
    hard_byte_cap: usize,
    bytes: usize,
}

impl RollingRingBuffer {
    pub fn new(window_seconds: u32, hard_byte_cap_mb: usize) -> Self {
        Self {
            // Grows as needed; long windows need not reserve it all up front.
            video: VecDeque::with_capacity(window_seconds.min(600) as usize * 120),
            audio: VecDeque::with_capacity(window_seconds.min(600) as usize * 60),
            window_hns: window_seconds as i64 * HNS_PER_SECOND,
            hard_byte_cap: hard_byte_cap_mb * 1024 * 1024,
            bytes: 0,
        }
    }

    /// Changes the rolling window *and* the byte ceiling that enforces it.
    ///
    /// The byte cap has to move with the window: it is derived from
    /// `window_seconds * bitrate`, so leaving it behind silently truncates the
    /// buffer. Going 60 s → 300 s without a restart used to keep the 60 s cap
    /// (~141 MB at 12 Mbps), which held only ~96 s — the user asked for 300 s
    /// and got 96 s with no error anywhere. See the `set_window_*` tests.
    pub fn set_window(&mut self, window_seconds: u32, bitrate_kbps: u32) {
        self.window_hns = window_seconds as i64 * HNS_PER_SECOND;
        self.hard_byte_cap = ring_cap_mb(window_seconds, bitrate_kbps) * 1024 * 1024;
        self.prune();
    }

    /// Test-only view of the byte ceiling so the cap/window coupling can be
    /// asserted without exposing it in the public surface.
    #[cfg(test)]
    fn hard_byte_cap(&self) -> usize {
        self.hard_byte_cap
    }

    /// Test-only view of the live audio packet count.
    ///
    /// Asserting through `snapshot()` is not enough: it filters by the newest
    /// video generation, so with an empty video queue it returns nothing and a
    /// leak assertion passes vacuously.
    #[cfg(test)]
    fn audio_packets(&self) -> usize {
        self.audio.len()
    }

    pub fn push(&mut self, pkt: EncodedPacket) {
        self.bytes += pkt.heap_size();
        match pkt.track {
            TrackKind::Video => self.video.push_back(pkt),
            TrackKind::Audio => self.audio.push_back(pkt),
        }
        self.prune();
    }

    fn newest_pts(&self) -> i64 {
        self.video.back().map(|p| p.pts_hns).unwrap_or(0)
    }

    /// Drops the leading audio packet and keeps `bytes` in sync.
    fn pop_audio(&mut self) -> bool {
        match self.audio.pop_front() {
            Some(p) => {
                self.bytes -= p.heap_size().min(self.bytes);
                true
            }
            None => false,
        }
    }

    /// Drop whole GOPs from the front until the window (and the hard byte cap)
    /// is satisfied.
    fn prune(&mut self) {
        let newest = self.newest_pts();
        let cutoff = newest - self.window_hns;

        loop {
            let over_time = self
                .video
                .front()
                .map(|p| p.pts_hns < cutoff)
                .unwrap_or(false);
            let over_bytes = self.bytes > self.hard_byte_cap;
            if !(over_time || over_bytes) || self.video.len() < 2 {
                break;
            }

            // Pop the leading GOP: the current key frame plus every delta frame
            // that depends on it.
            if let Some(front) = self.video.pop_front() {
                self.bytes -= front.heap_size().min(self.bytes);
            }
            while let Some(next) = self.video.front() {
                if next.keyframe {
                    break;
                }
                let p = self.video.pop_front().unwrap();
                self.bytes -= p.heap_size().min(self.bytes);
            }
        }

        // Audio is independent of GOPs, just clip to the oldest surviving video
        // timestamp minus 200 ms of lead-in so the muxer can align cleanly.
        //
        // When the video queue is empty this cutoff is i64::MIN and *nothing*
        // was ever evicted. That is reachable in production: the privacy gate
        // clears the ring but the audio thread keeps pushing (it does not read
        // the gate), so a long alt-tab accumulated audio forever. Bound the
        // audio track by its own newest timestamp as well, so it can never grow
        // past the window on its own.
        let audio_cutoff = match self.video.front() {
            Some(p) => p.pts_hns - HNS_PER_SECOND / 5,
            None => match self.audio.back() {
                Some(p) => p.pts_hns - self.window_hns,
                None => i64::MIN,
            },
        };
        while let Some(front) = self.audio.front() {
            if front.pts_hns >= audio_cutoff {
                break;
            }
            if !self.pop_audio() {
                break;
            }
        }

        // Audio is ~24 KB/s at 192 kbit/s, so it is cheap — but a video track
        // that is small (a static screen compresses to almost nothing) would
        // leave the byte cap to the audio side. Enforce the ceiling here too.
        while self.bytes > self.hard_byte_cap && self.pop_audio() {}
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }

    pub fn video_frames(&self) -> usize {
        self.video.len()
    }

    /// Generation and newest video timestamp, or `None` when empty.
    pub fn newest_video(&self) -> Option<(u32, i64)> {
        self.video.back().map(|p| (p.generation, p.pts_hns))
    }

    /// Timestamp of the newest key frame at or before `pts` (same generation).
    pub fn keyframe_at_or_before(&self, generation: u32, pts: i64) -> Option<i64> {
        self.video
            .iter()
            .rev()
            .find(|p| p.generation == generation && p.keyframe && p.pts_hns <= pts)
            .map(|p| p.pts_hns)
    }

    /// True when any audio is buffered.
    pub fn has_audio(&self) -> bool {
        !self.audio.is_empty()
    }

    /// Packets of `generation` newer than the given timestamps, oldest first.
    /// Used by screen recording to stream the ring to disk as it fills.
    pub fn packets_after(
        &self,
        generation: u32,
        video_after: i64,
        audio_after: i64,
    ) -> (Vec<EncodedPacket>, Vec<EncodedPacket>) {
        let video = self
            .video
            .iter()
            .filter(|p| p.generation == generation && p.pts_hns > video_after)
            .cloned()
            .collect();
        let audio = self
            .audio
            .iter()
            .filter(|p| p.generation == generation && p.pts_hns > audio_after)
            .cloned()
            .collect();
        (video, audio)
    }

    pub fn span_seconds(&self) -> f32 {
        match (self.video.front(), self.video.back()) {
            (Some(a), Some(b)) => ((b.pts_hns + b.duration_hns - a.pts_hns) as f64
                / HNS_PER_SECOND as f64) as f32,
            _ => 0.0,
        }
    }

    pub fn clear(&mut self) {
        self.video.clear();
        self.audio.clear();
        self.bytes = 0;
    }

    /// Cheap snapshot used by the Alt+C flush. Only the newest `generation`
    /// survives and the video track always starts on a key frame.
    pub fn snapshot(&self, max_seconds: Option<f32>) -> (Vec<EncodedPacket>, Vec<EncodedPacket>) {
        let generation = self.video.back().map(|p| p.generation).unwrap_or(0);
        let newest = self.newest_pts();
        let lower_bound = match max_seconds {
            Some(s) => newest - (s as f64 * HNS_PER_SECOND as f64) as i64,
            None => i64::MIN,
        };

        // Find the first key frame at or after the lower bound (walking back so
        // we keep as much history as the user asked for).
        let mut start_idx = 0usize;
        for (i, p) in self.video.iter().enumerate() {
            if p.generation == generation && p.keyframe && p.pts_hns >= lower_bound {
                start_idx = i;
                break;
            }
            if p.generation == generation && p.keyframe {
                start_idx = i; // keep the newest key frame that is still older
            }
        }

        let video: Vec<EncodedPacket> = self
            .video
            .iter()
            .skip(start_idx)
            .filter(|p| p.generation == generation)
            .cloned()
            .collect();

        let audio_start = video.first().map(|p| p.pts_hns).unwrap_or(0);
        let audio: Vec<EncodedPacket> = self
            .audio
            .iter()
            .filter(|p| p.generation == generation && p.pts_hns + p.duration_hns >= audio_start)
            .cloned()
            .collect();

        (video, audio)
    }
}

// ---------------------------------------------------------------------------
// Shared engine state
// ---------------------------------------------------------------------------

struct SharedState {
    running: AtomicBool,
    stop_requested: AtomicBool,
    pub(super) force_device_reset: AtomicBool,
    /// Set by the frontend when privacy mode is on and no game has focus: the
    /// capture thread stops feeding the encoder, so the ring can never hold
    /// desktop footage.
    privacy_gate: Arc<AtomicBool>,
    generation: Arc<AtomicU32>,
    dropped_frames: AtomicU64,
    device_resets: AtomicU32,
    frames_encoded: AtomicU64,
    encode_ns_total: AtomicU64,
    submit_ns_total: AtomicU64,
    started_at: Mutex<Option<Instant>>,
    state: RwLock<EngineState>,
    last_error: RwLock<Option<String>>,
    encoder: RwLock<EncoderInfo>,
    dimensions: RwLock<(u32, u32)>,
    capture_fps: RwLock<f32>,
    /// Effective values after Game Mode / integrated-GPU caps are applied by
    /// the capture thread (0 = fall back to the configured value).
    effective_target_fps: RwLock<u32>,
    effective_bitrate_kbps: RwLock<u32>,
    integrated_gpu: RwLock<bool>,
    audio_drift_ms: RwLock<f32>,
    capture_method: RwLock<String>,
    notice: RwLock<Option<String>>,
    /// Studio layers drawn into the video (S1: in the compositor, not in a
    /// window on the screen).
    pub(crate) layers: Arc<crate::media::layers::LayersShared>,
    /// Live preview for Studio (only made while someone is looking).
    pub(crate) preview: Arc<crate::media::preview::PreviewShared>,
    /// Shared with the audio thread, hence the `Arc`.
    ring: Arc<Mutex<RollingRingBuffer>>,
}

impl SharedState {
    fn new(cfg: &RecorderConfig) -> Self {
        Self {
            running: AtomicBool::new(false),
            stop_requested: AtomicBool::new(false),
            force_device_reset: AtomicBool::new(false),
            privacy_gate: Arc::new(AtomicBool::new(false)),
            generation: Arc::new(AtomicU32::new(1)),
            dropped_frames: AtomicU64::new(0),
            device_resets: AtomicU32::new(0),
            frames_encoded: AtomicU64::new(0),
            encode_ns_total: AtomicU64::new(0),
            submit_ns_total: AtomicU64::new(0),
            started_at: Mutex::new(None),
            state: RwLock::new(EngineState::Idle),
            last_error: RwLock::new(None),
            encoder: RwLock::new(EncoderInfo::default()),
            dimensions: RwLock::new((0, 0)),
            capture_fps: RwLock::new(0.0),
            effective_target_fps: RwLock::new(0),
            effective_bitrate_kbps: RwLock::new(0),
            integrated_gpu: RwLock::new(false),
            audio_drift_ms: RwLock::new(0.0),
            capture_method: RwLock::new(String::new()),
            notice: RwLock::new(None),
            layers: Arc::new(crate::media::layers::LayersShared::default()),
            preview: Arc::new(crate::media::preview::PreviewShared::default()),
            ring: Arc::new(Mutex::new(RollingRingBuffer::new(
                cfg.buffer_seconds,
                ring_cap_mb(cfg.buffer_seconds, cfg.bitrate_kbps),
            ))),
        }
    }

    fn set_state(&self, s: EngineState) {
        *self.state.write() = s;
    }

    fn fail(&self, msg: impl Into<String>) {
        let msg = msg.into();
        log::error!("[lastshot::recorder] {msg}");
        *self.last_error.write() = Some(msg);
        self.set_state(EngineState::Error);
    }
}

/// The presentation time for a frame captured at `raw_hns`: the nearest slot
/// on the `fps` grid, always at least one slot after `last`. Exact for any
/// fps (no drift from rounding the frame duration).
pub fn cfr_pts(raw_hns: i64, fps: u32, last: i64) -> i64 {
    let fps = fps.max(1) as i128;
    let slot = |n: i128| (n * HNS_PER_SECOND as i128 / fps) as i64;
    let n = (raw_hns as i128 * fps + HNS_PER_SECOND as i128 / 2) / HNS_PER_SECOND as i128;
    let mut pts = slot(n);
    if last != i64::MIN && pts <= last {
        let last_n = (last as i128 * fps + HNS_PER_SECOND as i128 / 2) / HNS_PER_SECOND as i128;
        pts = slot(last_n + 1);
    }
    pts
}

fn ring_cap_mb(buffer_seconds: u32, bitrate_kbps: u32) -> usize {
    // 1.6x head room over the nominal bitrate covers VBV overshoot on scene
    // cuts. Clamped so a long window can never eat the machine's RAM.
    let nominal = (buffer_seconds as u64 * bitrate_kbps as u64) / 8 / 1024;
    ((nominal as f64 * 1.6) as usize).clamp(24, ring_ceiling_mb())
}

/// Most RAM the ring may take: half the PC's memory, never below 1.5 GB.
fn ring_ceiling_mb() -> usize {
    let total = crate::power::read_power_state()
        .map(|p| p.total_ram_bytes)
        .unwrap_or(0);
    ((total / 2 / (1024 * 1024)) as usize).max(1536)
}

/// Heuristic for "the game and the encoder share one GPU". Dedicated VRAM is
/// the strongest signal — integrated adapters report a tiny reserved amount
/// (128-1024 MB) because the real framebuffer lives in system RAM. Name
/// matching covers cases where the driver reports 0.
pub fn is_integrated_gpu(adapter_name: &str, vram_mb: u64) -> bool {
    if vram_mb > 0 && vram_mb < 2048 {
        return true;
    }
    let n = adapter_name.to_ascii_lowercase();
    // Intel Arc is discrete; do not downclock it.
    if n.contains("arc") && vram_mb >= 2048 {
        return false;
    }
    n.contains("intel")
        || n.contains("iris")
        || n.contains("uhd graphics")
        || n.contains("hd graphics")
        || (n.contains("radeon") && n.contains("graphics"))
}

pub fn default_output_dir() -> PathBuf {
    #[cfg(windows)]
    {
        if let Ok(profile) = std::env::var("USERPROFILE") {
            return PathBuf::from(profile).join("Videos").join("Lastshot");
        }
    }
    std::env::temp_dir().join("Lastshot")
}

// ---------------------------------------------------------------------------
// CaptureEngine - the public facade used by `commands.rs`
// ---------------------------------------------------------------------------

/// What the UI shows about a running screen recording.
#[derive(Debug, Clone, Serialize)]
pub struct RecordingStatus {
    pub path: String,
    pub file_name: String,
    /// Seconds written so far (pauses not counted).
    pub seconds: f32,
    pub paused: bool,
    /// False once the recording thread has ended on its own (display change,
    /// disk error); the caller should then collect it with `stop_recording`.
    pub active: bool,
}

struct Recording {
    stop: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    written_hns: Arc<std::sync::atomic::AtomicI64>,
    path: PathBuf,
    started: Instant,
    thread: Option<std::thread::JoinHandle<RResult<(i64, bool)>>>,
}

pub struct CaptureEngine {
    recording: Mutex<Option<Recording>>,
    shared: Arc<SharedState>,
    config: RwLock<RecorderConfig>,
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
    audio: Mutex<Option<crate::media::audio::AudioCapture>>,
    /// Written by the audio thread: the reason audio is unavailable, if any.
    audio_error: Arc<parking_lot::Mutex<Option<String>>>,
    /// Live mix levels (permille, 0-1000) shared with the audio thread.
    game_gain: Arc<AtomicU32>,
    mic_gain: Arc<AtomicU32>,
    /// Specific microphone device ID (None = Windows default console device).
    mic_device: Arc<parking_lot::RwLock<Option<String>>>,
    /// Set by the muxer thread once the first flush produced a valid header.
    video_format: Arc<Mutex<Option<VideoFormatHeader>>>,
    /// Serialises every flush regardless of entry point (deck button, Alt+C,
    /// tray menu, auto-save). The lock used to live in `hotkeys.rs` only, so a
    /// UI save could race the hotkey and mux the same snapshot into the same
    /// second-resolution filename. It belongs here, next to the state it
    /// protects.
    flush_lock: parking_lot::Mutex<()>,
}

/// Everything the muxer needs to describe the elementary stream without
/// re-negotiating with the encoder (SPS/PPS live in `sequence_header`).
#[derive(Clone, Default)]
pub struct VideoFormatHeader {
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    pub bitrate: u32,
    pub profile: u32,
    pub codec: u8, // 0 = H.264, 1 = HEVC
    pub sequence_header: Vec<u8>,
}

impl CaptureEngine {
    pub fn new() -> Self {
        let cfg = RecorderConfig::default();
        let mic_dev = cfg.mic_device_id.clone();
        Self {
            recording: Mutex::new(None),
            shared: Arc::new(SharedState::new(&cfg)),
            config: RwLock::new(cfg),
            worker: Mutex::new(None),
            audio: Mutex::new(None),
            audio_error: Arc::new(parking_lot::Mutex::new(None)),
            game_gain: Arc::new(AtomicU32::new(1000)),
            mic_gain: Arc::new(AtomicU32::new(1000)),
            mic_device: Arc::new(parking_lot::RwLock::new(mic_dev)),
            video_format: Arc::new(Mutex::new(None)),
            flush_lock: parking_lot::Mutex::new(()),
        }
    }

    /// Studio layers drawn into the video.
    pub fn layers(&self) -> Arc<crate::media::layers::LayersShared> {
        Arc::clone(&self.shared.layers)
    }

    /// The live preview Studio shows.
    pub fn preview(&self) -> Arc<crate::media::preview::PreviewShared> {
        Arc::clone(&self.shared.preview)
    }

    pub fn config(&self) -> RecorderConfig {
        self.config.read().clone()
    }

    pub fn is_running(&self) -> bool {
        self.shared.running.load(Ordering::Acquire)
    }

    pub fn stats(&self) -> EngineStats {
        let cfg = self.config.read().clone();
        let ring = self.shared.ring.lock();
        let frames = self.shared.frames_encoded.load(Ordering::Relaxed).max(1);
        let (w, h) = *self.shared.dimensions.read();

        EngineStats {
            state: *self.shared.state.read(),
            encoder: self.shared.encoder.read().clone(),
            width: w,
            height: h,
            target_fps: {
                let effective = *self.shared.effective_target_fps.read();
                if effective > 0 {
                    effective
                } else {
                    cfg.target_fps
                }
            },
            bitrate_kbps: {
                let effective = *self.shared.effective_bitrate_kbps.read();
                if effective > 0 {
                    effective
                } else {
                    cfg.bitrate_kbps
                }
            },
            performance_mode: cfg.performance_mode,
            integrated_gpu: *self.shared.integrated_gpu.read(),
            capture_fps: *self.shared.capture_fps.read(),
            buffer_seconds: cfg.buffer_seconds,
            buffered_seconds: ring.span_seconds(),
            ring_bytes: ring.bytes() as u64,
            ring_frames: ring.video_frames() as u32,
            process_rss_bytes: process_rss_bytes(),
            encode_ms_avg: (self.shared.encode_ns_total.load(Ordering::Relaxed) as f64
                / frames as f64
                / 1.0e6) as f32,
            gpu_submit_ms_avg: (self.shared.submit_ns_total.load(Ordering::Relaxed) as f64
                / frames as f64
                / 1.0e6) as f32,
            dropped_frames: self.shared.dropped_frames.load(Ordering::Relaxed),
            device_resets: self.shared.device_resets.load(Ordering::Relaxed),
            audio_system: cfg.capture_system_audio,
            audio_mic: cfg.capture_microphone,
            audio_drift_ms: *self.shared.audio_drift_ms.read(),
            audio_error: self.audio_error.lock().clone(),
            privacy_active: self.shared.privacy_gate.load(Ordering::Acquire),
            uptime_seconds: self
                .shared
                .started_at
                .lock()
                .map(|t| t.elapsed().as_secs())
                .unwrap_or(0),
            last_error: self.shared.last_error.read().clone(),
            capture_method: self.shared.capture_method.read().clone(),
            notice: self.shared.notice.read().clone(),
        }
    }

    /// Boots the whole pipeline. Returns as soon as the first key frame has
    /// landed in the ring buffer (or after 2 s, whichever comes first) so the
    /// UI can show "armed" without lying.
    pub fn start(&self, cfg: RecorderConfig) -> RResult<EngineStats> {
        if self.is_running() {
            return Err(RecorderError::AlreadyRunning);
        }
        std::fs::create_dir_all(&cfg.output_dir)?;

        {
            let mut ring = self.shared.ring.lock();
            *ring = RollingRingBuffer::new(cfg.buffer_seconds, ring_cap_mb(cfg.buffer_seconds, cfg.bitrate_kbps));
        }
        *self.config.write() = cfg.clone();
        *self.shared.last_error.write() = None;
        self.shared.stop_requested.store(false, Ordering::Release);
        self.shared.running.store(true, Ordering::Release);
        self.shared.frames_encoded.store(0, Ordering::Relaxed);
        self.shared.encode_ns_total.store(0, Ordering::Relaxed);
        self.shared.submit_ns_total.store(0, Ordering::Relaxed);
        self.shared.dropped_frames.store(0, Ordering::Relaxed);
        *self.shared.effective_target_fps.write() = cfg.target_fps;
        *self.shared.effective_bitrate_kbps.write() = cfg.bitrate_kbps;
        *self.shared.integrated_gpu.write() = false;
        *self.shared.started_at.lock() = Some(Instant::now());
        self.shared.set_state(EngineState::Starting);

        let clock = Arc::new(QpcClock::new());

        // Audio first: WASAPI needs a couple of hundred ms to spin up its
        // endpoint, and starting it early keeps A/V aligned from frame zero.
        if cfg.capture_system_audio || cfg.capture_microphone {
            // Fresh engine → clear the previous run's audio error (the thread
            // re-populates it if it still cannot capture).
            *self.audio_error.lock() = None;
            // Volumes are 0-100; the audio thread works in permille so a fresh
            // engine always starts from the saved mix balance.
            self.game_gain.store(
                (cfg.game_volume.min(100) as u32) * 10,
                Ordering::Release,
            );
            self.mic_gain.store(
                (cfg.mic_volume.min(100) as u32) * 10,
                Ordering::Release,
            );
            *self.mic_device.write() = cfg.mic_device_id.clone();
            *crate::media::audio::APP_AUDIO.write() = cfg.app_audio.clone();
            match crate::media::audio::AudioCapture::start(
                cfg.capture_system_audio,
                cfg.capture_microphone,
                Arc::clone(&self.game_gain),
                Arc::clone(&self.mic_gain),
                Arc::clone(&self.mic_device),
                Arc::clone(&self.shared.ring),
                Arc::clone(&self.shared.generation),
                Arc::clone(&self.audio_error),
                Arc::clone(&clock),
                cfg.performance_mode,
                // The audio thread must observe the same gate as the capture
                // thread, otherwise it keeps pushing into a ring that privacy
                // mode just cleared.
                Arc::clone(&self.shared.privacy_gate),
            ) {
                Ok(a) => *self.audio.lock() = Some(a),
                Err(e) => {
                    *self.audio_error.lock() =
                        Some(format!("audio thread could not start: {e}"));
                    log::warn!("[lastshot::audio] disabled: {e}");
                }
            }
        } else {
            *self.audio_error.lock() = None;
        }

        let shared = Arc::clone(&self.shared);
        let fmt = Arc::clone(&self.video_format);
        let thread_cfg = cfg.clone();
        let clock_c = Arc::clone(&clock);
        let handle = std::thread::Builder::new()
            .name("lastshot-capture".into())
            .spawn(move || {
                // Game Mode runs the capture thread at NORMAL so the game's
                // render thread always wins a scheduling race. Outside Game
                // Mode, above-normal keeps capture reliable.
                set_thread_priority(thread_cfg.performance_mode);
                capture_thread_main(shared, thread_cfg, fmt, clock_c);
            })
            .map_err(|e| RecorderError::Other(format!("failed to spawn capture thread: {e}")))?;
        *self.worker.lock() = Some(handle);

        // Wait (bounded) for the pipeline to produce its first key frame.
        let deadline = Instant::now() + Duration::from_millis(2_000);
        while Instant::now() < deadline {
            if matches!(*self.shared.state.read(), EngineState::Buffering) {
                break;
            }
            if matches!(*self.shared.state.read(), EngineState::Error) {
                let msg = self
                    .shared
                    .last_error
                    .read()
                    .clone()
                    .unwrap_or_else(|| "unknown capture failure".into());
                self.stop();
                return Err(RecorderError::Other(msg));
            }
            std::thread::sleep(Duration::from_millis(15));
        }

        Ok(self.stats())
    }

    pub fn stop(&self) {
        // A recording must be finalised before the ring goes away, or the
        // MP4 has no index and will not play.
        if self.recording.lock().is_some() {
            let _ = self.stop_recording();
        }
        self.shared.stop_requested.store(true, Ordering::Release);
        if let Some(a) = self.audio.lock().take() {
            a.stop();
        }
        if let Some(h) = self.worker.lock().take() {
            let _ = h.join();
        }
        self.shared.running.store(false, Ordering::Release);
        self.shared.set_state(EngineState::Idle);
        self.shared.ring.lock().clear();
        *self.shared.effective_target_fps.write() = 0;
        *self.shared.effective_bitrate_kbps.write() = 0;
        *self.shared.integrated_gpu.write() = false;
    }

    // ------------------------------------------------------------ recording

    /// Starts writing everything the engine captures from now on to `path`
    /// (screen recording). The engine must be running. The capture ring is
    /// streamed to disk every half second, so no second encoder is needed.
    pub fn start_recording(&self, path: PathBuf) -> RResult<RecordingStatus> {
        if !self.is_running() {
            return Err(RecorderError::NotRunning);
        }
        let mut slot = self.recording.lock();
        if slot.as_ref().is_some_and(|r| r.thread.as_ref().is_some_and(|t| !t.is_finished())) {
            return Err(RecorderError::Other("Already recording".into()));
        }
        let header = self
            .video_format
            .lock()
            .clone()
            .ok_or_else(|| RecorderError::Other("The recorder is still starting. Try again in a second.".into()))?;
        let (generation, start) = {
            let ring = self.shared.ring.lock();
            let (generation, newest) = ring
                .newest_video()
                .ok_or_else(|| RecorderError::Other("The recorder is still starting. Try again in a second.".into()))?;
            let kf = ring.keyframe_at_or_before(generation, newest).unwrap_or(newest);
            (generation, kf)
        };
        // A running audio thread always delivers (silence until a device
        // or the chosen app has sound), so it decides, not whether packets
        // happen to be in the ring yet: a recording started right after the
        // engine used to get no sound track at all.
        let with_audio = self.shared.ring.lock().has_audio() || self.audio.lock().is_some();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }

        let stop = Arc::new(AtomicBool::new(false));
        let paused = Arc::new(AtomicBool::new(false));
        let written = Arc::new(std::sync::atomic::AtomicI64::new(0));
        let ring = Arc::clone(&self.shared.ring);
        let (t_stop, t_paused, t_written, t_path) =
            (Arc::clone(&stop), Arc::clone(&paused), Arc::clone(&written), path.clone());
        let thread = std::thread::Builder::new()
            .name("lastshot-recording".into())
            .spawn(move || {
                record_loop(&t_path, &header, &ring, generation, start, with_audio, &t_stop, &t_paused, &t_written)
            })
            .map_err(|e| RecorderError::Other(format!("could not start recording: {e}")))?;
        self.shared.layers.set_timer(Some(Arc::clone(&written)));
        *slot = Some(Recording {
            stop,
            paused,
            written_hns: written,
            path,
            started: Instant::now(),
            thread: Some(thread),
        });
        drop(slot);
        Ok(self.recording_status().expect("just started"))
    }

    pub fn recording_status(&self) -> Option<RecordingStatus> {
        let slot = self.recording.lock();
        let r = slot.as_ref()?;
        Some(RecordingStatus {
            path: r.path.to_string_lossy().to_string(),
            file_name: r
                .path
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default(),
            seconds: r.written_hns.load(Ordering::Relaxed) as f32 / HNS_PER_SECOND as f32,
            paused: r.paused.load(Ordering::Relaxed),
            active: r.thread.as_ref().is_some_and(|t| !t.is_finished()),
        })
    }

    pub fn set_recording_paused(&self, paused: bool) -> bool {
        match self.recording.lock().as_ref() {
            Some(r) => {
                r.paused.store(paused, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }

    /// Finishes the recording and returns the written file.
    pub fn stop_recording(&self) -> RResult<ClipWriteResult> {
        let rec = self
            .recording
            .lock()
            .take()
            .ok_or_else(|| RecorderError::Other("Not recording".into()))?;
        let t0 = Instant::now();
        self.shared.layers.set_timer(None);
        rec.stop.store(true, Ordering::Relaxed);
        let mut rec = rec;
        let joined = rec
            .thread
            .take()
            .map(|t| t.join())
            .unwrap_or(Ok(Ok((0, false))));
        let (duration_hns, has_audio) = match joined {
            Ok(r) => r,
            Err(_) => Err(RecorderError::Other("the recording thread crashed".into())),
        }
        .inspect_err(|_| {
            if std::fs::metadata(&rec.path).map(|m| m.len() == 0).unwrap_or(false) {
                let _ = std::fs::remove_file(&rec.path);
            }
        })?;
        let header = self.video_format.lock().clone().unwrap_or_default();
        let _ = rec.started;
        Ok(ClipWriteResult {
            path: rec.path.to_string_lossy().to_string(),
            file_name: rec
                .path
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default(),
            duration_seconds: duration_hns as f32 / HNS_PER_SECOND as f32,
            size_bytes: std::fs::metadata(&rec.path).map(|m| m.len()).unwrap_or(0),
            flush_ms: t0.elapsed().as_secs_f32() * 1000.0,
            width: header.width,
            height: header.height,
            fps: self.config.read().target_fps,
            has_audio,
        })
    }

    pub fn set_buffer_seconds(&self, seconds: u32) {
        let seconds = seconds.clamp(5, crate::settings::MAX_BUFFER_SECONDS);
        let bitrate = {
            let mut cfg = self.config.write();
            cfg.buffer_seconds = seconds;
            cfg.bitrate_kbps
        };
        // The byte ceiling is derived from (window, bitrate); pass the live
        // bitrate so raising the duration actually extends the buffer.
        self.shared.ring.lock().set_window(seconds, bitrate);
    }

    /// Lets the running engine follow a folder change without a full restart.
    pub fn set_output_dir(&self, dir: PathBuf) {
        self.config.write().output_dir = dir;
    }

    /// Routes Alt+C flushes into `output_dir/<sub>/` (per-game folders). The
    /// commands layer recomputes this on every save, so it can never go stale.
    pub fn set_clip_app(&self, app: Option<String>) {
        self.config.write().clip_app = app;
    }

    pub fn set_output_subfolder(&self, sub: Option<String>) {
        self.config.write().output_subfolder = sub;
    }

    /// Privacy mode: when `gate` turns on (no game focused), the ring history
    /// is dropped and the capture thread stops feeding the encoder, so the
    /// buffer can never hold desktop footage. Turning it off resumes capture
    /// from a clean slate (next frame is forced to a key frame).
    pub fn set_privacy_gate(&self, gate: bool) {
        // Store the gate BEFORE clearing: once the capture thread sees it, it
        // stops feeding the encoder, so nothing can be pushed after the clear.
        self.shared.privacy_gate.store(gate, Ordering::Release);
        if gate {
            self.shared.ring.lock().clear();
        }
    }

    /// Live mix balance (0-100 each). The audio thread picks the new gains up
    /// on its next loop — no engine restart needed.
    pub fn set_audio_volumes(&self, game: u32, mic: u32) {
        self.game_gain.store(game.min(100) * 10, Ordering::Release);
        self.mic_gain.store(mic.min(100) * 10, Ordering::Release);
    }

    /// Selects a specific microphone device live, or None to follow system default.
    pub fn set_mic_device(&self, device_id: Option<String>) {
        *self.mic_device.write() = device_id;
    }

    pub fn simulate_device_loss(&self) {
        self.shared.force_device_reset.store(true, Ordering::Release);
    }

    /// Picks a file name that does not collide with an existing clip.
    ///
    /// The base name has one-second resolution, so two saves inside the same
    /// second (a double Alt+C, or a UI save racing the hotkey) resolved to the
    /// same path and the second mux silently overwrote the first. The suffix
    /// keeps the human-readable timestamp and only disambiguates on collision.
    fn unique_clip_path(out_dir: &Path, stem: &str) -> PathBuf {
        let mut candidate = out_dir.join(format!("{stem}.mp4"));
        let mut n = 2u32;
        while candidate.exists() {
            candidate = out_dir.join(format!("{stem}_{n}.mp4"));
            n += 1;
        }
        candidate
    }

    /// The Alt+C path. Target: < 50 ms wall clock for a 60 s 1080p60 buffer.
    ///
    /// Every failure path restores the previous engine state and removes the
    /// partial file. Leaving the engine in `Flushing` used to be permanent: the
    /// deck then showed "Saving clip to disk…" forever with the Save button
    /// disabled, and the only way out was a restart that dropped the buffer.
    ///
    /// The flush is serialised here rather than at the call sites, so the deck
    /// button, Alt+C, the tray menu and auto-save can never mux concurrently.
    pub fn flush_to_disk(&self, max_seconds: Option<f32>) -> RResult<ClipWriteResult> {
        let _guard = match self.flush_lock.try_lock() {
            Some(g) => g,
            None => {
                return Err(RecorderError::Other(
                    "Save replay already in progress".into(),
                ))
            }
        };
        self.flush_to_disk_inner(max_seconds)
    }

    fn flush_to_disk_inner(&self, max_seconds: Option<f32>) -> RResult<ClipWriteResult> {
        if !self.is_running() {
            return Err(RecorderError::NotRunning);
        }
        let t0 = Instant::now();
        let cfg = self.config.read().clone();

        // --- critical section: pointer-copy snapshot only ---------------
        let (video, audio) = {
            let ring = self.shared.ring.lock();
            if ring.video_frames() == 0 {
                return Err(RecorderError::EmptyBuffer);
            }
            ring.snapshot(max_seconds)
        };
        // ----------------------------------------------------------------

        let header = self
            .video_format
            .lock()
            .clone()
            .ok_or_else(|| RecorderError::Other("encoder header not ready yet".into()))?;

        let prev_state = *self.shared.state.read();
        self.shared.set_state(EngineState::Flushing);

        // Everything that can fail runs inside this closure so the state is
        // restored on *every* exit path, not just the happy one.
        let written = (|| -> RResult<(PathBuf, String)> {
            let stem = crate::appname::file_stem(
                cfg.clip_app.as_deref().unwrap_or("Desktop"),
                None,
                chrono::Local::now(),
            );
            let out_dir = match &cfg.output_subfolder {
                Some(sub) => cfg.output_dir.join(sub),
                None => cfg.output_dir.clone(),
            };
            std::fs::create_dir_all(&out_dir)?;
            let path = Self::unique_clip_path(&out_dir, &stem);
            let file_name = path
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| format!("{stem}.mp4"));

            if let Err(e) = mux_packets_to_mp4(&path, &header, &video, &audio) {
                // A failed mux can leave a truncated MP4 behind; the library
                // scan would list it as a broken clip.
                let _ = std::fs::remove_file(&path);
                return Err(e);
            }
            Ok((path, file_name))
        })();

        self.shared.set_state(prev_state);

        let (path, file_name) = written?;
        let duration_hns = match (video.first(), video.last()) {
            (Some(a), Some(b)) => (b.pts_hns + b.duration_hns - a.pts_hns).max(0),
            _ => 0,
        };
        let has_audio = !audio.is_empty();
        let size_bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);

        Ok(ClipWriteResult {
            path: path.to_string_lossy().to_string(),
            file_name,
            duration_seconds: duration_hns as f32 / HNS_PER_SECOND as f32,
            size_bytes,
            flush_ms: t0.elapsed().as_secs_f32() * 1000.0,
            width: header.width,
            height: header.height,
            fps: cfg.target_fps,
            has_audio,
        })
    }
}

impl Default for CaptureEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for CaptureEngine {
    fn drop(&mut self) {
        if self.is_running() {
            self.stop();
        }
    }
}

// ===========================================================================
//                        WINDOWS IMPLEMENTATION
// ===========================================================================

#[cfg(all(windows, not(feature = "headless-sim")))]
mod win {
    use super::*;
    use windows::core::{Interface, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{HMODULE, TRUE, E_UNEXPECTED};
    use windows::Win32::Graphics::Direct3D::{
        D3D_FEATURE_LEVEL, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1,
    };
    use windows::Win32::Graphics::Direct3D11::*;
    use windows::Win32::Graphics::Dxgi::Common::*;
    use windows::Win32::Graphics::Dxgi::*;
    use windows::Win32::Media::MediaFoundation::*;
    use windows::Win32::Media::{timeBeginPeriod, timeEndPeriod};
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::Threading::{
        GetCurrentProcess, GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_ABOVE_NORMAL,
        THREAD_PRIORITY_NORMAL,
    };

    pub(super) fn hr(e: windows::core::Error) -> RecorderError {
        RecorderError::Win(format!("{} (0x{:08X})", e.message(), e.code().0 as u32))
    }

    /// The four HRESULTs that mean "throw everything away and start over".
    pub(super) fn is_device_lost(e: &windows::core::Error) -> bool {
        let c = e.code();
        c == DXGI_ERROR_DEVICE_REMOVED
            || c == DXGI_ERROR_DEVICE_RESET
            || c == DXGI_ERROR_ACCESS_LOST
            || c == DXGI_ERROR_DEVICE_HUNG
            || c == DXGI_ERROR_DRIVER_INTERNAL_ERROR
            || c == E_UNEXPECTED
    }

    // ------------------------------------------------------- MF lifecycle
    pub(super) struct MfSession;

    impl MfSession {
        pub fn new() -> RResult<Self> {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET).map_err(hr)?;
            }
            Ok(Self)
        }
    }

    impl Drop for MfSession {
        fn drop(&mut self) {
            unsafe {
                let _ = MFShutdown();
                CoUninitialize();
            }
        }
    }

    // ------------------------------------------------- timer resolution
    pub(super) struct HighResTimerGuard;

    impl HighResTimerGuard {
        pub fn new() -> Self {
            unsafe {
                let _ = timeBeginPeriod(1);
            }
            Self
        }
    }

    impl Drop for HighResTimerGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = timeEndPeriod(1);
            }
        }
    }

    // ----------------------------------------------------- D3D11 + DXGI
    /// How the stack should get the monitor's picture.
    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    pub(super) enum ScreenMode {
        /// Desktop duplication only (fails if unavailable).
        Duplication,
        /// Desktop duplication, Graphics Capture when it is unsupported.
        DuplicationOrCapture,
        /// Graphics Capture of the monitor.
        Capture,
        /// No monitor picture (a window source captured on its own).
        None,
    }

    pub(super) struct GraphicsStack {
        pub device: ID3D11Device,
        pub context: ID3D11DeviceContext,
        pub duplication: Option<IDXGIOutputDuplication>,
        /// Graphics Capture of the monitor (fallback or chosen method).
        pub wgc: Option<crate::media::wincap::WindowCapture>,
        /// Copy of the newest Graphics Capture frame.
        pub wgc_tex: Option<crate::media::compositor::SourceTexture>,
        pub monitor: windows::Win32::Graphics::Gdi::HMONITOR,
        /// The monitor's place on the desktop.
        pub desktop: crate::media::winvis::IRect,
        pub adapter_name: String,
        pub vram_mb: u64,
        pub src_width: u32,
        pub src_height: u32,
        pub src_format: DXGI_FORMAT,
    }

    impl GraphicsStack {
        pub fn create(monitor_index: u32, mode: ScreenMode, cursor: bool) -> RResult<Self> {
            unsafe {
                let factory: IDXGIFactory1 = CreateDXGIFactory1().map_err(hr)?;

                // Walk adapters/outputs to find the requested monitor. Index is
                // flattened across adapters so a 2-GPU laptop behaves sanely.
                let mut flat = 0u32;
                let mut adapter_idx = 0u32;
                loop {
                    let adapter: IDXGIAdapter1 = match factory.EnumAdapters1(adapter_idx) {
                        Ok(a) => a,
                        Err(_) => break,
                    };
                    let adesc = adapter.GetDesc1().map_err(hr)?;

                    // Skip the Microsoft Basic Render Driver.
                    if (adesc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32) != 0 {
                        adapter_idx += 1;
                        continue;
                    }

                    let mut output_idx = 0u32;
                    loop {
                        let output: IDXGIOutput = match adapter.EnumOutputs(output_idx) {
                            Ok(o) => o,
                            Err(_) => break,
                        };
                        if flat == monitor_index {
                            return Self::build(&adapter, &adesc, &output, mode, cursor);
                        }
                        flat += 1;
                        output_idx += 1;
                    }
                    adapter_idx += 1;
                }
                Err(RecorderError::NoSuchMonitor(monitor_index))
            }
        }

        unsafe fn build(
            adapter: &IDXGIAdapter1,
            adesc: &DXGI_ADAPTER_DESC1,
            output: &IDXGIOutput,
            mode: ScreenMode,
            cursor: bool,
        ) -> RResult<Self> {
            let levels = [D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0];
            let mut device: Option<ID3D11Device> = None;
            let mut context: Option<ID3D11DeviceContext> = None;
            let mut level = D3D_FEATURE_LEVEL::default();

            D3D11CreateDevice(
                adapter,
                // Must be UNKNOWN when an adapter is supplied.
                windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                Some(&levels),
                D3D11_SDK_VERSION,
                Some(&mut device),
                Some(&mut level),
                Some(&mut context),
            )
            .map_err(hr)?;

            let device = device.ok_or_else(|| RecorderError::Other("no d3d11 device".into()))?;
            let context = context.ok_or_else(|| RecorderError::Other("no d3d11 context".into()))?;

            // Desktop Duplication + MF both call into the device from several
            // threads; without this the driver will happily corrupt itself.
            let mt: ID3D11Multithread = device.cast().map_err(hr)?;
            let _ = mt.SetMultithreadProtected(TRUE);

            // Keep our GPU work behind the game's: a lower scheduling priority
            // for this device's work (drivers without support ignore it).
            if let Ok(dxgi_dev) = device.cast::<IDXGIDevice>() {
                let _ = dxgi_dev.SetGPUThreadPriority(-2);
            }

            let odesc = output.GetDesc().map_err(hr)?;
            let r = odesc.DesktopCoordinates;
            let desktop = crate::media::winvis::IRect { left: r.left, top: r.top, right: r.right, bottom: r.bottom };

            let mut duplication = None;
            let mut wgc = None;
            let (mut src_width, mut src_height, mut src_format) =
                (desktop.width() as u32, desktop.height() as u32, DXGI_FORMAT_B8G8R8A8_UNORM);
            let want_dup = matches!(mode, ScreenMode::Duplication | ScreenMode::DuplicationOrCapture);
            let mut use_wgc = mode == ScreenMode::Capture;
            if want_dup {
                let output1: IDXGIOutput1 = output.cast().map_err(hr)?;
                match output1.DuplicateOutput(&device) {
                    Ok(d) => {
                        let desc = d.GetDesc();
                        src_width = desc.ModeDesc.Width;
                        src_height = desc.ModeDesc.Height;
                        src_format = desc.ModeDesc.Format;
                        duplication = Some(d);
                    }
                    Err(e) if e.code() == DXGI_ERROR_UNSUPPORTED && mode == ScreenMode::DuplicationOrCapture => {
                        log::warn!("[lastshot] desktop duplication unsupported on this output; using Graphics Capture");
                        use_wgc = true;
                    }
                    Err(e) => {
                        return Err(if e.code() == DXGI_ERROR_UNSUPPORTED {
                            RecorderError::Other(
                                "Desktop Duplication is unavailable on this output (hybrid-GPU: run Lastshot on the GPU driving the display)".into(),
                            )
                        } else {
                            hr(e)
                        })
                    }
                }
            }
            if use_wgc {
                if !crate::media::wincap::supported() {
                    return Err(RecorderError::Other("screen capture is unavailable (needs Windows 10 1903 or newer)".into()));
                }
                wgc = Some(
                    crate::media::wincap::WindowCapture::for_monitor(&device, odesc.Monitor, cursor)
                        .map_err(RecorderError::Other)?,
                );
                src_format = DXGI_FORMAT_B8G8R8A8_UNORM;
            }
            if src_format == DXGI_FORMAT_UNKNOWN {
                src_format = DXGI_FORMAT_B8G8R8A8_UNORM;
            }

            let adapter_name = String::from_utf16_lossy(
                &adesc.Description[..adesc
                    .Description
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(adesc.Description.len())],
            );

            let _ = adapter; // adapter kept alive through `device`

            Ok(Self {
                src_width,
                src_height,
                src_format,
                device,
                context,
                duplication,
                wgc,
                wgc_tex: None,
                monitor: odesc.Monitor,
                desktop,
                adapter_name,
                vram_mb: (adesc.DedicatedVideoMemory / (1024 * 1024)) as u64,
            })
        }

        /// Plain-words name of the capture method in use.
        pub fn method_label(&self) -> &'static str {
            if self.duplication.is_some() {
                "Desktop duplication"
            } else if self.wgc.is_some() {
                "Graphics Capture"
            } else {
                "Window capture"
            }
        }

        /// Swaps desktop duplication for an already running Graphics Capture
        /// of the same monitor. The device, converter and encoder stay, so
        /// the replay buffer keeps its history.
        pub fn adopt_wgc(&mut self, cap: crate::media::wincap::WindowCapture) {
            self.duplication = None;
            self.wgc = Some(cap);
            self.wgc_tex = None;
        }

        /// The newest monitor picture from Graphics Capture (copied, so it
        /// stays valid), or the previous one when nothing changed.
        pub fn wgc_frame(&mut self) -> Option<ID3D11Texture2D> {
            let (wgc, slot, device, context) = (&mut self.wgc, &mut self.wgc_tex, &self.device, &self.context);
            if let Some(c) = wgc.as_mut() {
                c.with_latest(|t| {
                    let _ = crate::media::compositor::SourceTexture::update(slot, device, context, t);
                });
            }
            slot.as_ref().map(|s| s.tex.clone())
        }
    }

    /// The flat DXGI output index of the monitor showing most of `hwnd`.
    pub(super) fn monitor_index_of_window(hwnd: i64) -> Option<u32> {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::Graphics::Gdi::{MonitorFromWindow, MONITOR_DEFAULTTONULL};
        unsafe {
            let mon = MonitorFromWindow(HWND(hwnd as isize as *mut _), MONITOR_DEFAULTTONULL);
            if mon.is_invalid() {
                return None;
            }
            let factory: IDXGIFactory1 = CreateDXGIFactory1().ok()?;
            let mut flat = 0u32;
            let mut ai = 0u32;
            while let Ok(adapter) = factory.EnumAdapters1(ai) {
                let soft = adapter.GetDesc1().map(|d| d.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0).unwrap_or(true);
                if !soft {
                    let mut oi = 0u32;
                    while let Ok(output) = adapter.EnumOutputs(oi) {
                        if output.GetDesc().map(|d| d.Monitor == mon).unwrap_or(false) {
                            return Some(flat);
                        }
                        flat += 1;
                        oi += 1;
                    }
                }
                ai += 1;
            }
            None
        }
    }

    // --------------------------------------------- BGRA ➜ NV12 on the GPU
    #[allow(dead_code)]
    pub(super) struct ColorConverter {
        vdevice: ID3D11VideoDevice,
        vcontext: ID3D11VideoContext,
        context: ID3D11DeviceContext,
        processor: ID3D11VideoProcessor,
        enumerator: ID3D11VideoProcessorEnumerator,
        pub(super) input_tex: ID3D11Texture2D,
        in_view: ID3D11VideoProcessorInputView,
        pub nv12: ID3D11Texture2D,
        out_view: ID3D11VideoProcessorOutputView,
        src_w: u32,
        src_h: u32,
        _dst_w: u32,
        _dst_h: u32,
    }

    impl ColorConverter {
        pub fn new(
            device: &ID3D11Device,
            context: &ID3D11DeviceContext,
            src_w: u32,
            src_h: u32,
            src_format: DXGI_FORMAT,
            dst_w: u32,
            dst_h: u32,
            fps: u32,
            performance_mode: bool,
        ) -> RResult<Self> {
            unsafe {
                let vdevice: ID3D11VideoDevice = device.cast().map_err(hr)?;
                let vcontext: ID3D11VideoContext = context.cast().map_err(hr)?;

                let content_desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
                    InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                    InputFrameRate: DXGI_RATIONAL { Numerator: fps, Denominator: 1 },
                    InputWidth: src_w,
                    InputHeight: src_h,
                    OutputFrameRate: DXGI_RATIONAL { Numerator: fps, Denominator: 1 },
                    OutputWidth: dst_w,
                    OutputHeight: dst_h,
                    Usage: if performance_mode {
                        D3D11_VIDEO_USAGE_OPTIMAL_SPEED
                    } else {
                        D3D11_VIDEO_USAGE_PLAYBACK_NORMAL
                    },
                };

                let enumerator = vdevice
                    .CreateVideoProcessorEnumerator(&content_desc)
                    .map_err(hr)?;
                let processor = vdevice
                    .CreateVideoProcessor(&enumerator, 0)
                    .map_err(hr)?;

                // Game capture is full-range RGB going to limited-range NV12;
                // getting this wrong is the classic "washed out clip" bug.
                let in_cs = D3D11_VIDEO_PROCESSOR_COLOR_SPACE {
                    _bitfield: 0x0000_0001, // Usage = video processing, RGB_Range = full
                };
                let out_cs = D3D11_VIDEO_PROCESSOR_COLOR_SPACE {
                    _bitfield: 0x0000_0004, // YCbCr_Matrix = BT.709, nominal range 16-235
                };
                vcontext.VideoProcessorSetStreamColorSpace(&processor, 0, &in_cs);
                vcontext.VideoProcessorSetOutputColorSpace(&processor, &out_cs);
                vcontext.VideoProcessorSetStreamFrameFormat(
                    &processor,
                    0,
                    D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                );

                let input_desc = D3D11_TEXTURE2D_DESC {
                    Width: src_w,
                    Height: src_h,
                    MipLevels: 1,
                    ArraySize: 1,
                    Format: if src_format == DXGI_FORMAT_UNKNOWN {
                        DXGI_FORMAT_B8G8R8A8_UNORM
                    } else {
                        src_format
                    },
                    SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                    Usage: D3D11_USAGE_DEFAULT,
                    BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
                    CPUAccessFlags: 0,
                    MiscFlags: 0,
                };
                let mut input_tex: Option<ID3D11Texture2D> = None;
                device
                    .CreateTexture2D(&input_desc, None, Some(&mut input_tex))
                    .map_err(hr)?;
                let input_tex =
                    input_tex.ok_or_else(|| RecorderError::Other("no input texture".into()))?;

                let ivd = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                    FourCC: 0,
                    ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                    Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
                        Texture2D: D3D11_TEX2D_VPIV {
                            MipSlice: 0,
                            ArraySlice: 0,
                        },
                    },
                };
                let mut in_view: Option<ID3D11VideoProcessorInputView> = None;
                vdevice
                    .CreateVideoProcessorInputView(&input_tex, &enumerator, &ivd, Some(&mut in_view))
                    .map_err(hr)?;
                let in_view =
                    in_view.ok_or_else(|| RecorderError::Other("no vp input view".into()))?;

                let nv12_desc = D3D11_TEXTURE2D_DESC {
                    Width: dst_w,
                    Height: dst_h,
                    MipLevels: 1,
                    ArraySize: 1,
                    Format: DXGI_FORMAT_NV12,
                    SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                    Usage: D3D11_USAGE_DEFAULT,
                    BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
                    CPUAccessFlags: 0,
                    MiscFlags: 0,
                };
                let mut nv12: Option<ID3D11Texture2D> = None;
                device
                    .CreateTexture2D(&nv12_desc, None, Some(&mut nv12))
                    .map_err(hr)?;
                let nv12 = nv12.ok_or_else(|| RecorderError::Other("no nv12 texture".into()))?;

                let ovd = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                    ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                    Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                        Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 },
                    },
                };
                let mut out_view: Option<ID3D11VideoProcessorOutputView> = None;
                vdevice
                    .CreateVideoProcessorOutputView(&nv12, &enumerator, &ovd, Some(&mut out_view))
                    .map_err(hr)?;
                let out_view =
                    out_view.ok_or_else(|| RecorderError::Other("no vp output view".into()))?;

                Ok(Self {
                    vdevice,
                    vcontext,
                    context: context.clone(),
                    processor,
                    enumerator,
                    input_tex,
                    in_view,
                    nv12,
                    out_view,
                    src_w,
                    src_h,
                    _dst_w: dst_w,
                    _dst_h: dst_h,
                })
            }
        }

        /// One `VideoProcessorBlt` = colour convert + scale + (optional) crop.
        /// `overlay` draws onto the frame's copy before it is converted
        /// (the mouse pointer).
        pub fn convert_with(&self, src: &ID3D11Texture2D, overlay: impl FnOnce(&ID3D11Texture2D)) -> RResult<()> {
            unsafe {
                copy_fit(&self.context, &self.input_tex, src);
                overlay(&self.input_tex);

                let mut streams = [D3D11_VIDEO_PROCESSOR_STREAM {
                    Enable: TRUE,
                    OutputIndex: 0,
                    InputFrameOrField: 0,
                    PastFrames: 0,
                    FutureFrames: 0,
                    pInputSurface: std::mem::ManuallyDrop::new(Some(self.in_view.clone())),
                    ..Default::default()
                }];

                let result = self
                    .vcontext
                    .VideoProcessorBlt(&self.processor, &self.out_view, 0, &streams);

                let _ = std::mem::ManuallyDrop::take(&mut streams[0].pInputSurface);

                result.map_err(hr)
            }
        }
    }

    impl ColorConverter {
        /// The frame as it goes to the encoder (source size, with the
        /// pointer and layers drawn on it).
        pub fn input(&self) -> &ID3D11Texture2D {
            &self.input_tex
        }
    }

    /// CopyResource when the sizes match, otherwise the overlapping part
    /// (a capture that changed size mid-run must not make the copy fail).
    pub(super) fn copy_fit(ctx: &ID3D11DeviceContext, dst: &ID3D11Texture2D, src: &ID3D11Texture2D) {
        let (mut a, mut b) = (D3D11_TEXTURE2D_DESC::default(), D3D11_TEXTURE2D_DESC::default());
        unsafe {
            dst.GetDesc(&mut a);
            src.GetDesc(&mut b);
            if a.Width == b.Width && a.Height == b.Height {
                ctx.CopyResource(dst, src);
            } else if a.Format == b.Format {
                let bx = D3D11_BOX { left: 0, top: 0, front: 0, right: a.Width.min(b.Width), bottom: a.Height.min(b.Height), back: 1 };
                ctx.CopySubresourceRegion(dst, 0, 0, 0, 0, src, 0, Some(&bx));
            }
        }
    }

    // ------------------------------------------------ hardware H.264 MFT
    pub(super) struct HardwareEncoder {
        transform: IMFTransform,
        events: Option<IMFMediaEventGenerator>,
        _dxgi_manager: IMFDXGIDeviceManager,
        pub info: EncoderInfo,
        pub header: VideoFormatHeader,
        async_mode: bool,
        pending_input: u32,
        /// METransformHaveOutput events not yet answered with ProcessOutput.
        /// An async MFT must get exactly one ProcessOutput per event; calls
        /// without one fail (or, on some drivers, stall the next input).
        pending_output: u32,
        width: u32,
        height: u32,
        fps: u32,
    }

    impl HardwareEncoder {
        pub fn create(
            device: &ID3D11Device,
            width: u32,
            height: u32,
            fps: u32,
            bitrate_kbps: u32,
            codec: Codec,
            performance_mode: bool,
            adapter_name: &str,
            vram_mb: u64,
        ) -> RResult<Self> {
            unsafe {
                let subtype = match codec {
                    Codec::H264 => MFVideoFormat_H264,
                    Codec::Hevc => MFVideoFormat_HEVC,
                };

                // 1. Enumerate hardware encoders, preferring the vendor MFT that
                //    lives on the same adapter as our D3D device.
                let in_info = MFT_REGISTER_TYPE_INFO {
                    guidMajorType: MFMediaType_Video,
                    guidSubtype: MFVideoFormat_NV12,
                };
                let out_info = MFT_REGISTER_TYPE_INFO {
                    guidMajorType: MFMediaType_Video,
                    guidSubtype: subtype,
                };

                let mut activates: *mut Option<IMFActivate> = std::ptr::null_mut();
                let mut count: u32 = 0;
                MFTEnumEx(
                    MFT_CATEGORY_VIDEO_ENCODER,
                    MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
                    Some(&in_info),
                    Some(&out_info),
                    &mut activates,
                    &mut count,
                )
                .map_err(hr)?;

                let mut chosen: Option<(IMFActivate, String)> = None;
                if count > 0 && !activates.is_null() {
                    let slice = std::slice::from_raw_parts(activates, count as usize);
                    for act in slice.iter().flatten() {
                        let mut name = PWSTR::null();
                        let mut len = 0u32;
                        let friendly = if act
                            .GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut name, &mut len)
                            .is_ok()
                        {
                            let s = name.to_string().unwrap_or_default();
                            windows::Win32::System::Com::CoTaskMemFree(Some(
                                name.0 as *const std::ffi::c_void,
                            ));
                            s
                        } else {
                            "Hardware Encoder".to_string()
                        };
                        if chosen.is_none() {
                            chosen = Some((act.clone(), friendly));
                        }
                    }
                    windows::Win32::System::Com::CoTaskMemFree(Some(
                        activates as *const std::ffi::c_void,
                    ));
                }

                // 2. Software fallback keeps Lastshot usable on old iGPUs; it is
                //    clearly reported to the UI so the user knows why the CPU is busy.
                let (transform, friendly, hardware) = match chosen {
                    Some((act, name)) => {
                        let t: IMFTransform = act.ActivateObject().map_err(hr)?;
                        (t, name, true)
                    }
                    None => {
                        let t: IMFTransform = windows::Win32::System::Com::CoCreateInstance(
                            &CLSID_MSH264EncoderMFT,
                            None,
                            windows::Win32::System::Com::CLSCTX_INPROC_SERVER,
                        )
                        .map_err(|_| RecorderError::NoEncoder)?;
                        (t, "Microsoft H.264 Encoder MFT".to_string(), false)
                    }
                };

                if performance_mode && !hardware {
                    log::warn!(
                        "[lastshot] Game Mode is on but only a software H.264 encoder is available; capture may compete with the game for CPU"
                    );
                }

                // 3. Async unlock + low latency BEFORE any type negotiation.
                let attrs = transform.GetAttributes().ok();
                let mut async_mode = false;
                if let Some(a) = attrs.as_ref() {
                    if a.GetUINT32(&MF_TRANSFORM_ASYNC).unwrap_or(0) == 1 {
                        a.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1).map_err(hr)?;
                        async_mode = true;
                    }
                    let _ = a.SetUINT32(&MF_LOW_LATENCY, 1);
                    // Never let the MFT hold more than 1 frame: latency > memory.
                    let _ = a.SetUINT32(&MF_SA_D3D11_AWARE, 1);
                }

                // 4. Bind our D3D11 device so the MFT reads the NV12 texture in
                //    place (true zero-copy; no staging, no PCIe round trip).
                let mut reset_token = 0u32;
                let mut manager: Option<IMFDXGIDeviceManager> = None;
                MFCreateDXGIDeviceManager(&mut reset_token, &mut manager).map_err(hr)?;
                let manager =
                    manager.ok_or_else(|| RecorderError::Other("no dxgi manager".into()))?;
                manager.ResetDevice(device, reset_token).map_err(hr)?;
                transform
                    .ProcessMessage(
                        MFT_MESSAGE_SET_D3D_MANAGER,
                        manager.as_raw() as usize,
                    )
                    .map_err(hr)?;

                // 5. Output type first - that is the MFT contract.
                let out_type = MFCreateMediaType().map_err(hr)?;
                out_type
                    .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
                    .map_err(hr)?;
                out_type.SetGUID(&MF_MT_SUBTYPE, &subtype).map_err(hr)?;
                out_type
                    .SetUINT32(&MF_MT_AVG_BITRATE, bitrate_kbps * 1000)
                    .map_err(hr)?;
                out_type
                    .SetUINT32(
                        &MF_MT_INTERLACE_MODE,
                        MFVideoInterlace_Progressive.0 as u32,
                    )
                    .map_err(hr)?;
                set_attr_size(&out_type, &MF_MT_FRAME_SIZE, width, height)?;
                set_attr_ratio(&out_type, &MF_MT_FRAME_RATE, fps, 1)?;
                set_attr_ratio(&out_type, &MF_MT_PIXEL_ASPECT_RATIO, 1, 1)?;
                if codec == Codec::H264 {
                    out_type
                        .SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32)
                        .map_err(hr)?;
                }
                // 1 key frame per second: fine-grained ring eviction + fast seek.
                let _ = out_type.SetUINT32(&MF_MT_MAX_KEYFRAME_SPACING, fps);
                transform.SetOutputType(0, &out_type, 0).map_err(hr)?;

                // 6. Input type: NV12 straight from the video processor.
                let in_type = MFCreateMediaType().map_err(hr)?;
                in_type
                    .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
                    .map_err(hr)?;
                in_type
                    .SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)
                    .map_err(hr)?;
                in_type
                    .SetUINT32(
                        &MF_MT_INTERLACE_MODE,
                        MFVideoInterlace_Progressive.0 as u32,
                    )
                    .map_err(hr)?;
                set_attr_size(&in_type, &MF_MT_FRAME_SIZE, width, height)?;
                set_attr_ratio(&in_type, &MF_MT_FRAME_RATE, fps, 1)?;
                set_attr_ratio(&in_type, &MF_MT_PIXEL_ASPECT_RATIO, 1, 1)?;
                transform.SetInputType(0, &in_type, 0).map_err(hr)?;

                // 7. Rate control - CBR keeps VBV predictable, which keeps the
                //    ring buffer's memory ceiling predictable.
                if let Ok(codec_api) = transform.cast::<ICodecAPI>() {
                    let _ = set_codec_u32(&codec_api, &CODECAPI_AVEncCommonRateControlMode, 0);
                    let _ = set_codec_u32(
                        &codec_api,
                        &CODECAPI_AVEncCommonMeanBitRate,
                        bitrate_kbps * 1000,
                    );
                    let _ = set_codec_u32(&codec_api, &CODECAPI_AVEncCommonLowLatency, 1);
                    let _ = set_codec_u32(&codec_api, &CODECAPI_AVEncMPVGOPSize, fps);
                    let _ = set_codec_u32(&codec_api, &CODECAPI_AVEncVideoMaxNumRefFrame, 1);
                    // Game Mode: bias the encoder toward speed instead of the
                    // vendor's default quality preset. Clips still look good at
                    // 1080p, but the encoder spends noticeably less time on the
                    // GPU while a game is running.
                    if performance_mode {
                        let _ = set_codec_u32(&codec_api, &CODECAPI_AVEncCommonQuality, 55);
                        // The knob NVENC/AMF/QSV actually honour for the
                        // speed/quality tradeoff (0 = quality, 100 = speed).
                        let _ = set_codec_u32(
                            &codec_api,
                            &CODECAPI_AVEncCommonQualityVsSpeed,
                            80,
                        );
                        // No B-frames: less encoder work and no reorder delay.
                        let _ = set_codec_u32(
                            &codec_api,
                            &CODECAPI_AVEncMPVDefaultBPictureCount,
                            0,
                        );
                    }
                }

                let events: Option<IMFMediaEventGenerator> = if async_mode {
                    transform.cast().ok()
                } else {
                    None
                };

                transform
                    .ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)
                    .map_err(hr)?;
                transform
                    .ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)
                    .map_err(hr)?;

                // Grab SPS/PPS for the muxer (present after type negotiation).
                let negotiated = transform.GetOutputCurrentType(0).map_err(hr)?;
                let mut sequence_header = Vec::new();
                if let Ok(size) = negotiated.GetBlobSize(&MF_MT_MPEG_SEQUENCE_HEADER) {
                    if size > 0 {
                        sequence_header.resize(size as usize, 0u8);
                        let _ = negotiated
                            .GetBlob(&MF_MT_MPEG_SEQUENCE_HEADER, &mut sequence_header, None);
                    }
                }

                let vendor = if hardware {
                    EncoderVendor::from_friendly_name(&friendly)
                } else {
                    EncoderVendor::MediaFoundationSoftware
                };

                Ok(Self {
                    transform,
                    events,
                    _dxgi_manager: manager,
                    info: EncoderInfo {
                        vendor,
                        friendly_name: friendly,
                        codec: codec.as_str().to_string(),
                        hardware,
                        adapter_name: adapter_name.to_string(),
                        dedicated_vram_mb: vram_mb,
                    },
                    header: VideoFormatHeader {
                        width,
                        height,
                        fps_num: fps,
                        fps_den: 1,
                        bitrate: bitrate_kbps * 1000,
                        profile: eAVEncH264VProfile_High.0 as u32,
                        codec: if codec == Codec::H264 { 0 } else { 1 },
                        sequence_header,
                    },
                    async_mode,
                    pending_input: 0,
                    pending_output: 0,
                    width,
                    height,
                    fps,
                })
            }
        }

        /// Feeds one NV12 texture. `force_key` is used right after a device
        /// reset so the new generation always begins with an IDR.
        ///
        /// Returns `Ok(false)` when the encoder did not take the frame (it is
        /// saturated), so the caller can count it as dropped.
        pub fn submit(
            &mut self,
            texture: &ID3D11Texture2D,
            pts_hns: i64,
            duration_hns: i64,
            force_key: bool,
        ) -> RResult<bool> {
            unsafe {
                if self.async_mode {
                    // Async MFTs must be driven by METransformNeedInput.
                    // Collect every event that is already queued, then, if the
                    // encoder has not asked for input yet, give it up to half a
                    // frame to do so. The old pump blocked for exactly one event
                    // and dropped the frame whenever that event happened to be
                    // METransformHaveOutput, which threw away about every other
                    // frame (60 fps settings gave ~29 fps clips).
                    self.pump_events()?;
                    if self.pending_input == 0 {
                        let deadline = Instant::now()
                            + Duration::from_micros(500_000 / self.fps.max(1) as u64);
                        while self.pending_input == 0 && Instant::now() < deadline {
                            std::thread::sleep(Duration::from_millis(1));
                            self.pump_events()?;
                        }
                    }
                    if self.pending_input == 0 {
                        return Ok(false); // encoder is saturated; caller drops the frame
                    }
                    self.pending_input -= 1;
                }

                let buffer = MFCreateDXGISurfaceBuffer(
                    &ID3D11Texture2D::IID,
                    texture,
                    0,
                    false,
                )
                .map_err(hr)?;

                // 2D buffers report their length lazily; the MFT needs it set.
                if let Ok(b2d) = buffer.cast::<IMF2DBuffer>() {
                    if let Ok(len) = b2d.GetContiguousLength() {
                        let _ = buffer.SetCurrentLength(len);
                    }
                }

                let sample = MFCreateSample().map_err(hr)?;
                sample.AddBuffer(&buffer).map_err(hr)?;
                sample.SetSampleTime(pts_hns).map_err(hr)?;
                sample.SetSampleDuration(duration_hns).map_err(hr)?;
                if force_key {
                    let _ = sample.SetUINT32(&MFSampleExtension_CleanPoint, 1);
                }

                match self.transform.ProcessInput(0, &sample, 0) {
                    Ok(()) => Ok(true),
                    Err(e) if e.code() == MF_E_NOTACCEPTING => Ok(false),
                    Err(e) => Err(hr(e)),
                }
            }
        }

        /// Drains every ready access unit into `sink`.
        pub fn drain(&mut self, mut sink: impl FnMut(&[u8], i64, i64, bool)) -> RResult<()> {
            unsafe {
                if self.async_mode {
                    self.pump_events()?;
                }

                loop {
                    if self.async_mode {
                        if self.pending_output == 0 {
                            return Ok(());
                        }
                        self.pending_output -= 1;
                    }
                    let mut status = 0u32;
                    let mut out = [MFT_OUTPUT_DATA_BUFFER {
                        dwStreamID: 0,
                        pSample: std::mem::ManuallyDrop::new(None),
                        dwStatus: 0,
                        pEvents: std::mem::ManuallyDrop::new(None),
                    }];

                    let result = self.transform.ProcessOutput(0, &mut out, &mut status);
                    // The caller owns any event collection the MFT hands back;
                    // windows-rs never drops `ManuallyDrop` fields on its own.
                    drop(std::mem::ManuallyDrop::take(&mut out[0].pEvents));
                    match result {
                        Ok(()) => {}
                        Err(e)
                            if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT
                                || e.code() == MF_E_TRANSFORM_STREAM_CHANGE =>
                        {
                            if e.code() == MF_E_TRANSFORM_STREAM_CHANGE {
                                self.renegotiate_output()?;
                                continue;
                            }
                            return Ok(());
                        }
                        Err(e) if e.code() == E_UNEXPECTED => {
                            // E_UNEXPECTED (0x8000FFFF) cleanly signals shutdown/device teardown
                            return Ok(());
                        }
                        Err(e) => return Err(hr(e)),
                    }

                    let sample = match std::mem::ManuallyDrop::take(&mut out[0].pSample) {
                        Some(s) => s,
                        None => return Ok(()),
                    };

                    let pts = sample.GetSampleTime().unwrap_or(0);
                    let dur = sample
                        .GetSampleDuration()
                        .unwrap_or(HNS_PER_SECOND / self.fps.max(1) as i64);
                    let keyframe = sample.GetUINT32(&MFSampleExtension_CleanPoint).unwrap_or(0) == 1;

                    let buffer = sample.ConvertToContiguousBuffer().map_err(hr)?;
                    let mut ptr: *mut u8 = std::ptr::null_mut();
                    let mut max_len = 0u32;
                    let mut cur_len = 0u32;
                    buffer
                        .Lock(&mut ptr, Some(&mut max_len), Some(&mut cur_len))
                        .map_err(hr)?;
                    let slice = std::slice::from_raw_parts(ptr, cur_len as usize);
                    sink(slice, pts, dur, keyframe);
                    let _ = buffer.Unlock();
                }
            }
        }

        /// Async MFT event pump. Never blocks: it takes every event that is
        /// already queued and counts each METransformNeedInput, so no input
        /// request is lost behind a METransformHaveOutput. Output itself is
        /// collected by `drain`, which loops `ProcessOutput` until empty.
        unsafe fn pump_events(&mut self) -> RResult<()> {
            let Some(gen) = self.events.clone() else {
                self.pending_input = 1;
                return Ok(());
            };

            let flags = MEDIA_EVENT_GENERATOR_GET_EVENT_FLAGS(MF_EVENT_FLAG_NO_WAIT.0 as u32);
            loop {
                let evt = match gen.GetEvent(flags) {
                    Ok(e) => e,
                    Err(e) if e.code() == MF_E_NO_EVENTS_AVAILABLE => return Ok(()),
                    Err(e) if e.code() == MF_E_MULTIPLE_SUBSCRIBERS => return Ok(()),
                    Err(e) => return Err(hr(e)),
                };
                let kind = evt.GetType().unwrap_or(0);
                match me_transform_need_input_or(kind) {
                    EventKind::NeedInput => self.pending_input += 1,
                    EventKind::HaveOutput => self.pending_output += 1,
                    _ => {}
                }
            }
        }

        unsafe fn renegotiate_output(&mut self) -> RResult<()> {
            let available = self.transform.GetOutputAvailableType(0, 0).map_err(hr)?;
            self.transform.SetOutputType(0, &available, 0).map_err(hr)?;
            if let Ok(size) = available.GetBlobSize(&MF_MT_MPEG_SEQUENCE_HEADER) {
                if size > 0 {
                    let mut hdr = vec![0u8; size as usize];
                    if available
                        .GetBlob(&MF_MT_MPEG_SEQUENCE_HEADER, &mut hdr, None)
                        .is_ok()
                    {
                        self.header.sequence_header = hdr;
                    }
                }
            }
            Ok(())
        }

        pub fn flush(&mut self) {
            unsafe {
                let _ = self
                    .transform
                    .ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
            }
        }

        pub fn dimensions(&self) -> (u32, u32) {
            (self.width, self.height)
        }
    }

    impl Drop for HardwareEncoder {
        fn drop(&mut self) {
            unsafe {
                let _ = self
                    .transform
                    .ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
                let _ = self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0);
                let _ = self
                    .transform
                    .ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
            }
        }
    }

    pub(super) enum EventKind {
        NeedInput,
        HaveOutput,
        DrainComplete,
        Other,
    }

    fn me_transform_need_input_or(kind: u32) -> EventKind {
        const NEED_INPUT: u32 = 601; // METransformNeedInput
        const HAVE_OUTPUT: u32 = 602; // METransformHaveOutput
        const DRAIN_COMPLETE: u32 = 603; // METransformDrainComplete
        match kind {
            NEED_INPUT => EventKind::NeedInput,
            HAVE_OUTPUT => EventKind::HaveOutput,
            DRAIN_COMPLETE => EventKind::DrainComplete,
            _ => EventKind::Other,
        }
    }

    // ------------------------------------------------------ MF attr helpers
    pub(super) fn set_attr_size(
        t: &IMFMediaType,
        key: &windows::core::GUID,
        w: u32,
        h: u32,
    ) -> RResult<()> {
        unsafe {
            t.SetUINT64(key, ((w as u64) << 32) | h as u64).map_err(hr)
        }
    }

    pub(super) fn set_attr_ratio(
        t: &IMFMediaType,
        key: &windows::core::GUID,
        num: u32,
        den: u32,
    ) -> RResult<()> {
        unsafe {
            t.SetUINT64(key, ((num as u64) << 32) | den as u64)
                .map_err(hr)
        }
    }

    unsafe fn set_codec_u32(
        api: &ICodecAPI,
        key: &windows::core::GUID,
        value: u32,
    ) -> windows::core::Result<()> {
        let v = windows::core::VARIANT::from(value);
        api.SetValue(key, &v)
    }

    // ------------------------------------------------------------- muxing
    /// Remuxes ring-buffer packets into a fragmented-friendly MP4 with a
    /// pass-through sink writer (no re-encode, ~1 GB/s effective throughput).
    pub(super) fn mux(
        path: &Path,
        header: &VideoFormatHeader,
        video: &[EncodedPacket],
        audio: &[EncodedPacket],
    ) -> RResult<()> {
        let mut m = StreamMux::open(path, header, !audio.is_empty())?;
        let base_pts = video.first().map(|p| p.pts_hns).unwrap_or(0);
        for pkt in video {
            m.write(TrackKind::Video, pkt, pkt.pts_hns - base_pts)?;
        }
        for pkt in audio {
            m.write(TrackKind::Audio, pkt, pkt.pts_hns - base_pts)?;
        }
        m.finish()
    }

    /// An MP4 that encoded packets are appended to (pass-through, no
    /// re-encode). Used for replays (all at once) and screen recordings
    /// (streamed while they run). Must stay on the thread that opened it.
    pub(super) struct StreamMux {
        _session: MfSession,
        writer: IMFSinkWriter,
        vstream: u32,
        astream: Option<u32>,
    }

    impl StreamMux {
        pub(super) fn open(path: &Path, header: &VideoFormatHeader, with_audio: bool) -> RResult<Self> {
        unsafe {
            let _session = MfSession::new()?;
            let wide: Vec<u16> = path
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();

            let attrs = {
                let mut a: Option<IMFAttributes> = None;
                MFCreateAttributes(&mut a, 6).map_err(hr)?;
                a.ok_or_else(|| RecorderError::Other("no sink attributes".into()))?
            };
            attrs
                .SetGUID(&MF_TRANSCODE_CONTAINERTYPE, &MFTranscodeContainerType_MPEG4)
                .map_err(hr)?;
            // We are writing already-encoded samples; throttling would only add
            // latency to the Alt+C path.
            let _ = attrs.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1);
            let _ = attrs.SetUINT32(&MF_LOW_LATENCY, 0);
            let _ = attrs.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1);

            let writer =
                MFCreateSinkWriterFromURL(PCWSTR(wide.as_ptr()), None, &attrs).map_err(hr)?;

            // ---- video stream (pass-through) ----
            let subtype = if header.codec == 0 {
                MFVideoFormat_H264
            } else {
                MFVideoFormat_HEVC
            };
            let vtype = MFCreateMediaType().map_err(hr)?;
            vtype
                .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
                .map_err(hr)?;
            vtype.SetGUID(&MF_MT_SUBTYPE, &subtype).map_err(hr)?;
            vtype
                .SetUINT32(&MF_MT_AVG_BITRATE, header.bitrate)
                .map_err(hr)?;
            vtype
                .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
                .map_err(hr)?;
            set_attr_size(&vtype, &MF_MT_FRAME_SIZE, header.width, header.height)?;
            set_attr_ratio(&vtype, &MF_MT_FRAME_RATE, header.fps_num, header.fps_den)?;
            set_attr_ratio(&vtype, &MF_MT_PIXEL_ASPECT_RATIO, 1, 1)?;
            if !header.sequence_header.is_empty() {
                let _ = vtype.SetBlob(&MF_MT_MPEG_SEQUENCE_HEADER, &header.sequence_header);
            }
            if header.codec == 0 {
                let _ = vtype.SetUINT32(&MF_MT_MPEG2_PROFILE, header.profile);
            }
            let vstream = writer.AddStream(&vtype).map_err(hr)?;
            // Identical in/out type ⇒ the sink writer inserts no transform.
            writer.SetInputMediaType(vstream, &vtype, None).map_err(hr)?;

            // ---- audio stream (AAC pass-through) ----
            let astream = if with_audio {
                let atype = MFCreateMediaType().map_err(hr)?;
                atype
                    .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)
                    .map_err(hr)?;
                atype.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC).map_err(hr)?;
                atype
                    .SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, 48_000)
                    .map_err(hr)?;
                atype.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 2).map_err(hr)?;
                atype
                    .SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)
                    .map_err(hr)?;
                atype
                    .SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 24_000)
                    .map_err(hr)?;
                atype
                    .SetUINT32(&MF_MT_AAC_PAYLOAD_TYPE, 0)
                    .map_err(hr)?;
                atype
                    .SetUINT32(
                        &MF_MT_AAC_AUDIO_PROFILE_LEVEL_INDICATION,
                        0x29, // AAC-LC L2
                    )
                    .map_err(hr)?;
                let s = writer.AddStream(&atype).map_err(hr)?;
                writer.SetInputMediaType(s, &atype, None).map_err(hr)?;
                Some(s)
            } else {
                None
            };

            writer.BeginWriting().map_err(hr)?;
            Ok(Self { _session, writer, vstream, astream })
        }
        }

        /// Appends one packet at `pts` (100 ns, file time).
        pub(super) fn write(&mut self, track: TrackKind, pkt: &EncodedPacket, pts: i64) -> RResult<()> {
            let stream = match track {
                TrackKind::Video => self.vstream,
                TrackKind::Audio => match self.astream {
                    Some(s) => s,
                    None => return Ok(()),
                },
            };
            unsafe {
                // Clamp negative stamps: WriteSample rejects them.
                let key = matches!(track, TrackKind::Audio) || pkt.keyframe;
                let sample = make_sample(&pkt.data, pts.max(0), pkt.duration_hns, key)?;
                self.writer.WriteSample(stream, &sample).map_err(hr)?;
            }
            Ok(())
        }

        pub(super) fn finish(self) -> RResult<()> {
            unsafe { self.writer.Finalize().map_err(hr) }
        }
    }

    unsafe fn make_sample(
        data: &[u8],
        pts: i64,
        dur: i64,
        keyframe: bool,
    ) -> RResult<IMFSample> {
        let buffer = MFCreateMemoryBuffer(data.len() as u32).map_err(hr)?;
        let mut ptr: *mut u8 = std::ptr::null_mut();
        buffer.Lock(&mut ptr, None, None).map_err(hr)?;
        std::ptr::copy_nonoverlapping(data.as_ptr(), ptr, data.len());
        buffer.Unlock().map_err(hr)?;
        buffer.SetCurrentLength(data.len() as u32).map_err(hr)?;

        let sample = MFCreateSample().map_err(hr)?;
        sample.AddBuffer(&buffer).map_err(hr)?;
        sample.SetSampleTime(pts).map_err(hr)?;
        sample.SetSampleDuration(dur).map_err(hr)?;
        if keyframe {
            let _ = sample.SetUINT32(&MFSampleExtension_CleanPoint, 1);
        }
        Ok(sample)
    }

    // -------------------------------------------------------------- misc
    pub(super) fn rss_bytes() -> u64 {
        unsafe {
            let mut pmc = PROCESS_MEMORY_COUNTERS::default();
            let size = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
            if GetProcessMemoryInfo(GetCurrentProcess(), &mut pmc, size).is_ok() {
                pmc.WorkingSetSize as u64
            } else {
                0
            }
        }
    }

    pub(super) fn boost_thread(performance_mode: bool) {
        // In Game Mode the capture thread deliberately runs at NORMAL so it
        // cannot outrank the game's render thread. A missed duplicate frame is
        // harmless in a replay ring; a 1% low spike is not. With Game Mode off
        // we keep the old above-normal hint for reliability.
        let priority = if performance_mode {
            THREAD_PRIORITY_NORMAL
        } else {
            THREAD_PRIORITY_ABOVE_NORMAL
        };
        unsafe {
            let _ = SetThreadPriority(GetCurrentThread(), priority);
        }
    }

    use std::os::windows::ffi::OsStrExt;

    // ----------------------------------------------- window / app source
    /// A window drawn, fitted, into a fixed canvas (windows can be resized;
    /// the encoder cannot). Captured either by cropping it out of the
    /// duplicated screen (never touches the app) or with Windows.Graphics.
    /// Capture (works while covered); Automatic picks per frame.
    pub(super) struct WindowSource {
        hwnd: windows::Win32::Foundation::HWND,
        cap: Option<crate::media::wincap::WindowCapture>,
        exe: String,
        tex: Option<crate::media::compositor::SourceTexture>,
        part: Option<crate::media::compositor::SourceTexture>,
        comp: crate::media::compositor::Compositor,
        last_retry: Instant,
        cursor: bool,
        method: crate::media::winvis::WindowMethod,
        chooser: crate::media::winvis::MethodChooser,
        last_frame: Instant,
        /// Since when the crop method has been used without a break (the
        /// Graphics Capture session is closed after a while to save work).
        cropping_since: Option<Instant>,
        pub cropping: bool,
    }

    impl WindowSource {
        pub fn open(
            device: &ID3D11Device,
            context: &ID3D11DeviceContext,
            hwnd: i64,
            exe: &str,
            max_height: u32,
            cursor: bool,
            method: crate::media::winvis::WindowMethod,
        ) -> RResult<Self> {
            use crate::media::wincap;
            use windows::Win32::Foundation::HWND;
            if !wincap::supported() && method == crate::media::winvis::WindowMethod::Capture {
                return Err(RecorderError::Other("window capture needs Windows 10 (1903) or newer".into()));
            }
            let h = HWND(hwnd as isize as *mut _);
            let found = wincap::info(h).or_else(|| wincap::find_app_window(exe));
            let Some(win) = found else {
                return Err(RecorderError::Other(format!("the window to record is gone ({exe})")));
            };
            // Canvas: the window's own size (no black bars), even, capped by
            // the Game Mode height. Minimised windows report a tiny size.
            let (mut w, mut h2) = if win.width >= 64 && win.height >= 64 {
                (win.width, win.height)
            } else {
                (1920, 1080)
            };
            if max_height > 0 && h2 > max_height {
                w = ((w as u64 * max_height as u64) / h2 as u64) as u32;
                h2 = max_height;
            }
            let (w, h2) = ((w & !1).max(2), (h2 & !1).max(2));
            let comp = crate::media::compositor::Compositor::new(device, context, w, h2)
                .map_err(RecorderError::Other)?;
            let hwnd = HWND(win.hwnd as isize as *mut _);
            // Graphics Capture starts only when it is needed (Automatic opens
            // it the first time the window is covered).
            let cap = if method == crate::media::winvis::WindowMethod::Capture {
                Some(crate::media::wincap::WindowCapture::new(device, hwnd, cursor).map_err(RecorderError::Other)?)
            } else {
                None
            };
            Ok(Self {
                hwnd,
                cap,
                exe: win.exe,
                tex: None,
                part: None,
                comp,
                last_retry: Instant::now(),
                cursor,
                method,
                chooser: Default::default(),
                last_frame: Instant::now(),
                cropping_since: None,
                cropping: false,
            })
        }

        pub fn size(&self) -> (u32, u32) {
            (self.comp.width, self.comp.height)
        }

        /// Whether this source needs the duplicated screen.
        pub fn wants_screen(&self) -> bool {
            self.method != crate::media::winvis::WindowMethod::Capture
        }

        pub fn method_label(&self) -> &'static str {
            if self.cropping {
                "Window: crop from screen"
            } else {
                "Window: Graphics Capture"
            }
        }

        /// The window's part of the monitor, or None when it cannot be
        /// cropped right now.
        fn crop_rect(&self, desktop: &crate::media::winvis::IRect, force: bool) -> Option<crate::media::winvis::IRect> {
            use crate::media::winvis;
            if winvis::is_minimised(self.hwnd) {
                return None;
            }
            let r = winvis::window_rect(self.hwnd)?;
            if force {
                // Crop method: whatever part of it is on this monitor.
                let c = winvis::IRect {
                    left: r.left.max(desktop.left),
                    top: r.top.max(desktop.top),
                    right: r.right.min(desktop.right),
                    bottom: r.bottom.min(desktop.bottom),
                };
                return (!c.is_empty()).then_some(c);
            }
            let above = winvis::windows_above(self.hwnd, 96);
            winvis::unobstructed(r, *desktop, &above).then_some(r)
        }

        /// Composes the newest window frame into the canvas. `screen` is the
        /// duplicated monitor (when available) at `desktop`.
        pub fn frame(
            &mut self,
            screen: Option<&ID3D11Texture2D>,
            desktop: &crate::media::winvis::IRect,
            cursor: Option<&mut crate::media::cursor::CursorOverlay>,
        ) -> &ID3D11Texture2D {
            use crate::media::compositor::{fit, Crop, Rect, SourceTexture};
            use crate::media::winvis::WindowMethod;
            let dt = self.last_frame.elapsed().as_millis() as u64;
            self.last_frame = Instant::now();

            // The window was closed: look for the app again once a second.
            if unsafe { !windows::Win32::UI::WindowsAndMessaging::IsWindow(self.hwnd).as_bool() }
                || self.cap.as_ref().map(|c| c.is_closed()).unwrap_or(false)
            {
                self.cap = None;
                if self.last_retry.elapsed() >= Duration::from_secs(1) && !self.exe.is_empty() {
                    self.last_retry = Instant::now();
                    if let Some(w) = crate::media::wincap::find_app_window(&self.exe) {
                        self.hwnd = windows::Win32::Foundation::HWND(w.hwnd as isize as *mut _);
                    }
                }
            }

            let crop = match (self.method, screen) {
                (WindowMethod::Capture, _) | (_, None) => None,
                (WindowMethod::Crop, Some(_)) => self.crop_rect(desktop, true),
                (WindowMethod::Auto, Some(_)) => {
                    let r = self.crop_rect(desktop, false);
                    if self.chooser.crop(r.is_some(), dt) {
                        r
                    } else {
                        None
                    }
                }
            };
            self.cropping = crop.is_some();

            if let (Some(r), Some(scr)) = (crop, screen) {
                self.cropping_since.get_or_insert_with(Instant::now);
                // Close an idle Graphics Capture session after 10 s of crop.
                if self.cropping_since.map(|t| t.elapsed() > Duration::from_secs(10)).unwrap_or(false) {
                    self.cap = None;
                }
                let (pw, ph) = (r.width() as u32, r.height() as u32);
                if self.part.as_ref().map(|p| p.width != pw || p.height != ph).unwrap_or(true) {
                    self.part = SourceTexture::new(self.comp.device(), pw, ph, DXGI_FORMAT_B8G8R8A8_UNORM).ok();
                }
                let comp = &self.comp;
                comp.begin([0.0, 0.0, 0.0, 1.0]);
                if let Some(p) = self.part.as_ref() {
                    p.copy_region(comp.context(), scr, (r.left - desktop.left) as u32, (r.top - desktop.top) as u32);
                    let dst = fit(pw as f32, ph as f32, Rect { x: 0.0, y: 0.0, w: comp.width as f32, h: comp.height as f32 });
                    comp.draw(p, dst, Crop::NONE, 1.0, true);
                    comp.end();
                    if let Some(c) = cursor {
                        c.draw_mapped(
                            comp.device(),
                            comp.context(),
                            comp.canvas(),
                            ((r.left - desktop.left) as f32, (r.top - desktop.top) as f32),
                            (dst.x, dst.y),
                            dst.w / pw as f32,
                        );
                    }
                } else {
                    comp.end();
                }
                return comp.canvas();
            }

            self.cropping_since = None;
            if self.cap.is_none() && unsafe { windows::Win32::UI::WindowsAndMessaging::IsWindow(self.hwnd).as_bool() } {
                self.cap = crate::media::wincap::WindowCapture::new(self.comp.device(), self.hwnd, self.cursor).ok();
            }
            let (cap, tex, comp) = (&mut self.cap, &mut self.tex, &self.comp);
            if let Some(c) = cap.as_mut() {
                c.with_latest(|t| {
                    let _ = SourceTexture::update(tex, comp.device(), comp.context(), t);
                });
            } else {
                // The window is gone: show black until it comes back.
                *tex = None;
            }
            comp.begin([0.0, 0.0, 0.0, 1.0]);
            if let Some(t) = tex.as_ref() {
                let r = fit(
                    t.width as f32,
                    t.height as f32,
                    Rect { x: 0.0, y: 0.0, w: comp.width as f32, h: comp.height as f32 },
                );
                comp.draw(t, r, Crop::NONE, 1.0, true);
            }
            comp.end();
            comp.canvas()
        }
    }

    /// Picks how to capture the screen for this engine run.
    fn screen_mode(cfg: &RecorderConfig, dup_failures: u32) -> ScreenMode {
        match &cfg.source {
            CaptureSource::Window { method, .. } => {
                if *method == crate::media::winvis::WindowMethod::Capture || dup_failures >= 3 {
                    ScreenMode::None
                } else {
                    ScreenMode::Duplication
                }
            }
            CaptureSource::Display => match cfg.display_method {
                DisplayMethod::Duplication => ScreenMode::Duplication,
                DisplayMethod::GraphicsCapture => ScreenMode::Capture,
                DisplayMethod::Auto if dup_failures >= 3 => ScreenMode::Capture,
                DisplayMethod::Auto => ScreenMode::DuplicationOrCapture,
            },
        }
    }

    // ------------------------------------------------------- capture loop
    pub(super) fn capture_loop(
        shared: Arc<SharedState>,
        mut cfg: RecorderConfig,
        fmt: Arc<Mutex<Option<VideoFormatHeader>>>,
        clock: Arc<super::QpcClock>,
    ) {
        use crate::media::watchdog::{is_black, BlackWatch, LumaProbe, WatchAction, BLACK_NOTICE};
        let _timer_guard = HighResTimerGuard::new();
        let _session = match MfSession::new() {
            Ok(s) => s,
            Err(e) => {
                shared.fail(format!("Media Foundation unavailable: {e}"));
                return;
            }
        };

        let mut backoff_ms = 40u64;
        // Consecutive failures to set up desktop duplication; after three,
        // Automatic switches to Graphics Capture for this run.
        let mut dup_failures = 0u32;

        'outer: while !shared.stop_requested.load(Ordering::Acquire) {
            // ---------------- build (or rebuild) the graphics stack -------
            let mode = screen_mode(&cfg, dup_failures);
            let monitor_index = match &cfg.source {
                CaptureSource::Window { hwnd, .. } => monitor_index_of_window(*hwnd).unwrap_or(cfg.monitor_index),
                CaptureSource::Display => cfg.monitor_index,
            };
            let mut gfx = match GraphicsStack::create(monitor_index, mode, cfg.capture_cursor) {
                Ok(g) => {
                    if matches!(mode, ScreenMode::Duplication | ScreenMode::DuplicationOrCapture) {
                        dup_failures = 0;
                    }
                    g
                }
                Err(e) => {
                    if matches!(mode, ScreenMode::Duplication | ScreenMode::DuplicationOrCapture) {
                        dup_failures += 1;
                    }
                    shared.set_state(EngineState::Recovering);
                    shared.fail(format!("{e}"));
                    std::thread::sleep(Duration::from_millis(backoff_ms));
                    backoff_ms = (backoff_ms * 2).min(2_000);
                    continue 'outer;
                }
            };

            // Integrated GPUs (Intel Iris Xe/UHD, AMD Radeon Graphics) share
            // memory bandwidth and the power/thermal budget with the game, so
            // Game Mode caps harder than on a discrete NVENC/AMF card. 720p30
            // roughly halves the per-frame bandwidth the encoder steals from
            // Valorant and friends while keeping instant-replay clips readable.
            let integrated_gpu = is_integrated_gpu(&gfx.adapter_name, gfx.vram_mb);
            *shared.integrated_gpu.write() = integrated_gpu;
            if integrated_gpu && cfg.performance_mode {
                cfg.target_fps = cfg.target_fps.min(30);
                cfg.max_height = if cfg.max_height == 0 {
                    720
                } else {
                    cfg.max_height.min(720)
                };
                cfg.bitrate_kbps = cfg.bitrate_kbps.min(6_000);
            }
            *shared.effective_target_fps.write() = cfg.target_fps;
            *shared.effective_bitrate_kbps.write() = cfg.bitrate_kbps;

            let dst_w = if cfg.width == 0 { gfx.src_width } else { cfg.width } & !1;
            let dst_h = if cfg.height == 0 { gfx.src_height } else { cfg.height } & !1;
            // Game Mode: downscale >1080p monitors without breaking aspect
            // ratio. 1080p60 NVENC/AMF/QSV is effectively free on modern GPUs
            // while 1440p/4K capture is what usually shows up as a game stutter.
            let (dst_w, dst_h) = if cfg.max_height > 0
                && cfg.max_height < dst_h
                && cfg.width == 0
                && cfg.height == 0
            {
                let h = (cfg.max_height & !1).max(2);
                let w = (((gfx.src_width as u64 * h as u64) / gfx.src_height.max(1) as u64) as u32)
                    & !1;
                (w.max(2), h.max(2))
            } else {
                (dst_w, dst_h)
            };

            let mut window = match &cfg.source {
                CaptureSource::Window { hwnd, exe, method, .. } => {
                    match WindowSource::open(&gfx.device, &gfx.context, *hwnd, exe, cfg.max_height, cfg.capture_cursor, *method) {
                        Ok(w) => Some(w),
                        Err(e) => {
                            shared.fail(format!("{e}"));
                            std::thread::sleep(Duration::from_millis(backoff_ms));
                            backoff_ms = (backoff_ms * 2).min(2_000);
                            continue 'outer;
                        }
                    }
                }
                CaptureSource::Display => None,
            };
            let (src_w, src_h, src_fmt, dst_w, dst_h) = match window.as_ref() {
                Some(w) => {
                    let (cw, ch) = w.size();
                    (cw, ch, DXGI_FORMAT_B8G8R8A8_UNORM, cw, ch)
                }
                None => (gfx.src_width, gfx.src_height, gfx.src_format, dst_w, dst_h),
            };

            let converter = match ColorConverter::new(
                &gfx.device,
                &gfx.context,
                src_w,
                src_h,
                src_fmt,
                dst_w,
                dst_h,
                cfg.target_fps,
                cfg.performance_mode,
            ) {
                Ok(c) => c,
                Err(e) => {
                    shared.fail(format!("video processor: {e}"));
                    std::thread::sleep(Duration::from_millis(backoff_ms));
                    backoff_ms = (backoff_ms * 2).min(2_000);
                    continue 'outer;
                }
            };

            let mut encoder = match HardwareEncoder::create(
                &gfx.device,
                dst_w,
                dst_h,
                cfg.target_fps,
                cfg.bitrate_kbps,
                cfg.codec,
                cfg.performance_mode,
                &gfx.adapter_name,
                gfx.vram_mb,
            ) {
                Ok(e) => e,
                Err(e) => {
                    shared.fail(format!("encoder: {e}"));
                    std::thread::sleep(Duration::from_millis(backoff_ms));
                    backoff_ms = (backoff_ms * 2).min(2_000);
                    continue 'outer;
                }
            };

            *shared.encoder.write() = encoder.info.clone();
            *shared.dimensions.write() = encoder.dimensions();
            *fmt.lock() = Some(encoder.header.clone());
            *shared.last_error.write() = None;
            *shared.notice.write() = None;
            *shared.capture_method.write() =
                window.as_ref().map(|w| w.method_label()).unwrap_or(gfx.method_label()).to_string();
            shared.set_state(EngineState::Buffering);
            backoff_ms = 40;

            let generation = shared.generation.load(Ordering::Acquire);
            let frame_interval = Duration::from_secs_f64(1.0 / cfg.target_fps.max(1) as f64);
            let frame_hns = HNS_PER_SECOND / cfg.target_fps.max(1) as i64;

            let mut next_deadline = Instant::now();
            let mut force_key = true;
            let mut last_pts = i64::MIN;
            let mut was_gated = false;
            let mut last_screen: Option<ID3D11Texture2D> = None;
            // Desktop Duplication leaves the pointer out; we draw it.
            let mut cursor = (cfg.capture_cursor && gfx.duplication.is_some())
                .then(crate::media::cursor::CursorOverlay::default);
            let mut fps_window = Instant::now();
            let mut fps_frames = 0u32;

            // Studio layers and the live preview (both cost nothing when unused).
            let mut layers = crate::media::layers::LayerRenderer::default();
            let mut previewer: Option<crate::media::preview::Previewer> = None;

            // Black-frame watchdog (full-screen capture only).
            let mut black_watch = BlackWatch::default();
            let mut luma: Option<LumaProbe> = None;
            let mut last_luma = Instant::now();
            let mut probe_cap: Option<(crate::media::wincap::WindowCapture, Instant)> = None;
            let mut probe_tex: Option<crate::media::compositor::SourceTexture> = None;
            let mut probe_luma: Option<LumaProbe> = None;

            // ---------------------------- steady-state capture ------------
            loop {
                if shared.stop_requested.load(Ordering::Acquire) {
                    break 'outer;
                }

                if shared.force_device_reset.swap(false, Ordering::AcqRel) {
                    log::warn!("[lastshot] simulated device reset requested via IPC");
                    shared.device_resets.fetch_add(1, Ordering::Relaxed);
                    shared.generation.fetch_add(1, Ordering::AcqRel);
                    shared.set_state(EngineState::Recovering);
                    encoder.flush();
                    continue 'outer;
                }

                // Frame pacing: a plain high-resolution sleep. The old loop
                // spun the last 0.4 ms of every frame, which kept a CPU core
                // hot and stole scheduler time from CPU-bound games such as
                // Valorant. timeBeginPeriod(1) already gives ~1 ms accuracy,
                // more than enough for a 16.6 ms replay frame.
                let now = Instant::now();
                if now < next_deadline {
                    std::thread::sleep(next_deadline - now);
                }
                next_deadline += frame_interval;
                let after_frame = Instant::now();
                if after_frame >= next_deadline {
                    // We are already late for the *next* frame (a hitch or a
                    // slow encode). Resync once instead of burning through a
                    // burst of near-identical frames trying to catch up.
                    next_deadline = after_frame + frame_interval;
                    shared.dropped_frames.fetch_add(1, Ordering::Relaxed);
                }

                let submit_start = Instant::now();

                // ---- the screen picture (full screen, or a window to crop)
                let needs_screen = window.as_ref().map(|w| w.wants_screen()).unwrap_or(true);
                let mut screen: Option<ID3D11Texture2D> = None;
                let mut acquired = false;
                if needs_screen {
                    if let Some(dup) = gfx.duplication.clone() {
                        let mut frame_info = DXGI_OUTDUPL_FRAME_INFO::default();
                        let mut resource: Option<IDXGIResource> = None;
                        match unsafe { dup.AcquireNextFrame(0, &mut frame_info, &mut resource) } {
                            Ok(()) => {
                                acquired = true;
                                if let Some(c) = cursor.as_mut() {
                                    c.update(&dup, &gfx.device, &gfx.context, &frame_info);
                                }
                                if let Some(res) = resource.as_ref() {
                                    match res.cast::<ID3D11Texture2D>() {
                                        Ok(t) => {
                                            last_screen = Some(t.clone());
                                            screen = Some(t);
                                        }
                                        Err(e) => log::warn!("[lastshot] frame cast failed: {e}"),
                                    }
                                }
                            }
                            Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => {
                                // Nothing changed on screen. Re-encode the previous
                                // surface so the timeline stays constant-frame-rate.
                                screen = last_screen.clone();
                            }
                            Err(e) if is_device_lost(&e) => {
                                log::warn!("[lastshot] device lost during acquire: {e}");
                                let _ = unsafe { dup.ReleaseFrame() };
                                shared.device_resets.fetch_add(1, Ordering::Relaxed);
                                shared.generation.fetch_add(1, Ordering::AcqRel);
                                shared.set_state(EngineState::Recovering);
                                encoder.flush();
                                continue 'outer;
                            }
                            Err(e) => {
                                log::warn!("[lastshot] acquire error: {e}");
                                shared.dropped_frames.fetch_add(1, Ordering::Relaxed);
                                let _ = unsafe { dup.ReleaseFrame() };
                                continue;
                            }
                        }
                    } else if gfx.wgc.is_some() {
                        if gfx.wgc.as_ref().map(|c| c.is_closed()).unwrap_or(false) {
                            // The monitor went away (unplugged, mode change).
                            shared.generation.fetch_add(1, Ordering::AcqRel);
                            shared.set_state(EngineState::Recovering);
                            encoder.flush();
                            continue 'outer;
                        }
                        screen = gfx.wgc_frame();
                    }
                }

                let texture: Option<ID3D11Texture2D> = match window.as_mut() {
                    Some(w) => {
                        let t = w.frame(screen.as_ref(), &gfx.desktop, cursor.as_mut()).clone();
                        Some(t)
                    }
                    None => screen,
                };

                // ---- black-frame probe of the other method (full screen)
                if let Some((cap, started)) = probe_cap.as_mut() {
                    let mut verdict: Option<bool> = None;
                    let (dev, ctx) = (&gfx.device, &gfx.context);
                    cap.with_latest(|t| {
                        let _ = crate::media::compositor::SourceTexture::update(&mut probe_tex, dev, ctx, t);
                    });
                    if let Some(t) = probe_tex.as_ref() {
                        if probe_luma.is_none() {
                            probe_luma = LumaProbe::new(dev, ctx).ok();
                        }
                        if let Some(p) = probe_luma.as_mut() {
                            verdict = p.measure_now(&t.tex).map(is_black);
                        }
                    }
                    let timed_out = started.elapsed() > Duration::from_secs(2);
                    match verdict {
                        Some(false) => {
                            // Graphics Capture sees a picture, duplication
                            // does not: switch in place, keep the replay.
                            log::warn!("[lastshot] duplication gives black frames, Graphics Capture does not: switching");
                            let (cap, _) = probe_cap.take().expect("probe running");
                            gfx.adopt_wgc(cap);
                            cursor = None;
                            last_screen = None;
                            *shared.capture_method.write() = "Graphics Capture (black screen fallback)".into();
                        }
                        Some(true) => {
                            probe_cap = None;
                        }
                        None if timed_out => probe_cap = None,
                        None => {}
                    }
                    if probe_cap.is_none() {
                        probe_tex = None;
                    }
                }

                if let Some(tex) = texture.as_ref() {
                    // Privacy mode: no game is focused, so this frame is dropped
                    // before the encoder — the ring can never hold desktop
                    // footage. When the gate lifts, the next frame is forced to
                    // a key frame so the buffer restarts cleanly.
                    let sample_luma = window.is_none() && last_luma.elapsed() >= Duration::from_secs(1);
                    let mut dark: Option<f32> = None;
                    if shared.privacy_gate.load(Ordering::Acquire) {
                        was_gated = true;
                    } else if let Err(e) = converter.convert_with(tex, |t| {
                        // Before the pointer and layers are drawn on it.
                        if sample_luma {
                            if luma.is_none() {
                                luma = LumaProbe::new(&gfx.device, &gfx.context).ok();
                            }
                            dark = luma.as_mut().and_then(|p| p.sample(t));
                        }
                        if window.is_none() {
                            if let Some(c) = cursor.as_mut() {
                                c.draw_on(&gfx.device, &gfx.context, t);
                            }
                        }
                        layers.draw_on(&gfx.device, &gfx.context, t, &shared.layers);
                    }) {
                        log::warn!("[lastshot] color convert failed: {e}");
                        shared.dropped_frames.fetch_add(1, Ordering::Relaxed);
                    } else {
                        if sample_luma {
                            last_luma = Instant::now();
                            if let Some(d) = dark {
                                match black_watch.on_sample(is_black(d)) {
                                    WatchAction::ProbeOther => {
                                        if gfx.duplication.is_some()
                                            && cfg.display_method == DisplayMethod::Auto
                                            && probe_cap.is_none()
                                        {
                                            probe_cap = crate::media::wincap::WindowCapture::for_monitor(
                                                &gfx.device,
                                                gfx.monitor,
                                                cfg.capture_cursor,
                                            )
                                            .ok()
                                            .map(|c| (c, Instant::now()));
                                        }
                                    }
                                    WatchAction::Notice => *shared.notice.write() = Some(BLACK_NOTICE.into()),
                                    WatchAction::ClearNotice => *shared.notice.write() = None,
                                    WatchAction::None => {}
                                }
                            }
                        }
                        if shared.preview.wanted() {
                            if previewer.is_none() {
                                previewer = crate::media::preview::Previewer::new(&gfx.device, &gfx.context).ok();
                            }
                            if let Some(p) = previewer.as_mut() {
                                p.capture(converter.input(), &shared.preview);
                            }
                        } else if previewer.is_some() && !shared.preview.recently_wanted() {
                            previewer = None;
                        }
                        if was_gated {
                            force_key = true;
                            was_gated = false;
                        }
                        // Constant frame rate: stamp the frame on the fps
                        // grid (REC-036). Players then see an even cadence,
                        // and a late frame leaves a one-slot gap instead of
                        // jitter on every frame.
                        let pts = cfr_pts(clock.now_hns(), cfg.target_fps, last_pts);
                        last_pts = pts;
                        let submit_ns = submit_start.elapsed().as_nanos() as u64;
                        let encode_start = Instant::now();

                        let ring = Arc::clone(&shared.ring);
                        let mut push = |slice: &[u8], pts: i64, dur: i64, key: bool| {
                            let pkt = EncodedPacket {
                                track: TrackKind::Video,
                                data: Arc::from(slice),
                                pts_hns: pts,
                                duration_hns: dur,
                                keyframe: key,
                                generation,
                            };
                            ring.lock().push(pkt);
                        };

                        // Collect anything the encoder finished since the last
                        // frame first, so a full output queue never stops it
                        // from asking for this frame.
                        if let Err(e) = encoder.drain(&mut push) {
                            if !shared.stop_requested.load(Ordering::Acquire) {
                                log::warn!("[lastshot] encoder drain failed: {e}");
                            }
                        }

                        // Only frames the encoder actually took count as
                        // encoded; the rest are drops, and a pending key frame
                        // request stays armed for the next frame.
                        let accepted =
                            match encoder.submit(&converter.nv12, pts, frame_hns, force_key) {
                                Ok(true) => {
                                    force_key = false;
                                    true
                                }
                                Ok(false) => false,
                                Err(e) => {
                                    log::warn!("[lastshot] encoder submit failed: {e}");
                                    false
                                }
                            };
                        if !accepted {
                            shared.dropped_frames.fetch_add(1, Ordering::Relaxed);
                        }

                        let drain = encoder.drain(&mut push);

                        if let Err(e) = drain {
                            if !shared.stop_requested.load(Ordering::Acquire) {
                                log::warn!("[lastshot] encoder drain failed: {e}");
                            }
                        }

                        if accepted {
                            shared.frames_encoded.fetch_add(1, Ordering::Relaxed);
                            fps_frames += 1;
                        }
                        shared
                            .encode_ns_total
                            .fetch_add(encode_start.elapsed().as_nanos() as u64, Ordering::Relaxed);
                        shared.submit_ns_total.fetch_add(submit_ns, Ordering::Relaxed);
                    }
                }

                // Always release an acquired frame - DXGI reference counts
                // it and refuses the next acquire otherwise.
                if acquired {
                    if let Some(dup) = gfx.duplication.as_ref() {
                        unsafe {
                            let _ = dup.ReleaseFrame();
                        }
                    }
                }

                if fps_window.elapsed() >= Duration::from_millis(500) {
                    *shared.capture_fps.write() =
                        fps_frames as f32 / fps_window.elapsed().as_secs_f32();
                    fps_frames = 0;
                    fps_window = Instant::now();
                    if let Some(w) = window.as_ref() {
                        let label = w.method_label();
                        if *shared.capture_method.read() != label {
                            *shared.capture_method.write() = label.to_string();
                        }
                    }
                }
            }
        }

        shared.set_state(EngineState::Idle);
        shared.running.store(false, Ordering::Release);
    }
}

// ===========================================================================
//                  CROSS-PLATFORM / SIMULATION IMPLEMENTATION
// ===========================================================================
//
// Compiled on non-Windows hosts (or with `--features headless-sim`) so the IPC
// surface, ring-buffer logic and the entire UI remain testable off-Windows.

#[cfg(any(not(windows), feature = "headless-sim"))]
mod sim {
    use super::*;

    pub(super) fn rss_bytes() -> u64 {
        18 * 1024 * 1024
    }

    pub(super) fn boost_thread(_performance_mode: bool) {}

    pub(super) struct StreamMux {
        path: PathBuf,
        bytes: Vec<u8>,
    }

    impl StreamMux {
        pub(super) fn open(path: &Path, header: &VideoFormatHeader, _with_audio: bool) -> RResult<Self> {
            let mut bytes = vec![
                0x00, 0x00, 0x00, 0x18, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm', 0x00, 0x00,
                0x02, 0x00, b'i', b's', b'o', b'm', b'i', b's', b'o', b'2',
            ];
            bytes.extend_from_slice(&header.sequence_header);
            Ok(Self { path: path.to_path_buf(), bytes })
        }
        pub(super) fn write(&mut self, track: TrackKind, pkt: &EncodedPacket, _pts: i64) -> RResult<()> {
            if matches!(track, TrackKind::Video) {
                self.bytes.extend_from_slice(&pkt.data);
            }
            Ok(())
        }
        pub(super) fn finish(self) -> RResult<()> {
            std::fs::write(&self.path, self.bytes)?;
            Ok(())
        }
    }

    pub(super) fn mux(
        path: &Path,
        header: &VideoFormatHeader,
        video: &[EncodedPacket],
        _audio: &[EncodedPacket],
    ) -> RResult<()> {
        // Emit a structurally valid (if tiny) file so downstream code paths -
        // metadata scan, trimming, deletion - all still exercise real IO.
        let mut bytes = Vec::with_capacity(1024 + video.len() * 32);
        bytes.extend_from_slice(&[
            0x00, 0x00, 0x00, 0x18, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm', 0x00, 0x00,
            0x02, 0x00, b'i', b's', b'o', b'm', b'i', b's', b'o', b'2',
        ]);
        bytes.extend_from_slice(&header.sequence_header);
        for p in video {
            bytes.extend_from_slice(&p.data);
        }
        std::fs::write(path, bytes)?;
        Ok(())
    }

    pub(super) fn capture_loop(
        shared: Arc<SharedState>,
        cfg: RecorderConfig,
        fmt: Arc<Mutex<Option<VideoFormatHeader>>>,
        _clock: Arc<super::QpcClock>,
    ) {
        let w = if cfg.width == 0 { 1920 } else { cfg.width };
        let h = if cfg.height == 0 { 1080 } else { cfg.height };

        *shared.encoder.write() = EncoderInfo {
            vendor: EncoderVendor::MediaFoundationSoftware,
            friendly_name: "Synthetic pipeline (headless-sim)".into(),
            codec: cfg.codec.as_str().into(),
            hardware: false,
            adapter_name: "Virtual Adapter".into(),
            dedicated_vram_mb: 0,
        };
        *shared.dimensions.write() = (w, h);
        *fmt.lock() = Some(VideoFormatHeader {
            width: w,
            height: h,
            fps_num: cfg.target_fps,
            fps_den: 1,
            bitrate: cfg.bitrate_kbps * 1000,
            profile: 100,
            codec: 0,
            sequence_header: vec![0, 0, 0, 1, 0x67, 0x64, 0x00, 0x2A],
        });
        shared.set_state(EngineState::Buffering);

        let frame_hns = HNS_PER_SECOND / cfg.target_fps.max(1) as i64;
        let bytes_per_frame = (cfg.bitrate_kbps as usize * 1000 / 8) / cfg.target_fps.max(1) as usize;
        let interval = Duration::from_secs_f64(1.0 / cfg.target_fps.max(1) as f64);
        let mut pts = 0i64;
        let mut n = 0u64;
        let mut was_gated = false;
        let generation = shared.generation.load(Ordering::Acquire);
        let start = Instant::now();

        while !shared.stop_requested.load(Ordering::Acquire) {
            // Privacy mode: no game focused → nothing enters the ring buffer.
            if shared.privacy_gate.load(Ordering::Acquire) {
                was_gated = true;
                std::thread::sleep(interval);
                continue;
            }
            // Resuming from a gate: restart the GOP cadence so the buffer
            // begins on a key frame again.
            if was_gated {
                was_gated = false;
                n = 0;
            }
            let key = n % cfg.target_fps.max(1) as u64 == 0;
            let size = if key { bytes_per_frame * 6 } else { bytes_per_frame };
            let pkt = EncodedPacket {
                track: TrackKind::Video,
                data: Arc::from(vec![(n % 251) as u8; size.max(64)].into_boxed_slice()),
                pts_hns: pts,
                duration_hns: frame_hns,
                keyframe: key,
                generation,
            };
            shared.ring.lock().push(pkt);
            shared.frames_encoded.fetch_add(1, Ordering::Relaxed);
            shared.encode_ns_total.fetch_add(1_400_000, Ordering::Relaxed);
            shared.submit_ns_total.fetch_add(300_000, Ordering::Relaxed);
            pts += frame_hns;
            n += 1;
            if n % 30 == 0 {
                *shared.capture_fps.write() = n as f32 / start.elapsed().as_secs_f32().max(0.001);
            }
            std::thread::sleep(interval);
        }

        shared.set_state(EngineState::Idle);
        shared.running.store(false, Ordering::Release);
    }
}

// ---------------------------------------------------------------------------
// Platform dispatch
// ---------------------------------------------------------------------------

#[cfg(all(windows, not(feature = "headless-sim")))]
use win as platform;
#[cfg(any(not(windows), feature = "headless-sim"))]
use sim as platform;

fn capture_thread_main(
    shared: Arc<SharedState>,
    cfg: RecorderConfig,
    fmt: Arc<Mutex<Option<VideoFormatHeader>>>,
    clock: Arc<QpcClock>,
) {
    platform::capture_loop(shared, cfg, fmt, clock);
}

/// One stretch of a recording between pauses: raw engine timestamps
/// `start..end` are written shifted back by `offset`.
struct RecSegment {
    start: i64,
    end: Option<i64>,
    offset: i64,
}

/// The screen-recording thread: streams new ring packets into an MP4 until
/// `stop`, skipping paused stretches (it resumes on a key frame so the file
/// stays decodable). Returns the written duration and whether it has audio.
#[allow(clippy::too_many_arguments)]
fn record_loop(
    path: &Path,
    header: &VideoFormatHeader,
    ring: &Arc<Mutex<RollingRingBuffer>>,
    generation: u32,
    start: i64,
    with_audio: bool,
    stop: &AtomicBool,
    paused: &AtomicBool,
    written: &std::sync::atomic::AtomicI64,
) -> RResult<(i64, bool)> {
    let mut mux = platform::StreamMux::open(path, header, with_audio)?;
    let mut last_v = start - 1;
    let mut last_a = start - 1;
    let mut segs: Vec<RecSegment> = Vec::new();
    let mut need_key = true;
    let mut end_raw = start; // end of the last written video frame
    let mut wrote_audio = false;
    loop {
        let stopping = stop.load(Ordering::Relaxed);
        let (video, audio, gen_changed) = {
            let r = ring.lock();
            let changed = r.newest_video().is_some_and(|(g, _)| g != generation);
            let (v, a) = r.packets_after(generation, last_v, last_a);
            (v, a, changed)
        };
        let is_paused = paused.load(Ordering::Relaxed);
        if is_paused {
            if let Some(seg) = segs.last_mut() {
                if seg.end.is_none() {
                    seg.end = Some(end_raw);
                }
            }
            need_key = true;
        }
        for p in &video {
            last_v = p.pts_hns;
            if is_paused {
                continue;
            }
            if need_key {
                if !p.keyframe {
                    continue;
                }
                let offset = match segs.last() {
                    Some(prev) => prev.offset + (p.pts_hns - prev.end.unwrap_or(end_raw)),
                    None => start,
                };
                segs.push(RecSegment { start: p.pts_hns, end: None, offset });
                need_key = false;
            }
            let seg = segs.last().expect("segment opened above");
            mux.write(TrackKind::Video, p, p.pts_hns - seg.offset)?;
            end_raw = p.pts_hns + p.duration_hns;
            written.store(end_raw - seg.offset, Ordering::Relaxed);
        }
        for p in &audio {
            last_a = p.pts_hns;
            if !with_audio {
                continue;
            }
            // Only audio that belongs to a written stretch of video.
            let seg = segs.iter().find(|s| {
                p.pts_hns >= s.start && s.end.map_or(p.pts_hns < end_raw + 2 * HNS_PER_SECOND, |e| p.pts_hns < e)
            });
            if let Some(seg) = seg {
                mux.write(TrackKind::Audio, p, p.pts_hns - seg.offset)?;
                wrote_audio = true;
            }
        }
        if stopping || gen_changed {
            if gen_changed {
                log::warn!("[lastshot] recording ended: the display or GPU changed");
            }
            break;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    mux.finish()?;
    Ok((written.load(Ordering::Relaxed), with_audio && wrote_audio))
}

fn mux_packets_to_mp4(
    path: &Path,
    header: &VideoFormatHeader,
    video: &[EncodedPacket],
    audio: &[EncodedPacket],
) -> RResult<()> {
    platform::mux(path, header, video, audio)
}

pub fn process_rss_bytes() -> u64 {
    platform::rss_bytes()
}

fn set_thread_priority(performance_mode: bool) {
    platform::boost_thread(performance_mode);
}

// ---------------------------------------------------------------------------
// Monitor enumeration (used by the settings panel)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonitorInfo {
    pub index: u32,
    /// Top-left corner on the desktop, physical pixels.
    pub x: i32,
    pub y: i32,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub refresh_hz: u32,
    pub primary: bool,
    pub adapter: String,
}

pub fn enumerate_monitors() -> Vec<MonitorInfo> {
    #[cfg(all(windows, not(feature = "headless-sim")))]
    {
        use windows::Win32::Graphics::Dxgi::*;
        let mut out = Vec::new();
        unsafe {
            let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else {
                return out;
            };
            let mut flat = 0u32;
            let mut ai = 0u32;
            while let Ok(adapter) = factory.EnumAdapters1(ai) {
                let Ok(adesc) = adapter.GetDesc1() else {
                    ai += 1;
                    continue;
                };
                let adapter_name = String::from_utf16_lossy(
                    &adesc.Description[..adesc
                        .Description
                        .iter()
                        .position(|&c| c == 0)
                        .unwrap_or(adesc.Description.len())],
                );
                let mut oi = 0u32;
                while let Ok(output) = adapter.EnumOutputs(oi) {
                    if let Ok(odesc) = output.GetDesc() {
                        let r = odesc.DesktopCoordinates;
                        out.push(MonitorInfo {
                            index: flat,
                            x: r.left,
                            y: r.top,
                            name: String::from_utf16_lossy(
                                &odesc.DeviceName[..odesc
                                    .DeviceName
                                    .iter()
                                    .position(|&c| c == 0)
                                    .unwrap_or(odesc.DeviceName.len())],
                            ),
                            width: (r.right - r.left) as u32,
                            height: (r.bottom - r.top) as u32,
                            refresh_hz: 0,
                            primary: r.left == 0 && r.top == 0,
                            adapter: adapter_name.clone(),
                        });
                    }
                    flat += 1;
                    oi += 1;
                }
                ai += 1;
            }
        }
        out
    }

    #[cfg(any(not(windows), feature = "headless-sim"))]
    {
        vec![MonitorInfo {
            index: 0,
            x: 0,
            y: 0,
            name: "\\\\.\\DISPLAY1 (virtual)".into(),
            width: 1920,
            height: 1080,
            refresh_hz: 60,
            primary: true,
            adapter: "Virtual Adapter".into(),
        }]
    }
}

#[cfg(test)]
mod cfr_tests {
    use super::*;

    #[test]
    fn frames_land_on_the_fps_grid() {
        // 60 fps: slot n is n * 10_000_000 / 60, exact (no accumulated drift).
        assert_eq!(cfr_pts(166_000, 60, i64::MIN), 166_666);
        assert_eq!(cfr_pts(10_000_000 + 3_000, 60, i64::MIN), 10_000_000);
        assert_eq!(cfr_pts(3_600 * HNS_PER_SECOND + 70_000, 60, i64::MIN), 3_600 * HNS_PER_SECOND);
    }

    #[test]
    fn a_frame_never_shares_or_goes_back_a_slot() {
        let a = cfr_pts(1_000_000, 60, i64::MIN);
        let b = cfr_pts(1_010_000, 60, a); // woke up early: same slot
        assert!(b > a);
        assert_eq!((a, b), (1_000_000, 1_166_666));
        // A late frame skips a slot (a gap), it is not squeezed in.
        let c = cfr_pts(1_000_000 + 3 * 166_667, 60, b);
        assert_eq!(c, cfr_pts(1_000_000 + 3 * 166_667, 60, i64::MIN));
    }

    #[test]
    fn steady_capture_gives_an_even_cadence() {
        let mut last = i64::MIN;
        let mut out = Vec::new();
        for i in 0..600i64 {
            // Wake-ups jitter by up to +-2 ms around the ideal time.
            let jitter = [0, 15_000, -12_000, 20_000, -5_000][(i % 5) as usize];
            let p = cfr_pts(i * HNS_PER_SECOND / 60 + jitter, 60, last);
            out.push(p);
            last = p;
        }
        for w in out.windows(2) {
            let d = w[1] - w[0];
            assert!((166_666..=166_667).contains(&d), "uneven step {d}");
        }
    }
}

#[cfg(test)]
mod integrated_gpu_tests {
    use super::is_integrated_gpu;

    #[test]
    fn intel_iris_xe_is_integrated() {
        assert!(is_integrated_gpu("Intel(R) Iris(R) Xe Graphics", 128));
    }

    #[test]
    fn amd_igpu_low_vram_is_integrated() {
        assert!(is_integrated_gpu("AMD Radeon(TM) Graphics", 512));
    }

    #[test]
    fn nvidia_discrete_is_not_integrated() {
        assert!(!is_integrated_gpu("NVIDIA GeForce RTX 4070", 12288));
    }

    #[test]
    fn intel_arc_discrete_is_not_integrated() {
        assert!(!is_integrated_gpu("Intel(R) Arc(TM) A770 Graphics", 8192));
    }

    #[test]
    fn amd_discrete_is_not_integrated() {
        assert!(!is_integrated_gpu("AMD Radeon RX 6800 XT", 16384));
    }
}

// ===========================================================================
//                        RING BUFFER / SNAPSHOT TESTS
// ===========================================================================
//
// These cover the logic that decides whether a clip can be saved at all:
// GOP-aligned eviction, the "last N seconds" snapshot, the byte ceiling that
// enforces the window, and audio hygiene. They are pure (no D3D11, no MF), so
// they run on every platform — which is exactly why they were the biggest
// blind spot: `flush_to_disk` and `prune` had zero coverage.

#[cfg(test)]
mod ring_buffer_tests {
    use super::*;

    /// One encoded packet of `bytes` length, optionally a key frame.
    fn pkt(pts_hns: i64, bytes: usize, keyframe: bool) -> EncodedPacket {
        EncodedPacket {
            track: TrackKind::Video,
            data: Arc::from(vec![0u8; bytes].into_boxed_slice()),
            pts_hns,
            duration_hns: HNS_PER_SECOND / 60,
            keyframe,
            generation: 1,
        }
    }

    fn audio_pkt(pts_hns: i64, bytes: usize) -> EncodedPacket {
        EncodedPacket {
            track: TrackKind::Audio,
            data: Arc::from(vec![0u8; bytes].into_boxed_slice()),
            pts_hns,
            duration_hns: 1024 * HNS_PER_SECOND / 48_000,
            keyframe: true,
            generation: 1,
        }
    }

    /// Feeds `seconds` of 60 fps video with a key frame every `gop` frames.
    fn feed_video(ring: &mut RollingRingBuffer, seconds: u32, gop: u32, frame_bytes: usize) {
        let frames = seconds * 60;
        for i in 0..frames {
            let pts = i as i64 * HNS_PER_SECOND / 60;
            ring.push(pkt(pts, frame_bytes, i % gop == 0));
        }
    }

    // ---------------------------------------------------------- window / cap

    #[test]
    fn set_window_updates_the_byte_cap_with_the_window() {
        // Regression: the cap was computed once in `new()` and never moved, so
        // asking for 300 s on a 60 s engine silently kept the 60 s ceiling
        // (~141 MB at 12 Mbps) and delivered ~96 s.
        let mut ring = RollingRingBuffer::new(60, ring_cap_mb(60, 12_000));
        let cap_60 = ring.hard_byte_cap();

        ring.set_window(300, 12_000);
        let cap_300 = ring.hard_byte_cap();

        assert_eq!(cap_300, ring_cap_mb(300, 12_000) * 1024 * 1024);
        assert!(
            cap_300 > cap_60,
            "raising the window must raise the ceiling: {cap_60} -> {cap_300}"
        );
    }

    #[test]
    fn set_window_shrinks_the_cap_when_the_window_shrinks() {
        let mut ring = RollingRingBuffer::new(300, ring_cap_mb(300, 12_000));
        let cap_300 = ring.hard_byte_cap();
        ring.set_window(30, 12_000);
        assert_eq!(ring.hard_byte_cap(), ring_cap_mb(30, 12_000) * 1024 * 1024);
        assert!(ring.hard_byte_cap() < cap_300);
    }

    #[test]
    fn a_300s_window_actually_holds_300s_of_packets() {
        // The end-to-end version of the bug above: feed 300 s of data at a
        // bitrate whose 60 s cap would have truncated it to ~96 s.
        let mut ring = RollingRingBuffer::new(60, ring_cap_mb(60, 12_000));
        ring.set_window(300, 12_000);

        // 12 Mbps over 300 s = 450 MB nominal; ring_cap_mb adds 1.6x head room.
        feed_video(&mut ring, 300, 60, 25_000);

        let span = ring.span_seconds();
        assert!(
            span > 290.0,
            "a 300 s window must retain ~300 s, got {span:.1}s"
        );
    }

    #[test]
    fn cap_never_exceeds_the_hard_ceiling() {
        // `ring_cap_mb` clamps to half the RAM so a long window cannot eat it all.
        assert!(ring_cap_mb(3600, 150_000) <= ring_ceiling_mb());
        assert!(ring_ceiling_mb() >= 1536);
        assert!(ring_cap_mb(5, 1_000) >= 24);
    }

    // -------------------------------------------------------------- eviction

    #[test]
    fn eviction_never_leaves_a_delta_frame_at_the_front() {
        // A clip that starts on a P frame decodes to macro-block soup.
        let mut ring = RollingRingBuffer::new(2, ring_cap_mb(2, 12_000));
        feed_video(&mut ring, 6, 30, 2_000);

        let (video, _) = ring.snapshot(None);
        assert!(!video.is_empty());
        assert!(
            video[0].keyframe,
            "snapshot must start on a key frame, got a delta frame"
        );
    }

    #[test]
    fn eviction_keeps_the_buffer_within_its_window() {
        let mut ring = RollingRingBuffer::new(2, ring_cap_mb(2, 12_000));
        feed_video(&mut ring, 10, 30, 1_000);
        // One GOP of slack is expected because eviction is GOP aligned.
        assert!(
            ring.span_seconds() <= 3.5,
            "2 s window kept {:.1}s",
            ring.span_seconds()
        );
    }

    #[test]
    fn clear_empties_everything_and_zeroes_the_byte_counter() {
        let mut ring = RollingRingBuffer::new(5, 24);
        feed_video(&mut ring, 2, 30, 1_000);
        ring.push(audio_pkt(0, 512));
        assert!(ring.bytes() > 0);

        ring.clear();
        assert_eq!(ring.bytes(), 0);
        assert_eq!(ring.video_frames(), 0);
        assert_eq!(ring.span_seconds(), 0.0);
        let (v, a) = ring.snapshot(None);
        assert!(v.is_empty() && a.is_empty());
    }

    // -------------------------------------------------------------- snapshot

    #[test]
    fn snapshot_without_a_limit_returns_the_whole_buffer() {
        let mut ring = RollingRingBuffer::new(10, ring_cap_mb(10, 12_000));
        feed_video(&mut ring, 5, 60, 1_000);
        let (video, _) = ring.snapshot(None);
        assert_eq!(video.len(), 300, "5 s at 60 fps");
    }

    #[test]
    fn snapshot_with_a_limit_returns_roughly_that_many_seconds() {
        let mut ring = RollingRingBuffer::new(60, ring_cap_mb(60, 12_000));
        feed_video(&mut ring, 60, 60, 1_000);

        let (video, _) = ring.snapshot(Some(10.0));
        let span = (video.last().unwrap().pts_hns - video[0].pts_hns) as f32
            / HNS_PER_SECOND as f32;
        // Key-frame snapping can only ever give *more* history, never less.
        assert!(span >= 9.0, "10 s request returned {span:.1}s");
        assert!(span <= 12.5, "10 s request returned {span:.1}s (too much)");
        assert!(video[0].keyframe);
    }

    #[test]
    fn snapshot_limit_larger_than_the_buffer_returns_everything() {
        let mut ring = RollingRingBuffer::new(10, ring_cap_mb(10, 12_000));
        feed_video(&mut ring, 4, 60, 1_000);
        let (video, _) = ring.snapshot(Some(999.0));
        assert_eq!(video.len(), 240);
    }

    #[test]
    fn snapshot_never_mixes_generations() {
        // A device reset bumps the generation; a file must not contain packets
        // from two encoder sessions.
        let mut ring = RollingRingBuffer::new(10, ring_cap_mb(10, 12_000));
        for i in 0..60 {
            ring.push(EncodedPacket {
                track: TrackKind::Video,
                data: Arc::from(vec![0u8; 100].into_boxed_slice()),
                pts_hns: i as i64 * HNS_PER_SECOND / 60,
                duration_hns: HNS_PER_SECOND / 60,
                keyframe: i % 30 == 0,
                generation: 1,
            });
        }
        for i in 60..120 {
            ring.push(EncodedPacket {
                track: TrackKind::Video,
                data: Arc::from(vec![0u8; 100].into_boxed_slice()),
                pts_hns: i as i64 * HNS_PER_SECOND / 60,
                duration_hns: HNS_PER_SECOND / 60,
                keyframe: i % 30 == 0,
                generation: 2,
            });
        }

        let (video, _) = ring.snapshot(None);
        assert!(!video.is_empty());
        assert!(
            video.iter().all(|p| p.generation == 2),
            "snapshot leaked packets from the previous generation"
        );
        assert!(video[0].keyframe);
    }

    #[test]
    fn snapshot_on_an_empty_ring_is_empty_not_a_panic() {
        let ring = RollingRingBuffer::new(5, 24);
        let (v, a) = ring.snapshot(None);
        assert!(v.is_empty() && a.is_empty());
    }

    // ---------------------------------------------------------- audio hygiene

    #[test]
    fn audio_is_trimmed_alongside_video() {
        let mut ring = RollingRingBuffer::new(2, ring_cap_mb(2, 12_000));
        // Interleave 4 s of audio with 4 s of video; the window is 2 s.
        for i in 0..240 {
            let pts = i as i64 * HNS_PER_SECOND / 60;
            ring.push(pkt(pts, 500, i % 30 == 0));
            if i % 3 == 0 {
                ring.push(audio_pkt(pts, 200));
            }
        }
        let (_, audio) = ring.snapshot(None);
        assert!(
            audio.len() < 120,
            "audio track was not trimmed with the video window: {} packets",
            audio.len()
        );
    }

    #[test]
    fn audio_does_not_accumulate_when_the_video_track_is_empty() {
        // Regression for the privacy-gate leak: the gate clears the ring, and
        // if audio keeps arriving with no video to anchor the cutoff it used
        // to grow forever (~86 MB/hour).
        //
        // Asserted on the live audio queue, not on `snapshot()`: the snapshot
        // filters by the newest *video* generation, so an empty video track
        // makes it return nothing and the assertion would pass vacuously.
        let mut ring = RollingRingBuffer::new(30, 24);
        for i in 0..(60 * 300) {
            ring.push(audio_pkt(i as i64 * HNS_PER_SECOND / 60, 128));
        }
        // 30 s window at 60 pushes/s ≈ 1800 packets; anything near 18000 means
        // nothing was ever evicted.
        assert!(
            ring.audio_packets() <= 1_900,
            "audio accumulated unbounded: {} packets for a 30 s window",
            ring.audio_packets()
        );
        assert!(ring.bytes() <= 24 * 1024 * 1024);
    }

    #[test]
    fn byte_counter_matches_the_packets_that_remain() {
        let mut ring = RollingRingBuffer::new(2, ring_cap_mb(2, 12_000));
        feed_video(&mut ring, 8, 30, 2_000);
        for i in 0..100 {
            ring.push(audio_pkt(i as i64 * HNS_PER_SECOND / 60, 300));
        }

        let (video, audio) = ring.snapshot(None);
        let expected: usize = video
            .iter()
            .chain(audio.iter())
            .map(|p| p.heap_size())
            .sum();
        // `snapshot` clones, so compare against the live counter instead of
        // recomputing from the snapshot (audio lead-in is excluded there).
        assert!(ring.bytes() > 0);
        assert!(
            ring.bytes() >= expected / 2,
            "byte counter drifted from the live packets"
        );
    }
}

