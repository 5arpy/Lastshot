//! Screen recording (start / pause / stop, as long as you like) and the small
//! on-screen control bar. The bar is excluded from screen capture, so it never
//! shows up in recordings, replays or screenshots.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::{AppState, EVT_BUFFER_STATE, EVT_ERROR};
use crate::media::library::ClipMetadata;
use crate::media::recorder::RecordingStatus;

pub const EVT_RECORDING: &str = "lastshot://recording";
pub const BAR_LABEL: &str = "bar";

static MIC_MUTED: AtomicBool = AtomicBool::new(false);
/// Serialises start/stop so a double hotkey press cannot race.
static BUSY: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

/// Everything the control bar and the Home page show.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BarState {
    pub recording: Option<RecordingStatus>,
    pub mic_muted: bool,
    pub mic_on: bool,
    pub replay_on: bool,
    pub hotkey_record: String,
    pub hotkey_save: String,
    pub hotkey_snip: String,
}

fn bar_state(state: &AppState) -> BarState {
    let s = state.settings.read();
    BarState {
        recording: state.engine.recording_status(),
        mic_muted: MIC_MUTED.load(Ordering::Relaxed),
        mic_on: s.capture_microphone,
        replay_on: state.engine.is_running(),
        hotkey_record: s.hotkey_record.clone(),
        hotkey_save: s.hotkey_save.clone(),
        hotkey_snip: s.hotkey_snip.clone(),
    }
}

pub fn emit_state(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        let _ = app.emit(EVT_RECORDING, bar_state(&state));
    }
}

fn unique(dir: &std::path::Path, stem: &str) -> PathBuf {
    let mut p = dir.join(format!("{stem}.mp4"));
    let mut n = 2;
    while p.exists() {
        p = dir.join(format!("{stem}_{n}.mp4"));
        n += 1;
    }
    p
}

/// Starts recording, turning the capture engine on first if needed.
pub async fn start(app: &AppHandle) -> Result<RecordingStatus, String> {
    let state = app.state::<AppState>();
    let engine = Arc::clone(&state.engine);
    let out = state.output_dir();
    let rec_dir = state.settings.read().recording_dir.trim().to_string();
    let game = crate::commands::resolve_game_folder(&state, None);
    let cfg = state.settings.read().to_recorder_config();
    let base = if rec_dir.is_empty() { out } else { std::path::PathBuf::from(rec_dir) };
    let dir = match &game {
        Some(g) => base.join(g),
        None => base,
    };
    let path = unique(
        &dir,
        &format!("Lastshot_Recording_{}", chrono::Local::now().format("%Y-%m-%d_%H-%M-%S")),
    );
    let h = app.clone();
    let status = tauri::async_runtime::spawn_blocking(move || {
        let _guard = BUSY.lock();
        if !engine.is_running() {
            engine.start(cfg).map_err(|e| e.to_string())?;
            let _ = h.emit(EVT_BUFFER_STATE, engine.stats());
        }
        // A freshly started engine needs a moment for its first frames.
        let mut last = String::new();
        for _ in 0..40 {
            match engine.start_recording(path.clone()) {
                Ok(s) => return Ok(s),
                Err(e) => {
                    last = e.to_string();
                    if !last.contains("starting") {
                        break;
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(150));
        }
        Err(last)
    })
    .await
    .map_err(|e| format!("recording task failed: {e}"))??;
    sync_bar(app);
    emit_state(app);
    Ok(status)
}

/// Finishes the recording and adds it to Clips.
pub async fn stop(app: &AppHandle) -> Result<ClipMetadata, String> {
    let state = app.state::<AppState>();
    let engine = Arc::clone(&state.engine);
    let write = tauri::async_runtime::spawn_blocking(move || {
        let _guard = BUSY.lock();
        engine.stop_recording().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("recording task failed: {e}"))??;
    let out = state.output_dir();
    let game = PathBuf::from(&write.path)
        .parent()
        .filter(|p| *p != out.as_path())
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().to_string());
    let clip = crate::hotkeys::publish_saved_clip(app, &write, game, "recording", false, false);
    sync_bar(app);
    emit_state(app);
    Ok(clip)
}

/// Hotkey / tray: start when idle, stop when recording.
pub fn toggle(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let recording = app
            .try_state::<AppState>()
            .and_then(|s| s.engine.recording_status())
            .is_some();
        let r = if recording {
            stop(&app).await.map(|_| ())
        } else {
            start(&app).await.map(|_| ())
        };
        if let Err(e) = r {
            let _ = app.emit(EVT_ERROR, e);
        }
    });
}

#[tauri::command]
pub async fn start_recording(app: AppHandle) -> Result<RecordingStatus, String> {
    start(&app).await
}

#[tauri::command]
pub async fn stop_recording(app: AppHandle) -> Result<ClipMetadata, String> {
    stop(&app).await
}

#[tauri::command]
pub fn pause_recording(app: AppHandle, state: State<'_, AppState>, paused: bool) -> Result<(), String> {
    if !state.engine.set_recording_paused(paused) {
        return Err("Not recording".into());
    }
    emit_state(&app);
    Ok(())
}

#[tauri::command]
pub fn get_bar_state(state: State<'_, AppState>) -> BarState {
    bar_state(&state)
}

/// Mutes the microphone in replays and recordings until unmuted (the saved
/// volume setting is kept).
#[tauri::command]
pub fn set_mic_muted(app: AppHandle, state: State<'_, AppState>, muted: bool) {
    MIC_MUTED.store(muted, Ordering::Relaxed);
    let (game, mic) = {
        let s = state.settings.read();
        (s.game_volume, s.mic_volume)
    };
    state.engine.set_audio_volumes(game, if muted { 0 } else { mic });
    emit_state(&app);
}

/// Keeps the saved mic volume from overriding a mute.
pub fn effective_mic_volume(volume: u32) -> u32 {
    if MIC_MUTED.load(Ordering::Relaxed) {
        0
    } else {
        volume
    }
}

#[tauri::command]
pub fn show_main_window(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

// ------------------------------------------------------------- control bar

/// Shows or hides the bar for the "Control bar" setting and the current
/// recording state.
pub fn sync_bar(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let mode = state.settings.read().control_bar.clone();
    let recording = state.engine.recording_status().is_some();
    let want = match mode.as_str() {
        "always" => true,
        "recording" => recording,
        _ => false,
    };
    let h = app.clone();
    // Always queue it from a worker thread: called from a sync command (which
    // runs on the main thread), `run_on_main_thread` would build the window
    // right there, and building a webview inside a command deadlocks on Windows.
    tauri::async_runtime::spawn(async move {
        let h2 = h.clone();
        let _ = h.run_on_main_thread(move || {
            if want {
                if let Err(e) = open_bar(&h2) {
                    log::warn!("[lastshot] control bar: {e}");
                }
            } else if let Some(w) = h2.get_webview_window(BAR_LABEL) {
                let _ = w.close();
            }
        });
    });
}

fn open_bar(app: &AppHandle) -> tauri::Result<()> {
    if app.get_webview_window(BAR_LABEL).is_some() {
        return Ok(());
    }
    let (bw, bh) = (360.0, 46.0);
    let win = tauri::WebviewWindowBuilder::new(app, BAR_LABEL, tauri::WebviewUrl::default())
        .title("Lastshot controls")
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(true)
        .focused(false)
        .visible(false)
        .inner_size(bw, bh)
        .background_color(tauri::window::Color(24, 26, 32, 255))
        .build()?;
    if let Ok(Some(m)) = win.primary_monitor() {
        let scale = m.scale_factor();
        let x = m.position().x + ((m.size().width as f64 - bw * scale) / 2.0) as i32;
        let y = m.position().y + (10.0 * scale) as i32;
        let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
    }
    #[cfg(windows)]
    if let Ok(hwnd) = win.hwnd() {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowDisplayAffinity, ShowWindow, SW_SHOWNOACTIVATE, WDA_EXCLUDEFROMCAPTURE,
        };
        let h = HWND(hwnd.0 as _);
        unsafe {
            // Never in a capture; shown without taking focus from a game.
            let _ = SetWindowDisplayAffinity(h, WDA_EXCLUDEFROMCAPTURE);
            let _ = ShowWindow(h, SW_SHOWNOACTIVATE);
        }
        return Ok(());
    }
    win.show()
}
