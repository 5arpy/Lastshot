//! Pop-out frames: a picture, a clip frame, a playing clip, a reference board
//! or a live view in a borderless window of its own, to keep on top of
//! another app (trace in a drawing app, pose in Blender, watch a tutorial).
//!
//! - Each frame is a WebView window labelled `frame-<id>` that loads the same
//!   frontend (one shared WebView2 environment, so one browser process).
//! - Its place, size and settings live in `%APPDATA%\Lastshot\frames.json`;
//!   pictures that came from the clipboard, a snip or a drop are kept in
//!   `%APPDATA%\Lastshot\frames\` (a frame's own folder of pictures in
//!   `frames\<id>\`).
//! - Closing never loses those files: a frame that owns files goes to
//!   `frames\trash\` for 7 days and can be reopened from the Pop-outs panel
//!   ("Recently closed"). A frame holding things the user put in it (a board's
//!   pictures) asks before it closes.
//! - "Click-through" makes Windows send every mouse click to the app below
//!   (WS_EX_TRANSPARENT | WS_EX_LAYERED via Tauri). The frame can then only be
//!   reached from Lastshot: the Pop-outs panel, the tray menu and a global
//!   shortcut that flips click-through for every frame.
//! - Picture and clip frames never take the keyboard focus, not even when
//!   clicked. Frames made for typing (a Pro reference board) take it only
//!   when clicked.
//!
//! Also here: "copy this frame" / "save this frame" for the viewer.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use crate::commands::AppState;

pub const LABEL_PREFIX: &str = "frame-";
/// Every window hears the full frame list whenever it changes.
pub const EVT_FRAMES: &str = "lastshot://frames";
/// Asks the main window to open its Pop-outs panel.
pub const EVT_PANEL: &str = "lastshot://frames-panel";
/// A note for the Pop-outs panel (e.g. "boards with pictures were kept open").
pub const EVT_NOTICE: &str = "lastshot://frames-notice";
/// Sent to one frame window: the user asked to close it (Alt+F4) and it holds
/// things, so the frame asks first.
pub const EVT_ASK_CLOSE: &str = "lastshot://frame-ask-close";
/// Closed frames that owned files stay in `frames\trash\` this long.
pub const TRASH_DAYS: i64 = 7;
/// Files a frame may show from disk.
pub const PICTURE_EXTS: [&str; 6] = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];
pub const VIDEO_EXTS: [&str; 6] = ["mp4", "m4v", "mov", "mkv", "webm", "avi"];
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
    /// Only shown while one of these apps (exe names, e.g. "blender.exe") or
    /// Lastshot is in front; empty = over every app. Older files had one
    /// `onlyWith` string; it is read as a one-app list.
    #[serde(alias = "onlyWith", deserialize_with = "de_apps")]
    pub show_over: Vec<String>,
    /// The frame's own view and settings (zoom, colour, crop, video, board
    /// items…), owned by the frontend.
    pub view: serde_json::Value,
    /// `src` was written by Lastshot into the frames folder.
    pub owned: bool,
    pub created_ms: i64,
    /// How many things the user put in this frame (a board's pictures), as
    /// its page reports them; None = never reported (then the files in the
    /// frame's own folder count). A frame holding things asks before closing.
    pub items: Option<u32>,
    /// Short flags about the view that the Pop-outs panel shows ("gray",
    /// "grid", "flipH", …), set by the frame's page. The view itself is not
    /// sent to every window.
    pub badges: Vec<String>,
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
            show_over: Vec::new(),
            view: serde_json::Value::Null,
            owned: false,
            created_ms: 0,
            items: None,
            badges: Vec::new(),
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
    #[serde(default, alias = "onlyWith", deserialize_with = "de_apps_opt")]
    pub show_over: Option<Vec<String>>,
    pub items: Option<u32>,
    pub badges: Option<Vec<String>>,
}

impl Frame {
    /// A copy with `view` left out (Null).
    pub fn clone_without_view(&self) -> Frame {
        Frame {
            id: self.id.clone(),
            kind: self.kind.clone(),
            src: self.src.clone(),
            title: self.title.clone(),
            x: self.x,
            y: self.y,
            w: self.w,
            h: self.h,
            opacity: self.opacity,
            on_top: self.on_top,
            click_through: self.click_through,
            hidden: self.hidden,
            show_over: self.show_over.clone(),
            view: serde_json::Value::Null,
            owned: self.owned,
            created_ms: self.created_ms,
            items: self.items,
            badges: self.badges.clone(),
        }
    }

    /// Equal in everything but `view` (what every window hears about).
    pub fn same_outside_view(&self, o: &Frame) -> bool {
        self.id == o.id
            && self.kind == o.kind
            && self.src == o.src
            && self.title == o.title
            && (self.x, self.y, self.w, self.h) == (o.x, o.y, o.w, o.h)
            && self.opacity == o.opacity
            && (self.on_top, self.click_through, self.hidden) == (o.on_top, o.click_through, o.hidden)
            && self.show_over == o.show_over
            && self.owned == o.owned
            && self.items == o.items
            && self.badges == o.badges
    }

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
        if let Some(o) = &p.show_over {
            let o = norm_apps(o.iter().map(String::as_str));
            shown |= o != self.show_over;
            self.show_over = o;
        }
        if let Some(n) = p.items {
            self.items = Some(n);
        }
        if let Some(b) = &p.badges {
            self.badges = b.iter().take(8).map(|s| s.chars().take(16).collect()).collect();
        }
        (top, through, shown)
    }
}

/// At most this many apps per frame.
pub const MAX_SHOW_OVER: usize = 32;

/// One app as stored: the exe's file name ("blender.exe"), as typed but
/// trimmed; a name without ".exe" gets it. None for nothing usable.
pub fn norm_app(a: &str) -> Option<String> {
    let name = a.trim().rsplit(['\\', '/']).next().unwrap_or("").trim();
    if name.is_empty() || name.len() > 80 || name.chars().any(|c| c.is_control() || "<>:\"|?*".contains(c)) {
        return None;
    }
    if name.to_ascii_lowercase().ends_with(".exe") {
        Some(name.to_string())
    } else {
        Some(format!("{name}.exe"))
    }
}

/// A clean app list: usable names, no repeats (any case), at most [`MAX_SHOW_OVER`].
pub fn norm_apps<'a>(list: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for a in list {
        if let Some(n) = norm_app(a) {
            if out.len() < MAX_SHOW_OVER && !out.iter().any(|o| o.eq_ignore_ascii_case(&n)) {
                out.push(n);
            }
        }
    }
    out
}

/// The app list from a file or a patch: a list, the old single string
/// ("" = every app), or anything else (= every app, never a failed load).
fn apps_from(v: serde_json::Value) -> Vec<String> {
    match v {
        serde_json::Value::String(s) => norm_apps([s.as_str()]),
        serde_json::Value::Array(a) => norm_apps(a.iter().filter_map(|x| x.as_str())),
        _ => Vec::new(),
    }
}

fn de_apps<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    Ok(apps_from(serde_json::Value::deserialize(d)?))
}

fn de_apps_opt<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Vec<String>>, D::Error> {
    Ok(Some(apps_from(serde_json::Value::deserialize(d)?)))
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

static STORE: OnceLock<Mutex<Store>> = OnceLock::new();

fn store() -> &'static Mutex<Store> {
    STORE.get_or_init(|| Mutex::new(Store { file: load(), dirty: false }))
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
    // One writer at a time: the delayed save and `flush` at quit share the
    // temporary file, and the newest snapshot must be the last one written.
    static SAVING: Mutex<()> = Mutex::new(());
    let _one = SAVING.lock();
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

/// Saves pending changes now (Lastshot is quitting).
pub fn flush() {
    if STORE.get().is_some_and(|s| s.lock().dirty) {
        save_now();
    }
}

fn all() -> Vec<Frame> {
    store().lock().file.frames.clone()
}

/// Every frame without its `view` (a board's view holds its whole picture
/// list): what every window hears when something changes.
fn infos() -> Vec<Frame> {
    store().lock().file.frames.iter().map(Frame::clone_without_view).collect()
}

#[cfg_attr(not(feature = "pro-board"), allow(dead_code))]
pub(crate) fn get(id: &str) -> Option<Frame> {
    store().lock().file.frames.iter().find(|f| f.id == id).cloned()
}

fn announce(app: &AppHandle) {
    let _ = app.emit(EVT_FRAMES, infos());
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

/// Shows a window without activating it. Frames are built with
/// `focused(false)`, which makes tao show them with SW_SHOWNOACTIVATE every
/// time; going through tao also keeps its idea of "visible" right (a raw
/// ShowWindow would be undone by tao's next style change).
fn show_quietly(win: &WebviewWindow) {
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

/// Click-through on or off. Runs on the main thread so the window style is
/// in place before `keep_visible` looks at it.
fn set_click_through(app: &AppHandle, win: &WebviewWindow, on: bool) {
    let w = win.clone();
    let _ = app.run_on_main_thread(move || {
        let _ = w.set_ignore_cursor_events(on);
        keep_visible(&w);
    });
}

/// Click-through makes the window WS_EX_TRANSPARENT | WS_EX_LAYERED (tao).
/// A layered window that was never given its alpha is not drawn at all, so
/// give it full alpha: the picture's own opacity is drawn by the page.
fn keep_visible(win: &WebviewWindow) {
    #[cfg(windows)]
    if let Ok(hwnd) = win.hwnd() {
        use windows::Win32::Foundation::{COLORREF, HWND};
        use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, SetLayeredWindowAttributes, GWL_EXSTYLE, LWA_ALPHA, WS_EX_LAYERED};
        let h = HWND(hwnd.0 as _);
        unsafe {
            if GetWindowLongPtrW(h, GWL_EXSTYLE) as u32 & WS_EX_LAYERED.0 != 0 {
                let _ = SetLayeredWindowAttributes(h, COLORREF(0), 255, LWA_ALPHA);
            }
        }
    }
    #[cfg(not(windows))]
    let _ = win;
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
        // Never takes the keyboard focus, not even when clicked: Blender (or
        // whatever is traced in) keeps it.
        .focusable(false)
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
    crate::pro_board::on_window(&win, f);
    if f.click_through {
        let _ = win.set_ignore_cursor_events(true);
        keep_visible(&win);
    }
    if !f.hidden && over_its_app(f) {
        show_quietly(&win);
    }
    start_follow(app);
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
    let (w, h) = match at {
        // Pinned where it was snipped: its own size, as long as it fits.
        Some(_) => fit_size(nw, nh, aw, ah, 60),
        None => fit_size(nw, nh, (aw as f64 * 0.45) as u32, (ah as f64 * 0.55) as u32, 160),
    };
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
    write_atomic(&p, bytes).map_err(|e| e.to_string())?;
    Ok(p)
}

/// Writes `<path>.tmp`, then renames it over `path`: a crash or a full disk
/// never leaves a cut-off file under the real name.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    let r = std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, path));
    if r.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    r
}

fn has_ext(p: &Path, exts: &[&str]) -> bool {
    p.extension().and_then(|e| e.to_str()).is_some_and(|e| exts.iter().any(|x| x.eq_ignore_ascii_case(e)))
}

/// A picture file by name and by its first bytes.
pub(crate) fn is_picture_file(p: &Path) -> bool {
    use std::io::Read;
    if !has_ext(p, &PICTURE_EXTS) {
        return false;
    }
    let mut head = [0u8; 16];
    let n = std::fs::File::open(p).and_then(|mut f| f.read(&mut head)).unwrap_or(0);
    picture_ext(&head[..n]).is_some()
}

pub(crate) fn is_video_file(p: &Path) -> bool {
    has_ext(p, &VIDEO_EXTS)
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
            let path = Path::new(p);
            if !path.is_file() {
                return Err("That file is not there any more.".into());
            }
            // Only pictures and clips: opening a file also lets the webview read it.
            let ok = match kind.as_str() {
                "image" => {
                    let p2 = path.to_path_buf();
                    tauri::async_runtime::spawn_blocking(move || is_picture_file(&p2)).await.unwrap_or(false)
                }
                "video" => is_video_file(path),
                _ => false,
            };
            if !ok {
                return Err(if kind == "video" {
                    "That is not a clip Lastshot can play (MP4, M4V, MOV, MKV, WebM, AVI).".into()
                } else {
                    "That is not a picture Lastshot can show (PNG, JPG, GIF, WebP, BMP).".into()
                });
            }
            (p.clone(), false)
        }
        (None, None) if kind == "board" || kind == "live" => (String::new(), false),
        _ => return Err("Nothing to show".into()),
    };
    if !src.is_empty() {
        allow_file(&app, &src);
    }
    let from_file = if req.width.is_none() && kind == "image" && !src.is_empty() { file_picture_size(&src) } else { None };
    let (nw, nh) = match from_file {
        Some((w, h)) => (w.max(1), h.max(1)),
        None => (req.width.unwrap_or(800).max(1), req.height.unwrap_or(600).max(1)),
    };
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
    if let Err(e) = show_window(&app, &f).await {
        // No frame without a window, and no picture without a frame.
        store().lock().file.frames.retain(|x| x.id != f.id);
        if f.owned && is_ours(Path::new(&f.src)) {
            let _ = std::fs::remove_file(&f.src);
        }
        return Err(e);
    }
    save_soon();
    announce(&app);
    Ok(f)
}

/// Builds a frame's window on the main thread and waits for it (10 s at
/// most). On a timeout the window is never left behind: if it is still being
/// built, it is destroyed as soon as it exists.
async fn show_window(app: &AppHandle, f: &Frame) -> Result<(), String> {
    // 0 = waiting, 1 = the caller gave up, 2 = built and reported.
    let state = Arc::new(Mutex::new(0u8));
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let (app2, f2, st2) = (app.clone(), f.clone(), state.clone());
    app.run_on_main_thread(move || {
        if *st2.lock() == 1 {
            return;
        }
        let r = build_window(&app2, &f2);
        let mut s = st2.lock();
        if *s == 1 {
            if let Ok(w) = r {
                let _ = w.destroy();
            }
            return;
        }
        *s = 2;
        let _ = tx.send(r.map(|_| ()));
    })
    .map_err(|e| e.to_string())?;
    let mut rx = rx;
    match tokio::time::timeout(std::time::Duration::from_secs(10), &mut rx).await {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => Err("The frame's window could not be made.".into()),
        Err(_) => {
            let mut s = state.lock();
            if *s == 2 {
                // Built at the very last moment.
                return rx.try_recv().unwrap_or_else(|_| Err("The frame's window could not be made.".into()));
            }
            *s = 1;
            drop(s);
            if let Some(w) = window(app, &f.id) {
                let _ = w.destroy();
            }
            Err("The frame's window took too long to open. Try again.".into())
        }
    }
}

#[tauri::command]
pub fn frame_list() -> Vec<Frame> {
    all()
}

/// Changes a frame's settings or view. Async (off the UI thread); every
/// window hears about it unless only the view changed, and never gets views.
#[tauri::command]
pub async fn frame_update(app: AppHandle, id: String, patch: FramePatch) -> Result<Frame, String> {
    let (f, visible) = update(&app, &id, &patch)?;
    if visible {
        announce(&app);
    }
    Ok(f)
}

/// Applies a patch and its window effects; returns the frame (without its
/// view) and whether anything other windows show changed.
fn update(app: &AppHandle, id: &str, patch: &FramePatch) -> Result<(Frame, bool), String> {
    let (f, (top, through, shown), visible) = {
        let mut s = store().lock();
        let f = s.file.frames.iter_mut().find(|f| f.id == id).ok_or("That frame is closed")?;
        let before = f.clone_without_view();
        let changed = f.apply(patch);
        let visible = !before.same_outside_view(f);
        (f.clone_without_view(), changed, visible)
    };
    save_soon();
    if let Some(win) = window(app, id) {
        if top {
            let _ = win.set_always_on_top(f.on_top);
        }
        if through {
            set_click_through(app, &win, f.click_through);
        }
        if shown {
            if f.hidden || !over_its_app(&f) {
                let _ = win.hide();
            } else {
                show_quietly(&win);
            }
        }
    }
    if patch.show_over.is_some() {
        start_follow(app);
    }
    Ok((f, visible))
}

/// The cursor in physical screen pixels: frames move with it while dragged,
/// which stays right across monitors with different scaling.
#[tauri::command]
pub fn frame_cursor(app: AppHandle) -> Result<(f64, f64), String> {
    let p = app.cursor_position().map_err(|e| e.to_string())?;
    Ok((p.x, p.y))
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

/// Closes a frame. A frame that holds things the user put in it (a board
/// with pictures) is only closed with `force` (after the user said yes);
/// otherwise it stays open and this returns false. Files the frame owns go to
/// the trash (Recently closed, 7 days), never straight to deletion.
#[tauri::command]
pub async fn frame_close(app: AppHandle, id: String, force: Option<bool>) -> Result<bool, String> {
    if let Some(f) = get(&id) {
        if !force.unwrap_or(false) && holds(&f) > 0 {
            return Ok(false);
        }
    }
    close_now(&app, &id).await;
    Ok(true)
}

async fn close_now(app: &AppHandle, id: &str) {
    if let Some(w) = window(app, id) {
        let _ = w.destroy();
    }
    if let Some(f) = forget(app, id) {
        let app = app.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || put_away(&app, f)).await;
    }
}

/// How many things the frame holds: what its page reported, or (never
/// reported) the files in its own folder.
pub fn holds(f: &Frame) -> u32 {
    holds_in(&pictures_dir(), f)
}

fn holds_in(root: &Path, f: &Frame) -> u32 {
    f.items.unwrap_or_else(|| count_files(&root.join(&f.id)))
}

fn count_files(dir: &Path) -> u32 {
    std::fs::read_dir(dir)
        .map(|rd| rd.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_file())).count() as u32)
        .unwrap_or(0)
}

/// Takes a frame out of the list (its files are still where they were).
fn forget(app: &AppHandle, id: &str) -> Option<Frame> {
    let f = {
        let mut s = store().lock();
        let i = s.file.frames.iter().position(|f| f.id == id);
        i.map(|i| s.file.frames.remove(i))
    };
    if f.is_some() {
        save_soon();
        announce(app);
    }
    f
}

/// File work after a frame closed (blocking): its files go to the trash.
fn put_away(app: &AppHandle, f: Frame) {
    // Pictures a board no longer uses are not kept.
    #[cfg(feature = "pro-board")]
    crate::pro_board::before_trash(&f);
    let root = pictures_dir();
    let now = chrono::Utc::now().timestamp_millis();
    if let Err(e) = trash_in(&root, &f, now) {
        log::warn!("[frames] could not move {} to the trash: {e}", f.id);
    }
    purge_in(&root, now);
    // The Pop-outs panel's "Recently closed" list changed.
    announce(app);
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseAll {
    pub closed: u32,
    /// Frames that hold things and were left open (no `force`).
    pub kept: u32,
}

/// Closes every frame; with `force` also those that hold things (the user
/// said yes once), otherwise those stay open.
#[tauri::command]
pub async fn frame_close_all(app: AppHandle, force: Option<bool>) -> CloseAll {
    let mut r = CloseAll::default();
    for f in all() {
        if !force.unwrap_or(false) && holds(&f) > 0 {
            r.kept += 1;
            continue;
        }
        close_now(&app, &f.id).await;
        r.closed += 1;
    }
    r
}

// ---------------------------------------------------------------------------
// Trash: frames\trash\<key>\closed.json plus the files the frame owned
// (`dir` = its own folder, or its picture under its own name).
// ---------------------------------------------------------------------------

const TRASH: &str = "trash";
const CLOSED_JSON: &str = "closed.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Moved {
    /// Where it was (inside the frames folder).
    from: String,
    /// Its name inside the trash entry.
    to: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClosedRecord {
    frame: Frame,
    closed_ms: i64,
    moved: Vec<Moved>,
}

/// A closed frame that can be reopened (the Pop-outs panel's list).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClosedFrame {
    pub key: String,
    pub id: String,
    pub kind: String,
    pub title: String,
    pub closed_ms: i64,
    /// Pictures it held.
    pub pictures: u32,
}

pub fn expired(closed_ms: i64, now_ms: i64) -> bool {
    now_ms - closed_ms > TRASH_DAYS * 24 * 3600 * 1000
}

/// A trash key names a folder: the frame id, maybe `-<ms>`.
fn valid_key(k: &str) -> bool {
    !k.is_empty() && k.len() <= 64 && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn move_path(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut last = Ok(());
    for i in 0..3 {
        if i > 0 {
            std::thread::sleep(std::time::Duration::from_millis(150));
        }
        last = std::fs::rename(from, to);
        if last.is_ok() {
            break;
        }
    }
    last
}

/// Moves what a closed frame owned into the trash. Returns the entry's key,
/// or None when it owned nothing (an empty own folder is just removed).
fn trash_in(root: &Path, f: &Frame, now_ms: i64) -> std::io::Result<Option<String>> {
    let own_dir = root.join(&f.id);
    let src = Path::new(&f.src);
    let owned_src = f.owned && src.parent() == Some(root) && src.is_file();
    let has_dir = own_dir.is_dir() && std::fs::read_dir(&own_dir).map(|mut r| r.next().is_some()).unwrap_or(false);
    if !owned_src && !has_dir {
        if own_dir.is_dir() && valid_key(&f.id) {
            let _ = std::fs::remove_dir(&own_dir);
        }
        return Ok(None);
    }
    if !valid_key(&f.id) {
        return Err(std::io::Error::other("bad frame id"));
    }
    let trash = root.join(TRASH);
    let mut key = f.id.clone();
    if trash.join(&key).exists() {
        key = format!("{}-{now_ms}", f.id);
    }
    let entry = trash.join(&key);
    std::fs::create_dir_all(&entry)?;
    let mut moved = Vec::new();
    if has_dir {
        moved.push(Moved { from: own_dir.to_string_lossy().into(), to: "dir".into() });
    }
    if owned_src {
        let name = src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "picture".into());
        moved.push(Moved { from: f.src.clone(), to: name });
    }
    // The record first: if a move fails, the files left behind are still
    // where the record says they came from.
    let rec = ClosedRecord { frame: f.clone(), closed_ms: now_ms, moved };
    write_atomic(&entry.join(CLOSED_JSON), &serde_json::to_vec_pretty(&rec).map_err(std::io::Error::other)?)?;
    for m in &rec.moved {
        move_path(Path::new(&m.from), &entry.join(&m.to))?;
    }
    Ok(Some(key))
}

fn read_closed(root: &Path, key: &str) -> Option<ClosedRecord> {
    if !valid_key(key) {
        return None;
    }
    let s = std::fs::read(root.join(TRASH).join(key).join(CLOSED_JSON)).ok()?;
    serde_json::from_slice(&s).ok()
}

/// Recently closed frames, newest first.
fn closed_in(root: &Path, now_ms: i64) -> Vec<ClosedFrame> {
    let Ok(rd) = std::fs::read_dir(root.join(TRASH)) else { return Vec::new() };
    let mut v: Vec<ClosedFrame> = rd
        .flatten()
        .filter_map(|e| {
            let key = e.file_name().to_string_lossy().to_string();
            let r = read_closed(root, &key)?;
            if expired(r.closed_ms, now_ms) {
                return None;
            }
            let entry = root.join(TRASH).join(&key);
            let files = count_files(&entry.join("dir")) + r.moved.iter().filter(|m| m.to != "dir").count() as u32;
            Some(ClosedFrame {
                key,
                id: r.frame.id.clone(),
                kind: r.frame.kind.clone(),
                title: r.frame.title.clone(),
                closed_ms: r.closed_ms,
                pictures: r.frame.items.unwrap_or(files),
            })
        })
        .collect();
    v.sort_by_key(|c| std::cmp::Reverse(c.closed_ms));
    v
}

/// Puts a closed frame's files back where they were and drops its entry.
fn restore_in(root: &Path, key: &str) -> Result<Frame, String> {
    let rec = read_closed(root, key).ok_or("That closed frame is gone (closed frames are kept for 7 days).")?;
    let entry = root.join(TRASH).join(key);
    for m in &rec.moved {
        let from = PathBuf::from(&m.from);
        // Only back into the frames folder itself.
        if from.parent() != Some(root) || m.to.contains(['/', '\\']) || m.to == ".." {
            return Err("That closed frame's record is damaged.".into());
        }
        let here = entry.join(&m.to);
        if !here.exists() {
            continue; // never moved (the move failed): still where it was
        }
        if from.exists() {
            return Err(format!("{} is in the way.", from.display()));
        }
        move_path(&here, &from).map_err(|e| format!("Could not put back {}: {e}", from.display()))?;
    }
    let _ = std::fs::remove_dir_all(&entry);
    Ok(rec.frame)
}

/// Deletes trash entries older than 7 days.
fn purge_in(root: &Path, now_ms: i64) {
    let Ok(rd) = std::fs::read_dir(root.join(TRASH)) else { return };
    for e in rd.flatten() {
        let key = e.file_name().to_string_lossy().to_string();
        let closed = read_closed(root, &key).map(|r| r.closed_ms).or_else(|| {
            let t = e.metadata().ok()?.modified().ok()?;
            Some(chrono::DateTime::<chrono::Utc>::from(t).timestamp_millis())
        });
        if closed.is_some_and(|c| expired(c, now_ms)) && e.file_type().is_ok_and(|t| t.is_dir()) {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

#[tauri::command]
pub async fn frame_closed() -> Vec<ClosedFrame> {
    tauri::async_runtime::spawn_blocking(|| closed_in(&pictures_dir(), chrono::Utc::now().timestamp_millis()))
        .await
        .unwrap_or_default()
}

/// Reopens a recently closed frame with its files.
#[tauri::command]
pub async fn frame_reopen(app: AppHandle, key: String) -> Result<Frame, String> {
    let root = pictures_dir();
    let rec = read_closed(&root, &key).ok_or("That closed frame is gone (closed frames are kept for 7 days).")?;
    if get(&rec.frame.id).is_some() {
        return Err("That frame is already open.".into());
    }
    let r2 = root.clone();
    let mut f = tauri::async_runtime::spawn_blocking(move || restore_in(&r2, &key)).await.map_err(|e| e.to_string())??;
    f.click_through = false;
    f.hidden = false;
    if test_instance() || !on_some_screen(f.x, f.y, f.w, &screens(&app)) {
        (f.x, f.y, f.w, f.h) = initial_rect(&app, f.w, f.h, None);
    }
    if !f.src.is_empty() {
        allow_file(&app, &f.src);
    }
    store().lock().file.frames.push(f.clone());
    if let Err(e) = show_window(&app, &f).await {
        // Back to the trash, as it was.
        forget(&app, &f.id);
        let (app2, f2) = (app.clone(), f.clone());
        let _ = tauri::async_runtime::spawn_blocking(move || put_away(&app2, f2)).await;
        return Err(e);
    }
    save_soon();
    announce(&app);
    Ok(f)
}

/// Click-through for every frame: `on`, or flip (all on unless all are on).
#[tauri::command]
pub fn frame_click_through_all(app: AppHandle, on: Option<bool>) -> bool {
    let frames = all();
    let target = on.unwrap_or_else(|| toggle_target(&frames));
    for f in frames {
        let _ = update(&app, &f.id, &FramePatch { click_through: Some(target), ..Default::default() });
    }
    announce(&app);
    target
}

/// Hides or shows every frame.
#[tauri::command]
pub fn frame_hide_all(app: AppHandle, hidden: Option<bool>) -> bool {
    let frames = all();
    let target = hidden.unwrap_or_else(|| !frames.iter().all(|f| f.hidden));
    for f in frames {
        let _ = update(&app, &f.id, &FramePatch { hidden: Some(target), ..Default::default() });
    }
    announce(&app);
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
    /// The cursor, physical px (where a drag starts).
    pub cursor: Option<(f64, f64)>,
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
    let cursor = app.cursor_position().ok().map(|p| (p.x, p.y));
    Layout { screens: screens(&app), frames, me, scale, cursor }
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
    if !hotkey.is_empty() {
        crate::hotkeys::validate(&hotkey)?;
        if let Some(other) = crate::hotkeys::used_by(&app, &hotkey, "frames") {
            return Err(format!("'{hotkey}' is already the shortcut for {other}"));
        }
    }
    // Kept working by the shortcut guard (retries, self-check); never in
    // test copies.
    if let Err(e) = crate::hotkey_guard::set(&app, "frames", &hotkey) {
        log::warn!("[frames] shortcut {hotkey}: {e}");
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
    if b.len() >= 10 && (b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a")) {
        return Some((u16::from_le_bytes([b[6], b[7]]) as u32, u16::from_le_bytes([b[8], b[9]]) as u32));
    }
    if b.starts_with(&[0xFF, 0xD8]) {
        return jpeg_size(b);
    }
    if b.len() >= 30 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        return match &b[12..16] {
            b"VP8X" => Some((u32::from_le_bytes([b[24], b[25], b[26], 0]) + 1, u32::from_le_bytes([b[27], b[28], b[29], 0]) + 1)),
            b"VP8L" => {
                let v = u32::from_le_bytes([b[21], b[22], b[23], b[24]]);
                Some(((v & 0x3FFF) + 1, ((v >> 14) & 0x3FFF) + 1))
            }
            b"VP8 " => Some((u16::from_le_bytes([b[26], b[27]]) as u32 & 0x3FFF, u16::from_le_bytes([b[28], b[29]]) as u32 & 0x3FFF)),
            _ => None,
        };
    }
    None
}

/// Width and height from a JPEG's first frame header (SOF0-SOF15).
fn jpeg_size(b: &[u8]) -> Option<(u32, u32)> {
    let mut i = 2;
    while i + 9 < b.len() {
        if b[i] != 0xFF {
            i += 1;
            continue;
        }
        let m = b[i + 1];
        if m == 0xFF {
            i += 1;
            continue;
        }
        if m == 0x01 || (0xD0..=0xD9).contains(&m) {
            i += 2;
            continue;
        }
        let len = u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize;
        if (0xC0..=0xCF).contains(&m) && m != 0xC4 && m != 0xC8 && m != 0xCC {
            let h = u16::from_be_bytes([b[i + 5], b[i + 6]]) as u32;
            let w = u16::from_be_bytes([b[i + 7], b[i + 8]]) as u32;
            return (w > 0 && h > 0).then_some((w, h));
        }
        i += 2 + len;
    }
    None
}

/// A picture file's size from its first 256 KB (EXIF can push the JPEG header).
fn file_picture_size(path: &str) -> Option<(u32, u32)> {
    use std::io::Read;
    let mut buf = Vec::new();
    std::fs::File::open(path).ok()?.take(256 * 1024).read_to_end(&mut buf).ok()?;
    picture_size(&buf)
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
// "Only over one app": the frame shows while that app (or Lastshot) is in
// front and hides when anything else is, so a tracing frame never covers
// the browser or a game.
// Full screen: while another app fills a monitor (a game, a video), frames
// on that monitor hide unless they follow that app, so they never cover a
// game or knock it out of independent flip.
// A light thread (5 checks a second, a few window queries each) runs only
// while a frame is open.
// ---------------------------------------------------------------------------

static FRONT: Mutex<Option<String>> = Mutex::new(None);
/// The monitor (left, top, right, bottom) another app fills, if any.
static FULLSCREEN: Mutex<Option<(i32, i32, i32, i32)>> = Mutex::new(None);

/// The monitor a window of another app in front fills in real full screen,
/// if it does.
#[cfg(windows)]
fn fullscreen_front() -> Option<(i32, i32, i32, i32)> {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONULL};
    use windows::Win32::UI::Shell::{SHQueryUserNotificationState, QUNS_RUNNING_D3D_FULL_SCREEN};
    use windows::Win32::UI::WindowsAndMessaging::{GetClassNameW, GetForegroundWindow, GetWindowLongW, GetWindowRect, IsZoomed, GWL_STYLE};
    unsafe {
        let h = GetForegroundWindow();
        if h.is_invalid() || crate::appname::foreground_pid() == Some(std::process::id()) {
            return None;
        }
        let mut cls = [0u16; 64];
        let n = GetClassNameW(h, &mut cls).max(0) as usize;
        if is_shell_class(&String::from_utf16_lossy(&cls[..n])) {
            return None;
        }
        let mut r = RECT::default();
        GetWindowRect(h, &mut r).ok()?;
        let mon = MonitorFromWindow(h, MONITOR_DEFAULTTONULL);
        if mon.is_invalid() {
            return None;
        }
        let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(mon, &mut mi).as_bool() {
            return None;
        }
        let m = mi.rcMonitor;
        let m = (m.left, m.top, m.right, m.bottom);
        let d3d = SHQueryUserNotificationState().is_ok_and(|s| s == QUNS_RUNNING_D3D_FULL_SCREEN);
        let win = TopWindow {
            style: GetWindowLongW(h, GWL_STYLE) as u32,
            zoomed: IsZoomed(h).as_bool(),
            rect: (r.left, r.top, r.right, r.bottom),
        };
        is_full_screen(&win, m, d3d).then_some(m)
    }
}

#[cfg(not(windows))]
fn fullscreen_front() -> Option<(i32, i32, i32, i32)> {
    None
}

/// Shell windows that cover a screen but are not apps: the desktop, the
/// taskbars, Alt+Tab, Task View, Start and search.
pub fn is_shell_class(class: &str) -> bool {
    matches!(
        class,
        "Progman"
            | "WorkerW"
            | "Shell_TrayWnd"
            | "Shell_SecondaryTrayWnd"
            | "MultitaskingViewFrame"
            | "XamlExplorerHostIslandWindow"
            | "TaskSwitcherWnd"
            | "ForegroundStaging"
            | "Windows.UI.Core.CoreWindow"
            | "TopLevelWindowForOverflowXamlIsland"
            | "NotifyIconOverflowWindow"
    )
}

/// What [`is_full_screen`] looks at in the window in front.
#[derive(Debug, Clone, Copy)]
pub struct TopWindow {
    /// GWL_STYLE.
    pub style: u32,
    /// Maximised (IsZoomed).
    pub zoomed: bool,
    /// Outer rectangle: left, top, right, bottom.
    pub rect: (i32, i32, i32, i32),
}

const WS_CAPTION: u32 = 0x00C0_0000;
const WS_THICKFRAME: u32 = 0x0004_0000;

/// Real full screen only: Windows reports a Direct3D exclusive full-screen
/// app, or a borderless window (no caption, no sizing frame, not maximised)
/// fills its whole monitor. A maximised window never counts: its rectangle
/// spills past the monitor (the invisible borders) even when no taskbar
/// shows, and the user may want a frame over it (Blender, a drawing app).
pub fn is_full_screen(w: &TopWindow, monitor: (i32, i32, i32, i32), d3d_exclusive: bool) -> bool {
    if d3d_exclusive {
        return true;
    }
    if w.zoomed || w.style & WS_CAPTION == WS_CAPTION || w.style & WS_THICKFRAME != 0 {
        return false;
    }
    covers(w.rect, monitor)
}

fn covers(w: (i32, i32, i32, i32), m: (i32, i32, i32, i32)) -> bool {
    w.0 <= m.0 && w.1 <= m.1 && w.2 >= m.2 && w.3 >= m.3
}

/// Whether the frame should be on screen given the app in front and the
/// monitor a full-screen app fills.
pub fn may_show(f: &Frame, front: Option<&str>, fullscreen: Option<(i32, i32, i32, i32)>) -> bool {
    may_show_at(&f.show_over, (f.x, f.y, f.w, f.h), front, fullscreen)
}

/// With a list, the list decides (a chosen app in front, even full screen,
/// keeps the frame; any other app hides it). Without one, the frame shows
/// over every app except a full-screen one on its monitor.
fn may_show_at(show_over: &[String], (x, y, w, h): (i32, i32, u32, u32), front: Option<&str>, fullscreen: Option<(i32, i32, i32, i32)>) -> bool {
    if !show_over.is_empty() {
        return front_matches(show_over, front);
    }
    let Some(m) = fullscreen else { return true };
    let (l, t, r, b) = (x, y, x + w as i32, y + h as i32);
    // Hidden when it overlaps the full-screen monitor.
    !(l < m.2 && r > m.0 && t < m.3 && b > m.1)
}

/// True when the app in front is one this frame follows, or Lastshot itself
/// (always fine, so its own panels never hide the frames), or the list is empty.
pub fn front_matches(show_over: &[String], front: Option<&str>) -> bool {
    if show_over.is_empty() {
        return true;
    }
    match front {
        None => true, // unknown (desktop, lock screen): leave it as it is
        Some(e) => e.to_ascii_lowercase().starts_with("lastshot") || show_over.iter().any(|a| same_app(a, e)),
    }
}

/// Exe names compared without case and with or without ".exe".
fn same_app(a: &str, b: &str) -> bool {
    let strip = |s: &str| {
        let s = s.trim();
        if s.to_ascii_lowercase().ends_with(".exe") {
            s[..s.len() - 4].to_ascii_lowercase()
        } else {
            s.to_ascii_lowercase()
        }
    };
    strip(a) == strip(b)
}

fn over_its_app(f: &Frame) -> bool {
    let front = FRONT.lock().clone();
    let fs = *FULLSCREEN.lock();
    may_show(f, front.as_deref(), fs)
}

/// What the follow loop needs of a frame: id, hidden, show over, rectangle.
type Follower = (String, bool, Vec<String>, (i32, i32, u32, u32));

fn start_follow(app: &AppHandle) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static RUNNING: AtomicBool = AtomicBool::new(false);
    if RUNNING.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    let _ = std::thread::Builder::new().name("frames-follow".into()).spawn(move || {
        let mut last_pid = 0u32;
        let mut last_exe: Option<String> = None;
        let mut shown: std::collections::HashMap<String, bool> = Default::default();
        loop {
            // Only what this loop needs, five times a second (never the views).
            let users: Vec<Follower> = store()
                .lock()
                .file
                .frames
                .iter()
                .map(|f| (f.id.clone(), f.hidden, f.show_over.clone(), (f.x, f.y, f.w, f.h)))
                .collect();
            if users.is_empty() {
                RUNNING.store(false, Ordering::Release);
                *FULLSCREEN.lock() = None;
                // A frame may have opened meanwhile.
                if !store().lock().file.frames.is_empty() && !RUNNING.swap(true, Ordering::AcqRel) {
                    continue;
                }
                return;
            }
            if let Some(pid) = crate::appname::foreground_pid() {
                if pid != last_pid {
                    last_pid = pid;
                    let exe = if pid == std::process::id() { Some("lastshot.exe".to_string()) } else { crate::appname::snapshot_exe(pid) };
                    // Explorer (desktop, taskbar) and shell pop-ups keep the
                    // last real app, so clicking the taskbar does not flicker.
                    if let Some(e) = exe.filter(|e| e.eq_ignore_ascii_case("lastshot.exe") || !crate::appname::is_not_an_app(e)) {
                        last_exe = Some(e);
                    }
                }
            }
            *FRONT.lock() = last_exe.clone();
            let fs = fullscreen_front();
            *FULLSCREEN.lock() = fs;
            shown.retain(|id, _| users.iter().any(|u| &u.0 == id));
            for (id, hidden, show_over, rect) in users {
                let want = !hidden && may_show_at(&show_over, rect, last_exe.as_deref(), fs);
                if shown.get(&id) == Some(&want) {
                    continue;
                }
                shown.insert(id.clone(), want);
                if let Some(win) = window(&app, &id) {
                    let w2 = win.clone();
                    let _ = app.run_on_main_thread(move || {
                        if want {
                            show_quietly(&w2);
                        } else {
                            let _ = w2.hide();
                        }
                    });
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    });
}

// ---------------------------------------------------------------------------
// Start-up, window events, shortcut, tray
// ---------------------------------------------------------------------------

/// Called once from `setup`: lets the webview load frame pictures, registers
/// the click-through shortcut and reopens the frames that were open.
pub fn init(app: &AppHandle) {
    let _ = std::fs::create_dir_all(pictures_dir());
    let _ = app.asset_protocol_scope().allow_directory(pictures_dir(), true);
    // Closed frames older than 7 days leave the trash.
    std::thread::spawn(|| purge_in(&pictures_dir(), chrono::Utc::now().timestamp_millis()));
    let (hotkey, frames) = {
        let s = store().lock();
        (s.file.hotkey.clone(), s.file.frames.clone())
    };
    if !hotkey.is_empty() {
        if let Err(e) = crate::hotkey_guard::set(app, "frames", &hotkey) {
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
    if !keep.is_empty() {
        start_follow(app);
    }
    for f in keep {
        if let Err(e) = build_window(app, &f) {
            log::warn!("[frames] could not reopen {}: {e}", f.id);
        }
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
        tauri::WindowEvent::CloseRequested { api, .. } => {
            // Alt+F4 (the frame's own buttons call `frame_close`). A frame
            // holding things asks first, in its own window.
            let app = window.app_handle();
            if get(&id).is_some_and(|f| holds(&f) > 0) {
                api.prevent_close();
                let _ = window.emit_to(window.label(), EVT_ASK_CLOSE, ());
                return;
            }
            if let Some(f) = forget(app, &id) {
                let app = app.clone();
                std::thread::spawn(move || put_away(&app, f));
            }
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
        "frames:close" => {
            // No window to ask in: frames holding things (boards with
            // pictures) stay open, and the Pop-outs panel says so.
            tauri::async_runtime::spawn(async move {
                let r = frame_close_all(h.clone(), Some(false)).await;
                if r.kept > 0 {
                    show_panel(&h);
                    let msg = if r.kept == 1 {
                        "One frame with pictures was kept open. Close it here; it asks first.".to_string()
                    } else {
                        format!("{} frames with pictures were kept open. Close them here; each asks first.", r.kept)
                    };
                    let _ = h.emit(EVT_NOTICE, msg);
                }
            });
        }
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
    fn gif_jpeg_and_webp_sizes() {
        let gif = [b'G', b'I', b'F', b'8', b'9', b'a', 0x40, 0x01, 0xF0, 0x00];
        assert_eq!(picture_size(&gif), Some((320, 240)));
        // SOI, APP0 (len 16), SOF0 8-bit 300x200.
        let mut jpg = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
        jpg.extend_from_slice(&[0; 14]);
        jpg.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0xC8, 0x01, 0x2C, 0x03]);
        jpg.extend_from_slice(&[0; 12]);
        assert_eq!(picture_size(&jpg), Some((300, 200)));
        let mut webp = b"RIFF\0\0\0\0WEBPVP8X".to_vec();
        webp.extend_from_slice(&[0; 8]);
        webp.extend_from_slice(&[0x7F, 0x02, 0x00, 0xDF, 0x01, 0x00]);
        assert_eq!(picture_size(&webp), Some((640, 480)));
    }

    fn apps(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn shows_over_any_set_of_apps() {
        assert!(front_matches(&[], Some("chrome.exe")), "empty = every app");
        let one = apps(&["blender.exe"]);
        assert!(front_matches(&one, Some("Blender.exe")));
        assert!(front_matches(&one, Some("blender")), "with or without .exe");
        assert!(!front_matches(&one, Some("chrome.exe")));
        assert!(front_matches(&one, None));
        let many = apps(&["blender.exe", "krita.exe", "PureRef.exe"]);
        assert!(front_matches(&many, Some("krita.exe")));
        assert!(front_matches(&many, Some("pureref.exe")));
        assert!(!front_matches(&many, Some("blender-launcher.exe")), "whole names only");
        // Lastshot itself is always fine (its panels never hide the frames).
        assert!(front_matches(&many, Some("lastshot.exe")));
        assert!(front_matches(&many, Some("Lastshot_test_2026-11-16_pro.exe")));
    }

    #[test]
    fn app_lists_are_cleaned() {
        assert_eq!(norm_apps([" blender.exe ", "Blender.EXE", "krita", "", "  ", r"C:\Tools\PureRef.exe", "a<b"]), apps(&["blender.exe", "krita.exe", "PureRef.exe"]));
        let many: Vec<String> = (0..50).map(|i| format!("app{i}.exe")).collect();
        assert_eq!(norm_apps(many.iter().map(String::as_str)).len(), MAX_SHOW_OVER);
        let mut f = Frame::default();
        let (_, _, shown) = f.apply(&FramePatch { show_over: Some(apps(&[" blender.exe ", "krita"])), ..Default::default() });
        assert!(shown);
        assert_eq!(f.show_over, apps(&["blender.exe", "krita.exe"]));
        let (_, _, shown) = f.apply(&FramePatch { show_over: Some(apps(&["blender.exe", "krita.exe"])), ..Default::default() });
        assert!(!shown, "the same list changes nothing");
        let (_, _, shown) = f.apply(&FramePatch { show_over: Some(vec![]), ..Default::default() });
        assert!(shown && f.show_over.is_empty(), "back to every app");
    }

    #[test]
    fn old_files_with_one_app_still_load() {
        let old: FramesFile = serde_json::from_str(
            r#"{"frames":[{"id":"a","onlyWith":"blender.exe"},{"id":"b","onlyWith":""},{"id":"c"},{"id":"d","onlyWith":null}]}"#,
        )
        .unwrap();
        let lists: Vec<&[String]> = old.frames.iter().map(|f| f.show_over.as_slice()).collect();
        assert_eq!(lists, vec![&apps(&["blender.exe"])[..], &[][..], &[][..], &[][..]]);
        // Written back as the new list (and read back the same).
        let s = serde_json::to_string(&old).unwrap();
        assert!(s.contains(r#""showOver":["blender.exe"]"#) && !s.contains("onlyWith"), "{s}");
        let back: FramesFile = serde_json::from_str(&s).unwrap();
        assert_eq!(back.frames[0].show_over, apps(&["blender.exe"]));
        // A broken list never loses the frames.
        let odd: FramesFile = serde_json::from_str(r#"{"frames":[{"id":"e","showOver":[1,"krita.exe",{"x":1}]},{"id":"f","showOver":7}]}"#).unwrap();
        assert_eq!(odd.frames[0].show_over, apps(&["krita.exe"]));
        assert!(odd.frames[1].show_over.is_empty());
        // Patches from an older page still work.
        let p: FramePatch = serde_json::from_str(r#"{"onlyWith":"blender.exe"}"#).unwrap();
        assert_eq!(p.show_over, Some(apps(&["blender.exe"])));
        let p: FramePatch = serde_json::from_str(r#"{"showOver":["a.exe","b.exe"]}"#).unwrap();
        assert_eq!(p.show_over, Some(apps(&["a.exe", "b.exe"])));
        let p: FramePatch = serde_json::from_str(r#"{"opacity":0.5}"#).unwrap();
        assert_eq!(p.show_over, None);
    }

    #[test]
    fn hides_over_a_full_screen_app_unless_it_follows_it() {
        let f = Frame { x: 100, y: 100, w: 400, h: 300, ..Default::default() };
        let mon = (0, 0, 1920, 1080);
        assert!(may_show(&f, Some("game.exe"), None));
        assert!(!may_show(&f, Some("game.exe"), Some(mon)));
        // On the other monitor: stays.
        let right = Frame { x: 2000, ..f.clone() };
        assert!(may_show(&right, Some("game.exe"), Some(mon)));
        // Asked to show over that app (alone or among others): stays.
        let over = Frame { show_over: apps(&["game.exe"]), ..f.clone() };
        assert!(may_show(&over, Some("game.exe"), Some(mon)));
        let several = Frame { show_over: apps(&["blender.exe", "game.exe"]), ..f.clone() };
        assert!(may_show(&several, Some("game.exe"), Some(mon)));
        // Another full-screen app that is not on the list: hidden.
        assert!(!may_show(&several, Some("other.exe"), Some(mon)));
        // Lastshot in front: the frames stay.
        assert!(may_show(&several, Some("lastshot.exe"), None));
        assert!(covers((-8, -8, 1928, 1088), mon));
        assert!(!covers((0, 0, 1920, 1040), mon), "a maximised window leaves the taskbar");
    }

    const WS_OVERLAPPEDWINDOW: u32 = 0x00CF_0000;
    const WS_POPUP: u32 = 0x8000_0000;
    const WS_VISIBLE: u32 = 0x1000_0000;
    const WS_MAXIMIZE: u32 = 0x0100_0000;

    #[test]
    fn a_maximised_window_is_not_full_screen_even_without_a_taskbar() {
        let mon = (0, 0, 1920, 1080);
        // No taskbar (or auto-hidden): the maximised window's rectangle,
        // invisible borders included, spills past the whole monitor.
        let blender = TopWindow { style: WS_OVERLAPPEDWINDOW | WS_VISIBLE | WS_MAXIMIZE, zoomed: true, rect: (-8, -8, 1928, 1088) };
        assert!(!is_full_screen(&blender, mon, false));
        // Maximised and borderless still counts as maximised.
        let zoomed_popup = TopWindow { style: WS_POPUP | WS_VISIBLE, zoomed: true, rect: mon };
        assert!(!is_full_screen(&zoomed_popup, mon, false));
        // A normal window with a caption as big as the screen is not full screen.
        let big = TopWindow { style: WS_OVERLAPPEDWINDOW | WS_VISIBLE, zoomed: false, rect: mon };
        assert!(!is_full_screen(&big, mon, false));
    }

    #[test]
    fn borderless_and_exclusive_full_screen_count() {
        let mon = (1920, 0, 4480, 1440);
        let borderless = TopWindow { style: WS_POPUP | WS_VISIBLE, zoomed: false, rect: mon };
        assert!(is_full_screen(&borderless, mon, false));
        // Not filling the monitor: a borderless tool window.
        let small = TopWindow { rect: (1920, 0, 3000, 900), ..borderless };
        assert!(!is_full_screen(&small, mon, false));
        // Direct3D exclusive full screen, whatever the style says.
        let exclusive = TopWindow { style: WS_OVERLAPPEDWINDOW, zoomed: false, rect: (0, 0, 1, 1) };
        assert!(is_full_screen(&exclusive, mon, true));
    }

    #[test]
    fn shell_windows_never_count_as_apps() {
        for c in ["XamlExplorerHostIslandWindow", "MultitaskingViewFrame", "Shell_TrayWnd", "Progman", "WorkerW", "Windows.UI.Core.CoreWindow"] {
            assert!(is_shell_class(c), "{c}");
        }
        for c in ["GHOST_WindowClass", "UnrealWindow", "Chrome_WidgetWin_1", "ApplicationFrameWindow"] {
            assert!(!is_shell_class(c), "{c}");
        }
    }

    fn temp_root(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lastshot-frames-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn closing_a_board_moves_its_pictures_to_the_trash_and_back() {
        let root = temp_root("trash");
        let dir = root.join("b0a2d");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("aa.png"), b"one").unwrap();
        std::fs::write(dir.join("bb.png"), b"two").unwrap();
        let f = Frame { id: "b0a2d".into(), kind: "board".into(), title: "Refs".into(), items: Some(2), ..Default::default() };
        assert_eq!(holds_in(&root, &f), 2);
        assert_eq!(holds_in(&root, &Frame { items: None, ..f.clone() }), 2, "never reported: the files count");
        let key = trash_in(&root, &f, 1_000).unwrap().unwrap();
        assert_eq!(key, "b0a2d");
        assert!(!dir.exists(), "moved, not copied");
        let list = closed_in(&root, 2_000);
        assert_eq!(list.len(), 1);
        assert_eq!((list[0].title.as_str(), list[0].pictures, list[0].closed_ms), ("Refs", 2, 1_000));
        let back = restore_in(&root, &key).unwrap();
        assert_eq!(back.id, "b0a2d");
        assert_eq!(std::fs::read(dir.join("bb.png")).unwrap(), b"two");
        assert!(closed_in(&root, 2_000).is_empty());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn an_owned_picture_goes_to_the_trash_and_frames_without_files_do_not() {
        let root = temp_root("owned");
        let src = root.join("c1.png");
        std::fs::write(&src, b"png").unwrap();
        let f = Frame { id: "c1".into(), src: src.to_string_lossy().into(), owned: true, ..Default::default() };
        assert_eq!(holds_in(&root, &f), 0, "a single picture closes without asking");
        let key = trash_in(&root, &f, 5).unwrap().unwrap();
        assert!(!src.exists());
        assert_eq!(closed_in(&root, 6)[0].pictures, 1);
        // Closing the same id again while the first is in the trash: a second entry.
        std::fs::write(&src, b"png2").unwrap();
        let key2 = trash_in(&root, &f, 7).unwrap().unwrap();
        assert_ne!(key, key2);
        // A clip from disk owns nothing: no entry.
        let clip = Frame { id: "c2".into(), kind: "video".into(), src: "D:\\clips\\a.mp4".into(), ..Default::default() };
        assert_eq!(trash_in(&root, &clip, 8).unwrap(), None);
        // The first restore cannot overwrite the second picture's place.
        restore_in(&root, &key).unwrap();
        assert!(restore_in(&root, &key2).is_err(), "c1.png is in the way");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_trash_keeps_seven_days() {
        let day = 24 * 3600 * 1000;
        assert!(!expired(0, 7 * day));
        assert!(expired(0, 7 * day + 1));
        let root = temp_root("purge");
        let dir = root.join("d1");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("x.png"), b"x").unwrap();
        let f = Frame { id: "d1".into(), items: Some(1), ..Default::default() };
        trash_in(&root, &f, 0).unwrap();
        purge_in(&root, 6 * day);
        assert_eq!(closed_in(&root, 6 * day).len(), 1);
        purge_in(&root, 8 * day);
        assert!(!root.join(TRASH).join("d1").exists());
        // Keys never leave the trash folder.
        assert!(restore_in(&root, "..").is_err());
        assert!(restore_in(&root, "a\\b").is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn atomic_writes_and_file_kinds() {
        let root = temp_root("kinds");
        let p = root.join("a.png");
        let mut png = PNG_MAGIC.to_vec();
        png.extend_from_slice(&[0; 8]);
        write_atomic(&p, &png).unwrap();
        assert!(!root.join("a.png.tmp").exists());
        assert!(is_picture_file(&p));
        // The right name with the wrong bytes, and the other way round.
        let fake = root.join("b.png");
        std::fs::write(&fake, b"MZ not a picture").unwrap();
        assert!(!is_picture_file(&fake));
        let exe = root.join("c.exe");
        std::fs::write(&exe, &png).unwrap();
        assert!(!is_picture_file(&exe));
        assert!(is_video_file(Path::new("x.MP4")) && is_video_file(Path::new("x.webm")));
        assert!(!is_video_file(Path::new("x.exe")) && !is_video_file(Path::new("mp4")));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn only_visible_changes_reach_every_window() {
        let mut f = Frame { id: "e".into(), ..Default::default() };
        let before = f.clone_without_view();
        f.apply(&FramePatch { view: Some(serde_json::json!({"board": {"items": [1, 2, 3]}})), ..Default::default() });
        assert!(before.same_outside_view(&f), "a view change alone is not broadcast");
        assert_eq!(f.clone_without_view().view, serde_json::Value::Null);
        f.apply(&FramePatch { items: Some(3), badges: Some(vec!["gray".into(), "x".repeat(40)]), ..Default::default() });
        assert!(!before.same_outside_view(&f));
        assert_eq!(f.items, Some(3));
        assert_eq!(f.badges[1].len(), 16);
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
