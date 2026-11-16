//! Pop-out tabs: Audio, Editor or Studio in a window of its own (resizable,
//! own taskbar button). The window's size and place are remembered; closing
//! it docks the tab back into the main window.
//!
//! A popped-out window is labelled `pop-<view>` and loads the same frontend,
//! which picks the view from the label.

use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use crate::commands::AppState;
use crate::settings::WindowPlace;

pub const LABEL_PREFIX: &str = "pop-";
/// Tells every window which tabs are popped out (payload: their names).
pub const EVT_POPOUTS: &str = "lastshot://popouts";
pub const VIEWS: [&str; 3] = ["audio", "editor", "studio"];

pub fn label_for(view: &str) -> Option<String> {
    VIEWS.contains(&view).then(|| format!("{LABEL_PREFIX}{view}"))
}

pub fn view_of(label: &str) -> Option<&str> {
    label.strip_prefix(LABEL_PREFIX).filter(|v| VIEWS.contains(v))
}

fn title(view: &str) -> &'static str {
    match view {
        "audio" => "Lastshot – Audio",
        "editor" => "Lastshot – Editor",
        _ => "Lastshot – Studio",
    }
}

/// Default size (logical px) per view.
fn default_size(view: &str) -> (f64, f64) {
    match view {
        "audio" => (1100.0, 760.0),
        _ => (1200.0, 800.0),
    }
}

/// Places that would put the window's title bar off every screen are not
/// reused (an unplugged monitor).
pub fn place_visible(p: &WindowPlace, screens: &[(i32, i32, u32, u32)]) -> bool {
    if !(p.width >= 200.0 && p.height >= 150.0 && p.x.is_finite() && p.y.is_finite()) {
        return false;
    }
    let (px, py) = (p.x as i64 + 60, p.y as i64 + 16);
    screens.iter().any(|&(x, y, w, h)| {
        px >= x as i64 && px < x as i64 + w as i64 && py >= y as i64 && py < y as i64 + h as i64
    })
}

pub fn open_views(app: &AppHandle, except: Option<&str>) -> Vec<String> {
    app.webview_windows()
        .keys()
        .filter(|l| Some(l.as_str()) != except)
        .filter_map(|l| view_of(l).map(str::to_string))
        .collect()
}

fn announce(app: &AppHandle, except: Option<&str>) {
    let _ = app.emit(EVT_POPOUTS, open_views(app, except));
}

#[tauri::command]
pub fn popout_list(app: AppHandle) -> Vec<String> {
    open_views(&app, None)
}

/// Opens (or shows) the tab's own window. `focus: false` shows it without
/// taking the keyboard focus.
#[tauri::command]
pub async fn popout_open(
    app: AppHandle,
    state: State<'_, AppState>,
    view: String,
    focus: Option<bool>,
) -> Result<(), String> {
    let label = label_for(&view).ok_or_else(|| format!("This tab cannot pop out: {view}"))?;
    let focus = focus.unwrap_or(true);
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.unminimize();
        let _ = w.show();
        if focus {
            let _ = w.set_focus();
        }
        return Ok(());
    }
    let place = state.settings.read().popout_places.iter().find(|p| p.view == view).cloned();
    let screens: Vec<(i32, i32, u32, u32)> = app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| (m.position().x, m.position().y, m.size().width, m.size().height))
        .collect();
    let place = place.filter(|p| place_visible(p, &screens));
    let (w, h) = place.as_ref().map(|p| (p.width, p.height)).unwrap_or_else(|| default_size(&view));
    let mut b = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::default())
        .title(title(&view))
        .inner_size(w, h)
        .min_inner_size(640.0, 420.0)
        .resizable(true)
        .decorations(true)
        .theme(Some(tauri::Theme::Dark))
        .background_color(tauri::window::Color(0x15, 0x16, 0x1b, 0xff))
        .drag_and_drop(false)
        .focused(focus)
        .visible(false);
    if place.is_none() {
        b = b.center();
    }
    let win = b.build().map_err(|e| e.to_string())?;
    if let Some(p) = &place {
        let _ = win.set_position(tauri::PhysicalPosition::new(p.x as i32, p.y as i32));
    }
    if view == "studio" {
        crate::studio::allow_camera(&win);
    }
    show(&win, focus);
    announce(&app, None);
    Ok(())
}

fn show(win: &WebviewWindow, focus: bool) {
    if focus {
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    #[cfg(windows)]
    if let Ok(hwnd) = win.hwnd() {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOWNOACTIVATE};
        unsafe {
            let _ = ShowWindow(HWND(hwnd.0 as _), SW_SHOWNOACTIVATE);
        }
        return;
    }
    let _ = win.show();
}

/// Docks the tab back: closes its window.
#[tauri::command]
pub fn popout_close(app: AppHandle, view: String) -> Result<(), String> {
    let label = label_for(&view).ok_or("Unknown tab")?;
    if let Some(w) = app.get_webview_window(&label) {
        // A normal close: CloseRequested saves the place first.
        w.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Window events for popped-out windows (from `on_window_event`).
pub fn on_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let Some(view) = view_of(window.label()).map(str::to_string) else { return };
    match event {
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => store(window, &view, false),
        tauri::WindowEvent::CloseRequested { .. } => store(window, &view, true),
        tauri::WindowEvent::Destroyed => announce(window.app_handle(), Some(window.label())),
        _ => {}
    }
}

fn store(window: &tauri::Window, view: &str, to_disk: bool) {
    // Minimised or maximised: keep the last normal place.
    if window.is_minimized().unwrap_or(false) || window.is_maximized().unwrap_or(false) {
        if to_disk {
            save(window.app_handle());
        }
        return;
    }
    let (Ok(pos), Ok(size), Ok(sf)) = (window.outer_position(), window.inner_size(), window.scale_factor()) else {
        return;
    };
    let place = WindowPlace {
        view: view.to_string(),
        x: pos.x as f64,
        y: pos.y as f64,
        width: (size.width as f64 / sf).round(),
        height: (size.height as f64 / sf).round(),
    };
    let Some(state) = window.app_handle().try_state::<AppState>() else { return };
    {
        let mut s = state.settings.write();
        s.popout_places.retain(|p| p.view != view);
        s.popout_places.push(place);
    }
    if to_disk {
        save(window.app_handle());
    }
}

fn save(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        let s = state.settings.read().clone();
        if let Err(e) = s.save() {
            log::warn!("[lastshot] could not save the window place: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_and_views() {
        assert_eq!(label_for("audio").as_deref(), Some("pop-audio"));
        assert_eq!(label_for("settings"), None);
        assert_eq!(view_of("pop-editor"), Some("editor"));
        assert_eq!(view_of("pop-x"), None);
        assert_eq!(view_of("main"), None);
    }

    #[test]
    fn places_off_screen_are_dropped() {
        let screens = [(0, 0, 1920, 1080), (1920, 0, 2560, 1440)];
        let p = |x: f64, y: f64| WindowPlace { view: "audio".into(), x, y, width: 900.0, height: 600.0 };
        assert!(place_visible(&p(100.0, 100.0), &screens));
        assert!(place_visible(&p(3000.0, 1200.0), &screens));
        assert!(!place_visible(&p(5000.0, 100.0), &screens));
        assert!(!place_visible(&p(-2000.0, 100.0), &screens));
        assert!(!place_visible(&WindowPlace { width: 10.0, ..p(100.0, 100.0) }, &screens));
    }
}
