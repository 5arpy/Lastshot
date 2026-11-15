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
/// The picked area of the running recording (None = whole screen).
static AREA: parking_lot::Mutex<Option<Area>> = parking_lot::Mutex::new(None);
/// Moments marked during the running recording (seconds).
static MARKERS: parking_lot::Mutex<Vec<f32>> = parking_lot::Mutex::new(Vec::new());
/// 0-1 while a finished area recording is being cropped.
static FINISHING: parking_lot::Mutex<Option<f32>> = parking_lot::Mutex::new(None);
/// The user hid the bar; it stays away until the next recording starts.
static BAR_HIDDEN: AtomicBool = AtomicBool::new(false);
/// The user asked for the bar (Home / tray) even though the setting is off.
static BAR_WANTED: AtomicBool = AtomicBool::new(false);
static BAR_OPEN: AtomicBool = AtomicBool::new(false);
static DRAWING: AtomicBool = AtomicBool::new(false);
/// What is happening after stop: "Saving the recording" / "Cutting to the area".
static FINISH_LABEL: parking_lot::Mutex<Option<&'static str>> = parking_lot::Mutex::new(None);
/// Label of the screen-drawing overlay window.
pub const ANNOT_LABEL: &str = "annot";

/// Part of the screen a recording keeps.
#[derive(Clone, Debug)]
pub struct Area {
    pub crop: crate::media::shrink::Crop,
    /// "1280×720"
    pub label: String,
}
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
    /// Size of the recorded area ("1280×720"), None for the whole screen.
    pub area: Option<String>,
    /// How many moments were marked so far.
    pub markers: usize,
    /// Size of the recording file so far, bytes.
    pub bytes: u64,
    /// 0-1 while a stopped recording is being finished (saved / cut to the area).
    pub finishing: Option<f32>,
    /// What the finishing step is, for the bar and the notice in the window.
    pub finishing_label: Option<String>,
    /// The bar window is open.
    pub bar_open: bool,
    /// Drawing on the screen is on.
    pub drawing: bool,
}

fn bar_state(state: &AppState) -> BarState {
    let s = state.settings.read();
    let recording = state.engine.recording_status();
    let bytes = recording
        .as_ref()
        .and_then(|r| std::fs::metadata(&r.path).ok())
        .map(|m| m.len())
        .unwrap_or(0);
    BarState {
        area: recording.as_ref().and(AREA.lock().as_ref().map(|a| a.label.clone())),
        markers: if recording.is_some() { MARKERS.lock().len() } else { 0 },
        bytes,
        finishing: *FINISHING.lock(),
        finishing_label: FINISH_LABEL.lock().map(str::to_string),
        bar_open: BAR_OPEN.load(Ordering::Relaxed),
        drawing: DRAWING.load(Ordering::Relaxed),
        recording,
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

/// Starts recording the whole screen, turning the capture engine on first if needed.
pub async fn start(app: &AppHandle) -> Result<RecordingStatus, String> {
    start_with(app, None).await
}

/// Makes `source` what the engine captures (saved in Settings), restarting
/// a running engine with it. The instant replay buffer starts over.
pub async fn set_source(app: &AppHandle, source: crate::media::CaptureSource) -> Result<(), String> {
    let state = app.state::<AppState>();
    if state.settings.read().capture_source == source {
        return Ok(());
    }
    if state.engine.recording_status().is_some() {
        return Err("Stop the recording before changing what to record.".into());
    }
    let cfg = {
        let mut s = state.settings.write();
        s.capture_source = source;
        let _ = s.save();
        s.to_recorder_config()
    };
    let engine = Arc::clone(&state.engine);
    if engine.is_running() {
        let h = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _guard = BUSY.lock();
            engine.stop();
            let r = engine.start(cfg).map(|_| ()).map_err(|e| e.to_string());
            let _ = h.emit(EVT_BUFFER_STATE, engine.stats());
            r
        })
        .await
        .map_err(|e| format!("engine task failed: {e}"))??;
    }
    let _ = app.emit("lastshot://settings-changed", ());
    Ok(())
}

/// Records `source` (full screen or one window / app).
pub async fn start_source(app: &AppHandle, source: crate::media::CaptureSource) -> Result<RecordingStatus, String> {
    set_source(app, source).await?;
    start_with(app, None).await
}

/// Starts recording; with `area`, only that part of the screen is kept.
pub async fn start_with(app: &AppHandle, area: Option<Area>) -> Result<RecordingStatus, String> {
    // An area is cut out of the full screen afterwards, so it needs the
    // full screen as the source.
    if area.is_some() {
        set_source(app, crate::media::CaptureSource::Display).await?;
    }
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
    *AREA.lock() = area;
    MARKERS.lock().clear();
    BAR_HIDDEN.store(false, Ordering::Relaxed);
    sync_bar(app);
    emit_state(app);
    Ok(status)
}

/// Finishes the recording and adds it to Clips.
pub async fn stop(app: &AppHandle) -> Result<ClipMetadata, String> {
    let r = stop_inner(app).await;
    *FINISHING.lock() = None;
    *FINISH_LABEL.lock() = None;
    BAR_WANTED.store(false, Ordering::Relaxed);
    sync_bar(app);
    emit_state(app);
    r
}

async fn stop_inner(app: &AppHandle) -> Result<ClipMetadata, String> {
    let state = app.state::<AppState>();
    let engine = Arc::clone(&state.engine);
    close_drawing(app);
    // Shown in the bar and in the window until the clip is in Clips.
    *FINISHING.lock() = Some(0.0);
    *FINISH_LABEL.lock() = Some("Saving the recording");
    emit_state(app);
    let write = tauri::async_runtime::spawn_blocking(move || {
        let _guard = BUSY.lock();
        engine.stop_recording().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("recording task failed: {e}"))??;
    let area = AREA.lock().take();
    let markers = std::mem::take(&mut *MARKERS.lock());
    if area.is_some() {
        *FINISH_LABEL.lock() = Some("Cutting the recording to the area");
    }
    sync_bar(app);
    let write = match area {
        Some(a) => crop_to_area(app, write, a).await,
        None => write,
    };
    if !markers.is_empty() {
        let _ = state.clip_meta.lock().set_markers(&write.path, markers);
    }
    let out = state.output_dir();
    let game = PathBuf::from(&write.path)
        .parent()
        .filter(|p| *p != out.as_path())
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().to_string());
    let mut clip = crate::hotkeys::publish_saved_clip(app, &write, game, "recording", false, false);
    clip.markers = state.clip_meta.lock().get(&write.path).markers;
    Ok(clip)
}

/// Re-encodes a finished recording down to the picked area (on the GPU, at
/// full quality) and replaces the file. If that fails, the full-screen
/// recording is kept and the error is shown.
async fn crop_to_area(
    app: &AppHandle,
    write: crate::media::recorder::ClipWriteResult,
    area: Area,
) -> crate::media::recorder::ClipWriteResult {
    use crate::media::shrink::{self, Segment, Target};
    let full = PathBuf::from(&write.path);
    let tmp = full.with_file_name(format!(
        "{}_area.mp4",
        full.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()
    ));
    *FINISHING.lock() = Some(0.0);
    emit_state(app);
    let h = app.clone();
    let (src, dst) = (full.clone(), tmp.clone());
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut last = -1.0f32;
        let r = shrink::export(
            &[Segment { path: src.clone(), start: 0.0, end: None }],
            Some(area.crop),
            Target::Quality,
            &dst,
            &mut |p| {
                if p - last >= 0.03 {
                    last = p;
                    *FINISHING.lock() = Some(p);
                    emit_state(&h);
                }
            },
        )
        .map_err(|e| e.to_string())?;
        std::fs::remove_file(&src).map_err(|e| e.to_string())?;
        std::fs::rename(&dst, &src).map_err(|e| e.to_string())?;
        let probe = crate::media::library::probe(&src).map_err(|e| e.to_string())?;
        Ok::<_, String>((r, probe))
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    *FINISHING.lock() = Some(1.0);
    match result {
        Ok((_, probe)) => crate::media::recorder::ClipWriteResult {
            size_bytes: std::fs::metadata(&full).map(|m| m.len()).unwrap_or(0),
            duration_seconds: probe.duration_seconds,
            width: probe.width,
            height: probe.height,
            fps: probe.fps,
            has_audio: probe.has_audio,
            ..write
        },
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            let _ = app.emit(
                EVT_ERROR,
                format!("Kept the whole screen: cropping the recording to the area failed ({e})"),
            );
            write
        }
    }
}

/// Stops the recording and deletes it.
pub async fn discard(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let engine = Arc::clone(&state.engine);
    let write = tauri::async_runtime::spawn_blocking(move || {
        let _guard = BUSY.lock();
        engine.stop_recording().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("recording task failed: {e}"))??;
    AREA.lock().take();
    MARKERS.lock().clear();
    close_drawing(app);
    BAR_WANTED.store(false, Ordering::Relaxed);
    let _ = std::fs::remove_file(&write.path);
    sync_bar(app);
    emit_state(app);
    Ok(())
}

#[tauri::command]
pub async fn discard_recording(app: AppHandle) -> Result<(), String> {
    discard(&app).await
}

/// Marks this moment of the running recording; the editor shows the marks.
#[tauri::command]
pub fn add_marker(app: AppHandle, state: State<'_, AppState>) -> Result<usize, String> {
    let status = state.engine.recording_status().ok_or("Not recording")?;
    let n = {
        let mut m = MARKERS.lock();
        if m.last().is_some_and(|l| (status.seconds - l).abs() < 0.5) {
            return Ok(m.len());
        }
        m.push(status.seconds);
        m.len()
    };
    emit_state(&app);
    Ok(n)
}

/// Hides the bar until the next recording starts.
#[tauri::command]
pub fn hide_bar(app: AppHandle) {
    BAR_HIDDEN.store(true, Ordering::Relaxed);
    BAR_WANTED.store(false, Ordering::Relaxed);
    if let Some(w) = app.get_webview_window(BAR_LABEL) {
        let _ = w.close();
    }
    BAR_OPEN.store(false, Ordering::Relaxed);
    emit_state(&app);
}

/// Brings the bar back (after it was hidden, or when the setting is off).
#[tauri::command]
pub fn show_bar(app: AppHandle) {
    BAR_HIDDEN.store(false, Ordering::Relaxed);
    BAR_WANTED.store(true, Ordering::Relaxed);
    sync_bar(&app);
}

/// Shrinks the bar to a small pill (timer + expand) or back to full size,
/// keeping its centre where it is.
#[tauri::command]
pub fn set_bar_compact(app: AppHandle, compact: bool) -> Result<(), String> {
    let w = app.get_webview_window(BAR_LABEL).ok_or("no bar")?;
    let scale = w.scale_factor().map_err(|e| e.to_string())?;
    let pos = w.outer_position().map_err(|e| e.to_string())?;
    let size = w.outer_size().map_err(|e| e.to_string())?;
    let new_w = if compact { BAR_COMPACT_W } else { BAR_W };
    let new_px = (new_w * scale) as i32;
    let x = pos.x + (size.width as i32 - new_px) / 2;
    w.set_size(tauri::LogicalSize::new(new_w, BAR_H)).map_err(|e| e.to_string())?;
    w.set_position(tauri::PhysicalPosition::new(x, pos.y)).map_err(|e| e.to_string())?;
    Ok(())
}

const BAR_W: f64 = 600.0;
const BAR_H: f64 = 46.0;
const BAR_COMPACT_W: f64 = 150.0;

/// The monitor Lastshot records (Settings › Screen), as (x, y, w, h) physical pixels.
pub fn recorded_monitor(state: &AppState) -> Option<(i32, i32, u32, u32, String)> {
    let wanted = state.settings.read().monitor_index;
    let monitors = crate::media::recorder::enumerate_monitors();
    monitors
        .iter()
        .find(|m| m.index == wanted)
        .or_else(|| monitors.iter().find(|m| m.primary))
        .or(monitors.first())
        .map(|m| (m.x, m.y, m.width, m.height, m.name.clone()))
}

/// Turns drawing on the screen on or off. The drawing layer covers the
/// recorded screen and IS in the recording (the bar is not).
#[tauri::command]
pub async fn set_drawing(app: AppHandle, on: bool) -> Result<(), String> {
    if !on {
        close_drawing(&app);
        emit_state(&app);
        return Ok(());
    }
    let rect = recorded_monitor(&app.state::<AppState>()).ok_or("no screen found")?;
    let h = app.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    // Windows are built on the main thread, queued from here (see sync_bar).
    let _ = app.run_on_main_thread(move || {
        let _ = tx.send(open_drawing(&h, rect).map_err(|e| e.to_string()));
    });
    rx.await.map_err(|e| e.to_string())??;
    DRAWING.store(true, Ordering::Relaxed);
    emit_state(&app);
    Ok(())
}

/// Click-through: the drawings stay on screen but the mouse works normally again.
#[tauri::command]
pub fn set_drawing_passthrough(app: AppHandle, on: bool) -> Result<(), String> {
    let w = app.get_webview_window(ANNOT_LABEL).ok_or("drawing is off")?;
    w.set_ignore_cursor_events(on).map_err(|e| e.to_string())?;
    if !on {
        raise_bar(&app);
    }
    Ok(())
}

fn close_drawing(app: &AppHandle) {
    DRAWING.store(false, Ordering::Relaxed);
    if let Some(w) = app.get_webview_window(ANNOT_LABEL) {
        let _ = w.close();
    }
}

/// Keeps the bar above the drawing layer (both are always on top).
fn raise_bar(app: &AppHandle) {
    if let Some(b) = app.get_webview_window(BAR_LABEL) {
        let _ = b.set_always_on_top(false);
        let _ = b.set_always_on_top(true);
    }
}

fn open_drawing(app: &AppHandle, rect: (i32, i32, u32, u32, String)) -> tauri::Result<()> {
    if app.get_webview_window(ANNOT_LABEL).is_some() {
        return Ok(());
    }
    let (x, y, w, h, _) = rect;
    let win = tauri::WebviewWindowBuilder::new(app, ANNOT_LABEL, tauri::WebviewUrl::default())
        .title("Lastshot drawing")
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .focused(false)
        .visible(false)
        .build()?;
    hide_from_alt_tab(&win);
    win.set_position(tauri::PhysicalPosition::new(x, y))?;
    win.set_size(tauri::PhysicalSize::new(w, h))?;
    // Shown without taking focus from a game; clicking it to draw activates it.
    #[cfg(windows)]
    if let Ok(hwnd) = win.hwnd() {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOWNOACTIVATE};
        unsafe {
            let _ = ShowWindow(HWND(hwnd.0 as _), SW_SHOWNOACTIVATE);
        }
    }
    #[cfg(not(windows))]
    win.show()?;
    raise_bar(app);
    Ok(())
}

/// Keeps a helper window (control bar, snip overlay) out of Alt+Tab and the
/// taskbar, so switching away from Lastshot never lands on it.
pub fn hide_from_alt_tab(win: &tauri::WebviewWindow) {
    #[cfg(windows)]
    if let Ok(hwnd) = win.hwnd() {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
        };
        let h = HWND(hwnd.0 as _);
        unsafe {
            let ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
            let next = (ex | WS_EX_TOOLWINDOW.0 as isize) & !(WS_EX_APPWINDOW.0 as isize);
            SetWindowLongPtrW(h, GWL_EXSTYLE, next);
        }
    }
    #[cfg(not(windows))]
    let _ = win;
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
    // Studio layers follow recording too.
    crate::studio::sync(app);
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let mode = state.settings.read().control_bar.clone();
    let recording = state.engine.recording_status().is_some();
    let busy = recording || FINISHING.lock().is_some();
    let want = (match mode.as_str() {
        "always" => true,
        "recording" => busy,
        _ => false,
    } || (busy && BAR_WANTED.load(Ordering::Relaxed)))
        && !BAR_HIDDEN.load(Ordering::Relaxed);
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
            // Closing is asynchronous: the window still exists right after
            // close(), so go by what was asked.
            BAR_OPEN.store(want && h2.get_webview_window(BAR_LABEL).is_some(), Ordering::Relaxed);
            emit_state(&h2);
        });
    });
}

fn open_bar(app: &AppHandle) -> tauri::Result<()> {
    if app.get_webview_window(BAR_LABEL).is_some() {
        return Ok(());
    }
    let (bw, bh) = (BAR_W, BAR_H);
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
    hide_from_alt_tab(&win);
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


/// Records the whole screen or one window / app (Home, Studio).
#[tauri::command]
pub async fn start_recording_source(
    app: AppHandle,
    source: crate::media::CaptureSource,
) -> Result<RecordingStatus, String> {
    start_source(&app, source).await
}

/// Changes what Lastshot captures without starting a recording.
#[tauri::command]
pub async fn set_capture_source(app: AppHandle, source: crate::media::CaptureSource) -> Result<(), String> {
    set_source(&app, source).await
}
