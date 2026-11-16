//! Pop-out frames: a picture, a clip frame, a playing clip, a reference board
//! or a live view in a borderless window of its own, to keep on top of
//! another app (trace in a drawing app, pose in Blender, watch a tutorial).
//!
//! - Each frame is a WebView window labelled `frame-<id>` that loads the same
//!   frontend (one shared WebView2 environment, so one browser process).
//! - Its place, size and settings live in `%APPDATA%\Lastshot\frames.json`;
//!   pictures that came from the clipboard, a snip or a drop are kept in
//!   `%APPDATA%\Lastshot\frames\` and deleted with their frame.
//! - "Click-through" makes Windows send every mouse click to the app below
//!   (WS_EX_TRANSPARENT | WS_EX_LAYERED via Tauri). The frame can then only be
//!   reached from Lastshot: the Pop-outs panel, the tray menu and a global
//!   shortcut that flips click-through for every frame.
//! - Frames never take the keyboard focus when shown or changed; only a click
//!   on a frame (click-through off) activates it.
//!
//! Also here: "copy this frame" / "save this frame" for the viewer.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use crate::commands::AppState;

pub const LABEL_PREFIX: &str = "frame-";
/// Every window hears the full frame list whenever it changes.
pub const EVT_FRAMES: &str = "lastshot://frames";
/// Asks the main window to open its Pop-outs panel.
pub const EVT_PANEL: &str = "lastshot://frames-panel";
/// Default "click-through on/off for all frames" shortcut.
pub const DEFAULT_HOTKEY: &str = "Ctrl+Alt+Shift+X";

const PNG_MAGIC: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Frame {
    pub id: String,
    /// "image", "video", "board" or "live".
    pub kind: String,
    /// Picture or clip path ("" for boards and live views).
    pub src: String,
    pub title: String,
    /// Outer rectangle, physical pixels.
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    /// 0.05–1.
    pub opacity: f64,
    pub on_top: bool,
    pub click_through: bool,
    pub hidden: bool,
    /// The frame's own view and settings (zoom, colour, crop, video, board
    /// items…), owned by the frontend.
    pub view: serde_json::Value,
    /// `src` was written by Lastshot into the frames folder.
    pub owned: bool,
    pub created_ms: i64,
}

impl Default for Frame {
    fn default() -> Self {
        Self {
            id: String::new(),
            kind: "image".into(),
            src: String::new(),
            title: String::new(),
            x: 0,
            y: 0,
            w: 480,
            h: 320,
            opacity: 1.0,
            on_top: true,
            click_through: false,
            hidden: false,
            view: serde_json::Value::Null,
            owned: false,
            created_ms: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FramesFile {
    pub hotkey: String,
    pub frames: Vec<Frame>,
}

impl Default for FramesFile {
    fn default() -> Self {
        Self { hotkey: DEFAULT_HOTKEY.into(), frames: Vec::new() }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FramePatch {
    pub opacity: Option<f64>,
    pub on_top: Option<bool>,
    pub click_through: Option<bool>,
    pub hidden: Option<bool>,
    pub view: Option<serde_json::Value>,
    pub title: Option<String>,
}

impl Frame {
    /// Applies a patch; returns which window-level things changed.
    pub fn apply(&mut self, p: &FramePatch) -> (bool, bool, bool) {
        let mut top = false;
        let mut through = false;
        let mut shown = false;
        if let Some(o) = p.opacity {
            self.opacity = clamp_opacity(o);
        }
        if let Some(t) = p.on_top {
            top = t != self.on_top;
            self.on_top = t;
        }
        if let Some(c) = p.click_through {
            through = c != self.click_through;
            self.click_through = c;
        }
        if let Some(h) = p.hidden {
            shown = h != self.hidden;
            self.hidden = h;
        }
        if let Some(v) = &p.view {
            self.view = v.clone();
        }
        if let Some(t) = &p.title {
            self.title = t.chars().take(120).collect();
        }
        (top, through, shown)
    }
}

pub fn clamp_opacity(o: f64) -> f64 {
    if o.is_finite() {
        o.clamp(0.05, 1.0)
    } else {
        1.0
    }
}

pub fn label_of(id: &str) -> String {
    format!("{LABEL_PREFIX}{id}")
}

pub fn id_of(label: &str) -> Option<&str> {
    label.strip_prefix(LABEL_PREFIX).filter(|s| !s.is_empty())
}

/// A fresh, short, file-name-safe id.
pub fn new_id() -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static N: AtomicU32 = AtomicU32::new(0);
    let t = chrono::Utc::now().timestamp_millis() as u64;
    format!("{:x}{:02x}", t & 0xff_ffff_ffff, N.fetch_add(1, Ordering::Relaxed) & 0xff)
}

/// "All on" unless every frame already is: the shortcut's toggle rule.
pub fn toggle_target(frames: &[Frame]) -> bool {
    frames.is_empty() || !frames.iter().all(|f| f.click_through)
}

/// Fits a picture of `nw×nh` into `max_w×max_h` keeping its shape.
pub fn fit_size(nw: u32, nh: u32, max_w: u32, max_h: u32, min: u32) -> (u32, u32) {
    let (nw, nh) = (nw.max(1) as f64, nh.max(1) as f64);
    let k = (max_w as f64 / nw).min(max_h as f64 / nh).min(1.0);
    let (w, h) = ((nw * k).round(), (nh * k).round());
    // Tiny pictures grow to the minimum along their short side.
    let g = (min as f64 / w.min(h)).max(1.0);
    ((w * g).round() as u32, (h * g).round() as u32)
}

/// Saved places that no screen shows any more are moved back on screen.
pub fn on_some_screen(x: i32, y: i32, w: u32, screens: &[(i32, i32, u32, u32)]) -> bool {
    let (px, py) = (x as i64 + (w as i64 / 2).min(60), y as i64 + 10);
    screens.iter().any(|&(sx, sy, sw, sh)| {
        px >= sx as i64 && px < sx as i64 + sw as i64 && py >= sy as i64 && py < sy as i64 + sh as i64
    })
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

struct Store {
    file: FramesFile,
    dirty: bool,
}

fn store() -> &'static Mutex<Store> {
    static S: OnceLock<Mutex<Store>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Store { file: load(), dirty: false }))
}

fn file_path() -> PathBuf {
    crate::paths::app_file("frames.json")
}

pub fn pictures_dir() -> PathBuf {
    crate::paths::app_data_dir().join("frames")
}

fn load() -> FramesFile {
    std::fs::read_to_string(file_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_now() {
    let snapshot = {
        let mut s = store().lock();
        s.dirty = false;
        s.file.clone()
    };
    let path = file_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = path.with_extension("json.tmp");
    match serde_json::to_vec_pretty(&snapshot) {
        Ok(bytes) => {
            if std::fs::write(&tmp, bytes).is_ok() {
                let _ = std::fs::rename(&tmp, &path);
            }
        }
        Err(e) => log::warn!("[frames] could not save: {e}"),
    }
}

/// Saves within about a second, coalescing bursts (moving, resizing).
fn save_soon() {
    let start = {
        let mut s = store().lock();
        let was = s.dirty;
        s.dirty = true;
        !was
    };
    if start {
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(800));
            save_now();
        });
    }
}

fn all() -> Vec<Frame> {
    store().lock().file.frames.clone()
}

#[cfg_attr(not(feature = "pro-board"), allow(dead_code))]
pub(crate) fn get(id: &str) -> Option<Frame> {
    store().lock().file.frames.iter().find(|f| f.id == id).cloned()
}

fn announce(app: &AppHandle) {
    let _ = app.emit(EVT_FRAMES, all());
}

fn test_instance() -> bool {
    std::env::var("LASTSHOT_TEST_INSTANCE").as_deref() == Ok("1")
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

fn window(app: &AppHandle, id: &str) -> Option<WebviewWindow> {
    app.get_webview_window(&label_of(id))
}

/// Shows a window without activating it.
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

/// Moves and sizes in one step, without activating or changing the z-order.
fn place(win: &WebviewWindow, x: i32, y: i32, w: u32, h: u32) {
    #[cfg(windows)]
    if let Ok(hwnd) = win.hwnd() {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER};
        unsafe {
            let _ = SetWindowPos(HWND(hwnd.0 as _), None, x, y, w.max(40) as i32, h.max(30) as i32, SWP_NOACTIVATE | SWP_NOZORDER);
        }
        return;
    }
    let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
    let _ = win.set_size(tauri::PhysicalSize::new(w.max(40), h.max(30)));
}

fn screens(app: &AppHandle) -> Vec<(i32, i32, u32, u32)> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let a = m.work_area();
            (a.position.x, a.position.y, a.size.width, a.size.height)
        })
        .collect()
}

fn build_window(app: &AppHandle, f: &Frame) -> Result<WebviewWindow, String> {
    let label = label_of(&f.id);
    if let Some(w) = app.get_webview_window(&label) {
        return Ok(w);
    }
    let win = tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::default())
        .title(if f.title.is_empty() { "Lastshot frame" } else { &f.title })
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(true)
        .skip_taskbar(true)
        .always_on_top(f.on_top)
        .focused(false)
        .visible(false)
        .drag_and_drop(false)
        .min_inner_size(60.0, 40.0)
        .inner_size(f.w as f64, f.h as f64)
        .background_color(tauri::window::Color(0, 0, 0, 0))
        .build()
        .map_err(|e| e.to_string())?;
    place(&win, f.x, f.y, f.w, f.h);
    #[cfg(feature = "pro-board")]
    crate::pro_board::on_window(&win, &f.kind);
    let _ = win.set_ignore_cursor_events(f.click_through);
    if !f.hidden {
        show_quietly(&win);
    }
    Ok(win)
}

/// Where a new frame goes: near the cursor's screen centre, cascading; test
/// instances always far off screen so nothing ever covers the user's work.
fn initial_rect(app: &AppHandle, nw: u32, nh: u32, at: Option<(i32, i32)>) -> (i32, i32, u32, u32) {
    let count = store().lock().file.frames.len() as i32;
    if test_instance() {
        let (w, h) = fit_size(nw, nh, 640, 480, 120);
        return (-20000 - count * 700, 100, w, h);
    }
    let cursor = app.cursor_position().ok();
    let mon = cursor
        .and_then(|c| app.monitor_from_point(c.x, c.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let (ax, ay, aw, ah) = mon
        .map(|m| {
            let a = m.work_area();
            (a.position.x, a.position.y, a.size.width, a.size.height)
        })
        .unwrap_or((0, 0, 1920, 1040));
    let (w, h) = fit_size(nw, nh, (aw as f64 * 0.45) as u32, (ah as f64 * 0.55) as u32, 160);
    let (x, y) = match at {
        Some((x, y)) => (x, y),
        None => {
            let off = (count % 8) * 28;
            (ax + (aw as i32 - w as i32) / 2 + off, ay + (ah as i32 - h as i32) / 2 + off)
        }
    };
    (x, y, w, h)
}

// ---------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------

/// Decodes a `data:image/png;base64,…` URL (or bare base64) and checks it is
/// a PNG, so the webview can never write anything else.
pub fn decode_png(data: &str) -> Result<Vec<u8>, String> {
    let bytes = decode_b64(data)?;
    if bytes.len() < 8 || bytes[..8] != PNG_MAGIC {
        return Err("that is not a PNG picture".into());
    }
    Ok(bytes)
}

pub(crate) fn decode_b64(data: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let b64 = data.split_once(',').map(|(_, d)| d).unwrap_or(data);
    base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("bad picture data: {e}"))
}

/// The picture formats a frame accepts, by their first bytes.
pub fn picture_ext(b: &[u8]) -> Option<&'static str> {
    if b.len() >= 8 && b[..8] == PNG_MAGIC {
        Some("png")
    } else if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        Some("gif")
    } else if b.len() >= 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some("webp")
    } else if b.starts_with(b"BM") {
        Some("bmp")
    } else {
        None
    }
}

/// Writes picture bytes into the frames folder; returns the path.
fn keep_picture(id: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let ext = picture_ext(bytes).ok_or("That is not a picture Lastshot can show (PNG, JPG, GIF, WebP, BMP).")?;
    if bytes.len() > 200 * 1024 * 1024 {
        return Err("That picture is too big (over 200 MB).".into());
    }
    let dir = pictures_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let p = dir.join(format!("{id}.{ext}"));
    std::fs::write(&p, bytes).map_err(|e| e.to_string())?;
    Ok(p)
}

fn is_ours(p: &Path) -> bool {
    p.parent().map(|d| d == pictures_dir()).unwrap_or(false)
}

/// A free file name `<stem>.png` (then `<stem>_2.png`, …) in `dir`.
pub fn free_png_path(dir: &Path, stem: &str) -> PathBuf {
    let stem = crate::commands::sanitize_file_stem(stem, "Lastshot frame");
    let mut p = dir.join(format!("{stem}.png"));
    let mut n = 2;
    while p.exists() {
        p = dir.join(format!("{stem}_{n}.png"));
        n += 1;
    }
    p
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenFrame {
    pub kind: String,
    /// A file to show (a clip or a picture already on disk).
    pub path: Option<String>,
    /// Or picture bytes as a data URL (PNG, JPG, GIF, WebP, BMP).
    pub data: Option<String>,
    pub title: Option<String>,
    /// The picture's own size, to give the window its shape.
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub view: Option<serde_json::Value>,
    /// Physical screen point for the top-left corner.
    pub x: Option<i32>,
    pub y: Option<i32>,
}

#[tauri::command]
pub async fn frame_open(app: AppHandle, req: OpenFrame) -> Result<Frame, String> {
    let kind = match req.kind.as_str() {
        "image" | "video" => req.kind.clone(),
        // Reference boards and live views are Lastshot Pro (src/pro_board.rs).
        "board" | "live" if cfg!(feature = "pro-board") => req.kind.clone(),
        k => return Err(format!("Unknown frame kind: {k}")),
    };
    let id = new_id();
    let (src, owned) = match (&req.data, &req.path) {
        (Some(d), _) => {
            let bytes = decode_b64(d)?;
            let id2 = id.clone();
            let p = tauri::async_runtime::spawn_blocking(move || keep_picture(&id2, &bytes))
                .await
                .map_err(|e| e.to_string())??;
            (p.to_string_lossy().to_string(), true)
        }
        (None, Some(p)) => {
            if !Path::new(p).is_file() {
                return Err("That file is not there any more.".into());
            }
            (p.clone(), false)
        }
        (None, None) if kind == "board" || kind == "live" => (String::new(), false),
        _ => return Err("Nothing to show".into()),
    };
    if !src.is_empty() {
        allow_file(&app, &src);
    }
    let (nw, nh) = (req.width.unwrap_or(800).max(1), req.height.unwrap_or(600).max(1));
    let at = req.x.zip(req.y);
    let (x, y, w, h) = initial_rect(&app, nw, nh, at);
    let title = req.title.clone().unwrap_or_else(|| {
        Path::new(&src).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| match kind.as_str() {
            "board" => "Reference board".into(),
            "live" => "Live view".into(),
            _ => "Picture".into(),
        })
    });
    let f = Frame {
        id,
        kind,
        src,
        title,
        x,
        y,
        w,
        h,
        view: req.view.clone().unwrap_or(serde_json::Value::Null),
        owned,
        created_ms: chrono::Utc::now().timestamp_millis(),
        ..Default::default()
    };
    store().lock().file.frames.push(f.clone());
    save_soon();
    let app2 = app.clone();
    let f2 = f.clone();
    // Windows are created on the main thread.
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(build_window(&app2, &f2).map(|_| ()));
    })
    .map_err(|e| e.to_string())?;
    if let Ok(Err(e)) = rx.recv_timeout(std::time::Duration::from_secs(10)) {
        store().lock().file.frames.retain(|x| x.id != f.id);
        return Err(e);
    }
    announce(&app);
    Ok(f)
}

#[tauri::command]
pub fn frame_list() -> Vec<Frame> {
    all()
}

#[tauri::command]
pub fn frame_update(app: AppHandle, id: String, patch: FramePatch) -> Result<Frame, String> {
    let (f, (top, through, shown)) = {
        let mut s = store().lock();
        let f = s.file.frames.iter_mut().find(|f| f.id == id).ok_or("That frame is closed")?;
        let changed = f.apply(&patch);
        (f.clone(), changed)
    };
    save_soon();
    if let Some(win) = window(&app, &id) {
        if top {
            let _ = win.set_always_on_top(f.on_top);
        }
        if through {
            let _ = win.set_ignore_cursor_events(f.click_through);
        }
        if shown {
            if f.hidden {
                let _ = win.hide();
            } else {
                show_quietly(&win);
            }
        }
    }
    // A view-only change (zoom, colour…) is the frame's own business: only
    // window-level changes are told to every window.
    if patch.view.is_none() || top || through || shown || patch.opacity.is_some() || patch.title.is_some() {
        announce(&app);
    }
    Ok(f)
}

/// Moves / resizes a frame (physical px), e.g. while dragging its edges.
#[tauri::command]
pub fn frame_set_rect(app: AppHandle, id: String, x: i32, y: i32, w: u32, h: u32) -> Result<(), String> {
    let win = window(&app, &id).ok_or("That frame is closed")?;
    place(&win, x, y, w, h);
    Ok(())
}

#[tauri::command]
pub fn frame_fullscreen(app: AppHandle, id: String, on: Option<bool>) -> Result<bool, String> {
    let win = window(&app, &id).ok_or("That frame is closed")?;
    let next = on.unwrap_or(!win.is_fullscreen().unwrap_or(false));
    win.set_fullscreen(next).map_err(|e| e.to_string())?;
    Ok(next)
}

/// Brings a frame to the front (and to the screen it is on) without focus.
#[tauri::command]
pub fn frame_raise(app: AppHandle, id: String) -> Result<(), String> {
    let win = window(&app, &id).ok_or("That frame is closed")?;
    {
        let mut s = store().lock();
        if let Some(f) = s.file.frames.iter_mut().find(|f| f.id == id) {
            f.hidden = false;
        }
    }
    show_quietly(&win);
    #[cfg(windows)]
    if let Ok(hwnd) = win.hwnd() {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, HWND_TOP, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE};
        unsafe {
            let _ = SetWindowPos(HWND(hwnd.0 as _), HWND_TOP, 0, 0, 0, 0, SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE);
        }
    }
    announce(&app);
    Ok(())
}

#[tauri::command]
pub fn frame_close(app: AppHandle, id: String) -> Result<(), String> {
    if let Some(w) = window(&app, &id) {
        let _ = w.destroy();
    }
    forget(&app, &id);
    Ok(())
}

fn forget(app: &AppHandle, id: &str) {
    let gone = {
        let mut s = store().lock();
        let gone: Vec<Frame> = s.file.frames.iter().filter(|f| f.id == id).cloned().collect();
        s.file.frames.retain(|f| f.id != id);
        gone
    };
    for f in gone {
        if f.owned && is_ours(Path::new(&f.src)) {
            let _ = std::fs::remove_file(&f.src);
        }
        // Board pictures live in <frames>/<id>/.
        let dir = pictures_dir().join(&f.id);
        if dir.is_dir() && dir.parent() == Some(pictures_dir().as_path()) {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
    save_soon();
    announce(app);
}

#[tauri::command]
pub fn frame_close_all(app: AppHandle) {
    for f in all() {
        let _ = frame_close(app.clone(), f.id);
    }
}

/// Click-through for every frame: `on`, or flip (all on unless all are on).
#[tauri::command]
pub fn frame_click_through_all(app: AppHandle, on: Option<bool>) -> bool {
    let frames = all();
    let target = on.unwrap_or_else(|| toggle_target(&frames));
    for f in frames {
        let _ = frame_update(
            app.clone(),
            f.id,
            FramePatch { click_through: Some(target), ..Default::default() },
        );
    }
    target
}

/// Hides or shows every frame.
#[tauri::command]
pub fn frame_hide_all(app: AppHandle, hidden: Option<bool>) -> bool {
    let frames = all();
    let target = hidden.unwrap_or_else(|| !frames.iter().all(|f| f.hidden));
    for f in frames {
        let _ = frame_update(app.clone(), f.id, FramePatch { hidden: Some(target), ..Default::default() });
    }
    target
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    /// Work areas (physical px): x, y, w, h.
    pub screens: Vec<(i32, i32, u32, u32)>,
    /// Other frames' outer rectangles.
    pub frames: Vec<(String, i32, i32, u32, u32)>,
    /// This frame's own outer rectangle.
    pub me: Option<(i32, i32, u32, u32)>,
    pub scale: f64,
}

/// What a frame snaps to while moved or resized.
#[tauri::command]
pub fn frame_layout(app: AppHandle, id: String) -> Layout {
    let frames = app
        .webview_windows()
        .into_iter()
        .filter_map(|(label, w)| {
            let fid = id_of(&label)?.to_string();
            if fid == id || !w.is_visible().unwrap_or(false) {
                return None;
            }
            let p = w.outer_position().ok()?;
            let s = w.outer_size().ok()?;
            Some((fid, p.x, p.y, s.width, s.height))
        })
        .collect();
    let win = window(&app, &id);
    let scale = win.as_ref().and_then(|w| w.scale_factor().ok()).unwrap_or(1.0);
    let me = win.and_then(|w| {
        let p = w.outer_position().ok()?;
        let s = w.outer_size().ok()?;
        Some((p.x, p.y, s.width, s.height))
    });
    Layout { screens: screens(&app), frames, me, scale }
}

#[tauri::command]
pub fn frame_get_hotkey() -> String {
    store().lock().file.hotkey.clone()
}

/// Sets the click-through shortcut ("" turns it off).
#[tauri::command]
pub fn frame_set_hotkey(app: AppHandle, hotkey: String) -> Result<String, String> {
    let hotkey = hotkey.trim().to_string();
    let old = store().lock().file.hotkey.clone();
    if hotkey == old {
        return Ok(hotkey);
    }
    if hotkey.is_empty() {
        unregister(&app, &old);
    } else if old.is_empty() {
        register(&app, &hotkey)?;
    } else {
        crate::hotkeys::rebind(&app, &old, &hotkey)?;
    }
    store().lock().file.hotkey = hotkey.clone();
    save_soon();
    Ok(hotkey)
}

/// Picture on the clipboard → a frame. Reads the "PNG" format (browsers,
/// Snipping Tool, Lastshot) or a plain bitmap (stored as BMP).
#[tauri::command]
pub async fn frame_from_clipboard(app: AppHandle) -> Result<Frame, String> {
    let bytes = tauri::async_runtime::spawn_blocking(clipboard::read_picture)
        .await
        .map_err(|e| e.to_string())??;
    let (w, h) = picture_size(&bytes).unwrap_or((800, 600));
    use base64::Engine;
    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
    frame_open(
        app,
        OpenFrame {
            kind: "image".into(),
            data: Some(data),
            title: Some("Clipboard picture".into()),
            width: Some(w),
            height: Some(h),
            ..Default::default()
        },
    )
    .await
}

/// Width and height from a PNG or BMP header.
pub fn picture_size(b: &[u8]) -> Option<(u32, u32)> {
    if b.len() >= 24 && b[..8] == PNG_MAGIC {
        let w = u32::from_be_bytes(b[16..20].try_into().ok()?);
        let h = u32::from_be_bytes(b[20..24].try_into().ok()?);
        return Some((w, h));
    }
    if b.len() >= 26 && b.starts_with(b"BM") {
        let w = i32::from_le_bytes(b[18..22].try_into().ok()?);
        let h = i32::from_le_bytes(b[22..26].try_into().ok()?);
        return Some((w.unsigned_abs(), h.unsigned_abs()));
    }
    None
}

/// Asks the main window to show its Pop-outs panel.
#[tauri::command]
pub fn frame_show_panel(app: AppHandle) {
    show_panel(&app);
}

pub fn show_panel(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    let _ = app.emit(EVT_PANEL, ());
}

#[tauri::command]
pub async fn viewer_copy_png(png: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = decode_png(&png)?;
        crate::snip::copy_png(&bytes)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Saves into the Screenshots folder; returns the file's path.
#[tauri::command]
pub async fn viewer_save_png(state: State<'_, AppState>, png: String, name: String) -> Result<String, String> {
    let dir = state.settings.read().screenshots_dir();
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = decode_png(&png)?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = free_png_path(&dir, &name);
        std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
        Ok(path.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn allow_file(app: &AppHandle, path: &str) {
    let _ = app.asset_protocol_scope().allow_file(Path::new(path));
}

// ---------------------------------------------------------------------------
// Start-up, window events, shortcut, tray
// ---------------------------------------------------------------------------

/// Called once from `setup`: lets the webview load frame pictures, registers
/// the click-through shortcut and reopens the frames that were open.
pub fn init(app: &AppHandle) {
    let _ = std::fs::create_dir_all(pictures_dir());
    let _ = app.asset_protocol_scope().allow_directory(pictures_dir(), true);
    let (hotkey, frames) = {
        let s = store().lock();
        (s.file.hotkey.clone(), s.file.frames.clone())
    };
    if !hotkey.is_empty() {
        if let Err(e) = register(app, &hotkey) {
            log::warn!("[frames] shortcut {hotkey}: {e}");
        }
    }
    if test_instance() {
        return;
    }
    let screens = screens(app);
    let mut keep = Vec::new();
    for mut f in frames {
        if !f.src.is_empty() && !Path::new(&f.src).is_file() {
            continue; // its picture or clip is gone
        }
        // Never come back click-through: the user would not see why clicks
        // fall through.
        f.click_through = false;
        if !on_some_screen(f.x, f.y, f.w, &screens) {
            let (x, y, w, h) = initial_rect(app, f.w, f.h, None);
            (f.x, f.y, f.w, f.h) = (x, y, w, h);
        }
        if !f.src.is_empty() {
            allow_file(app, &f.src);
        }
        keep.push(f);
    }
    store().lock().file.frames = keep.clone();
    save_soon();
    for f in keep {
        if let Err(e) = build_window(app, &f) {
            log::warn!("[frames] could not reopen {}: {e}", f.id);
        }
    }
}

fn register(app: &AppHandle, hotkey: &str) -> Result<(), String> {
    if test_instance() {
        return crate::hotkeys::validate(hotkey).map(|_| ());
    }
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let sc = crate::hotkeys::validate(hotkey)?;
    let gs = app.global_shortcut();
    if !gs.is_registered(sc) {
        gs.register(sc).map_err(|e| format!("could not register {hotkey}: {e} (another app may own it)"))?;
    }
    Ok(())
}

fn unregister(app: &AppHandle, hotkey: &str) {
    if test_instance() {
        return;
    }
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    if let Ok(sc) = crate::hotkeys::parse(hotkey) {
        let _ = app.global_shortcut().unregister(sc);
    }
}

/// From the global shortcut handler.
pub fn is_hotkey(shortcut: &tauri_plugin_global_shortcut::Shortcut) -> bool {
    let key = store().lock().file.hotkey.clone();
    !key.is_empty() && crate::hotkeys::parse(&key).map(|s| &s == shortcut).unwrap_or(false)
}

pub fn on_hotkey(app: &AppHandle) {
    let h = app.clone();
    tauri::async_runtime::spawn(async move {
        frame_click_through_all(h, None);
    });
}

/// Window events for frames (from `on_window_event`).
pub fn on_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let Some(id) = id_of(window.label()).map(str::to_string) else { return };
    match event {
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
            if window.is_fullscreen().unwrap_or(false) || window.is_minimized().unwrap_or(false) {
                return;
            }
            let (Ok(p), Ok(s)) = (window.outer_position(), window.outer_size()) else { return };
            let changed = {
                let mut st = store().lock();
                match st.file.frames.iter_mut().find(|f| f.id == id) {
                    Some(f) if (f.x, f.y, f.w, f.h) != (p.x, p.y, s.width, s.height) => {
                        (f.x, f.y, f.w, f.h) = (p.x, p.y, s.width, s.height);
                        true
                    }
                    _ => false,
                }
            };
            if changed {
                save_soon();
            }
        }
        tauri::WindowEvent::CloseRequested { .. } => {
            // Alt+F4 or the frame's own close button.
            forget(window.app_handle(), &id);
        }
        _ => {}
    }
}

/// Tray submenu: what you need while a frame ignores the mouse.
pub fn tray_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Submenu<tauri::Wry>> {
    use tauri::menu::{MenuItem, Submenu};
    let key = store().lock().file.hotkey.clone();
    let through = MenuItem::with_id(
        app,
        "frames:through",
        if key.is_empty() { "Click-through on / off".to_string() } else { format!("Click-through on / off\t{key}") },
        true,
        None::<&str>,
    )?;
    let hide = MenuItem::with_id(app, "frames:hide", "Show / hide all frames", true, None::<&str>)?;
    let clip = MenuItem::with_id(app, "frames:clipboard", "Pop out the clipboard picture", true, None::<&str>)?;
    let panel = MenuItem::with_id(app, "frames:panel", "Pop-outs panel…", true, None::<&str>)?;
    let close = MenuItem::with_id(app, "frames:close", "Close all frames", true, None::<&str>)?;
    let sub = Submenu::with_id_and_items(app, "frames", "Pop-out frames", true, &[&through, &hide, &clip, &panel, &close])?;
    #[cfg(feature = "pro-board")]
    crate::pro_board::tray_items(app, &sub)?;
    Ok(sub)
}

/// Tray clicks with a `frames:` id. Returns false for other ids.
pub fn on_tray(app: &AppHandle, id: &str) -> bool {
    let h = app.clone();
    match id {
        "frames:through" => {
            frame_click_through_all(h, None);
        }
        "frames:hide" => {
            frame_hide_all(h, None);
        }
        "frames:close" => frame_close_all(h),
        "frames:panel" => show_panel(&h),
        "frames:clipboard" => {
            tauri::async_runtime::spawn(async move {
                if let Err(e) = frame_from_clipboard(h.clone()).await {
                    let _ = h.emit(crate::commands::EVT_ERROR, e);
                }
            });
        }
        #[cfg(feature = "pro-board")]
        other if crate::pro_board::on_tray(&h, other) => {}
        _ => return false,
    }
    true
}

// ---------------------------------------------------------------------------
// Clipboard (read)
// ---------------------------------------------------------------------------

#[cfg(all(windows, not(feature = "headless-sim")))]
mod clipboard {
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW};
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
    use windows::Win32::System::Ole::{CF_DIB, CF_DIBV5};

    unsafe fn bytes_of(fmt: u32) -> Option<Vec<u8>> {
        if IsClipboardFormatAvailable(fmt).is_err() {
            return None;
        }
        let h = GetClipboardData(fmt).ok()?;
        let g = HGLOBAL(h.0);
        let size = GlobalSize(g);
        let p = GlobalLock(g) as *const u8;
        if p.is_null() || size == 0 {
            return None;
        }
        let v = std::slice::from_raw_parts(p, size).to_vec();
        let _ = GlobalUnlock(g);
        Some(v)
    }

    pub fn read_picture() -> Result<Vec<u8>, String> {
        unsafe {
            OpenClipboard(None).map_err(|e| format!("The clipboard is busy: {e}"))?;
            let r = (|| {
                let png = RegisterClipboardFormatW(windows::core::w!("PNG"));
                if png != 0 {
                    if let Some(b) = bytes_of(png) {
                        return Ok(b);
                    }
                }
                for f in [CF_DIBV5.0 as u32, CF_DIB.0 as u32] {
                    if let Some(dib) = bytes_of(f) {
                        return Ok(super::dib_to_bmp(&dib));
                    }
                }
                Err("There is no picture on the clipboard.".to_string())
            })();
            let _ = CloseClipboard();
            r
        }
    }
}

#[cfg(any(not(windows), feature = "headless-sim"))]
mod clipboard {
    pub fn read_picture() -> Result<Vec<u8>, String> {
        Err("Needs Windows".into())
    }
}

/// A packed DIB (BITMAPINFOHEADER… + pixels) → a .bmp file.
pub fn dib_to_bmp(dib: &[u8]) -> Vec<u8> {
    let header = if dib.len() >= 4 { u32::from_le_bytes([dib[0], dib[1], dib[2], dib[3]]) } else { 40 };
    let bit_count = if dib.len() >= 16 { u16::from_le_bytes([dib[14], dib[15]]) } else { 32 };
    let compression = if dib.len() >= 20 { u32::from_le_bytes([dib[16], dib[17], dib[18], dib[19]]) } else { 0 };
    let clr_used = if dib.len() >= 36 { u32::from_le_bytes([dib[32], dib[33], dib[34], dib[35]]) } else { 0 };
    // BI_BITFIELDS with a plain 40-byte header carries 3 masks after it.
    let masks = if compression == 3 && header == 40 { 12 } else { 0 };
    let palette = if bit_count <= 8 { 4 * if clr_used > 0 { clr_used } else { 1 << bit_count } } else { 4 * clr_used };
    let off = 14 + header + masks + palette;
    let mut out = Vec::with_capacity(14 + dib.len());
    out.extend_from_slice(b"BM");
    out.extend_from_slice(&((14 + dib.len()) as u32).to_le_bytes());
    out.extend_from_slice(&[0, 0, 0, 0]);
    out.extend_from_slice(&off.to_le_bytes());
    out.extend_from_slice(dib);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_png_data_is_accepted() {
        assert!(decode_png("data:image/png;base64,iVBORw0KGgoAAAA=").is_ok());
        assert!(decode_png("data:image/png;base64,R0lGODlh").is_err()); // GIF
        assert!(decode_png("not base64 !!").is_err());
    }

    #[test]
    fn free_names_never_overwrite() {
        let dir = std::env::temp_dir().join(format!("lastshot-frames-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = free_png_path(&dir, "shot:1");
        assert_eq!(a.file_name().unwrap(), "shot1.png");
        std::fs::write(&a, b"x").unwrap();
        let b = free_png_path(&dir, "shot:1");
        assert_eq!(b.file_name().unwrap(), "shot1_2.png");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn labels_round_trip() {
        assert_eq!(label_of("ab12"), "frame-ab12");
        assert_eq!(id_of("frame-ab12"), Some("ab12"));
        assert_eq!(id_of("frame-"), None);
        assert_eq!(id_of("pop-audio"), None);
        let (a, b) = (new_id(), new_id());
        assert_ne!(a, b);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn patches_apply_and_report_window_changes() {
        let mut f = Frame::default();
        let changed = f.apply(&FramePatch { opacity: Some(0.01), click_through: Some(true), ..Default::default() });
        assert_eq!(f.opacity, 0.05);
        assert_eq!(changed, (false, true, false));
        let changed = f.apply(&FramePatch { on_top: Some(false), hidden: Some(true), opacity: Some(f64::NAN), ..Default::default() });
        assert_eq!(changed, (true, false, true));
        assert_eq!(f.opacity, 1.0);
        f.apply(&FramePatch { title: Some("x".repeat(500)), ..Default::default() });
        assert_eq!(f.title.len(), 120);
    }

    #[test]
    fn the_shortcut_turns_all_on_unless_all_are_on() {
        let mk = |c| Frame { click_through: c, ..Default::default() };
        assert!(toggle_target(&[mk(false), mk(true)]));
        assert!(!toggle_target(&[mk(true), mk(true)]));
        assert!(toggle_target(&[]));
    }

    #[test]
    fn sizes_fit_and_never_vanish() {
        assert_eq!(fit_size(3840, 2160, 1000, 800, 160), (1000, 563));
        assert_eq!(fit_size(400, 300, 1000, 800, 160), (400, 300));
        assert_eq!(fit_size(20, 10, 1000, 800, 160), (320, 160));
    }

    #[test]
    fn places_off_every_screen_are_detected() {
        let s = [(0, 0, 1920, 1040), (1920, 0, 2560, 1400)];
        assert!(on_some_screen(100, 100, 400, &s));
        assert!(on_some_screen(3000, 900, 400, &s));
        assert!(!on_some_screen(-20000, 100, 400, &s));
        assert!(!on_some_screen(100, 5000, 400, &s));
    }

    #[test]
    fn picture_kinds_and_sizes() {
        let mut png = PNG_MAGIC.to_vec();
        png.extend_from_slice(&[0, 0, 0, 13, b'I', b'H', b'D', b'R', 0, 0, 7, 128, 0, 0, 4, 56]);
        assert_eq!(picture_ext(&png), Some("png"));
        assert_eq!(picture_size(&png), Some((1920, 1080)));
        assert_eq!(picture_ext(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("jpg"));
        assert_eq!(picture_ext(b"GIF89a.."), Some("gif"));
        assert_eq!(picture_ext(b"RIFF\0\0\0\0WEBPVP8 "), Some("webp"));
        assert_eq!(picture_ext(b"<svg"), None);
    }

    #[test]
    fn dib_becomes_a_bmp_file() {
        // 40-byte header, 2×1, 32 bpp, BI_RGB.
        let mut dib = vec![0u8; 40 + 8];
        dib[0] = 40;
        dib[4] = 2;
        dib[8] = 1;
        dib[12] = 1;
        dib[14] = 32;
        let bmp = dib_to_bmp(&dib);
        assert_eq!(&bmp[..2], b"BM");
        assert_eq!(u32::from_le_bytes(bmp[2..6].try_into().unwrap()), 14 + 48);
        assert_eq!(u32::from_le_bytes(bmp[10..14].try_into().unwrap()), 54);
        assert_eq!(picture_size(&bmp), Some((2, 1)));
    }

    #[test]
    fn frames_file_survives_round_trip_and_old_versions() {
        let f = FramesFile { hotkey: "Alt+X".into(), frames: vec![Frame { id: "a".into(), view: serde_json::json!({"z": 2}), ..Default::default() }] };
        let s = serde_json::to_string(&f).unwrap();
        let back: FramesFile = serde_json::from_str(&s).unwrap();
        assert_eq!(back.frames[0], f.frames[0]);
        let old: FramesFile = serde_json::from_str(r#"{"frames":[{"id":"b"}]}"#).unwrap();
        assert_eq!(old.hotkey, DEFAULT_HOTKEY);
        assert_eq!(old.frames[0].opacity, 1.0);
        assert!(old.frames[0].on_top);
    }
}
