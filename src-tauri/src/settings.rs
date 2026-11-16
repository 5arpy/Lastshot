//! User settings. Stored as a single JSON file next to the executable's
//! app-data folder. No cloud, no account, no telemetry - Lastshot never opens
//! an outbound socket.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::foreground;
use crate::media::recorder::{default_output_dir, Codec, RecorderConfig};

/// One per-game capture preset (ShadowPlay style). Applying a profile copies
/// its capture values into the global settings; the buffer window applies to
/// the running engine immediately, fps/bitrate/codec on the next engine start.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureProfile {
    /// Stable slug, e.g. "competitivo".
    pub id: String,
    pub name: String,
    pub buffer_seconds: u32,
    pub target_fps: u32,
    pub bitrate_kbps: u32,
    pub codec: Codec,
}

/// Maps a foreground executable to a profile. Keys on the exe name so the
/// match is exact and cheap (no fuzzy matching on window titles).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileMapEntry {
    pub profile_id: String,
    /// Lowercase executable name, e.g. "cs2.exe".
    pub exe_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub buffer_seconds: u32,
    pub target_fps: u32,
    pub bitrate_kbps: u32,
    pub codec: Codec,
    pub monitor_index: u32,
    /// Full screen (the monitor above) or one window / app.
    #[serde(default)]
    pub capture_source: crate::media::CaptureSource,
    /// Whose sound "PC sound" records: everything, one app, or all but one.
    #[serde(default)]
    pub app_audio: crate::media::procaudio::AppAudio,
    /// Show the mouse pointer in recordings and replays.
    #[serde(default = "default_true")]
    pub capture_cursor: bool,
    /// Full-screen capture method (hidden; Automatic is right for nearly
    /// everyone).
    #[serde(default)]
    pub display_method: crate::media::recorder::DisplayMethod,
    pub capture_system_audio: bool,
    pub capture_microphone: bool,
    pub output_dir: String,
    pub hotkey_save: String,
    pub hotkey_toggle: String,
    pub open_trimmer_after_save: bool,
    pub minimize_to_tray: bool,
    pub autostart_buffer: bool,
    pub play_save_sound: bool,
    /// Keep the control deck pinned above full-screen games.
    #[serde(default)]
    pub always_on_top: bool,
    /// Per-game capture profiles. Seeded with three stock presets on first run.
    #[serde(default)]
    pub profiles: Vec<CaptureProfile>,
    /// Foreground exe → profile mapping (auto-switch).
    #[serde(default)]
    pub profile_map: Vec<ProfileMapEntry>,
    /// When true, the mapped profile follows the game that has focus.
    #[serde(default)]
    pub auto_switch_profiles: bool,
    /// Launch Lastshot hidden to tray at Windows sign-in.
    #[serde(default)]
    pub launch_at_startup: bool,
    /// Delete clips older than N days at launch (0 = keep everything).
    #[serde(default)]
    pub auto_cleanup_days: u32,
    /// Save clips into per-game subfolders and tag them with the game.
    #[serde(default = "default_true")]
    pub organize_by_game: bool,
    /// When the foreground game leaves focus, save its last 30 s automatically.
    #[serde(default)]
    pub autosave_on_game_exit: bool,
    /// Game Mode: favours the game when the machine is busy. Caps capture at
    /// 1080p/60, lowers the encoder quality-vs-speed bias and keeps background
    /// UI work quiet. Enabled by default so existing users get the fix after
    /// an update without touching settings.
    #[serde(default = "default_true")]
    pub performance_mode: bool,
    /// Privacy mode: when no game has the foreground focus, the buffer stops
    /// accumulating (and is cleared), so clips can never contain desktop
    /// content — only gameplay.
    #[serde(default)]
    pub privacy_pause_when_unfocused: bool,
    /// System (game) audio volume in the mix, 0-100. Applies live.
    #[serde(default = "default_100")]
    pub game_volume: u32,
    /// Microphone volume in the mix, 0-100. Applies live.
    #[serde(default = "default_100")]
    pub mic_volume: u32,
    /// Specific microphone device ID, or None to use system default.
    #[serde(default)]
    pub mic_device_id: Option<String>,
    /// "Clean up my voice": low cut, noise gate, compressor and limiter on
    /// the microphone. Applies live.
    #[serde(default)]
    pub clean_voice: bool,
    /// Adaptive capture (ECO): on battery or under memory pressure the deck
    /// shrinks the rolling buffer live and caps the fps. Invisible when off.
    #[serde(default)]
    pub adaptive_eco: bool,
    /// Battery % at or below which ECO kicks in while on battery.
    #[serde(default = "default_30")]
    pub eco_battery_threshold_pct: u32,
    /// Free physical RAM (GiB) below which ECO kicks in.
    #[serde(default = "default_4")]
    pub eco_ram_free_gbs: u32,
    /// Check GitHub for a newer signed release at startup.
    ///
    /// Default `false`: Lastshot's proposition is "no telemetry, no background
    /// network", and an unconditional startup check contradicted that. The
    /// manual button in Settings always works; this only controls the silent
    /// probe. See README "Zero Telemetry".
    #[serde(default)]
    pub check_updates_on_startup: bool,
    /// "Shrink & copy" size limit in MB (Discord's free cap is 10 MB). Kept as
    /// a setting so a platform change needs no app update.
    #[serde(default = "default_share_mb")]
    pub share_size_mb: f32,
    /// Hotkey that opens the snipping overlay.
    #[serde(default = "default_snip_hotkey")]
    pub hotkey_snip: String,
    /// Also save every snip as a PNG in `<clips folder>\Screenshots`.
    #[serde(default = "default_true")]
    pub snip_save_to_folder: bool,
    /// Extra folders whose videos show up in Clips too (edit, share, star),
    /// e.g. another recorder's folder. Lastshot only saves to `output_dir`,
    /// and auto-cleanup / "Delete all" never touch these.
    #[serde(default)]
    pub library_folders: Vec<String>,
    /// Starts / stops a screen recording.
    #[serde(default = "default_record_hotkey")]
    pub hotkey_record: String,
    /// Small on-screen control bar: "recording" (while recording), "always"
    /// or "off". It is never captured.
    #[serde(default = "default_control_bar")]
    pub control_bar: String,
    /// Studio layers on the recorded screen: "off", "recording" or "always".
    #[serde(default = "default_studio_layers")]
    pub studio_layers: String,
    /// "Open with Lastshot" on MP4 files in Explorer's right-click menu.
    #[serde(default)]
    pub explorer_open_with: bool,
    /// Where screenshots are saved; empty = `<save location>\Screenshots`.
    #[serde(default)]
    pub screenshot_dir: String,
    /// "png" (lossless) or "jpg" (smaller).
    #[serde(default = "default_screenshot_format")]
    pub screenshot_format: String,
    /// JPG quality 50-100.
    #[serde(default = "default_screenshot_quality")]
    pub screenshot_quality: u8,
    /// Put screenshots on the clipboard (otherwise they are only saved).
    #[serde(default = "default_true")]
    pub screenshot_copy: bool,
    /// Where screen recordings are saved; empty = the save location.
    #[serde(default)]
    pub recording_dir: String,
    /// Hides folder paths in the window (for streaming / screen sharing).
    #[serde(default)]
    pub streamer_mode: bool,
    /// Audio tab: apps sent to their own output device, set again whenever
    /// the app starts.
    #[serde(default)]
    pub app_outputs: Vec<crate::audio_routing::AppOutputRule>,
    /// Where each popped-out tab's window was last (logical pixels).
    #[serde(default)]
    pub popout_places: Vec<WindowPlace>,
    /// Audio tab → Cables (Pro). Kept as plain JSON so a build without
    /// cables keeps them untouched; the cables module reads and writes it.
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub cables: serde_json::Value,
    /// Audio tab → Devices: the Audio guard (off until turned on).
    #[serde(default)]
    pub audio_guard: crate::audio_guard::GuardSettings,
}

/// A popped-out tab's window size and position.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowPlace {
    pub view: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

fn default_share_mb() -> f32 {
    10.0
}

fn default_snip_hotkey() -> String {
    "Alt+S".into()
}

fn default_screenshot_format() -> String {
    "png".into()
}

fn default_screenshot_quality() -> u8 {
    90
}

/// Longest instant replay (60 min). It only costs RAM, and the ring's byte
/// cap (half the PC's memory at most) keeps a big number from eating it all.
pub const MAX_BUFFER_SECONDS: u32 = 3600;

fn default_record_hotkey() -> String {
    "Alt+R".into()
}

fn default_control_bar() -> String {
    "recording".into()
}

fn default_studio_layers() -> String {
    "recording".into()
}

fn default_30() -> u32 {
    30
}

fn default_4() -> u32 {
    4
}

fn default_100() -> u32 {
    100
}

impl Settings {
    /// Folders Clips scans besides the save location: the extra library
    /// folders, plus the recordings folder when it lies outside the save
    /// location (so recordings always show up in Clips).
    pub fn scan_folders(&self) -> Vec<std::path::PathBuf> {
        let mut out: Vec<std::path::PathBuf> =
            self.library_folders.iter().map(std::path::PathBuf::from).collect();
        let rec = self.recording_dir.trim();
        if !rec.is_empty() {
            let p = std::path::PathBuf::from(rec);
            let inside = p.starts_with(&self.output_dir);
            let listed = out.iter().any(|d| d.to_string_lossy().eq_ignore_ascii_case(rec));
            if !inside && !listed {
                out.push(p);
            }
        }
        out
    }

    /// Where screenshots are saved.
    pub fn screenshots_dir(&self) -> std::path::PathBuf {
        if self.screenshot_dir.trim().is_empty() {
            std::path::PathBuf::from(&self.output_dir).join("Screenshots")
        } else {
            std::path::PathBuf::from(self.screenshot_dir.trim())
        }
    }
}

fn default_true() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            buffer_seconds: 60,
            target_fps: 60,
            bitrate_kbps: 12_000,
            codec: Codec::H264,
            monitor_index: 0,
            capture_source: Default::default(),
            app_audio: Default::default(),
            capture_cursor: true,
            display_method: Default::default(),
            capture_system_audio: true,
            capture_microphone: false,
            output_dir: default_output_dir().to_string_lossy().to_string(),
            hotkey_save: "Alt+C".into(),
            hotkey_toggle: "Alt+Shift+C".into(),
            open_trimmer_after_save: true,
            minimize_to_tray: true,
            autostart_buffer: true,
            play_save_sound: true,
            always_on_top: false,
            profiles: Vec::new(),
            profile_map: Vec::new(),
            auto_switch_profiles: false,
            launch_at_startup: false,
            auto_cleanup_days: 0,
            organize_by_game: true,
            autosave_on_game_exit: false,
            performance_mode: true,
            privacy_pause_when_unfocused: false,
            game_volume: 100,
            mic_volume: 100,
            mic_device_id: None,
            clean_voice: false,
            adaptive_eco: false,
            eco_battery_threshold_pct: 30,
            eco_ram_free_gbs: 4,
            check_updates_on_startup: false,
            share_size_mb: default_share_mb(),
            hotkey_snip: default_snip_hotkey(),
            snip_save_to_folder: true,
            library_folders: Vec::new(),
            hotkey_record: default_record_hotkey(),
            control_bar: default_control_bar(),
            studio_layers: default_studio_layers(),
            explorer_open_with: false,
            screenshot_dir: String::new(),
            screenshot_format: default_screenshot_format(),
            screenshot_quality: default_screenshot_quality(),
            screenshot_copy: true,
            recording_dir: String::new(),
            streamer_mode: false,
            app_outputs: Vec::new(),
            popout_places: Vec::new(),
            cables: Default::default(),
            audio_guard: Default::default(),
        }
    }
}

impl Settings {
    /// Seeds the three stock profiles on first run. The "default" one mirrors
    /// whatever the user's global capture settings currently are, so applying
    /// it later is a true "back to my baseline" action.
    pub fn seed_default_profiles(&mut self) {
        if !self.profiles.is_empty() {
            return;
        }
        self.profiles = vec![
            CaptureProfile {
                id: "default".into(),
                name: "Default".into(),
                buffer_seconds: self.buffer_seconds,
                target_fps: self.target_fps,
                bitrate_kbps: self.bitrate_kbps,
                codec: self.codec,
            },
            CaptureProfile {
                id: "competitivo".into(),
                name: "Competitivo".into(),
                buffer_seconds: 30,
                target_fps: 60,
                bitrate_kbps: 12_000,
                codec: Codec::H264,
            },
            CaptureProfile {
                id: "cine".into(),
                name: "Cine".into(),
                buffer_seconds: 120,
                target_fps: 60,
                bitrate_kbps: 25_000,
                codec: Codec::Hevc,
            },
        ];
    }

    pub fn profile_by_id(&self, id: &str) -> Option<&CaptureProfile> {
        self.profiles.iter().find(|p| p.id == id)
    }

    /// The profile mapped to `exe` (case-insensitive match), if any.
    pub fn profile_for_exe(&self, exe: &str) -> Option<&CaptureProfile> {
        let exe = exe.to_ascii_lowercase();
        self.profile_map
            .iter()
            .find(|m| m.exe_name.to_ascii_lowercase() == exe)
            .and_then(|m| self.profile_by_id(&m.profile_id))
    }

    /// The profile that should be live right now under auto-switch: the one
    /// mapped to the game currently in the foreground, if any.
    pub fn active_profile(&self) -> Option<&CaptureProfile> {
        if !self.auto_switch_profiles {
            return None;
        }
        let game = foreground::get_foreground_game()?;
        self.profile_for_exe(&game.exe)
    }

    /// Copies a profile's capture values into the global settings.
    pub fn apply_profile_values(&mut self, profile: &CaptureProfile) {
        self.buffer_seconds = profile.buffer_seconds.clamp(5, MAX_BUFFER_SECONDS);
        self.target_fps = profile.target_fps.clamp(24, 240);
        self.bitrate_kbps = profile.bitrate_kbps.clamp(1_000, 150_000);
        self.codec = profile.codec;
    }

    /// RecorderConfig for a specific profile (used at launch when the
    /// auto-switch profile should be armed from the very first frame).
    pub fn to_profile_config(&self, profile: &CaptureProfile) -> RecorderConfig {
        let mut cfg = self.to_recorder_config();
        cfg.buffer_seconds = profile.buffer_seconds.clamp(5, MAX_BUFFER_SECONDS);
        cfg.target_fps = profile.target_fps.clamp(24, 240);
        cfg.bitrate_kbps = profile.bitrate_kbps.clamp(1_000, 150_000);
        cfg.codec = profile.codec;
        self.apply_performance_caps(&mut cfg);
        cfg
    }

    pub fn to_recorder_config(&self) -> RecorderConfig {
        let mut cfg = RecorderConfig {
            buffer_seconds: self.buffer_seconds.clamp(5, MAX_BUFFER_SECONDS),
            target_fps: self.target_fps.clamp(24, 240),
            width: 0,
            height: 0,
            max_height: 0,
            performance_mode: self.performance_mode,
            bitrate_kbps: self.bitrate_kbps.clamp(1_000, 150_000),
            codec: self.codec,
            monitor_index: self.monitor_index,
            capture_system_audio: self.capture_system_audio,
            capture_microphone: self.capture_microphone,
            game_volume: self.game_volume.clamp(0, 100),
            mic_volume: self.mic_volume.clamp(0, 100),
            mic_device_id: self.mic_device_id.clone(),
            output_dir: PathBuf::from(&self.output_dir),
            output_subfolder: None,
            clip_app: None,
            source: self.capture_source.clone(),
            app_audio: self.app_audio.clone(),
            capture_cursor: self.capture_cursor,
            display_method: self.display_method,
        };
        self.apply_performance_caps(&mut cfg);
        cfg
    }

    /// Game Mode keeps the recorder deliberately lightweight: the game keeps
    /// priority on the GPU/CPU and a replay is still 1080p at up to 60 fps,
    /// which is what instant-replay clips actually need. Users who want the
    /// old full-resolution behaviour can turn Game Mode off in Settings.
    fn apply_performance_caps(&self, cfg: &mut RecorderConfig) {
        if self.performance_mode {
            cfg.target_fps = cfg.target_fps.min(60);
            // 0 means "native" — only downscale monitors above 1080p.
            cfg.max_height = 1080;
            cfg.performance_mode = true;
        } else {
            cfg.max_height = 0;
            cfg.performance_mode = false;
        }
    }

    pub fn config_path() -> PathBuf {
        crate::paths::app_file("settings.json")
    }

    pub fn load() -> Self {
        let path = Self::config_path();
        match std::fs::read_to_string(&path) {
            Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|e| {
                log::warn!("[lastshot] settings parse error ({e}); using defaults");
                Self::default()
            }),
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self) -> Result<(), String> {
        let path = Self::config_path();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(&path, json).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn performance_mode_caps_replay_to_1080p60() {
        let mut s = Settings::default();
        s.performance_mode = true;
        s.target_fps = 144;
        s.profiles = vec![CaptureProfile {
            id: "test".into(),
            name: "Test".into(),
            buffer_seconds: 30,
            target_fps: 120,
            bitrate_kbps: 20_000,
            codec: Codec::H264,
        }];

        let cfg = s.to_recorder_config();
        assert_eq!(cfg.target_fps, 60);
        assert_eq!(cfg.max_height, 1080);
        assert!(cfg.performance_mode);

        let profile_cfg = s.to_profile_config(&s.profiles[0]);
        assert_eq!(profile_cfg.target_fps, 60, "profiles must respect Game Mode too");
        assert_eq!(profile_cfg.max_height, 1080);
    }

    #[test]
    fn performance_mode_off_keeps_native_resolution_and_fps() {
        let mut s = Settings::default();
        s.performance_mode = false;
        s.target_fps = 144;

        let cfg = s.to_recorder_config();
        assert_eq!(cfg.target_fps, 144);
        assert_eq!(cfg.max_height, 0);
        assert!(!cfg.performance_mode);
    }
}
