//! Screen recording (start / pause / stop, as long as you like) and the small
//! on-screen control bar. The bar is excluded from screen capture, so it never
//! shows up in recordings, replays or screenshots.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::{AppState, EVT_BUFFER_STATE, EVT_ERROR};
use crate::media::library::ClipMetadata;
use crate::media::recorder::RecordingStatus;

pub const EVT_RECORDING: &str = "lastshot://recording";
/// `{ message, level: "info" | "warning" }`: shown as a toast.
pub const EVT_NOTICE: &str = "lastshot://notice";
/// `{ path, progress }` while a file is repaired / converted.
pub const EVT_REPAIR_PROGRESS: &str = "lastshot://repair-progress";
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
/// Seconds left of the countdown before a recording starts.
static COUNTDOWN: parking_lot::Mutex<Option<u32>> = parking_lot::Mutex::new(None);
static COUNTDOWN_CANCEL: AtomicBool = AtomicBool::new(false);
/// A start is under way (countdown or engine start): a second press waits.
static STARTING: AtomicBool = AtomicBool::new(false);

/// Part of the screen a recording keeps.
#[derive(Clone, Debug)]
pub struct Area {
    pub crop: crate::media::shrink::Crop,
    /// "1280×720"
    pub label: String,
}
/// Serialises start/stop so a double hotkey press cannot race.
static BUSY: parking_lot::Mutex<()> = parking_lot::Mutex::new(());
/// A settings change needs the engine restarted. Whoever takes BUSY first
/// does it (the restart task, or a recording that starts right away), so a
/// recording never runs on the old engine and is never cut off by the restart.
static RESTART_PENDING: AtomicBool = AtomicBool::new(false);

/// Restarts the running engine with the current settings, in the background
/// but ordered with recording start/stop.
pub(crate) fn restart_engine_soon(app: &AppHandle) {
    RESTART_PENDING.store(true, Ordering::Release);
    let h = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = BUSY.lock();
        if !RESTART_PENDING.swap(false, Ordering::AcqRel) {
            return; // a recording start already did it
        }
        let state = h.state::<AppState>();
        let engine = Arc::clone(&state.engine);
        if !engine.is_running() || engine.recording_status().is_some() {
            return;
        }
        let cfg = state.settings.read().to_recorder_config();
        engine.stop();
        if let Err(e) = engine.start(cfg) {
            log::warn!("[lastshot] restart with new settings: {e}");
        }
        let _ = h.emit(EVT_BUFFER_STATE, engine.stats());
    });
}

/// Everything the control bar and the Home page show.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BarState {
    pub recording: Option<RecordingStatus>,
    pub mic_muted: bool,
    pub mic_on: bool,
    pub replay_on: bool,
    pub hotkey_record: String,
    pub hotkey_pause: String,
    pub hotkey_save: String,
    pub hotkey_snip: String,
    /// Seconds left before a counted-down recording starts.
    pub countdown: Option<u32>,
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
    let bytes = recording.as_ref().map(|r| r.bytes).unwrap_or(0);
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
        hotkey_pause: s.hotkey_pause.clone(),
        hotkey_save: s.hotkey_save.clone(),
        hotkey_snip: s.hotkey_snip.clone(),
        countdown: *COUNTDOWN.lock(),
    }
}

pub fn emit_state(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        let _ = app.emit(EVT_RECORDING, bar_state(&state));
    }
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
            RESTART_PENDING.store(false, Ordering::Release);
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
/// With a countdown set, it starts when the countdown ends (a second press
/// or Cancel stops the countdown).
pub async fn start_with(app: &AppHandle, area: Option<Area>) -> Result<RecordingStatus, String> {
    if STARTING.swap(true, Ordering::AcqRel) {
        return Err("A recording is already starting.".into());
    }
    let r = start_inner(app, area).await;
    STARTING.store(false, Ordering::Release);
    if COUNTDOWN.lock().take().is_some() {
        sync_bar(app);
    }
    emit_state(app);
    r
}

async fn start_inner(app: &AppHandle, area: Option<Area>) -> Result<RecordingStatus, String> {
    // An area is cut out of the full screen afterwards, so it needs the
    // full screen as the source.
    if area.is_some() {
        set_source(app, crate::media::CaptureSource::Display).await?;
    }
    let state = app.state::<AppState>();
    if state.engine.recording_status().is_some() {
        return Err("Already recording".into());
    }
    // No room on the drive: say so now, not after a countdown and a
    // recording that stops at once.
    {
        let (reserve, dir) = {
            let s = state.settings.read();
            let rec = s.recording_dir.trim().to_string();
            (s.record_options().reserve_bytes, if rec.is_empty() { state.output_dir() } else { PathBuf::from(rec) })
        };
        let _ = std::fs::create_dir_all(&dir);
        if let Some(free) = crate::media::recorder::free_space(&dir).filter(|&f| reserve > 0 && f <= reserve) {
            use crate::media::recorder::gb;
            return Err(format!(
                "Not enough free space: the drive has {} free and Lastshot keeps {} free. Free some space, or keep less free in Settings > Screen recording.",
                gb(free),
                gb(reserve)
            ));
        }
    }
    let countdown = state.settings.read().record_countdown.min(60);
    if countdown > 0 {
        run_countdown(app, countdown).await?;
    }
    let engine = Arc::clone(&state.engine);
    let out = state.output_dir();
    let (rec_dir, template, if_exists, opts, cfg) = {
        let s = state.settings.read();
        (
            s.recording_dir.trim().to_string(),
            s.record_file_name.clone(),
            s.record_if_exists.clone(),
            s.record_options(),
            s.to_recorder_config(),
        )
    };
    let (app_name, game) = crate::commands::resolve_app_and_folder(&state, None);
    let base = if rec_dir.is_empty() { out } else { std::path::PathBuf::from(rec_dir) };
    let dir = match &game {
        Some(g) => base.join(g),
        None => base,
    };
    let h = app.clone();
    let now = chrono::Local::now();
    let status = tauri::async_runtime::spawn_blocking(move || {
        let _guard = BUSY.lock();
        // Settings changed a moment ago: restart now, before recording.
        if RESTART_PENDING.swap(false, Ordering::AcqRel) && engine.is_running() {
            engine.stop();
        }
        if !engine.is_running() {
            engine.start(cfg.clone()).map_err(|e| e.to_string())?;
            let _ = h.emit(EVT_BUFFER_STATE, engine.stats());
        }
        // A freshly started engine needs a moment for its first frames.
        let mut last = String::new();
        let mut path: Option<PathBuf> = None;
        for _ in 0..40 {
            if path.is_none() || engine.stats().width == 0 {
                let stats = engine.stats();
                let parts = NameParts {
                    app: &app_name,
                    when: now,
                    width: stats.width,
                    height: stats.height,
                    fps: if stats.target_fps > 0 { stats.target_fps } else { cfg.target_fps },
                    codec: &stats.encoder.codec,
                };
                let name = render_file_name(&template, &parts).or_else(|_| {
                    render_file_name(crate::settings::DEFAULT_RECORD_FILE_NAME, &parts)
                })?;
                path = Some(pick_path(&dir, &name, opts.format.extension(), &if_exists)?);
            }
            let p = path.clone().expect("picked above");
            journal_add(&p);
            match engine.start_recording(p.clone(), opts.clone()) {
                Ok(s) => return Ok(s),
                Err(e) => {
                    journal_remove(&p);
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
    watch(app, status.path.clone());
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
    let rec_path = engine.recording_status().map(|r| PathBuf::from(r.path));
    let write = tauri::async_runtime::spawn_blocking(move || {
        let _guard = BUSY.lock();
        engine.stop_recording().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("recording task failed: {e}"))?;
    if let Some(p) = rec_path.as_ref() {
        if write.is_err() || !p.exists() {
            journal_remove(p);
        }
    }
    let write = write?;
    let finished = finish_file(app, write).await;
    if let Some(p) = rec_path.as_ref() {
        journal_remove(p);
    }
    let write = finished?;
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
    let rec_path = engine.recording_status().map(|r| PathBuf::from(r.path));
    let write = tauri::async_runtime::spawn_blocking(move || {
        let _guard = BUSY.lock();
        engine.stop_recording().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("recording task failed: {e}"));
    if let Some(p) = rec_path.as_ref() {
        journal_remove(p);
    }
    let write = match write? {
        Ok(w) => w,
        // Nothing was recorded: nothing to delete either.
        Err(e) if e.starts_with("Nothing was recorded") => {
            AREA.lock().take();
            MARKERS.lock().clear();
            close_drawing(app);
            BAR_WANTED.store(false, Ordering::Relaxed);
            sync_bar(app);
            emit_state(app);
            return Ok(());
        }
        Err(e) => return Err(e),
    };
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

/// Keeps a helper window (control bar, snip overlay, frames) out of Alt+Tab
/// and the taskbar, so switching away from Lastshot never lands on it.
///
/// tao gives every window without an owner WS_EX_APPWINDOW and writes the
/// whole extended style again whenever the window is shown, hidden, put on
/// top or made click-through, which used to undo a one-off change: a shown
/// helper window (or a frame, which never had it) was an Alt+Tab target that
/// cannot be seen or take the focus, so the first Alt+Tab seemed to do
/// nothing. A window subclass now keeps WS_EX_TOOLWINDOW on and
/// WS_EX_APPWINDOW off through every later style change.
pub fn hide_from_alt_tab(win: &tauri::WebviewWindow) {
    #[cfg(windows)]
    if let Ok(hwnd) = win.hwnd() {
        let h = hwnd.0 as isize;
        let apply = move || unsafe { alt_tab::keep_tool_window(h) };
        // A subclass must be set on the window's own thread.
        if win.run_on_main_thread(apply).is_err() {
            unsafe { alt_tab::keep_tool_window(h) };
        }
    }
    #[cfg(not(windows))]
    let _ = win;
}

#[cfg(windows)]
pub(crate) mod alt_tab {
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, STYLESTRUCT, WM_STYLECHANGING, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
    };

    const SUBCLASS_ID: usize = 0x4C53_5457; // "LSTW"

    /// The extended style a helper window must keep.
    pub fn tool_style(ex: u32) -> u32 {
        (ex | WS_EX_TOOLWINDOW.0) & !WS_EX_APPWINDOW.0
    }

    unsafe extern "system" fn proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, _data: usize) -> LRESULT {
        if msg == WM_STYLECHANGING && wparam.0 as i32 == GWL_EXSTYLE.0 && lparam.0 != 0 {
            let ss = &mut *(lparam.0 as *mut STYLESTRUCT);
            ss.styleNew = tool_style(ss.styleNew);
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }

    /// # Safety
    /// `h` must be a window of this process; call on its thread.
    pub unsafe fn keep_tool_window(h: isize) {
        let hwnd = HWND(h as _);
        let _ = SetWindowSubclass(hwnd, Some(proc), SUBCLASS_ID, 0);
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        let want = tool_style(ex);
        if want != ex {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want as isize);
        }
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn tool_windows_never_keep_the_app_window_bit() {
            assert_eq!(super::tool_style(0x0004_0000 | 0x0800_0000), 0x0000_0080 | 0x0800_0000);
            assert_eq!(super::tool_style(0x80), 0x80);
        }
    }
}

/// Hotkey / tray: start when idle, stop when recording, cancel a countdown.
pub fn toggle(app: AppHandle) {
    if COUNTDOWN.lock().is_some() {
        COUNTDOWN_CANCEL.store(true, Ordering::Release);
        return;
    }
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
        match r {
            Err(e) if e == COUNTDOWN_CANCELLED || e.starts_with("A recording is already starting") => {}
            Err(e) => {
                let _ = app.emit(EVT_ERROR, e);
            }
            Ok(()) => {}
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
    crate::startup::show_main(&app);
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
    let busy = recording || FINISHING.lock().is_some() || COUNTDOWN.lock().is_some();
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

// ------------------------------------------------------------- notices

#[derive(Clone, Serialize)]
struct Notice {
    message: String,
    level: &'static str,
}

/// A toast in the main window ("info" or "warning").
pub fn notice(app: &AppHandle, message: impl Into<String>, level: &'static str) {
    let message = message.into();
    log::info!("[lastshot] notice: {message}");
    let _ = app.emit(EVT_NOTICE, Notice { message, level });
}

// ------------------------------------------------------------- countdown

const COUNTDOWN_CANCELLED: &str = "Countdown cancelled";

/// Counts down in the bar and on Home; Err when cancelled.
async fn run_countdown(app: &AppHandle, secs: u32) -> Result<(), String> {
    COUNTDOWN_CANCEL.store(false, Ordering::Release);
    *COUNTDOWN.lock() = Some(secs);
    BAR_HIDDEN.store(false, Ordering::Relaxed);
    sync_bar(app);
    let h = app.clone();
    let r = tauri::async_runtime::spawn_blocking(move || {
        for left in (1..=secs).rev() {
            *COUNTDOWN.lock() = Some(left);
            emit_state(&h);
            for _ in 0..10 {
                if COUNTDOWN_CANCEL.load(Ordering::Acquire) {
                    return Err(COUNTDOWN_CANCELLED.to_string());
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?;
    *COUNTDOWN.lock() = None;
    if r.is_err() {
        sync_bar(app);
        emit_state(app);
    }
    r
}

#[tauri::command]
pub fn cancel_record_countdown() {
    if COUNTDOWN.lock().is_some() {
        COUNTDOWN_CANCEL.store(true, Ordering::Release);
    }
}

// ------------------------------------------------------------- pause

/// Hotkey / bar: pause a running recording, or resume a paused one.
pub fn toggle_pause(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    if let Some(r) = state.engine.recording_status() {
        state.engine.set_recording_paused(!r.paused);
        emit_state(app);
    }
}

#[tauri::command]
pub fn toggle_pause_recording(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if state.engine.recording_status().is_none() {
        return Err("Not recording".into());
    }
    toggle_pause(&app);
    Ok(())
}

// ------------------------------------------------------------- file names

/// What the file name tokens are filled from.
pub struct NameParts<'a> {
    pub app: &'a str,
    pub when: chrono::DateTime<chrono::Local>,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub codec: &'a str,
}

pub const FILE_NAME_TOKENS: [&str; 12] =
    ["app", "date", "time", "year", "month", "day", "hour", "minute", "second", "res", "fps", "codec"];

/// The file name (without extension) a template gives, or why it can't be
/// one: `{app} Recording {date} {time}` -> `Roblox Recording 2026-11-17 20-15-03`.
pub fn render_file_name(template: &str, p: &NameParts) -> Result<String, String> {
    let mut out = String::new();
    let mut rest = template;
    while let Some(i) = rest.find('{') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        let j = after.find('}').ok_or("A { has no closing }.")?;
        let token = after[..j].trim().to_ascii_lowercase();
        let v = match token.as_str() {
            "app" => crate::appname::sanitize(p.app),
            "date" => p.when.format("%Y-%m-%d").to_string(),
            "time" => p.when.format("%H-%M-%S").to_string(),
            "year" => p.when.format("%Y").to_string(),
            "month" => p.when.format("%m").to_string(),
            "day" => p.when.format("%d").to_string(),
            "hour" => p.when.format("%H").to_string(),
            "minute" => p.when.format("%M").to_string(),
            "second" => p.when.format("%S").to_string(),
            "res" => format!("{}x{}", p.width, p.height),
            "fps" => p.fps.to_string(),
            "codec" => p.codec.replace('.', ""),
            _ => {
                let list: Vec<String> = FILE_NAME_TOKENS.iter().map(|t| format!("{{{t}}}")).collect();
                return Err(format!("Unknown name part {{{token}}}. These work: {}.", list.join(" ")));
            }
        };
        out.push_str(&v);
        rest = &after[j + 1..];
    }
    if rest.contains('}') {
        return Err("A } has no opening {.".into());
    }
    out.push_str(rest);
    let name = out.split_whitespace().collect::<Vec<_>>().join(" ");
    let name = name.trim_end_matches(['.', ' ']).to_string();
    if name.is_empty() {
        return Err("The file name is empty.".into());
    }
    if name.chars().any(|c| matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control()) {
        return Err("A file name can't contain \\ / : * ? \" < > |".into());
    }
    let upper = name.to_ascii_uppercase();
    let stem = upper.split('.').next().unwrap_or("");
    if ["CON", "PRN", "AUX", "NUL"].contains(&stem)
        || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit())
    {
        return Err(format!("Windows keeps the name {name} for itself."));
    }
    if name.chars().count() > 180 {
        return Err("The file name is too long (180 characters at most).".into());
    }
    Ok(name)
}

fn sample_parts() -> NameParts<'static> {
    NameParts { app: "Roblox", when: chrono::Local::now(), width: 1920, height: 1080, fps: 60, codec: "H.264" }
}

/// Settings check: the template makes a valid file name.
pub fn check_file_name_template(template: &str) -> Result<(), String> {
    render_file_name(template, &sample_parts()).map(|_| ())
}

/// The file name a template gives right now (Settings preview).
#[tauri::command]
pub fn preview_record_file_name(state: State<'_, AppState>, template: String) -> Result<String, String> {
    let (app_name, _) = crate::commands::resolve_app_and_folder(&state, None);
    let stats = state.engine.stats();
    let s = state.settings.read();
    let parts = NameParts {
        app: &app_name,
        when: chrono::Local::now(),
        width: if stats.width > 0 { stats.width } else { 1920 },
        height: if stats.height > 0 { stats.height } else { 1080 },
        fps: if stats.target_fps > 0 { stats.target_fps } else { s.target_fps },
        codec: if stats.width > 0 { stats.encoder.codec.as_str() } else { s.codec.as_str() },
    };
    let t = if template.trim().is_empty() { crate::settings::DEFAULT_RECORD_FILE_NAME } else { template.trim() };
    Ok(format!("{}.{}", render_file_name(t, &parts)?, s.recording_format.extension()))
}

/// Where a new recording goes: `name.ext`, or with " 2", " 3"... when that
/// exists; with "overwrite", the old file goes to the Recycle Bin first.
fn pick_path(dir: &Path, name: &str, ext: &str, if_exists: &str) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("Can't make the folder {}: {e}", dir.display()))?;
    let first = dir.join(format!("{name}.{ext}"));
    if !first.exists() {
        return Ok(first);
    }
    if if_exists == "overwrite" {
        crate::library_ops::recycle(&[first.to_string_lossy().to_string()])?;
        if !first.exists() {
            return Ok(first);
        }
    }
    let mut n = 2;
    loop {
        let p = dir.join(format!("{name} {n}.{ext}"));
        if !p.exists() {
            return Ok(p);
        }
        n += 1;
    }
}

// ------------------------------------------------------------- journal

/// Recordings being written. A recording still listed at start-up was cut
/// off (crash, power cut, kill) and gets repaired.
fn journal_path() -> PathBuf {
    crate::paths::app_file("recordings-in-progress.txt")
}

static JOURNAL: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

fn journal_read() -> Vec<String> {
    std::fs::read_to_string(journal_path())
        .map(|t| t.lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect())
        .unwrap_or_default()
}

fn journal_write(list: &[String]) {
    let p = journal_path();
    if list.is_empty() {
        let _ = std::fs::remove_file(&p);
        return;
    }
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let _ = std::fs::write(&p, list.join("\n") + "\n");
}

fn journal_add(path: &Path) {
    let _g = JOURNAL.lock();
    let mut list = journal_read();
    let p = path.to_string_lossy().to_string();
    if !list.contains(&p) {
        list.push(p);
        journal_write(&list);
    }
}

fn journal_remove(path: &Path) {
    let _g = JOURNAL.lock();
    let p = path.to_string_lossy().to_string();
    let list: Vec<String> = journal_read().into_iter().filter(|l| *l != p).collect();
    journal_write(&list);
}

/// At start-up: repairs recordings that were cut off last time (they play
/// already; this adds the normal index so every app and editor reads them).
pub fn recover_unfinished(app: &AppHandle) {
    let h = app.clone();
    std::thread::spawn(move || {
        let list = {
            let _g = JOURNAL.lock();
            let l = journal_read();
            journal_write(&[]);
            l
        };
        if list.is_empty() {
            return;
        }
        // Let the window come up so the notice is seen.
        std::thread::sleep(std::time::Duration::from_secs(3));
        let remux_mkv = h.try_state::<AppState>().map(|s| s.settings.read().remux_mkv).unwrap_or(true);
        let mut fixed = 0;
        for p in list {
            let path = PathBuf::from(&p);
            if !path.exists() {
                continue;
            }
            let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            use crate::media::container::remux::{self, Need};
            let d = match remux::diagnose(&path) {
                Ok(d) => d,
                Err(e) => {
                    log::warn!("[lastshot] cut-off recording {p}: {e}");
                    continue;
                }
            };
            let r = match d.need {
                Need::RepairInPlace => remux::fix(&path, &mut |_| {}),
                Need::Remux if d.container == "mkv" && remux_mkv => remux::fix(&path, &mut |_| {}),
                Need::Unfixable => {
                    notice(&h, format!("{name} was cut off before anything could be saved."), "warning");
                    continue;
                }
                _ => continue,
            };
            match r {
                Ok(f) => {
                    fixed += 1;
                    notice(
                        &h,
                        format!(
                            "{name} was cut off (Lastshot or Windows closed while recording) and has been repaired: {} saved.",
                            fmt_secs(f.seconds)
                        ),
                        "info",
                    );
                }
                Err(e) => notice(&h, format!("{name} was cut off and could not be repaired ({e}). It may still play."), "warning"),
            }
        }
        if fixed > 0 {
            let _ = h.emit(crate::library_ops::EVT_LIBRARY_CHANGED, ());
        }
    });
}

fn fmt_secs(s: f64) -> String {
    let s = s.max(0.0).round() as u64;
    if s >= 3600 {
        format!("{}:{:02}:{:02}", s / 3600, (s / 60) % 60, s % 60)
    } else {
        format!("{}:{:02}", s / 60, s % 60)
    }
}

// ------------------------------------------------------------- after stop

/// Makes the stopped file final: finishes an MP4 the writer could not
/// finish (disk full at the very end), and converts an MKV to MP4 when
/// asked (the MKV goes once the MP4 checks out).
async fn finish_file(
    app: &AppHandle,
    write: crate::media::recorder::ClipWriteResult,
) -> Result<crate::media::recorder::ClipWriteResult, String> {
    use crate::media::container::{mkv, mp4, remux};
    let path = PathBuf::from(&write.path);
    let is_mkv = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("mkv"));
    let remux_mkv = app.try_state::<AppState>().map(|s| s.settings.read().remux_mkv).unwrap_or(true);
    if !is_mkv {
        let p = path.clone();
        let usable = tauri::async_runtime::spawn_blocking(move || match remux::diagnose(&p) {
            Ok(d) if d.need == remux::Need::RepairInPlace => {
                if let Err(e) = remux::repair_in_place(&p) {
                    log::warn!("[lastshot] finishing {}: {e}", p.display());
                }
                true
            }
            // Cut off before the first second reached the disk.
            Ok(d) if d.need == remux::Need::Unfixable => {
                let _ = std::fs::remove_file(&p);
                false
            }
            _ => true,
        })
        .await
        .unwrap_or(true);
        if !usable {
            return Err("Nothing was recorded: the file could not be written.".into());
        }
        return Ok(crate::media::recorder::ClipWriteResult {
            size_bytes: std::fs::metadata(&path).map(|m| m.len()).unwrap_or(write.size_bytes),
            ..write
        });
    }
    if !remux_mkv {
        return Ok(write);
    }
    *FINISH_LABEL.lock() = Some("Converting the recording to MP4");
    *FINISHING.lock() = Some(0.0);
    emit_state(app);
    let h = app.clone();
    let src = path.clone();
    let r = tauri::async_runtime::spawn_blocking(move || -> Result<PathBuf, String> {
        let dst = remux::remux_target(&src, true);
        let mut last = -1.0f32;
        remux::remux_to_mp4(&src, &dst, &mut |p| {
            if p - last >= 0.05 {
                last = p;
                *FINISHING.lock() = Some(p);
                emit_state(&h);
            }
        })
        .map_err(|e| e.to_string())?;
        // Only drop the MKV once the MP4 holds every frame.
        let a = mkv::read(&src).map_err(|e| e.to_string())?;
        let b = mp4::read(&dst).map_err(|e| e.to_string())?;
        let frames = |t: &[crate::media::container::TrackData]| t.iter().map(|t| t.samples.len()).sum::<usize>();
        if frames(&a.tracks) != frames(&b.tracks) {
            return Err(format!("the MP4 has {} frames, the MKV {}", frames(&b.tracks), frames(&a.tracks)));
        }
        std::fs::remove_file(&src).map_err(|e| e.to_string())?;
        Ok(dst)
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    *FINISHING.lock() = Some(1.0);
    Ok(match r {
        Ok(dst) => crate::media::recorder::ClipWriteResult {
            path: dst.to_string_lossy().to_string(),
            file_name: dst.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
            size_bytes: std::fs::metadata(&dst).map(|m| m.len()).unwrap_or(0),
            ..write
        },
        Err(e) => {
            notice(app, format!("Kept the MKV: converting it to MP4 failed ({e}). Right-click it in Clips to try again."), "warning");
            write
        }
    })
}

// ------------------------------------------------------------- watcher

/// Saves a recording that stopped by itself (time or size limit, full disk,
/// drive removed, display change) the way a stop does, and says why. Also
/// keeps the bar's notice and time left fresh.
fn watch(app: &AppHandle, path: String) {
    let h = app.clone();
    std::thread::Builder::new()
        .name("lastshot-rec-watch".into())
        .spawn(move || {
            let mut last_notice: Option<String> = None;
            let mut ticks = 0u32;
            loop {
                std::thread::sleep(std::time::Duration::from_millis(500));
                let Some(state) = h.try_state::<AppState>() else {
                    return;
                };
                let Some(status) = state.engine.recording_status() else {
                    return;
                };
                if status.path != path {
                    return;
                }
                if status.active {
                    ticks += 1;
                    if status.notice != last_notice || (status.seconds_left.is_some() && ticks % 4 == 0) {
                        if let (Some(n), None) = (status.notice.as_ref(), last_notice.as_ref()) {
                            notice(&h, n.clone(), "warning");
                        }
                        last_notice = status.notice.clone();
                        emit_state(&h);
                    }
                    continue;
                }
                let reason = status.ended.clone();
                let r = tauri::async_runtime::block_on(stop(&h));
                match (r, reason) {
                    (Ok(_), Some(why)) => {
                        let level = if why.starts_with("Stopped at") { "info" } else { "warning" };
                        notice(&h, format!("{why} Saved to Clips."), level);
                    }
                    (Ok(_), None) => {}
                    (Err(e), _) => {
                        let _ = h.emit(EVT_ERROR, e);
                    }
                }
                return;
            }
        })
        .ok();
}

// ------------------------------------------------------------- repair

/// What a video file needs (Clips › right-click › Repair / convert to MP4).
#[tauri::command]
pub async fn diagnose_clip(path: String) -> Result<crate::media::container::remux::Diagnosis, String> {
    tauri::async_runtime::spawn_blocking(move || crate::media::container::remux::diagnose(Path::new(&path)).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Clone, Serialize)]
struct RepairProgress {
    path: String,
    progress: f32,
}

/// Repairs a cut-off recording in place, or converts MKV / fragmented /
/// broken MP4 to a normal MP4 next to it.
#[tauri::command]
pub async fn repair_clip(app: AppHandle, path: String) -> Result<crate::media::container::remux::FixResult, String> {
    if app.state::<AppState>().engine.recording_status().is_some_and(|r| r.path == path) {
        return Err("This file is still being recorded.".into());
    }
    let h = app.clone();
    let r = tauri::async_runtime::spawn_blocking(move || {
        let mut last = -1.0f32;
        let p = path.clone();
        crate::media::container::remux::fix(Path::new(&path), &mut |f| {
            if f - last >= 0.02 || f >= 1.0 {
                last = f;
                let _ = h.emit(EVT_REPAIR_PROGRESS, RepairProgress { path: p.clone(), progress: f });
            }
        })
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    let _ = app.emit(crate::library_ops::EVT_LIBRARY_CHANGED, ());
    Ok(r)
}

/// Which encoders this PC has, per codec (Settings labels).
#[tauri::command]
pub async fn encoder_caps() -> Result<crate::media::recorder::EncoderCaps, String> {
    tauri::async_runtime::spawn_blocking(crate::media::recorder::encoder_caps).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod name_tests {
    use super::*;
    use chrono::TimeZone;

    fn parts() -> NameParts<'static> {
        NameParts {
            app: "Roblox",
            when: chrono::Local.with_ymd_and_hms(2026, 11, 17, 20, 15, 3).unwrap(),
            width: 2560,
            height: 1440,
            fps: 144,
            codec: "H.264",
        }
    }

    #[test]
    fn the_default_template_gives_todays_names() {
        let n = render_file_name(crate::settings::DEFAULT_RECORD_FILE_NAME, &parts()).unwrap();
        assert_eq!(n, crate::appname::file_stem("Roblox", Some("Recording"), parts().when));
        assert_eq!(n, "Roblox Recording 2026-11-17 20-15-03");
    }

    #[test]
    fn every_token_fills_in() {
        let n = render_file_name("{year}{month}{day}_{hour}{minute}{second} {RES} {fps}fps {codec} {app}", &parts()).unwrap();
        assert_eq!(n, "20261117_201503 2560x1440 144fps H264 Roblox");
    }

    #[test]
    fn bad_templates_say_why() {
        assert!(render_file_name("{nope}", &parts()).unwrap_err().contains("{app}"));
        assert!(render_file_name("a {date", &parts()).is_err());
        assert!(render_file_name("a } b", &parts()).is_err());
        assert!(render_file_name("a:b", &parts()).unwrap_err().contains("can't contain"));
        assert!(render_file_name("  ", &parts()).is_err());
        assert!(render_file_name("CON", &parts()).is_err());
        assert!(render_file_name(&"x".repeat(200), &parts()).is_err());
        // Spaces from empty parts collapse; trailing dots go.
        assert_eq!(render_file_name("clip  {app}..", &parts()).unwrap(), "clip Roblox");
    }

    #[test]
    fn existing_files_get_a_number() {
        let dir = std::env::temp_dir().join(format!("lastshot-names-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let a = pick_path(&dir, "Clip", "mp4", "number").unwrap();
        std::fs::write(&a, b"x").unwrap();
        let b = pick_path(&dir, "Clip", "mp4", "number").unwrap();
        assert_eq!(b.file_name().unwrap(), "Clip 2.mp4");
        std::fs::write(&b, b"x").unwrap();
        assert_eq!(pick_path(&dir, "Clip", "mp4", "number").unwrap().file_name().unwrap(), "Clip 3.mp4");
        // Another container is another file.
        assert_eq!(pick_path(&dir, "Clip", "mkv", "number").unwrap().file_name().unwrap(), "Clip.mkv");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
