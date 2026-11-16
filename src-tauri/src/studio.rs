//! Studio: layers (pictures, text, webcam, clock, recording timer) on top of
//! the recorded picture, OBS-style. Since S1 the capture engine draws them
//! itself (media/layers.rs), so they are in replays, recordings and window
//! captures, and no longer shown on the user's screen. The layers are kept
//! in `studio_layers.json` so they also work when Lastshot starts in the tray
//! without its window.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager, State};

use crate::commands::AppState;
use crate::media::layers::LayerSpec;

pub const SCENE_LABEL: &str = "scene";

static OPEN: AtomicBool = AtomicBool::new(false);

fn layers_file() -> std::path::PathBuf {
    crate::paths::app_file("studio_layers.json")
}

/// Loads the saved layers into the engine (at startup).
pub fn init(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else { return };
    if let Ok(raw) = std::fs::read_to_string(layers_file()) {
        if let Ok(v) = serde_json::from_str::<Vec<LayerSpec>>(&raw) {
            state.engine.layers().set(v);
        }
    }
    sync(app);
}

/// Turns the layers on or off for the "Show layers" setting: "off",
/// "recording" (only while recording) or "always".
pub fn sync(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else { return };
    let mode = state.settings.read().studio_layers.clone();
    let recording = state.engine.recording_status().is_some();
    let want = match mode.as_str() {
        "always" => true,
        "recording" => recording,
        _ => false,
    };
    state.engine.layers().set_enabled(want);
    // The old on-screen layer window is not used any more.
    if OPEN.swap(false, Ordering::Relaxed) || app.get_webview_window(SCENE_LABEL).is_some() {
        let h = app.clone();
        tauri::async_runtime::spawn(async move {
            let h2 = h.clone();
            let _ = h.run_on_main_thread(move || {
                if let Some(w) = h2.get_webview_window(SCENE_LABEL) {
                    let _ = w.close();
                }
            });
        });
    }
}

/// Studio saved its layers: draw them from the next frame on.
#[tauri::command]
pub fn set_studio_layers(app: AppHandle, state: State<'_, AppState>, layers: Vec<LayerSpec>) -> Result<(), String> {
    let json = serde_json::to_string_pretty(&layers).map_err(|e| e.to_string())?;
    if let Some(dir) = layers_file().parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(layers_file(), json).map_err(|e| e.to_string())?;
    let paths: Vec<String> = layers.iter().filter_map(|l| l.path.clone()).collect();
    for p in paths {
        if let Some(dir) = std::path::Path::new(&p).parent() {
            let _ = app.asset_protocol_scope().allow_directory(dir, false);
        }
    }
    state.engine.layers().set(layers);
    Ok(())
}

/// The layers the engine draws (None when Studio never saved any, so the
/// panel can bring over layers from the old local storage once).
#[tauri::command]
pub fn get_studio_layers(state: State<'_, AppState>) -> Option<Vec<LayerSpec>> {
    if !layers_file().exists() {
        return None;
    }
    Some(state.engine.layers().get())
}

/// Cameras for the webcam layer (names only; nothing is opened).
#[tauri::command]
pub async fn list_cameras() -> Vec<crate::media::webcam::CameraInfo> {
    tauri::async_runtime::spawn_blocking(crate::media::webcam::list_cameras).await.unwrap_or_default()
}

/// The newest live preview frame: 12-byte header (width, height, sequence)
/// + RGBA. Empty when the engine has none yet. Asking keeps the preview on.
#[tauri::command]
pub fn get_preview_frame(state: State<'_, AppState>) -> tauri::ipc::Response {
    let bytes = state.engine.preview().request().map(|f| f.to_bytes()).unwrap_or_default();
    tauri::ipc::Response::new(bytes)
}

#[allow(dead_code)]
fn open(app: &AppHandle, rect: (i32, i32, u32, u32)) -> tauri::Result<()> {
    if app.get_webview_window(SCENE_LABEL).is_some() {
        return Ok(());
    }
    let (x, y, w, h) = rect;
    let win = tauri::WebviewWindowBuilder::new(app, SCENE_LABEL, tauri::WebviewUrl::default())
        .title("Lastshot layers")
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .focused(false)
        .visible(false)
        .build()?;
    allow_camera(&win);
    win.set_position(tauri::PhysicalPosition::new(x, y))?;
    win.set_size(tauri::PhysicalSize::new(w, h))?;
    // Clicks go through to whatever is below.
    win.set_ignore_cursor_events(true)?;
    // After the click-through change, which rewrites the extended style.
    crate::recording::hide_from_alt_tab(&win);
    #[cfg(windows)]
    if let Ok(hwnd) = win.hwnd() {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOWNOACTIVATE};
        unsafe {
            let _ = ShowWindow(HWND(hwnd.0 as _), SW_SHOWNOACTIVATE);
        }
        return Ok(());
    }
    win.show()
}

/// Lets a Lastshot window use the webcam without a prompt (the layer window
/// cannot be clicked, so it could never answer one).
pub fn allow_camera(win: &tauri::WebviewWindow) {
    #[cfg(windows)]
    let _ = win.with_webview(|wv| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_CAMERA,
            COREWEBVIEW2_PERMISSION_STATE_ALLOW,
        };
        use webview2_com::PermissionRequestedEventHandler;
        let Ok(core) = wv.controller().CoreWebView2() else { return };
        let handler = PermissionRequestedEventHandler::create(Box::new(|_, args| {
            if let Some(args) = args {
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                args.PermissionKind(&mut kind)?;
                if kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA {
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                }
            }
            Ok(())
        }));
        let mut token = 0i64;
        let _ = core.add_PermissionRequested(&handler, &mut token);
    });
    #[cfg(not(windows))]
    let _ = win;
}

/// A small picture of the recorded screen, for placing layers in Studio.
#[tauri::command]
pub async fn screen_snapshot(state: State<'_, AppState>) -> Result<ScreenShot, String> {
    let (x, y, w, h, name) = crate::recording::recorded_monitor(&state).ok_or("no screen found")?;
    let image = tauri::async_runtime::spawn_blocking(move || crate::snip::snapshot(x, y, w, h, 960))
        .await
        .map_err(|e| e.to_string())??;
    Ok(ScreenShot { image, width: w, height: h, name: name.trim_start_matches("\\\\.\\").to_string() })
}

#[derive(serde::Serialize)]
pub struct ScreenShot {
    pub image: String,
    pub width: u32,
    pub height: u32,
    pub name: String,
}

/// Re-reads the layer setting (after a change in Studio).
#[tauri::command]
pub fn sync_layers(app: AppHandle) {
    sync(&app);
}
