//! Studio: layers (pictures, text, webcam, clock) shown on top of the
//! recorded screen, OBS-style. They are drawn in a transparent, click-through
//! window over that screen, so every capture (recordings, instant replays,
//! screenshots) includes them. The layers themselves live in the window's
//! local storage, shared by the Studio panel and the layer window.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager, State};

use crate::commands::AppState;

pub const SCENE_LABEL: &str = "scene";

static OPEN: AtomicBool = AtomicBool::new(false);

/// Opens or closes the layer window for the "Show layers" setting:
/// "off", "recording" (only while recording) or "always".
pub fn sync(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else { return };
    let mode = state.settings.read().studio_layers.clone();
    let recording = state.engine.recording_status().is_some();
    let want = match mode.as_str() {
        "always" => true,
        "recording" => recording,
        _ => false,
    };
    if want == OPEN.load(Ordering::Relaxed) && (want == app.get_webview_window(SCENE_LABEL).is_some()) {
        return;
    }
    let rect = crate::recording::recorded_monitor(&state);
    let h = app.clone();
    // Built on the main thread, queued from a worker (see recording::sync_bar).
    tauri::async_runtime::spawn(async move {
        let h2 = h.clone();
        let _ = h.run_on_main_thread(move || {
            if want {
                if let Some((x, y, w, hh, _)) = rect {
                    if let Err(e) = open(&h2, (x, y, w, hh)) {
                        log::warn!("[lastshot] studio layers: {e}");
                    }
                }
            } else if let Some(w) = h2.get_webview_window(SCENE_LABEL) {
                let _ = w.close();
            }
            OPEN.store(want && h2.get_webview_window(SCENE_LABEL).is_some(), Ordering::Relaxed);
        });
    });
}

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
