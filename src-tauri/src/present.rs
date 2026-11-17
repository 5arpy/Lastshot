//! Draw on screen (presentation mode), started from the snip bar (D).
//!
//! One transparent, always-on-top window ("present") covers the same screens
//! as the snip (Settings › Screenshots › Screens) over the *live* desktop.
//! The page draws with the shared annotation tools (no blur / pixelate:
//! there is no picture under them).
//!
//! Mouse mode makes the window click-through: the drawing stays and the
//! mouse works the apps under it. While the cursor is over the page's
//! toolbar the window takes clicks again, so the way back is always one
//! click. That is polled with GetCursorPos every 40 ms only while mouse mode
//! is on (no input hooks).
//!
//! Like any overlay, it takes a full-screen game out of independent flip
//! while it is open; closing it gives that back. It only opens when the user
//! asks for it.
//!
//! Test copies put it far off screen, like every other window.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::snip_geo::MonRect;

pub const PRESENT_LABEL: &str = "present";

/// What the page needs: its size and the monitors in it (physical pixels,
/// relative to the window), and the monitor the toolbar starts on.
#[derive(Debug, Clone, Serialize)]
pub struct PresentInfo {
    pub width: u32,
    pub height: u32,
    pub monitors: Vec<MonRect>,
    pub home: usize,
}

static INFO: Mutex<Option<PresentInfo>> = Mutex::new(None);
/// Bumped to stop the mouse-mode watcher.
static WATCH: AtomicU64 = AtomicU64::new(0);

/// Opens the drawing window over `rect` (desktop pixels). `monitors` are
/// relative to the rect's corner. An open one is only brought forward.
pub fn open(app: &AppHandle, rect: (i32, i32, u32, u32), monitors: Vec<MonRect>, home: usize) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(PRESENT_LABEL) {
        stop_watch();
        let _ = w.set_ignore_cursor_events(false);
        crate::shell::bring_to_front(&w);
        return Ok(());
    }
    *INFO.lock() = Some(PresentInfo { width: rect.2, height: rect.3, monitors, home });
    let win = tauri::WebviewWindowBuilder::new(app, PRESENT_LABEL, tauri::WebviewUrl::default())
        .title("Lastshot drawing on screen")
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    crate::recording::hide_from_alt_tab(&win);
    let place = if crate::startup::test_offscreen() { (-30000, 100, rect.2, rect.3) } else { rect };
    crate::snip::place_window(&win, place).map_err(|e| e.to_string())?;
    // The page shows the window once it has painted.
    Ok(())
}

#[tauri::command]
pub fn present_info() -> Result<PresentInfo, String> {
    INFO.lock().clone().ok_or_else(|| "not drawing".into())
}

/// Mouse mode on or off. `bar`: the toolbar (x, y, w, h) in the window's
/// physical pixels; over it the window takes clicks again.
#[tauri::command]
pub fn present_through(app: AppHandle, on: bool, bar: Option<[f64; 4]>) -> Result<(), String> {
    let w = app.get_webview_window(PRESENT_LABEL).ok_or("not drawing")?;
    let gen = stop_watch();
    w.set_ignore_cursor_events(on).map_err(|e| e.to_string())?;
    let (Some(b), true) = (bar, on) else {
        return Ok(());
    };
    let origin = w.outer_position().map_err(|e| e.to_string())?;
    // A few pixels of slack around the bar.
    let bar = MonRect::new(origin.x + b[0].floor() as i32 - 4, origin.y + b[1].floor() as i32 - 4, b[2].ceil() as i32 + 8, b[3].ceil() as i32 + 8);
    std::thread::spawn(move || {
        let mut through = true;
        while WATCH.load(Ordering::SeqCst) == gen {
            std::thread::sleep(Duration::from_millis(40));
            let Some(p) = cursor_now() else { continue };
            let want = !bar.contains(p);
            if want != through {
                through = want;
                if w.set_ignore_cursor_events(through).is_err() {
                    break; // the window is gone
                }
            }
        }
    });
    Ok(())
}

/// Ends drawing on screen.
#[tauri::command]
pub fn present_close(app: AppHandle) {
    stop_watch();
    if let Some(w) = app.get_webview_window(PRESENT_LABEL) {
        let _ = w.close();
    }
    INFO.lock().take();
}

/// Snips the screen with the drawing on it: the regular snip overlay opens
/// over everything (the page hides its toolbar first). Returns once the
/// screen is frozen, so the page can show its toolbar again.
#[tauri::command]
pub async fn present_snip(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(PRESENT_LABEL) {
        // The snip's own window takes the clicks; this one stays as it is.
        stop_watch();
        let _ = w.set_ignore_cursor_events(false);
    }
    crate::snip::begin_with(app, false, "shot");
    for _ in 0..60 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        if crate::snip::frozen() {
            break;
        }
    }
    Ok(())
}

/// Stops the mouse-mode watcher; returns the new generation.
fn stop_watch() -> u64 {
    WATCH.fetch_add(1, Ordering::SeqCst) + 1
}

#[cfg(windows)]
fn cursor_now() -> Option<(i32, i32)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p).ok()? };
    Some((p.x, p.y))
}

#[cfg(not(windows))]
fn cursor_now() -> Option<(i32, i32)> {
    None
}
