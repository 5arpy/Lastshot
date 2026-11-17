//! The app's windows and their tabs, like browser tabs.
//!
//! - Every app window runs the same page (`App`), showing the tabs it holds.
//!   "main" is the first window and always keeps at least one tab; others are
//!   labelled `shell-<n>`.
//! - A tab dragged out of a tab strip becomes a window of its own; dragged
//!   onto another window's strip it docks there. Closing a window docks its
//!   tabs back into the main window. The menus offer the same for keyboards.
//! - The layout (which window holds which tabs, where each window was, and
//!   whether it was maximised) is kept in the settings and restored when the
//!   main window opens.
//! - Window places are physical pixels for the position (so a window comes
//!   back on its own monitor) and logical pixels for the size (so it keeps
//!   its size across DPI). Places off every screen are not reused.
//!
//! Also here: bringing a window to the front without tricks (no injected
//! keys) and the UI scale of the app windows.

use std::collections::HashMap;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use crate::commands::AppState;

/// Every window hears the layout whenever it changes (payload: ShellLayout).
pub const EVT_SHELL: &str = "lastshot://shell";
/// Sent to one window while a tab is dragged over its strip
/// (payload: insert index, or null when the tab left).
pub const EVT_HINT: &str = "lastshot://shell-hint";
/// Sent to the window holding a tab that was asked to open (payload: {tab, payload}).
pub const EVT_OPEN: &str = "lastshot://shell-open";
pub const MAIN: &str = "main";
pub const PREFIX: &str = "shell-";
/// The app's tabs, in their default order.
pub const TABS: [&str; 6] = ["home", "clips", "editor", "studio", "audio", "settings"];

const MIN_W: f64 = 720.0;
const MIN_H: f64 = 480.0;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ShellLayout {
    pub windows: Vec<ShellWin>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ShellWin {
    pub label: String,
    pub tabs: Vec<String>,
    pub active: String,
    pub place: Option<Place>,
}

/// Position in physical pixels, size in logical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Place {
    pub x: i32,
    pub y: i32,
    pub width: f64,
    pub height: f64,
    pub maximized: bool,
}

pub fn is_shell_label(label: &str) -> bool {
    label == MAIN || label.strip_prefix(PREFIX).is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

pub fn clamp_scale(v: f64) -> f64 {
    if !v.is_finite() {
        return 1.0;
    }
    (v.clamp(0.5, 2.0) * 100.0).round() / 100.0
}

// ---------------------------------------------------------------------------
// Layout rules (pure)
// ---------------------------------------------------------------------------

impl ShellLayout {
    /// Every tab exactly once, the main window first and never empty,
    /// unknown tabs and empty windows dropped, an active tab in each window.
    pub fn normalized(&self) -> ShellLayout {
        let mut seen = std::collections::HashSet::new();
        let mut main = self.windows.iter().find(|w| w.label == MAIN).cloned().unwrap_or_else(|| ShellWin { label: MAIN.into(), ..Default::default() });
        let mut wins = vec![];
        let mut labels = std::collections::HashSet::new();
        for w in std::iter::once(&main).chain(self.windows.iter().filter(|w| w.label != MAIN)) {
            if !is_shell_label(&w.label) || !labels.insert(w.label.clone()) {
                continue;
            }
            let tabs: Vec<String> = w.tabs.iter().filter(|t| TABS.contains(&t.as_str()) && seen.insert(t.to_string())).cloned().collect();
            wins.push(ShellWin { tabs, ..w.clone() });
        }
        main = wins.remove(0);
        for t in TABS {
            if !seen.contains(t) {
                main.tabs.push(t.to_string());
            }
        }
        let mut out = vec![main];
        out.extend(wins.into_iter().filter(|w| !w.tabs.is_empty()));
        for w in &mut out {
            if !w.tabs.contains(&w.active) {
                w.active = w.tabs.first().cloned().unwrap_or_default();
            }
        }
        ShellLayout { windows: out }
    }

    pub fn win(&self, label: &str) -> Option<&ShellWin> {
        self.windows.iter().find(|w| w.label == label)
    }

    fn win_mut(&mut self, label: &str) -> Option<&mut ShellWin> {
        self.windows.iter_mut().find(|w| w.label == label)
    }

    pub fn host_of(&self, tab: &str) -> Option<&str> {
        self.windows.iter().find(|w| w.tabs.iter().any(|t| t == tab)).map(|w| w.label.as_str())
    }

    /// The next free `shell-<n>` label.
    pub fn new_label(&self, taken: &[String]) -> String {
        (2..)
            .map(|n| format!("{PREFIX}{n}"))
            .find(|l| self.win(l).is_none() && !taken.contains(l))
            .unwrap_or_else(|| format!("{PREFIX}x"))
    }

    /// Moves `tab` into window `to` (made when missing) at `index` (end when
    /// None) and makes it active there. The main window keeps one tab.
    pub fn move_tab(&mut self, tab: &str, to: &str, index: Option<usize>) -> Result<(), String> {
        if !TABS.contains(&tab) {
            return Err(format!("Unknown tab: {tab}"));
        }
        if !is_shell_label(to) {
            return Err(format!("Unknown window: {to}"));
        }
        let from = self.host_of(tab).map(str::to_string);
        if from.as_deref() == Some(MAIN) && to != MAIN && self.win(MAIN).is_some_and(|w| w.tabs.len() <= 1) {
            return Err("The main window keeps at least one tab.".into());
        }
        let mut old_index = None;
        if let Some(f) = from.as_deref().and_then(|f| self.win_mut(f)) {
            old_index = f.tabs.iter().position(|t| t == tab);
            f.tabs.retain(|t| t != tab);
            if f.active == tab {
                let i = old_index.unwrap_or(0).min(f.tabs.len().saturating_sub(1));
                f.active = f.tabs.get(i).cloned().unwrap_or_default();
            }
        }
        if self.win(to).is_none() {
            self.windows.push(ShellWin { label: to.into(), ..Default::default() });
        }
        let w = self.win_mut(to).expect("just added");
        let mut i = index.unwrap_or(w.tabs.len()).min(w.tabs.len());
        // Moving within the same window: the index was counted with the tab still in.
        if from.as_deref() == Some(to) && old_index.is_some_and(|o| o < i) && index.is_some() {
            i = i.saturating_sub(1).min(w.tabs.len());
        }
        w.tabs.insert(i, tab.into());
        w.active = tab.into();
        self.windows.retain(|w| w.label == MAIN || !w.tabs.is_empty());
        Ok(())
    }

    /// A window closes: its tabs go back to the end of the main window.
    pub fn dock_all(&mut self, label: &str) {
        if label == MAIN {
            return;
        }
        let Some(pos) = self.windows.iter().position(|w| w.label == label) else { return };
        let w = self.windows.remove(pos);
        if let Some(m) = self.win_mut(MAIN) {
            m.tabs.extend(w.tabs);
        }
    }

    pub fn set_active(&mut self, label: &str, tab: &str) -> bool {
        match self.win_mut(label) {
            Some(w) if w.tabs.iter().any(|t| t == tab) && w.active != tab => {
                w.active = tab.into();
                true
            }
            _ => false,
        }
    }

    /// New order for a window's tabs (must be the same set).
    pub fn reorder(&mut self, label: &str, tabs: &[String]) -> bool {
        let Some(w) = self.win_mut(label) else { return false };
        let mut a = w.tabs.clone();
        let mut b = tabs.to_vec();
        a.sort();
        b.sort();
        if a != b || w.tabs == tabs {
            return false;
        }
        w.tabs = tabs.to_vec();
        true
    }
}

/// A place whose title bar is on some screen (an unplugged monitor is not reused).
pub fn place_visible(p: &Place, screens: &[(i32, i32, u32, u32)]) -> bool {
    if !(p.width >= 200.0 && p.height >= 150.0) {
        return false;
    }
    let (px, py) = (p.x as i64 + 60, p.y as i64 + 16);
    screens.iter().any(|&(x, y, w, h)| px >= x as i64 && px < x as i64 + w as i64 && py >= y as i64 && py < y as i64 + h as i64)
}

/// Insert index for a point `x` (any unit) over tabs given as (left, right).
pub fn insert_index(tabs: &[(f64, f64)], x: f64) -> usize {
    tabs.iter().filter(|(l, r)| (l + r) / 2.0 < x).count()
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/// Tab strips as each window reported them (CSS px in its client area).
#[derive(Debug, Clone, Default)]
struct Strip {
    rect: (f64, f64, f64, f64),
    tabs: Vec<(f64, f64)>,
}

static STRIPS: Mutex<Option<HashMap<String, Strip>>> = Mutex::new(None);
static HINTED: Mutex<Option<String>> = Mutex::new(None);
static TEST_CURSOR: Mutex<Option<(i32, i32)>> = Mutex::new(None);
/// Labels of windows being made (so two quick tear-outs never pick one label).
static MAKING: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn test_instance() -> bool {
    std::env::var("LASTSHOT_TEST_INSTANCE").as_deref() == Ok("1")
}

fn layout(app: &AppHandle) -> ShellLayout {
    app.try_state::<AppState>().map(|s| s.settings.read().shell.normalized()).unwrap_or_else(|| ShellLayout::default().normalized())
}

fn ui_scale(app: &AppHandle) -> f64 {
    app.try_state::<AppState>().map(|s| clamp_scale(s.settings.read().ui_scale)).unwrap_or(1.0)
}

/// Changes the layout, announces it and (when `save`) writes the settings.
fn change(app: &AppHandle, save: bool, f: impl FnOnce(&mut ShellLayout) -> Result<bool, String>) -> Result<ShellLayout, String> {
    let state = app.try_state::<AppState>().ok_or("not ready")?;
    let (out, changed) = {
        let mut s = state.settings.write();
        let mut l = s.shell.normalized();
        let changed = f(&mut l)?;
        let l = l.normalized();
        let changed = changed || l != s.shell;
        s.shell = l.clone();
        (l, changed)
    };
    if changed {
        let _ = app.emit(EVT_SHELL, &out);
        if save {
            save_now(app);
        }
    }
    Ok(out)
}

/// Writes the settings (the layout with them).
pub fn save_now(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        let s = state.settings.read().clone();
        if let Err(e) = s.save() {
            log::warn!("[shell] could not save the window layout: {e}");
        }
    }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

fn screens(app: &AppHandle) -> Vec<(i32, i32, u32, u32)> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| (m.position().x, m.position().y, m.size().width, m.size().height))
        .collect()
}

/// The cursor in physical pixels (a test copy may set a pretend cursor).
pub fn cursor(app: &AppHandle) -> Option<(i32, i32)> {
    // Test copies use the pretend cursor only: a test window must never
    // follow the user's mouse onto the screen.
    if crate::startup::test_offscreen() {
        return *TEST_CURSOR.lock();
    }
    app.cursor_position().ok().map(|p| (p.x.round() as i32, p.y.round() as i32))
}

/// Shows a window and asks Windows to bring it to the front. Unlike
/// `set_focus` (tao), this never injects an Alt key press when Windows says
/// no: Windows then flashes the taskbar button, which is the polite answer.
/// Test copies never take the focus.
pub fn bring_to_front(win: &WebviewWindow) {
    if crate::startup::test_offscreen() {
        show_quietly(win);
        return;
    }
    let _ = win.unminimize();
    let _ = win.show();
    #[cfg(windows)]
    if let Ok(h) = win.hwnd() {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow;
        unsafe {
            let _ = SetForegroundWindow(HWND(h.0 as _));
        }
    }
}

/// Shows a window without taking the focus.
fn show_quietly(win: &WebviewWindow) {
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

/// Applies the UI scale to one app window.
pub fn apply_scale(win: &WebviewWindow, scale: f64) {
    let _ = win.set_zoom(clamp_scale(scale));
}

pub fn apply_scale_all(app: &AppHandle, scale: f64) {
    for (l, w) in app.webview_windows() {
        if is_shell_label(&l) {
            apply_scale(&w, scale);
        }
    }
}

/// Makes the window for `label`. `at`: its top-left in physical pixels.
fn build(app: &AppHandle, label: &str, at: Option<(i32, i32)>, size: (f64, f64), maximized: bool, focus: bool) -> Result<WebviewWindow, String> {
    if let Some(w) = app.get_webview_window(label) {
        return Ok(w);
    }
    let test = crate::startup::test_offscreen();
    let (w, h) = (size.0.max(MIN_W), size.1.max(MIN_H));
    let win = tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::default())
        .title("Lastshot")
        .inner_size(w, h)
        .min_inner_size(MIN_W, MIN_H)
        .resizable(true)
        .decorations(false)
        .shadow(true)
        .theme(Some(tauri::Theme::Dark))
        .background_color(tauri::window::Color(0x15, 0x16, 0x1b, 0xff))
        .drag_and_drop(false)
        // Test copies: no taskbar button (their windows are off screen).
        .skip_taskbar(test)
        .focused(focus && !test)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    if test {
        crate::recording::hide_from_alt_tab(&win);
    }
    let at = if test { Some(at.filter(|p| p.0 < -10000).unwrap_or((-26000, 120))) } else { at };
    match at {
        Some((x, y)) => {
            let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
        }
        None => {
            let _ = win.center();
        }
    }
    crate::studio::allow_camera(&win);
    // File paths for drops on the page (the Editor's media bin and timeline), in any window that can show the Editor tab.
    crate::editor_media::install_drop_bridge(&win);
    apply_scale(&win, ui_scale(app));
    if maximized && !test {
        let _ = win.maximize();
    }
    if focus {
        bring_to_front(&win);
    } else {
        show_quietly(&win);
    }
    Ok(win)
}

/// Opens the windows of the saved layout that are not open yet (when the
/// main window shows; never in the tray-only start).
#[tauri::command]
pub async fn shell_restore(app: AppHandle) -> Result<ShellLayout, String> {
    let l = layout(&app);
    let screens = screens(&app);
    for w in l.windows.iter().filter(|w| w.label != MAIN) {
        if app.get_webview_window(&w.label).is_some() {
            continue;
        }
        let place = w.place.filter(|p| place_visible(p, &screens));
        let size = place.map(|p| (p.width, p.height)).unwrap_or((1100.0, 760.0));
        if let Err(e) = build(&app, &w.label, place.map(|p| (p.x, p.y)), size, place.is_some_and(|p| p.maximized), false) {
            log::warn!("[shell] could not reopen {}: {e}", w.label);
        }
    }
    Ok(l)
}

#[tauri::command]
pub fn shell_layout(app: AppHandle) -> ShellLayout {
    layout(&app)
}

#[tauri::command]
pub fn shell_set_active(app: AppHandle, window: tauri::Window, tab: String) -> Result<(), String> {
    let label = window.label().to_string();
    change(&app, false, |l| Ok(l.set_active(&label, &tab))).map(|_| ())
}

#[tauri::command]
pub fn shell_reorder(app: AppHandle, window: tauri::Window, tabs: Vec<String>) -> Result<(), String> {
    let label = window.label().to_string();
    change(&app, true, |l| Ok(l.reorder(&label, &tabs))).map(|_| ())
}

/// The calling window's tab strip (CSS px in its client area) and its tabs' (left, right).
#[tauri::command]
pub fn shell_report_strip(window: tauri::Window, rect: (f64, f64, f64, f64), tabs: Vec<(f64, f64)>) {
    STRIPS.lock().get_or_insert_with(HashMap::new).insert(window.label().to_string(), Strip { rect, tabs });
}

/// Test copies only: a pretend cursor (physical px) for tab-drag tests.
#[tauri::command]
pub fn shell_test_cursor(x: Option<i32>, y: Option<i32>) -> Result<(), String> {
    if !test_instance() {
        return Err("only in test copies".into());
    }
    *TEST_CURSOR.lock() = x.zip(y);
    Ok(())
}

/// A strip under the cursor: (window label, insert index), skipping `except`.
fn drop_target(app: &AppHandle, except: &str) -> Option<(String, usize)> {
    let (cx, cy) = cursor(app)?;
    let zoom = ui_scale(app);
    let strips = STRIPS.lock().clone().unwrap_or_default();
    let mut hits = vec![];
    for (label, s) in strips {
        if label == except || !is_shell_label(&label) {
            continue;
        }
        let Some(w) = app.get_webview_window(&label) else { continue };
        if !w.is_visible().unwrap_or(false) || w.is_minimized().unwrap_or(false) {
            continue;
        }
        let (Ok(pos), Ok(sf)) = (w.inner_position(), w.scale_factor()) else { continue };
        let k = sf * zoom;
        let (l, t, r, b) = s.rect;
        // A little slack above and below the strip, like browsers.
        let slack = 12.0 * k;
        let (x0, y0) = (pos.x as f64 + l * k, pos.y as f64 + t * k - slack);
        let (x1, y1) = (pos.x as f64 + r * k, pos.y as f64 + b * k + slack);
        let (fx, fy) = (cx as f64, cy as f64);
        if fx >= x0 && fx < x1 && fy >= y0 && fy < y1 {
            let local = (fx - pos.x as f64) / k;
            hits.push((label, insert_index(&s.tabs, local), z_rank(&w)));
        }
    }
    hits.sort_by_key(|h| h.2);
    hits.into_iter().next().map(|(l, i, _)| (l, i))
}

/// Lower is nearer the top of the z-order.
fn z_rank(win: &WebviewWindow) -> u32 {
    #[cfg(windows)]
    if let Ok(h) = win.hwnd() {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{GetWindow, GW_HWNDPREV};
        let mut n = 0u32;
        let mut cur = HWND(h.0 as _);
        unsafe {
            while let Ok(p) = GetWindow(cur, GW_HWNDPREV) {
                if p.is_invalid() || n > 5000 {
                    break;
                }
                cur = p;
                n += 1;
            }
        }
        return n;
    }
    let _ = win;
    0
}

fn hint(app: &AppHandle, target: Option<(String, usize)>) {
    let mut last = HINTED.lock();
    if let Some(old) = last.as_ref() {
        if target.as_ref().map(|t| &t.0) != Some(old) {
            let _ = app.emit_to(old.as_str(), EVT_HINT, None::<usize>);
        }
    }
    if let Some((l, i)) = &target {
        let _ = app.emit_to(l.as_str(), EVT_HINT, Some(*i));
    }
    *last = target.map(|t| t.0);
}

/// Where a window goes so the cursor sits at `grab` (CSS px) inside it.
fn place_under_cursor(app: &AppHandle, win: Option<&WebviewWindow>, grab: (f64, f64)) -> Option<(i32, i32)> {
    let (cx, cy) = cursor(app)?;
    let sf = win
        .and_then(|w| w.scale_factor().ok())
        .or_else(|| app.monitor_from_point(cx as f64, cy as f64).ok().flatten().map(|m| m.scale_factor()))
        .unwrap_or(1.0);
    let k = sf * ui_scale(app);
    // The client area starts at the outer corner (no frame on our windows).
    Some((cx - (grab.0 * k).round() as i32, cy - (grab.1 * k).round() as i32))
}

/// Tears `tab` out of the calling window into a new one under the cursor;
/// `grab` is where the cursor is inside the tab strip (CSS px), `size` the
/// new window's logical size. Returns the new window's label.
#[tauri::command]
pub async fn shell_tear_out(app: AppHandle, window: tauri::Window, tab: String, grab: (f64, f64), size: Option<(f64, f64)>) -> Result<String, String> {
    let from = window.label().to_string();
    // A window's only tab: the window itself is what moves (like browsers).
    if from != MAIN && layout(&app).win(&from).is_some_and(|w| w.tabs.len() == 1 && w.tabs[0] == tab) {
        return Ok(from);
    }
    let label = {
        let mut making = MAKING.lock();
        let l = layout(&app).new_label(&making);
        making.push(l.clone());
        l
    };
    let res = (|| {
        if layout(&app).host_of(&tab) != Some(from.as_str()) {
            return Err("That tab is not in this window.".to_string());
        }
        change(&app, true, |l| l.move_tab(&tab, &label, None).map(|_| true))?;
        Ok(())
    })();
    if let Err(e) = res {
        MAKING.lock().retain(|l| l != &label);
        return Err(e);
    }
    // The same size as the window it leaves, like browsers.
    let size = size.unwrap_or_else(|| {
        let sf = window.scale_factor().unwrap_or(1.0);
        window.inner_size().map(|s| (s.width as f64 / sf, s.height as f64 / sf)).unwrap_or((1100.0, 760.0))
    });
    let at = place_under_cursor(&app, None, grab);
    let built = build(&app, &label, at, size, false, false);
    MAKING.lock().retain(|l| l != &label);
    if let Err(e) = built {
        // Put the tab back.
        let _ = change(&app, true, |l| l.move_tab(&tab, &from, None).map(|_| true));
        return Err(e);
    }
    Ok(label)
}

/// Moves window `label` so the cursor sits at `grab` (CSS px) inside it, and
/// shows the drop hint on a strip under the cursor. Returns that target.
#[tauri::command]
pub fn shell_drag_to(app: AppHandle, label: String, grab: (f64, f64)) -> Option<(String, usize)> {
    if let Some(w) = app.get_webview_window(&label) {
        if w.is_maximized().unwrap_or(false) {
            let _ = w.unmaximize();
        }
        if let Some((x, y)) = place_under_cursor(&app, Some(&w), grab) {
            let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
        }
    }
    let t = drop_target(&app, &label);
    hint(&app, t.clone());
    t
}

/// The drag ended. Over another window's strip, `tab` docks there (and the
/// dragged window closes once empty); else the dragged window stays and comes
/// to the front. Returns the window that holds the tab now.
#[tauri::command]
pub fn shell_drop(app: AppHandle, label: String, tab: String) -> Result<String, String> {
    let target = drop_target(&app, &label);
    hint(&app, None);
    let Some((to, index)) = target else {
        if let Some(w) = app.get_webview_window(&label) {
            bring_to_front(&w);
        }
        return Ok(label);
    };
    let before = layout(&app);
    change(&app, true, |l| l.move_tab(&tab, &to, Some(index)).map(|_| true))?;
    let after = layout(&app);
    // The dragged window is empty now: it goes without docking anything.
    if before.win(&label).is_some() && after.win(&label).is_none() {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.destroy();
        }
    }
    if let Some(w) = app.get_webview_window(&to) {
        bring_to_front(&w);
    }
    Ok(to)
}

/// Menus and keys: moves `tab` to window `to` ("new" makes one next to the
/// calling window) at `index`.
#[tauri::command]
pub async fn shell_move_tab(app: AppHandle, window: tauri::Window, tab: String, to: String, index: Option<usize>) -> Result<String, String> {
    let from = window.label().to_string();
    hint(&app, None);
    if to == "new" {
        let label = {
            let mut making = MAKING.lock();
            let l = layout(&app).new_label(&making);
            making.push(l.clone());
            l
        };
        let r = change(&app, true, |l| l.move_tab(&tab, &label, None).map(|_| true));
        if let Err(e) = r {
            MAKING.lock().retain(|l| l != &label);
            return Err(e);
        }
        // Next to the window it came from, cascaded.
        let (at, size) = match app.get_webview_window(&from) {
            Some(w) => {
                let p = w.outer_position().ok().map(|p| (p.x + 48, p.y + 48));
                let sf = w.scale_factor().unwrap_or(1.0);
                let s = w.inner_size().ok().map(|s| (s.width as f64 / sf, s.height as f64 / sf)).unwrap_or((1100.0, 760.0));
                (p, s)
            }
            None => (None, (1100.0, 760.0)),
        };
        let built = build(&app, &label, at, size, false, true);
        MAKING.lock().retain(|l| l != &label);
        if let Err(e) = built {
            let _ = change(&app, true, |l| l.move_tab(&tab, &from, None).map(|_| true));
            return Err(e);
        }
        return Ok(label);
    }
    let before = layout(&app);
    let src = before.host_of(&tab).map(str::to_string);
    change(&app, true, |l| l.move_tab(&tab, &to, index).map(|_| true))?;
    let after = layout(&app);
    if let Some(src) = src {
        if src != MAIN && before.win(&src).is_some() && after.win(&src).is_none() {
            if let Some(w) = app.get_webview_window(&src) {
                let _ = w.destroy();
            }
        }
    }
    if from != to {
        if let Some(w) = app.get_webview_window(&to) {
            bring_to_front(&w);
        }
    }
    Ok(to)
}

/// Shows the window holding `tab`, makes `tab` active there and hands it
/// `payload` (e.g. files for the Editor, a Settings section).
#[tauri::command]
pub async fn shell_open_tab(app: AppHandle, tab: String, payload: Option<serde_json::Value>) -> Result<String, String> {
    let l = layout(&app);
    let host = l.host_of(&tab).ok_or_else(|| format!("Unknown tab: {tab}"))?.to_string();
    change(&app, false, |l| Ok(l.set_active(&host, &tab)))?;
    if host == MAIN {
        crate::startup::show_main(&app);
    } else {
        match app.get_webview_window(&host) {
            Some(w) => bring_to_front(&w),
            None => {
                shell_restore(app.clone()).await?;
            }
        }
    }
    let _ = app.emit_to(host.as_str(), EVT_OPEN, serde_json::json!({ "tab": tab, "payload": payload }));
    Ok(host)
}

/// Brings the calling window to the front (no injected keys).
#[tauri::command]
pub fn shell_focus_self(window: tauri::WebviewWindow) {
    bring_to_front(&window);
}

/// The calling window's UI scale was asked for (it applies the setting).
#[tauri::command]
pub fn shell_apply_scale(app: AppHandle, window: tauri::WebviewWindow) {
    apply_scale(&window, ui_scale(&app));
}

/// Window events for the app windows (from `on_window_event`).
pub fn on_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let label = window.label().to_string();
    if !is_shell_label(&label) {
        return;
    }
    match event {
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => remember_place(window),
        tauri::WindowEvent::CloseRequested { .. } if label != MAIN => {
            // A user close (button, Alt+F4): the tabs go home. A quit never
            // gets here, so the layout survives a restart.
            remember_place(window);
            let app = window.app_handle().clone();
            let _ = change(&app, true, |l| {
                l.dock_all(&label);
                Ok(true)
            });
        }
        tauri::WindowEvent::Destroyed => {
            if let Some(m) = STRIPS.lock().as_mut() {
                m.remove(&label);
            }
        }
        _ => {}
    }
}

fn remember_place(window: &tauri::Window) {
    if test_instance() || window.is_minimized().unwrap_or(false) {
        return;
    }
    let maximized = window.is_maximized().unwrap_or(false);
    let Some(state) = window.app_handle().try_state::<AppState>() else { return };
    let mut s = state.settings.write();
    let Some(w) = s.shell.windows.iter_mut().find(|w| w.label == window.label()) else { return };
    if maximized {
        // Keep the normal place to come back to.
        let mut p = w.place.unwrap_or_default();
        p.maximized = true;
        w.place = Some(p);
        return;
    }
    let (Ok(pos), Ok(size), Ok(sf)) = (window.outer_position(), window.inner_size(), window.scale_factor()) else { return };
    w.place = Some(Place {
        x: pos.x,
        y: pos.y,
        width: (size.width as f64 / sf).round(),
        height: (size.height as f64 / sf).round(),
        maximized: false,
    });
}

/// Where the main window was last, if it is on some screen.
pub fn main_place(app: &AppHandle) -> Option<Place> {
    if test_instance() {
        return None;
    }
    let p = layout(app).win(MAIN)?.place?;
    place_visible(&p, &screens(app)).then_some(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn l(wins: &[(&str, &[&str], &str)]) -> ShellLayout {
        ShellLayout {
            windows: wins
                .iter()
                .map(|(label, tabs, active)| ShellWin { label: label.to_string(), tabs: tabs.iter().map(|t| t.to_string()).collect(), active: active.to_string(), place: None })
                .collect(),
        }
    }
    fn tabs(l: &ShellLayout, label: &str) -> Vec<String> {
        l.win(label).map(|w| w.tabs.clone()).unwrap_or_default()
    }

    #[test]
    fn labels() {
        assert!(is_shell_label("main"));
        assert!(is_shell_label("shell-2"));
        assert!(!is_shell_label("shell-"));
        assert!(!is_shell_label("shell-x"));
        assert!(!is_shell_label("frame-2"));
    }

    #[test]
    fn normalising_keeps_every_tab_once_and_main_first() {
        let n = ShellLayout::default().normalized();
        assert_eq!(n.windows.len(), 1);
        assert_eq!(tabs(&n, MAIN), TABS.to_vec());
        assert_eq!(n.windows[0].active, "home");
        let messy = l(&[("shell-3", &["audio", "audio", "nope"], "x"), ("main", &["clips", "audio"], "clips"), ("shell-4", &[], "")]);
        let n = messy.normalized();
        assert_eq!(n.windows[0].label, MAIN);
        assert_eq!(tabs(&n, MAIN), vec!["clips", "audio", "home", "editor", "studio", "settings"]);
        // audio was already in main: shell-3 is left empty and goes; so does shell-4.
        assert_eq!(n.windows.len(), 1);
    }

    #[test]
    fn tearing_out_docking_and_the_main_window_keeping_one() {
        let mut x = ShellLayout::default().normalized();
        x.move_tab("audio", "shell-2", None).unwrap();
        x.move_tab("editor", "shell-2", Some(0)).unwrap();
        assert_eq!(tabs(&x, "shell-2"), vec!["editor", "audio"]);
        assert_eq!(x.win("shell-2").unwrap().active, "editor");
        assert_eq!(x.host_of("audio"), Some("shell-2"));
        // Docking the last tab back closes the window.
        x.move_tab("editor", MAIN, Some(1)).unwrap();
        x.move_tab("audio", MAIN, None).unwrap();
        assert!(x.win("shell-2").is_none());
        assert_eq!(tabs(&x, MAIN)[1], "editor");
        // The main window keeps at least one tab.
        let mut y = l(&[("main", &["home"], "home"), ("shell-2", &["clips", "editor", "studio", "audio", "settings"], "clips")]).normalized();
        assert!(y.move_tab("home", "shell-2", None).is_err());
        assert!(y.move_tab("bogus", "shell-2", None).is_err());
    }

    #[test]
    fn moving_within_a_window_reorders() {
        let mut x = ShellLayout::default().normalized();
        // home clips editor studio audio settings: drop "home" before "studio" (index 3).
        x.move_tab("home", MAIN, Some(3)).unwrap();
        assert_eq!(tabs(&x, MAIN), vec!["clips", "editor", "home", "studio", "audio", "settings"]);
        assert!(x.reorder(MAIN, &["settings", "clips", "editor", "home", "studio", "audio"].map(String::from)));
        assert!(!x.reorder(MAIN, &["settings".to_string()]));
    }

    #[test]
    fn closing_a_window_docks_its_tabs_and_active_follows() {
        let mut x = ShellLayout::default().normalized();
        x.move_tab("studio", "shell-2", None).unwrap();
        x.move_tab("audio", "shell-2", None).unwrap();
        assert_eq!(x.win(MAIN).unwrap().tabs.len(), 4);
        assert!(x.set_active("shell-2", "studio"));
        assert!(!x.set_active("shell-2", "home"));
        x.dock_all("shell-2");
        assert!(x.win("shell-2").is_none());
        assert_eq!(tabs(&x, MAIN), vec!["home", "clips", "editor", "settings", "studio", "audio"]);
        x.dock_all(MAIN); // never
        assert!(x.win(MAIN).is_some());
    }

    #[test]
    fn new_labels_skip_taken_ones() {
        let mut x = ShellLayout::default().normalized();
        x.move_tab("audio", "shell-2", None).unwrap();
        assert_eq!(x.new_label(&[]), "shell-3");
        assert_eq!(x.new_label(&["shell-3".into()]), "shell-4");
    }

    #[test]
    fn insert_points_and_places() {
        let t = [(0.0, 100.0), (100.0, 180.0), (180.0, 300.0)];
        assert_eq!(insert_index(&t, 10.0), 0);
        assert_eq!(insert_index(&t, 60.0), 1);
        assert_eq!(insert_index(&t, 150.0), 2);
        assert_eq!(insert_index(&t, 999.0), 3);
        let screens = [(0, 0, 1920, 1080), (1920, -300, 3840, 2160)];
        let p = |x, y| Place { x, y, width: 900.0, height: 600.0, maximized: false };
        assert!(place_visible(&p(100, 100), &screens));
        assert!(place_visible(&p(4000, -200), &screens)); // the 4K screen above
        assert!(!place_visible(&p(-3000, 100), &screens)); // an unplugged monitor
        assert!(!place_visible(&Place { width: 50.0, ..p(100, 100) }, &screens));
        assert_eq!(clamp_scale(3.0), 2.0);
        assert_eq!(clamp_scale(0.1), 0.5);
        assert_eq!(clamp_scale(f64::NAN), 1.0);
        assert_eq!(clamp_scale(1.104), 1.1);
    }

    #[test]
    fn old_settings_without_a_layout_still_load() {
        let v: ShellLayout = serde_json::from_str(r#"{"windows":[{"label":"main","tabs":["audio"]}]}"#).unwrap();
        let n = v.normalized();
        assert_eq!(tabs(&n, MAIN)[0], "audio");
        assert_eq!(n.windows[0].active, "audio");
        let w: ShellWin = serde_json::from_str(r#"{"label":"shell-2","place":{"x":-1,"y":2,"width":800,"height":600}}"#).unwrap();
        assert!(!w.place.unwrap().maximized);
    }
}
