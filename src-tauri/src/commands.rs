//! Every Tauri IPC handler lives here. Each one returns `Result<T, String>` so
//! the frontend gets a plain, user-presentable message instead of an HRESULT.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::clipmeta::{ClipMetaEntry, ClipMetaStore};
use crate::foreground::ForegroundGame;
use crate::media::library::{self, ClipMetadata, TrimResult};
use crate::media::recorder::{
    enumerate_monitors, CaptureEngine, ClipWriteResult, Codec, EngineStats, MonitorInfo,
};
use crate::settings::{CaptureProfile, ProfileMapEntry, Settings};

// ---------------------------------------------------------------------------
// Shared application state
// ---------------------------------------------------------------------------

pub struct AppState {
    pub engine: Arc<CaptureEngine>,
    pub settings: RwLock<Settings>,
    /// Favourites + custom tags, persisted to `clip_meta.json` in AppData.
    pub clip_meta: Mutex<ClipMetaStore>,
}

impl AppState {
    pub fn new() -> Self {
        let mut settings = Settings::load();
        settings.seed_default_profiles();
        let _ = settings.save(); // persist the stock profiles once
        crate::media::voice::set_clean_voice(settings.clean_voice);
        Self {
            engine: Arc::new(CaptureEngine::new()),
            settings: RwLock::new(settings),
            clip_meta: Mutex::new(ClipMetaStore::load()),
        }
    }

    pub fn output_dir(&self) -> PathBuf {
        PathBuf::from(self.settings.read().output_dir.clone())
    }

    /// Where new files made from `source` (trims, splits, edits) go: next to
    /// it inside the save folder, or the save folder itself for a clip from
    /// an extra library folder (Lastshot never writes into those).
    pub fn edit_dir_for(&self, source: &Path) -> PathBuf {
        edit_dir(&self.output_dir(), source)
    }
}

fn edit_dir(out: &Path, source: &Path) -> PathBuf {
    match source.parent() {
        Some(p) if p.starts_with(out) => p.to_path_buf(),
        _ => out.to_path_buf(),
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

pub const EVT_CLIP_SAVED: &str = "lastshot://clip-saved";
pub const EVT_STATS: &str = "lastshot://stats";
pub const EVT_ERROR: &str = "lastshot://error";
pub const EVT_HOTKEY: &str = "lastshot://hotkey";
pub const EVT_BUFFER_STATE: &str = "lastshot://buffer-state";
/// Every window hears the settings whenever they change (payload: Settings).
pub const EVT_SETTINGS: &str = "lastshot://settings";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipSavedPayload {
    pub clip: ClipMetadata,
    pub flush_ms: f32,
    pub triggered_by: String,
    /// Whether the frontend should open the trimmer automatically. The Rust
    /// side decides so the hotkey path never raises the deck mid-game (that
    /// would steal focus from a fullscreen-exclusive game).
    #[serde(default)]
    pub open_trimmer: bool,
}

// ---------------------------------------------------------------------------
// Buffer lifecycle
// ---------------------------------------------------------------------------

/// Initialises DXGI Desktop Duplication + the hardware encoder and starts
/// filling the in-memory ring buffer.
#[tauri::command]
pub async fn start_replay_buffer(
    state: State<'_, AppState>,
    app: AppHandle,
    buffer_seconds: u32,
    target_fps: u32,
) -> Result<EngineStats, String> {
    let cfg = {
        let mut s = state.settings.write();
        s.buffer_seconds = buffer_seconds.clamp(5, crate::settings::MAX_BUFFER_SECONDS);
        s.target_fps = target_fps.clamp(24, 240);
        let _ = s.save();
        s.to_recorder_config()
    };
    std::fs::create_dir_all(&cfg.output_dir).map_err(|e| e.to_string())?;
    // `to_recorder_config()` already applied the Game Mode caps. Do not
    // overwrite `cfg.target_fps` here: the old code copied the raw UI value and
    // silently bypassed the 60 FPS cap on ARM / APPLY & RESTART.

    let engine = Arc::clone(&state.engine);
    let stats = tauri::async_runtime::spawn_blocking(move || engine.start(cfg))
        .await
        .map_err(|e| format!("engine task panicked: {e}"))?
        .map_err(|e| e.to_string())?;

    let _ = app.emit(EVT_BUFFER_STATE, &stats);
    Ok(stats)
}

#[tauri::command]
pub async fn stop_replay_buffer(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<EngineStats, String> {
    // A running screen recording is finished and added to Clips first.
    if state.engine.recording_status().is_some() {
        crate::recording::stop(&app).await?;
    }
    let engine = Arc::clone(&state.engine);
    let stats = tauri::async_runtime::spawn_blocking(move || {
        engine.stop();
        engine.stats()
    })
    .await
    .map_err(|e| format!("engine task panicked: {e}"))?;

    let _ = app.emit(EVT_BUFFER_STATE, &stats);
    Ok(stats)
}

#[tauri::command]
pub fn get_engine_stats(state: State<'_, AppState>) -> Result<EngineStats, String> {
    Ok(state.engine.stats())
}

#[tauri::command]
pub fn set_buffer_seconds(state: State<'_, AppState>, seconds: u32) -> Result<(), String> {
    // Live-only apply: the engine's rolling window changes without touching the
    // persisted setting — persisting is `update_settings`' job. Adaptive ECO
    // mode relies on this: it shrinks the ring on battery/RAM pressure and
    // restores it afterwards without clobbering the user's configured value.
    state.engine.set_buffer_seconds(seconds.clamp(5, crate::settings::MAX_BUFFER_SECONDS));
    Ok(())
}

// ---------------------------------------------------------------------------
// The Alt+C path
// ---------------------------------------------------------------------------

/// Sanitises a user-supplied name into a safe file stem.
///
/// Windows forbids `\ / : * ? " < > |` in file names, and a bare `.`/`..`
/// would escape the output folder. This was duplicated in three places
/// (`game_folder_name`, `rename_clip`, `save_png_snapshot`) with slightly
/// different rules; one shared helper keeps them consistent.
pub fn sanitize_file_stem(raw: &str, fallback: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .filter(|c| !c.is_control())
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

/// Resolves the per-game subfolder for the next flush: the game in the
/// foreground, or `game_override` when the caller already knows the game (the
/// auto-save-on-game-exit flow). Returns `None` when per-game organisation is
/// off or no game applies — the clip then lands in the output root.
pub fn resolve_game_folder(state: &AppState, game_override: Option<&str>) -> Option<String> {
    resolve_app_and_folder(state, game_override).1
}

/// The app a save is named after (`Roblox`), and the per-game folder it goes
/// to (`None` = the save folder itself: per-game folders off, or nothing but
/// the desktop was in use). A window source is named after its app; a full
/// screen save after the app in the foreground (or the last one played in
/// the last few seconds when Lastshot or the desktop has focus).
pub fn resolve_app_and_folder(state: &AppState, game_override: Option<&str>) -> (String, Option<String>) {
    let (organize, source) = {
        let s = state.settings.read();
        (s.organize_by_game, s.capture_source.clone())
    };
    let app = match (game_override, source) {
        (Some(exe), _) if !crate::appname::is_not_an_app(exe) => crate::appname::display_name(exe, None),
        (_, crate::media::CaptureSource::Window { hwnd, exe, .. }) => crate::appname::window_app(hwnd as isize, &exe),
        _ => crate::appname::foreground_app(),
    };
    let app = crate::appname::sanitize(&app);
    let folder = (organize && app != "Desktop").then(|| app.clone());
    (app, folder)
}

/// Before a replay save: name the clip after the app and route it into the
/// app's folder. Returns the folder (the clip's game tag).
pub fn prepare_save(state: &AppState, game_override: Option<&str>) -> Option<String> {
    let (app, folder) = resolve_app_and_folder(state, game_override);
    state.engine.set_output_subfolder(folder.clone());
    state.engine.set_clip_app(Some(app));
    folder
}

/// The single source of truth for the privacy gate: pause only when the
/// foreground is *positively* our own deck or the desktop. When the query
/// returns `None` (elevated game, protected process, lock screen) we keep
/// recording — breaking Alt+C for an undetected game is worse than a rare
/// ambiguous frame. Mirrored by the deck's `gated` computation in App.tsx.
/// Uses the title-less [`crate::foreground::foreground_exe`] so it is safe on
/// the main thread (no blocking `GetWindowTextW`).
pub fn privacy_should_gate() -> bool {
    match crate::foreground::foreground_exe() {
        Some(e) => crate::hotkeys::is_own_or_desktop(&e),
        None => false,
    }
}

/// When privacy mode is on and the foreground is positively the desktop or
/// our own deck, saving would flush desktop footage (or an empty buffer).
/// Returns the message to surface to the user, or `None` when saving is fine.
pub fn privacy_blocked_message(state: &AppState, game_override: Option<&str>) -> Option<String> {
    let s = state.settings.read();
    if !s.privacy_pause_when_unfocused {
        return None;
    }
    if game_override.is_some() {
        return None; // auto-save tags a game that just lost focus: gameplay
    }
    if privacy_should_gate() {
        Some(
            "Privacy mode: nothing recorded — no game is focused. Focus a game to arm the buffer again."
                .to_string(),
        )
    } else {
        None
    }
}

/// Flushes the ring buffer to a finalised `.mp4`, then returns its metadata.
/// `max_seconds` lets the UI (or the tray menu) ask for "last 30 s" out of a
/// 120 s buffer without re-configuring the engine. `game_override` is used by
/// the auto-save-on-game-exit flow: the game that just lost focus is tagged
/// even though it is no longer the foreground process at flush time.
#[tauri::command]
pub async fn save_instant_replay(
    state: State<'_, AppState>,
    app: AppHandle,
    max_seconds: Option<f32>,
    triggered_by: Option<String>,
    game_override: Option<String>,
) -> Result<ClipMetadata, String> {
    // Privacy mode: never save desktop content. If no game has focus, the ring
    // is empty anyway — fail with a message instead of a bare "empty buffer".
    if let Some(msg) = privacy_blocked_message(&state, game_override.as_deref()) {
        return Err(msg);
    }
    // Per-game organisation: route the flush into output_dir/<game>/. The
    // subfolder is recomputed on every save so it can never go stale.
    let game_folder = prepare_save(&state, game_override.as_deref());

    let engine = Arc::clone(&state.engine);

    let result: ClipWriteResult = tauri::async_runtime::spawn_blocking(move || {
        engine.flush_to_disk(max_seconds).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("flush task panicked: {e}"))??;

    // Auto-saves must never interrupt the user; only explicit UI saves open
    // the trimmer afterwards.
    let open_trimmer = match triggered_by.as_deref() {
        None | Some("ui") => state.settings.read().open_trimmer_after_save,
        _ => false,
    };
    // Shared with the hotkey and tray paths so every save emits exactly one
    // event and builds identical metadata. The UI path never raises the deck
    // (the user is already looking at it) and never steals focus.
    let clip = crate::hotkeys::publish_saved_clip(
        &app,
        &result,
        game_folder,
        triggered_by.as_deref().unwrap_or("ui"),
        open_trimmer,
        false,
    );

    log::info!(
        "[lastshot] saved {} ({:.1}s, {:.1} MB) in {:.1} ms",
        clip.file_name,
        clip.duration_seconds,
        clip.size_bytes as f32 / 1_048_576.0,
        result.flush_ms
    );

    Ok(clip)
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_recorded_clips(
    state: State<'_, AppState>,
    with_thumbnails: Option<bool>,
) -> Result<Vec<ClipMetadata>, String> {
    let dir = state.output_dir();
    let extra: Vec<std::path::PathBuf> = state.settings.read().scan_folders();
    let thumbs = with_thumbnails.unwrap_or(true);
    let mut clips = tauri::async_runtime::spawn_blocking(move || {
        library::scan_library(&dir, &extra, thumbs).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("scan task panicked: {e}"))??;
    // Fold in favourites + tags from the sidecar and prune deleted entries.
    state.clip_meta.lock().merge_into(&mut clips);
    Ok(clips)
}

#[tauri::command]
pub async fn get_clip_thumbnail(path: String, at_seconds: Option<f32>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        library::extract_thumbnail(Path::new(&path), at_seconds.unwrap_or(1.0))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("thumbnail task panicked: {e}"))?
}

/// Pure split-point policy, shared with the unit tests: validates the clip is
/// long enough to be split in two and clamps the requested playhead so both
/// halves are at least 200 ms long (stream copy can only cut on key frames,
/// so the clamp also gives the encoder room to snap to a real cut point).
fn split_at_seconds(duration_seconds: f32, at_seconds: f32) -> Result<f32, String> {
    if duration_seconds <= 0.4 {
        return Err("clip is too short to split".to_string());
    }
    Ok(at_seconds.clamp(0.2, duration_seconds - 0.2))
}


/// Splits a clip in two at `at_seconds` with two stream-copy trims.
///
/// Both halves run inside ONE blocking task so the Media Foundation sessions
/// (startup/shutdown per trim) never overlap or race — back-to-back separate
/// `trim_clip` invokes were flaky. A short pause between the two sessions
/// lets the first MF instance tear down fully before the second starts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitResult {
    pub part_a: TrimResult,
    pub part_b: TrimResult,
}

#[tauri::command]
pub async fn split_clip(
    state: State<'_, AppState>,
    source_path: String,
    at_seconds: f32,
) -> Result<SplitResult, String> {
    let dir = state.edit_dir_for(Path::new(&source_path));
    tauri::async_runtime::spawn_blocking(move || {
        let source = PathBuf::from(&source_path);
        if !source.exists() {
            return Err(format!("source clip not found: {source_path}"));
        }
        // Use the probed duration so both halves stay inside the media even if
        // the gallery's cached duration is stale.
        let duration = library::probe(&source).map_err(|e| e.to_string())?.duration_seconds;
        let at = split_at_seconds(duration, at_seconds)?;

        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let part_a = library::trim_stream_copy(
            &source,
            &library::suggested_trim_path_in(&dir, &source),
            0.0,
            at,
        )
        .map_err(|e| e.to_string())?;

        // Beat for the first MF session to fully tear down (rapid
        // MFStartup/MFShutdown churn is a known source of flaky failures).
        std::thread::sleep(std::time::Duration::from_millis(40));

        let dest_b = library::suggested_trim_path_in(&dir, &source);
        let part_b = match library::trim_stream_copy(&source, &dest_b, at, duration) {
            Ok(b) => b,
            Err(e) => {
                // A failed split must not leave stray files — remove the
                // already-written part A and any partial part B so the library
                // stays consistent.
                let _ = std::fs::remove_file(PathBuf::from(&part_a.path));
                let _ = std::fs::remove_file(&dest_b);
                return Err(e.to_string());
            }
        };

        Ok(SplitResult { part_a, part_b })
    })
    .await
    .map_err(|e| format!("split task panicked: {e}"))?
}

/// Lossless key-frame accurate cut. No re-encode, so a 60 s clip trims in
/// roughly the time it takes to copy the bytes.
#[tauri::command]
pub async fn trim_clip(
    state: State<'_, AppState>,
    source_path: String,
    start_time: f32,
    end_time: f32,
    overwrite: Option<bool>,
) -> Result<TrimResult, String> {
    let dir = state.edit_dir_for(Path::new(&source_path));
    tauri::async_runtime::spawn_blocking(move || {
        let source = PathBuf::from(&source_path);
        let overwrite = overwrite.unwrap_or(false);
        let dest = if overwrite {
            source.with_extension("trim.tmp.mp4")
        } else {
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            library::suggested_trim_path_in(&dir, &source)
        };

        let mut result = library::trim_stream_copy(&source, &dest, start_time, end_time)
            .map_err(|e| e.to_string())?;

        if overwrite {
            std::fs::rename(&dest, &source).map_err(|e| e.to_string())?;
            result.path = source.to_string_lossy().to_string();
            result.file_name = source
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
        }
        Ok(result)
    })
    .await
    .map_err(|e| format!("trim task panicked: {e}"))?
}

#[tauri::command]
pub async fn delete_clip(path: String) -> Result<(), String> {
    // `async` + spawn_blocking: a non-async command runs on the main thread,
    // and a slow/network path here would freeze the whole WebView.
    // To the Recycle Bin, never deleted for good.
    tauri::async_runtime::spawn_blocking(move || crate::library_ops::recycle(&[path]))
    .await
    .map_err(|e| format!("delete task panicked: {e}"))?
}

/// Removes every recorded clip from the output folder. Returns how many were
/// deleted so the UI can toast a precise count.
#[tauri::command]
pub async fn delete_all_clips(state: State<'_, AppState>) -> Result<u32, String> {
    let dir = state.output_dir();
    tauri::async_runtime::spawn_blocking(move || {
        let clips = library::scan_directory(&dir, false).map_err(|e| e.to_string())?;
        let paths: Vec<String> = clips.into_iter().map(|c| c.path).collect();
        crate::library_ops::recycle(&paths)?;
        Ok(paths.len() as u32)
    })
    .await
    .map_err(|e| format!("delete task panicked: {e}"))?
}

#[tauri::command]
pub async fn rename_clip(
    state: State<'_, AppState>,
    path: String,
    new_name: String,
) -> Result<String, String> {
    let src = PathBuf::from(&path);
    let dest = tauri::async_runtime::spawn_blocking(move || -> Result<PathBuf, String> {
        let stem = sanitize_file_stem(&new_name, "");
        if stem.is_empty() {
            return Err("clip name cannot be empty".into());
        }
        let name = if stem.to_ascii_lowercase().ends_with(".mp4") {
            stem
        } else {
            format!("{stem}.mp4")
        };
        let dest = src
            .parent()
            .ok_or_else(|| "clip has no parent directory".to_string())?
            .join(name);
        std::fs::rename(&src, &dest).map_err(|e| e.to_string())?;
        Ok(dest)
    })
    .await
    .map_err(|e| format!("rename task panicked: {e}"))??;

    // Keep favourites/tags attached to the clip across the rename: the sidecar
    // is keyed by path, so the entry moves to the new path.
    state
        .clip_meta
        .lock()
        .migrate(&path, &dest.to_string_lossy());
    Ok(dest.to_string_lossy().to_string())
}

/// Puts the clip on the clipboard as a CF_HDROP file drop, which is what
/// Discord / Explorer / Slack / Teams paste handlers expect for a video.
#[tauri::command]
pub fn copy_clip_to_clipboard(path: String) -> Result<(), String> {
    clipboard::copy_files(&[PathBuf::from(path)])
}

/// Puts several clips on the clipboard as one multi-file CF_HDROP drop
/// (batch library management — paste the whole selection into Discord).
#[tauri::command]
pub fn copy_clips_to_clipboard(paths: Vec<String>) -> Result<(), String> {
    let clips: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    clipboard::copy_files(&clips)
}

/// Deletes several clips at once (batch library management). Returns how many
/// were actually removed so the UI can toast a precise count.
#[tauri::command]
pub async fn delete_clips(paths: Vec<String>) -> Result<u32, String> {
    // Batch delete of hundreds of files must never block the main thread.
    tauri::async_runtime::spawn_blocking(move || {
        // To the Recycle Bin, never deleted for good.
        let there: Vec<String> = paths.into_iter().filter(|p| Path::new(p).exists()).collect();
        crate::library_ops::recycle(&there)?;
        Ok(there.len() as u32)
    })
    .await
    .map_err(|e| format!("delete task panicked: {e}"))?
}

/// Stars / unstars many clips in one sidecar persist. Returns how many
/// entries actually changed.
#[tauri::command]
pub fn set_clips_favorite(
    state: State<'_, AppState>,
    paths: Vec<String>,
    favorite: bool,
) -> Result<u32, String> {
    Ok(state.clip_meta.lock().set_favorite_many(&paths, favorite))
}

/// Adds one tag to many clips (dedup + caps, single persist). Returns how
/// many clips actually gained the tag.
#[tauri::command]
pub fn add_clips_tag(
    state: State<'_, AppState>,
    paths: Vec<String>,
    tag: String,
) -> Result<u32, String> {
    Ok(state.clip_meta.lock().add_tag_many(&paths, &tag))
}

/// Removes one tag from many clips (single persist). Returns how many clips
/// actually lost the tag.
#[tauri::command]
pub fn remove_clips_tag(
    state: State<'_, AppState>,
    paths: Vec<String>,
    tag: String,
) -> Result<u32, String> {
    Ok(state.clip_meta.lock().remove_tag_many(&paths, &tag))
}

#[tauri::command]
pub fn reveal_clip_in_folder(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_output_folder(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = state.output_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_clip_external(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Manual "check for updates" — just opens the GitHub Releases page. No
/// background updater, no telemetry: Lastshot stays true to its privacy model.
#[tauri::command]
pub fn open_releases_page(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(
            "https://github.com/5arpy/Lastshot/releases",
            None::<&str>,
        )
        .map_err(|e| e.to_string())
}

/// Decodes one frame of a clip (hardware accelerated) into a full-resolution
/// PNG data URL — powers the "snapshot" button in the trimmer without ever
/// touching the webview's canvas (which asset-protocol media would taint).
#[tauri::command]
pub async fn extract_png_frame(
    path: String,
    at_seconds: Option<f32>,
    max_width: Option<u32>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        library::extract_frame_png(
            Path::new(&path),
            at_seconds.unwrap_or(0.0),
            max_width.unwrap_or(0),
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("snapshot task panicked: {e}"))?
}

/// Writes a PNG (base64 data URL) into the Lastshot output folder. Only accepts
/// valid PNG bytes so the webview can never write arbitrary files.
#[tauri::command]
pub async fn save_png_snapshot(
    state: State<'_, AppState>,
    png_base64: String,
    base_name: String,
) -> Result<String, String> {
    let dir = state.output_dir();
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        use base64::Engine;
        let raw = png_base64.trim_start_matches("data:image/png;base64,");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(raw)
            .map_err(|e| format!("invalid png data: {e}"))?;
        if bytes.len() < 8 || bytes[..8] != [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A] {
            return Err("payload is not a PNG image".into());
        }
        let stem = sanitize_file_stem(&base_name, "snapshot");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        // Never overwrite a previous snapshot: two shots of the same clip used
        // to resolve to the same name and the first one vanished silently.
        let mut path = dir.join(format!("{stem}.png"));
        let mut n = 2u32;
        while path.exists() {
            path = dir.join(format!("{stem}_{n}.png"));
            n += 1;
        }
        std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
        Ok(path.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("snapshot task panicked: {e}"))?
}

// ---------------------------------------------------------------------------
// Settings / system
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    Ok(state.settings.read().clone())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub buffer_seconds: Option<u32>,
    pub target_fps: Option<u32>,
    pub bitrate_kbps: Option<u32>,
    pub codec: Option<Codec>,
    pub monitor_index: Option<u32>,
    pub capture_source: Option<crate::media::CaptureSource>,
    pub app_audio: Option<crate::media::procaudio::AppAudio>,
    pub capture_cursor: Option<bool>,
    pub display_method: Option<crate::media::recorder::DisplayMethod>,
    pub capture_system_audio: Option<bool>,
    pub capture_microphone: Option<bool>,
    pub output_dir: Option<String>,
    pub open_trimmer_after_save: Option<bool>,
    pub minimize_to_tray: Option<bool>,
    pub autostart_buffer: Option<bool>,
    pub play_save_sound: Option<bool>,
    pub hotkey_save: Option<String>,
    pub hotkey_toggle: Option<String>,
    pub always_on_top: Option<bool>,
    pub auto_switch_profiles: Option<bool>,
    pub launch_at_startup: Option<bool>,
    pub auto_cleanup_days: Option<u32>,
    pub organize_by_game: Option<bool>,
    pub autosave_on_game_exit: Option<bool>,
    pub performance_mode: Option<bool>,
    pub privacy_pause_when_unfocused: Option<bool>,
    pub game_volume: Option<u32>,
    pub mic_volume: Option<u32>,
    pub mic_device_id: Option<String>,
    pub clean_voice: Option<bool>,
    pub adaptive_eco: Option<bool>,
    pub eco_battery_threshold_pct: Option<u32>,
    pub eco_ram_free_gbs: Option<u32>,
    pub check_updates_on_startup: Option<bool>,
    pub share_size_mb: Option<f32>,
    pub hotkey_snip: Option<String>,
    pub snip_save_to_folder: Option<bool>,
    pub library_folders: Option<Vec<String>>,
    pub hotkey_record: Option<String>,
    pub control_bar: Option<String>,
    pub studio_layers: Option<String>,
    pub explorer_open_with: Option<bool>,
    pub screenshot_dir: Option<String>,
    pub screenshot_format: Option<String>,
    pub screenshot_quality: Option<u8>,
    pub screenshot_copy: Option<bool>,
    pub recording_dir: Option<String>,
    pub recording_format: Option<crate::media::container::stream::Format>,
    pub remux_mkv: Option<bool>,
    pub rate_control: Option<crate::media::recorder::RateControl>,
    pub cqp_level: Option<u32>,
    pub keyframe_seconds: Option<f32>,
    pub encoder_preset: Option<crate::media::recorder::EncoderPreset>,
    pub encoder_backend: Option<crate::media::recorder::EncoderBackend>,
    pub hotkey_pause: Option<String>,
    pub record_countdown: Option<u32>,
    pub record_max_minutes: Option<f32>,
    pub record_max_gb: Option<f32>,
    pub record_file_name: Option<String>,
    pub record_if_exists: Option<String>,
    pub disk_reserve_mb: Option<u32>,
    pub streamer_mode: Option<bool>,
    /// In-app shortcut rebindings (the whole map).
    pub shortcuts: Option<std::collections::BTreeMap<String, String>>,
    pub ui_scale: Option<f64>,
}

#[tauri::command]
pub fn update_settings(
    state: State<'_, AppState>,
    app: AppHandle,
    patch: SettingsPatch,
) -> Result<Settings, String> {
    // Commit-on-success: the whole patch is applied to a *clone* and only
    // written back once every fallible step succeeded. The old code mutated
    // the live settings as it went, so a failure halfway through (folder
    // creation, autostart registry, disk full on save) left memory and
    // `settings.json` disagreeing — e.g. the hotkey re-registered with the OS
    // but the new combo never persisted, so it silently reverted on restart.
    let mut s = state.settings.read().clone();

    // Hotkeys must be re-registered with the OS before we persist them — if
    // another app owns the combo the whole patch fails and nothing is written.
    // Conflicts are rejected up front so one combo can never drive both actions.
    {
        let save = patch.hotkey_save.as_ref().unwrap_or(&s.hotkey_save);
        let toggle = patch.hotkey_toggle.as_ref().unwrap_or(&s.hotkey_toggle);
        let snip = patch.hotkey_snip.as_ref().unwrap_or(&s.hotkey_snip);
        let record = patch.hotkey_record.as_ref().unwrap_or(&s.hotkey_record);
        let pause = patch.hotkey_pause.as_ref().unwrap_or(&s.hotkey_pause);
        let keys = [
            (save, "Save replay"),
            (toggle, "Instant replay on/off"),
            (snip, "Screenshot"),
            (record, "Screen recording"),
            (pause, "Pause recording"),
        ];
        for (i, (a, an)) in keys.iter().enumerate() {
            for (b, bn) in keys.iter().skip(i + 1) {
                if !a.is_empty() && a.eq_ignore_ascii_case(b) {
                    return Err(format!("'{a}' is used twice: {an} and {bn}"));
                }
            }
        }
        // ...nor the mic-mute or frames click-through shortcut.
        for changed in [&patch.hotkey_save, &patch.hotkey_toggle, &patch.hotkey_snip, &patch.hotkey_record, &patch.hotkey_pause].into_iter().flatten() {
            let other = crate::hotkeys::used_by(&app, changed, "main").filter(|n| *n == "Mic mute" || *n == "Pop-out frames click-through");
            if let Some(name) = other {
                return Err(format!("'{changed}' is already the shortcut for {name}"));
            }
        }
    }
    if let Some(v) = patch.hotkey_save.clone() {
        crate::hotkeys::rebind(&app, &s.hotkey_save, &v)?;
        s.hotkey_save = v;
    }
    if let Some(v) = patch.hotkey_toggle.clone() {
        crate::hotkeys::rebind(&app, &s.hotkey_toggle, &v)?;
        s.hotkey_toggle = v;
    }
    if let Some(v) = patch.hotkey_snip.clone() {
        crate::hotkeys::rebind(&app, &s.hotkey_snip, &v)?;
        s.hotkey_snip = v;
    }
    if let Some(v) = patch.hotkey_record.clone() {
        crate::hotkeys::rebind(&app, &s.hotkey_record, &v)?;
        s.hotkey_record = v;
    }
    if let Some(v) = patch.hotkey_pause.as_ref() {
        let v = v.trim().to_string();
        crate::hotkey_guard::set(&app, "pause", &v)?;
        s.hotkey_pause = v;
    }
    if let Some(v) = patch.recording_format {
        s.recording_format = v;
    }
    if let Some(v) = patch.remux_mkv {
        s.remux_mkv = v;
    }
    if let Some(v) = patch.rate_control {
        s.rate_control = v;
    }
    if let Some(v) = patch.cqp_level {
        s.cqp_level = v.clamp(1, 51);
    }
    if let Some(v) = patch.keyframe_seconds {
        if !v.is_finite() {
            return Err("The key frame interval must be a number".into());
        }
        s.keyframe_seconds = v.clamp(0.25, 10.0);
    }
    if let Some(v) = patch.encoder_preset {
        s.encoder_preset = v;
    }
    if let Some(v) = patch.encoder_backend {
        s.encoder_backend = v;
    }
    if let Some(v) = patch.record_countdown {
        s.record_countdown = v.min(60);
    }
    if let Some(v) = patch.record_max_minutes {
        s.record_max_minutes = if v.is_finite() { v.clamp(0.0, 100_000.0) } else { 0.0 };
    }
    if let Some(v) = patch.record_max_gb {
        s.record_max_gb = if v.is_finite() { v.clamp(0.0, 100_000.0) } else { 0.0 };
    }
    if let Some(v) = patch.record_file_name.as_ref() {
        let v = v.trim();
        let v = if v.is_empty() { crate::settings::DEFAULT_RECORD_FILE_NAME } else { v };
        crate::recording::check_file_name_template(v)?;
        s.record_file_name = v.to_string();
    }
    if let Some(v) = patch.record_if_exists.as_ref() {
        if !["number", "overwrite"].contains(&v.as_str()) {
            return Err(format!("unknown choice {v}"));
        }
        s.record_if_exists = v.clone();
    }
    if let Some(v) = patch.disk_reserve_mb {
        s.disk_reserve_mb = v.clamp(100, 1_000_000);
    }
    if let Some(v) = patch.control_bar.clone() {
        if !["recording", "always", "off"].contains(&v.as_str()) {
            return Err(format!("unknown control bar mode {v}"));
        }
        s.control_bar = v;
    }
    if let Some(v) = patch.studio_layers.clone() {
        if !["recording", "always", "off"].contains(&v.as_str()) {
            return Err(format!("unknown layers mode {v}"));
        }
        s.studio_layers = v;
    }
    if let Some(v) = patch.screenshot_dir.as_ref() {
        s.screenshot_dir = v.trim().to_string();
    }
    if let Some(v) = patch.screenshot_format.as_ref() {
        if !["png", "jpg"].contains(&v.as_str()) {
            return Err(format!("unknown screenshot format {v}"));
        }
        s.screenshot_format = v.clone();
    }
    if let Some(v) = patch.screenshot_quality {
        s.screenshot_quality = v.clamp(50, 100);
    }
    if let Some(v) = patch.screenshot_copy {
        s.screenshot_copy = v;
    }
    if let Some(v) = patch.recording_dir.as_ref() {
        s.recording_dir = v.trim().to_string();
    }
    if let Some(v) = patch.shortcuts.as_ref() {
        s.shortcuts = v
            .iter()
            .filter(|(k, v)| k.len() <= 200 && v.len() <= 200 && k.contains(':'))
            .take(500)
            .map(|(k, v)| (k.clone(), v.trim().to_string()))
            .collect();
    }
    if let Some(v) = patch.ui_scale {
        if !v.is_finite() {
            return Err("UI scale must be a number".into());
        }
        s.ui_scale = crate::shell::clamp_scale(v);
    }
    if let Some(v) = patch.streamer_mode {
        s.streamer_mode = v;
    }
    if let Some(v) = patch.explorer_open_with {
        crate::files::set_explorer_verb(v)?;
        s.explorer_open_with = v;
    }

    if let Some(v) = patch.buffer_seconds {
        s.buffer_seconds = v.clamp(5, crate::settings::MAX_BUFFER_SECONDS);
    }
    if let Some(v) = patch.target_fps {
        s.target_fps = v.clamp(24, 240);
    }
    if let Some(v) = patch.bitrate_kbps {
        s.bitrate_kbps = v.clamp(1_000, 150_000);
    }
    if let Some(v) = patch.codec {
        s.codec = v;
    }
    if let Some(v) = patch.monitor_index {
        s.monitor_index = v;
    }
    let source_changed = patch.capture_source.as_ref().map(|v| *v != s.capture_source).unwrap_or(false)
        || patch.app_audio.as_ref().map(|v| *v != s.app_audio).unwrap_or(false)
        || patch.capture_cursor.map(|v| v != s.capture_cursor).unwrap_or(false)
        || patch.display_method.map(|v| v != s.display_method).unwrap_or(false);
    if source_changed && state.engine.recording_status().is_some() {
        return Err("Stop the recording before changing what to record.".into());
    }
    if let Some(v) = patch.capture_source.clone() {
        s.capture_source = v;
    }
    if let Some(v) = patch.app_audio.clone() {
        s.app_audio = v;
    }
    if let Some(v) = patch.capture_cursor {
        s.capture_cursor = v;
    }
    if let Some(v) = patch.display_method {
        s.display_method = v;
    }
    if let Some(v) = patch.capture_system_audio {
        s.capture_system_audio = v;
    }
    if let Some(v) = patch.capture_microphone {
        s.capture_microphone = v;
    }
    if let Some(v) = patch.output_dir.clone() {
        std::fs::create_dir_all(&v).map_err(|e| e.to_string())?;
        s.output_dir = v;
    }
    if let Some(v) = patch.open_trimmer_after_save {
        s.open_trimmer_after_save = v;
    }
    if let Some(v) = patch.minimize_to_tray {
        s.minimize_to_tray = v;
    }
    if let Some(v) = patch.autostart_buffer {
        s.autostart_buffer = v;
    }
    if let Some(v) = patch.play_save_sound {
        s.play_save_sound = v;
    }
    if let Some(v) = patch.always_on_top {
        s.always_on_top = v;
    }
    if let Some(v) = patch.auto_switch_profiles {
        s.auto_switch_profiles = v;
    }
    if let Some(v) = patch.launch_at_startup {
        // Registry Run key lives with the OS; keep it in sync with the setting
        // so a corrupt settings.json can never leave an unwanted autostart.
        s.launch_at_startup = v;
        use tauri_plugin_autostart::ManagerExt;
        if std::env::var_os("LASTSHOT_TEST_INSTANCE").is_some() {
            // A test copy never touches the real Run key.
        } else if v {
            if let Err(e) = app.autolaunch().enable() {
                return Err(format!("could not enable launch at startup: {e}"));
            }
        } else if let Err(e) = app.autolaunch().disable() {
            return Err(format!("could not disable launch at startup: {e}"));
        }
    }
    if let Some(v) = patch.auto_cleanup_days {
        s.auto_cleanup_days = v;
    }
    if let Some(v) = patch.organize_by_game {
        s.organize_by_game = v;
    }
    if let Some(v) = patch.autosave_on_game_exit {
        s.autosave_on_game_exit = v;
    }
    if let Some(v) = patch.performance_mode {
        s.performance_mode = v;
        // Capture caps (1080p/60 + encoder tuning) are read when the engine
        // starts. The deck offers APPLY & RESTART for an immediate switch.
    }
    if let Some(v) = patch.privacy_pause_when_unfocused {
        s.privacy_pause_when_unfocused = v;
    }
    if let Some(v) = patch.game_volume {
        s.game_volume = v.clamp(0, 100);
    }
    if let Some(v) = patch.mic_volume {
        s.mic_volume = v.clamp(0, 100);
    }
    if let Some(v) = patch.mic_device_id.clone() {
        let clean = if v.trim().is_empty() || v == "default" {
            None
        } else {
            Some(v)
        };
        s.mic_device_id = clean;
    }
    if let Some(v) = patch.adaptive_eco {
        s.adaptive_eco = v;
        // Re-evaluate immediately so enabling ECO reacts now, not at the next
        // poll. The deck applies the resulting buffer change itself.
    }
    if let Some(v) = patch.eco_battery_threshold_pct {
        s.eco_battery_threshold_pct = v.clamp(5, 100);
    }
    if let Some(v) = patch.eco_ram_free_gbs {
        s.eco_ram_free_gbs = v.clamp(1, 32);
    }
    if let Some(v) = patch.check_updates_on_startup {
        s.check_updates_on_startup = v;
    }
    if let Some(v) = patch.share_size_mb {
        if !v.is_finite() {
            return Err("size limit must be a number".into());
        }
        s.share_size_mb = v.clamp(1.0, 2000.0);
    }
    if let Some(v) = patch.snip_save_to_folder {
        s.snip_save_to_folder = v;
    }
    if let Some(v) = patch.library_folders.as_ref() {
        let mut seen = std::collections::HashSet::new();
        s.library_folders = v
            .iter()
            .map(|f| f.trim().to_string())
            .filter(|f| !f.is_empty() && seen.insert(f.to_lowercase()))
            .take(20)
            .collect();
    }

    // Persist first: if this fails, nothing below runs and the in-memory
    // settings are untouched.
    s.save()?;

    // ---- live side effects, applied only after the patch is durable ----
    if patch.buffer_seconds.is_some() {
        state.engine.set_buffer_seconds(s.buffer_seconds);
    }
    if let Some(dir) = patch.output_dir {
        // Point the running engine at the new folder so the next Alt+C flush
        // lands where the gallery is scanning — no restart required.
        state.engine.set_output_dir(std::path::PathBuf::from(&dir));
        // The trimmer's <video> loads through the asset: protocol, whose scope
        // is a static glob in tauri.conf.json. Widen it to the new folder or
        // previews break the moment the user moves the library.
        crate::allow_asset_dir(&app, &dir);
    }
    if patch.library_folders.is_some() {
        for dir in &s.library_folders {
            crate::allow_asset_dir(&app, dir);
        }
    }
    if patch.recording_dir.is_some() && !s.recording_dir.is_empty() {
        crate::allow_asset_dir(&app, &s.recording_dir);
    }
    if let Some(v) = patch.always_on_top {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.set_always_on_top(v);
        }
    }
    if let Some(v) = patch.privacy_pause_when_unfocused {
        // If privacy just turned on while no game is focused, gate the engine
        // immediately instead of waiting for the next foreground poll.
        if v {
            state.engine.set_privacy_gate(privacy_should_gate());
        } else {
            state.engine.set_privacy_gate(false);
        }
    }
    if patch.game_volume.is_some() || patch.mic_volume.is_some() {
        state
            .engine
            .set_audio_volumes(s.game_volume, crate::recording::effective_mic_volume(s.mic_volume));
    }
    if let Some(v) = patch.clean_voice {
        s.clean_voice = v;
        crate::media::voice::set_clean_voice(v);
    }
    if patch.mic_device_id.is_some() {
        state.engine.set_mic_device(s.mic_device_id.clone());
    }

    *state.settings.write() = s.clone();
    // Every window (tabs in their own windows too) shows the same settings.
    let _ = app.emit(EVT_SETTINGS, &s);
    if patch.ui_scale.is_some() {
        crate::shell::apply_scale_all(&app, s.ui_scale);
    }
    // A new source takes effect at once: restart a running engine with it
    // (off the main thread; the replay buffer starts over).
    if source_changed && state.engine.is_running() {
        crate::recording::restart_engine_soon(&app);
    }
    // After the write: the bar reads the new mode and hotkey.
    if patch.studio_layers.is_some() || patch.monitor_index.is_some() {
        crate::studio::sync(&app);
    }
    if patch.control_bar.is_some() || patch.hotkey_record.is_some() || patch.hotkey_pause.is_some() {
        crate::recording::sync_bar(&app);
        crate::recording::emit_state(&app);
    }
    Ok(s)
}

/// Battery + RAM snapshot for the adaptive ECO capture mode. Cheap local
/// reads (one syscall each) — safe to poll every few seconds.
#[tauri::command]
pub fn get_power_state() -> Result<crate::power::PowerState, String> {
    crate::power::read_power_state()
}


// ---------------------------------------------------------------------------
// Clip metadata (favourites + tags)
// ---------------------------------------------------------------------------

/// Stars / unstars a clip (persisted in the sidecar store).
#[tauri::command]
pub fn set_clip_favorite(
    state: State<'_, AppState>,
    path: String,
    favorite: bool,
) -> Result<ClipMetaEntry, String> {
    if !std::path::Path::new(&path).exists() {
        return Err(format!("clip not found: {path}"));
    }
    state.clip_meta.lock().set_favorite(&path, favorite)
}

/// Replaces the custom tags of a clip (persisted in the sidecar store).
#[tauri::command]
pub fn set_clip_tags(
    state: State<'_, AppState>,
    path: String,
    tags: Vec<String>,
) -> Result<ClipMetaEntry, String> {
    if !std::path::Path::new(&path).exists() {
        return Err(format!("clip not found: {path}"));
    }
    state.clip_meta.lock().set_tags(&path, tags)
}

/// Privacy mode: tells the engine whether a game is currently focused. When
/// gated, the ring is cleared and capture stops feeding the encoder.
#[tauri::command]
pub fn set_privacy_gate(state: State<'_, AppState>, gate: bool) -> Result<(), String> {
    state.engine.set_privacy_gate(gate);
    Ok(())
}

/// Deletes clips older than `days` from the output folder. Returns how many
/// were removed so the UI can toast an exact count. Runs off the main thread.
#[tauri::command]
pub async fn cleanup_old_clips(state: State<'_, AppState>, days: u32) -> Result<u32, String> {
    let dir = state.output_dir();
    let days = days.max(1);
    let cutoff = chrono::Utc::now() - chrono::Duration::days(days as i64);
    let clips = tauri::async_runtime::spawn_blocking(move || library::scan_directory(&dir, false))
        .await
        .map_err(|e| format!("cleanup task panicked: {e}"))?
        .map_err(|e| e.to_string())?;
    // Starred clips are kept forever: that is what starring is for.
    let victims: Vec<String> = {
        let meta = state.clip_meta.lock();
        clips
            .into_iter()
            .filter(|c| {
                chrono::DateTime::from_timestamp_millis(c.created_unix_ms)
                    .is_some_and(|created| created < cutoff)
                    && !meta.get(&c.path).favorite
            })
            .map(|c| c.path)
            .collect()
    };
    tauri::async_runtime::spawn_blocking(move || {
        victims
            .iter()
            .filter(|p| library::delete_clip(Path::new(p)).is_ok())
            .count() as u32
    })
    .await
    .map_err(|e| format!("cleanup task panicked: {e}"))
}

// ---------------------------------------------------------------------------
// Capture profiles (per-game presets)
// ---------------------------------------------------------------------------

/// The game currently in the foreground, if any. The UI polls this at ~2 Hz
/// to drive profile auto-switching. Runs off the main thread because
/// `GetWindowTextW` sends a cross-process message that can block while a
/// hung foreground app ignores it.
#[tauri::command]
pub async fn get_foreground_game() -> Result<Option<ForegroundGame>, String> {
    tauri::async_runtime::spawn_blocking(crate::foreground::get_foreground_game)
        .await
        .map_err(|e| format!("foreground query panicked: {e}"))
}

#[tauri::command]
pub fn get_profiles(state: State<'_, AppState>) -> Result<Vec<CaptureProfile>, String> {
    Ok(state.settings.read().profiles.clone())
}

/// Creates or updates a profile (matched by `id`). Returns the full settings
/// so the UI can re-render from a single source of truth.
#[tauri::command]
pub fn save_profile(
    state: State<'_, AppState>,
    profile: CaptureProfile,
) -> Result<Settings, String> {
    let mut s = state.settings.write();
    let id = profile.id.trim().to_ascii_lowercase();
    if id.is_empty() {
        return Err("profile id cannot be empty".into());
    }
    let mut profile = profile;
    profile.id = id.clone();
    if profile.name.trim().is_empty() {
        profile.name = id.clone();
    } else {
        profile.name = profile.name.trim().to_string();
    }
    profile.buffer_seconds = profile.buffer_seconds.clamp(5, crate::settings::MAX_BUFFER_SECONDS);
    profile.target_fps = profile.target_fps.clamp(24, 240);
    profile.bitrate_kbps = profile.bitrate_kbps.clamp(1_000, 150_000);

    if let Some(existing) = s.profiles.iter_mut().find(|p| p.id == id) {
        *existing = profile;
    } else {
        s.profiles.push(profile);
    }
    s.save()?;
    Ok(s.clone())
}

/// Removes a profile and any mappings that pointed at it.
#[tauri::command]
pub fn delete_profile(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<Settings, String> {
    let mut s = state.settings.write();
    let before = s.profiles.len();
    s.profiles.retain(|p| p.id != profile_id);
    if s.profiles.len() == before {
        return Err(format!("profile '{profile_id}' not found"));
    }
    s.profile_map.retain(|m| m.profile_id != profile_id);
    s.save()?;
    Ok(s.clone())
}

/// Replaces the whole exe → profile map. Rows with empty exes or unknown
/// profile ids are dropped; duplicate exes keep the first entry.
#[tauri::command]
pub fn set_profile_map(
    state: State<'_, AppState>,
    map: Vec<ProfileMapEntry>,
) -> Result<Settings, String> {
    let mut s = state.settings.write();
    let mut seen = std::collections::HashSet::new();
    let cleaned: Vec<ProfileMapEntry> = map
        .into_iter()
        .filter_map(|m| {
            let exe = m.exe_name.trim().to_ascii_lowercase();
            if exe.is_empty() || s.profile_by_id(&m.profile_id).is_none() {
                return None;
            }
            if !seen.insert(exe.clone()) {
                return None;
            }
            Some(ProfileMapEntry {
                profile_id: m.profile_id,
                exe_name: exe,
            })
        })
        .collect();
    s.profile_map = cleaned;
    s.save()?;
    Ok(s.clone())
}

/// Applies a profile right now: the buffer window changes live on the running
/// engine, fps/bitrate/codec are persisted and take effect on the next engine
/// start (same contract as the APPLY & RESTART ENGINE button).
#[tauri::command]
pub fn apply_profile(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<Settings, String> {
    let mut s = state.settings.write();
    let profile = s
        .profile_by_id(&profile_id)
        .cloned()
        .ok_or_else(|| format!("profile '{profile_id}' not found"))?;
    s.apply_profile_values(&profile);
    state.engine.set_buffer_seconds(s.buffer_seconds);
    s.save()?;
    Ok(s.clone())
}

#[tauri::command]
pub async fn get_monitors() -> Result<Vec<MonitorInfo>, String> {
    // DXGI adapter/output enumeration is a COM walk; it must not run on the
    // main thread (a slow driver would freeze the window).
    tauri::async_runtime::spawn_blocking(enumerate_monitors)
        .await
        .map_err(|e| format!("monitor query panicked: {e}"))
}

#[tauri::command]
pub async fn get_audio_input_devices() -> Result<Vec<crate::media::audio::AudioDevice>, String> {
    // COM enumeration + property-store reads for every capture endpoint.
    tauri::async_runtime::spawn_blocking(crate::media::audio::enumerate_audio_devices)
        .await
        .map_err(|e| format!("audio device query panicked: {e}"))
}

#[tauri::command]
pub fn hide_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    Ok(())
}

#[tauri::command]
pub fn quit_app(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.engine.stop();
    crate::quit_cleanup(&app);
    // Removes the tray icon (a plain exit leaves a ghost icon behind).
    app.cleanup_before_exit();
    std::process::exit(0);
}

// ---------------------------------------------------------------------------
// Clipboard (CF_HDROP)
// ---------------------------------------------------------------------------

pub(crate) mod clipboard {
    use std::path::PathBuf;

    /// Multi-file CF_HDROP: a double-NUL terminated list of wide paths, each
    /// file its own NUL-terminated string. Discord / Explorer / Teams paste
    /// handlers read exactly this shape.
    #[cfg(all(windows, not(feature = "headless-sim")))]
    pub fn copy_files(paths: &[PathBuf]) -> Result<(), String> {
        use std::os::windows::ffi::OsStrExt;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::DataExchange::{
            CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
        };
        use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
        use windows::Win32::System::Ole::CF_HDROP;
        use windows::Win32::UI::Shell::DROPFILES;

        for p in paths {
            if !p.exists() {
                return Err(format!("clip not found: {}", p.display()));
            }
        }

        let mut wide: Vec<u16> = Vec::new();
        for p in paths {
            wide.extend(p.as_os_str().encode_wide());
            wide.push(0);
        }
        wide.push(0); // second NUL terminates the whole list

        let header = std::mem::size_of::<DROPFILES>();
        let total = header + wide.len() * 2;

        unsafe {
            OpenClipboard(None).map_err(|e| format!("OpenClipboard: {e}"))?;
            let result = (|| -> Result<(), String> {
                EmptyClipboard().map_err(|e| format!("EmptyClipboard: {e}"))?;
                let hmem =
                    GlobalAlloc(GMEM_MOVEABLE, total).map_err(|e| format!("GlobalAlloc: {e}"))?;
                let ptr = GlobalLock(hmem);
                if ptr.is_null() {
                    return Err("GlobalLock returned null".into());
                }
                std::ptr::write_bytes(ptr as *mut u8, 0, total);
                let df = ptr as *mut DROPFILES;
                (*df).pFiles = header as u32;
                (*df).fWide = true.into();
                std::ptr::copy_nonoverlapping(
                    wide.as_ptr(),
                    (ptr as *mut u8).add(header) as *mut u16,
                    wide.len(),
                );
                let _ = GlobalUnlock(hmem);
                SetClipboardData(CF_HDROP.0 as u32, HANDLE(hmem.0))
                    .map_err(|e| format!("SetClipboardData: {e}"))?;
                Ok(())
            })();
            let _ = CloseClipboard();
            result
        }
    }

    #[cfg(any(not(windows), feature = "headless-sim"))]
    pub fn copy_files(paths: &[PathBuf]) -> Result<(), String> {
        for p in paths {
            if !p.exists() {
                return Err(format!("clip not found: {}", p.display()));
            }
        }
        let names: Vec<String> = paths
            .iter()
            .map(|p| p.display().to_string())
            .collect();
        log::info!("[lastshot] (stub) copied {} to clipboard", names.join(", "));
        Ok(())
    }
}

#[tauri::command]
pub fn simulate_device_loss(state: State<'_, AppState>) {
    state.engine.simulate_device_loss();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {

    #[test]
    fn edits_of_outside_clips_go_to_the_save_folder() {
        use super::edit_dir;
        use std::path::{Path, PathBuf};
        let out = Path::new(r"C:\Videos\Lastshot");
        assert_eq!(
            edit_dir(out, Path::new(r"C:\Videos\Lastshot\cs2\a.mp4")),
            PathBuf::from(r"C:\Videos\Lastshot\cs2")
        );
        assert_eq!(edit_dir(out, Path::new(r"D:\Old\b.mp4")), out.to_path_buf());
        assert_eq!(edit_dir(out, Path::new(r"C:\Videos\LastshotOld\c.mp4")), out.to_path_buf());
    }

    use super::split_at_seconds;

    #[test]
    fn rejects_clips_too_short_to_split() {
        // 0.4 s is the minimum *total* length: it cannot produce two real
        // halves, and everything shorter is rejected too.
        assert!(split_at_seconds(0.4, 0.2).is_err());
        assert!(split_at_seconds(0.3, 0.1).is_err());
        assert!(split_at_seconds(0.0, 0.0).is_err());
    }

    #[test]
    fn passes_through_playheads_inside_the_media() {
        assert_eq!(split_at_seconds(10.0, 5.0).unwrap(), 5.0);
        assert_eq!(split_at_seconds(60.0, 30.0).unwrap(), 30.0);
        assert_eq!(split_at_seconds(10.0, 3.25).unwrap(), 3.25);
    }

    #[test]
    fn clamps_playhead_to_a_minimum_half_length() {
        // At the very start -> pushed to 0.2 s so part A is non-empty.
        assert_eq!(split_at_seconds(10.0, 0.0).unwrap(), 0.2);
        assert_eq!(split_at_seconds(10.0, -5.0).unwrap(), 0.2);
        // At/after the end -> pushed to duration - 0.2 s so part B is non-empty.
        assert_eq!(split_at_seconds(10.0, 9.9).unwrap(), 9.8);
        assert_eq!(split_at_seconds(10.0, 999.0).unwrap(), 9.8);
    }

    #[test]
    fn clamp_keeps_both_halves_inside_the_media() {
        // Whatever the playhead, both halves must be within [0, duration].
        for at in [-100.0, -0.1, 0.0, 0.2, 1.0, 5.0, 9.8, 10.0, 100.0] {
            let cut = split_at_seconds(10.0, at).unwrap();
            assert!(cut >= 0.2, "cut {cut} below 0.2");
            assert!(cut <= 9.8, "cut {cut} above duration - 0.2");
        }
    }
}


/// Windows that can be recorded on their own (front-most first).
#[tauri::command]
pub async fn list_windows() -> Result<Vec<crate::media::wincap::WindowInfo>, String> {
    tauri::async_runtime::spawn_blocking(crate::media::wincap::list_windows)
        .await
        .map_err(|e| e.to_string())
}
