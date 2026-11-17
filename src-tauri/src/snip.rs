//! Snipping tool.
//!
//! The hotkey freezes the screens (by default every monitor at once; or the
//! one under the cursor, or a chosen one: Settings › Screenshots) with a GDI
//! screen grab, so it is instant and needs no capture session, then opens
//! one borderless overlay window over that area showing the frozen image
//! (like ShareX: a box can cross monitors, and the picture stays 1:1 in
//! physical pixels on monitors with different scaling). The overlay (the
//! same web UI, window label "snip") lets the user pick a region or a
//! window, mark it up, and hands the finished PNG back here to be copied
//! and/or saved.
//!
//! Test copies never grab the real screen: they snip a made-up desktop
//! (`LASTSHOT_TEST_SCREEN`, see `snip_geo::TestScreen`).

use std::time::Duration;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::{AppState, EVT_ERROR};
use crate::snip_geo::{record_crop, snip_area, test_pixel, MonRect, SnipArea, TestScreen};

pub const EVT_SNIP_DONE: &str = "lastshot://snip-done";
pub use imp::snapshot;
/// Also used by the viewer and pop-out frames ("copy this frame").
pub(crate) use imp::copy_png;

pub const SNIP_LABEL: &str = "snip";

/// A top-level window's outline, relative to the captured monitor, in
/// physical pixels. Front-most first.
#[derive(Debug, Clone, Serialize)]
pub struct WinRect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub title: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SnipCapture {
    /// `data:image/png;base64,...` of the whole monitor.
    pub image: String,
    pub width: u32,
    pub height: u32,
    pub windows: Vec<WinRect>,
    /// "shot" (screenshot) or "rec" (record an area): which tab the snip bar
    /// opens on.
    pub start_mode: String,
    /// The monitors in the picture, relative to its corner (one when the
    /// snip covers one screen). Between them (monitors of different sizes)
    /// the picture is black.
    pub monitors: Vec<MonRect>,
    /// The monitor the cursor was on: the bar opens there.
    pub home: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct SnipDone {
    pub path: Option<String>,
    pub copied: bool,
}

struct Pending {
    capture: SnipCapture,
    restore_main: bool,
    opened: std::time::Instant,
    /// The snipped area on the desktop (x, y, w, h), physical pixels.
    rect: (i32, i32, u32, u32),
    /// The monitors in it, desktop pixels.
    monitors: Vec<MonRect>,
}

static PENDING: Mutex<Option<Pending>> = Mutex::new(None);

/// Hotkey entry point: snip whatever is on screen right now.
pub fn begin(app: AppHandle) {
    begin_with(app, false, "shot");
}

/// `hide_main`: the request came from Lastshot's own window, which would
/// otherwise be in the picture. It is hidden first and shown again after.
/// `mode`: "shot" or "rec", the tab the snip bar opens on.
pub fn begin_with(app: AppHandle, hide_main: bool, mode: &'static str) {
    tauri::async_runtime::spawn(async move {
        if let Some(w) = app.get_webview_window(SNIP_LABEL) {
            // The overlay shows itself once its page has painted. One that is
            // still hidden after a few seconds never loaded: replace it, so a
            // broken page can never block screenshots until a restart.
            let stale = !w.is_visible().unwrap_or(true)
                && PENDING
                    .lock()
                    .as_ref()
                    .map_or(true, |p| p.opened.elapsed() > Duration::from_secs(3));
            if !stale {
                return; // already snipping
            }
            log::warn!("[lastshot] replacing a snip overlay that never showed");
            if PENDING.lock().take().is_some_and(|p| p.restore_main) {
                show_main(&app);
            }
            let _ = w.destroy();
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        let main = app.get_webview_window("main");
        let restore_main = hide_main
            && main
                .as_ref()
                .map(|w| w.is_visible().unwrap_or(false))
                .unwrap_or(false);
        if restore_main {
            if let Some(w) = main.as_ref() {
                let _ = w.hide();
            }
            // Let the compositor drop our window before the grab.
            tokio::time::sleep(Duration::from_millis(220)).await;
        }

        let scope = app.state::<AppState>().settings.read().snip_scope.clone();
        // Test copies snip a made-up desktop, never the user's screen.
        let test_screen = crate::startup::test_offscreen() || std::env::var_os("LASTSHOT_TEST_SCREEN").is_some();
        let grabbed = tauri::async_runtime::spawn_blocking(move || {
            if test_screen {
                test_capture(&scope)
            } else {
                imp::capture(&scope)
            }
        })
        .await;
        let (mut capture, rect) = match grabbed {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => return fail(&app, restore_main, format!("Snip failed: {e}")),
            Err(e) => return fail(&app, restore_main, format!("Snip failed: {e}")),
        };
        capture.start_mode = mode.to_string();
        let monitors = capture.monitors.iter().map(|m| m.moved(rect.0, rect.1)).collect();
        *PENDING.lock() = Some(Pending {
            capture,
            restore_main,
            opened: std::time::Instant::now(),
            rect,
            monitors,
        });
        if let Err(e) = open_overlay(&app, rect) {
            PENDING.lock().take();
            fail(&app, restore_main, format!("Could not open the snip overlay: {e}"));
        }
    });
}

fn fail(app: &AppHandle, restore_main: bool, msg: String) {
    if restore_main {
        show_main(app);
    }
    let _ = app.emit(EVT_ERROR, msg);
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        crate::shell::bring_to_front(&w);
    }
}

fn open_overlay(app: &AppHandle, rect: (i32, i32, u32, u32)) -> tauri::Result<()> {
    let (x, y, w, h) = rect;
    let win = tauri::WebviewWindowBuilder::new(app, SNIP_LABEL, tauri::WebviewUrl::default())
        .title("Lastshot snip")
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false)
        .background_color(tauri::window::Color(0, 0, 0, 255))
        .build()?;
    crate::recording::hide_from_alt_tab(&win);
    // Over monitors with different scaling, Windows may resize the window
    // when it lands on another monitor's scale (WM_DPICHANGED): set the
    // place again until it holds.
    for _ in 0..4 {
        win.set_position(tauri::PhysicalPosition::new(x, y))?;
        win.set_size(tauri::PhysicalSize::new(w, h))?;
        let pos = win.outer_position()?;
        let size = win.outer_size()?;
        if (pos.x, pos.y, size.width, size.height) == (x, y, w, h) {
            break;
        }
        log::info!("[snip] overlay landed at {pos:?} {size:?}, setting it again");
    }
    // The page shows the window once the frozen image has painted.
    Ok(())
}

/// The scope's monitor for "monitor:<index>" (Settings › Instant replay's
/// screen numbers), on the desktop.
fn chosen_monitor(scope: &str) -> Option<MonRect> {
    let n: u32 = scope.strip_prefix("monitor:")?.parse().ok()?;
    crate::media::recorder::enumerate_monitors()
        .into_iter()
        .find(|m| m.index == n)
        .map(|m| MonRect::new(m.x, m.y, m.width as i32, m.height as i32))
}

/// A snip of the made-up test desktop (`LASTSHOT_TEST_SCREEN`): one colour
/// per monitor in 100-px squares, black between monitors.
fn test_capture(scope: &str) -> Result<(SnipCapture, (i32, i32, u32, u32)), String> {
    let t = TestScreen::parse(std::env::var("LASTSHOT_TEST_SCREEN").ok().as_deref());
    let mons = t.rects();
    let chosen = scope.strip_prefix("monitor:").and_then(|n| n.parse::<usize>().ok()).and_then(|i| mons.get(i).copied());
    let SnipArea { area, monitors, home } = snip_area(&mons, scope, (t.cursor[0], t.cursor[1]), chosen).ok_or("no monitors")?;
    let mut rgb = Vec::with_capacity((area.w * area.h * 3) as usize);
    for y in 0..area.h {
        for x in 0..area.w {
            rgb.extend_from_slice(&test_pixel(&mons, (area.x + x, area.y + y)));
        }
    }
    let windows = t
        .windows
        .iter()
        .filter_map(|w| {
            let r = MonRect::new(w.x, w.y, w.w, w.h).intersect(&area)?;
            Some(WinRect { x: r.x - area.x, y: r.y - area.y, w: r.w, h: r.h, title: w.title.clone() })
        })
        .collect();
    let image = png_data_url(&rgb, area.w as u32, area.h as u32)?;
    Ok((
        SnipCapture { image, width: area.w as u32, height: area.h as u32, windows, start_mode: "shot".into(), monitors, home },
        (area.x, area.y, area.w as u32, area.h as u32),
    ))
}

/// RGB pixels as a `data:image/png;base64,...` URL (fast compression).
fn png_data_url(rgb: &[u8], w: u32, h: u32) -> Result<String, String> {
    let mut png = Vec::new();
    let enc = image::codecs::png::PngEncoder::new_with_quality(
        &mut png,
        image::codecs::png::CompressionType::Fast,
        image::codecs::png::FilterType::Sub,
    );
    image::ImageEncoder::write_image(enc, rgb, w, h, image::ExtendedColorType::Rgb8).map_err(|e| format!("png encode: {e}"))?;
    use base64::Engine;
    Ok(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&png)))
}

fn close_overlay(app: &AppHandle) {
    let restore = PENDING.lock().take().map(|p| p.restore_main).unwrap_or(false);
    if let Some(w) = app.get_webview_window(SNIP_LABEL) {
        let _ = w.close();
    }
    if restore {
        show_main(app);
    }
}

/// The overlay asks for the frozen screen it should show.
#[tauri::command]
pub fn snip_get_capture() -> Result<SnipCapture, String> {
    PENDING
        .lock()
        .as_ref()
        .map(|p| p.capture.clone())
        .ok_or_else(|| "nothing to snip".into())
}

/// Starts a snip from Lastshot's own window (the window hides itself first).
/// `mode`: "shot" (default) or "rec" to record an area.
#[tauri::command]
pub fn start_snip(app: AppHandle, mode: Option<String>) {
    let mode = if mode.as_deref() == Some("rec") { "rec" } else { "shot" };
    begin_with(app, true, mode);
}

/// Region in the snip picture's physical pixels.
#[derive(Debug, Clone, Copy, serde::Deserialize)]
pub struct SnipRegion {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// Closes the overlay and records the picked area (the whole screen when
/// the area covers it). Lastshot's window stays hidden so it is not in the
/// recording; the control bar brings it back.
#[tauri::command]
pub async fn snip_record(
    app: AppHandle,
    state: State<'_, AppState>,
    region: SnipRegion,
) -> Result<crate::media::recorder::RecordingStatus, String> {
    let (cap_w, cap_h, area, restore_main, snipped) = {
        let p = PENDING.lock();
        let p = p.as_ref().ok_or("nothing to record")?;
        (p.capture.width as i32, p.capture.height as i32, p.rect, p.restore_main, p.monitors.clone())
    };
    // The engine records one monitor (Settings › Screen): it must be this one.
    let wanted = state.settings.read().monitor_index;
    let monitors = crate::media::recorder::enumerate_monitors();
    let recorded = monitors
        .iter()
        .find(|m| m.index == wanted)
        .or_else(|| monitors.iter().find(|m| m.primary))
        .or(monitors.first());
    let recorded = recorded.ok_or("no screen to record")?;
    let rec = MonRect::new(recorded.x, recorded.y, recorded.width as i32, recorded.height as i32);
    // The box on the desktop.
    let x = region.x.clamp(0, cap_w);
    let y = region.y.clamp(0, cap_h);
    let w = region.w.clamp(1, (cap_w - x).max(1));
    let h = region.h.clamp(1, (cap_h - y).max(1));
    let boxed = MonRect::new(area.0 + x, area.1 + y, w, h);
    let crop = record_crop(boxed, rec).map_err(|_| {
        if snipped.iter().any(|m| boxed.inside(m, 2)) {
            format!(
                "Lastshot records the screen {} ({}×{}). To record on this one, choose it in Settings › Instant replay › Screen.",
                recorded.name.trim_start_matches("\\\\.\\"),
                recorded.width,
                recorded.height
            )
        } else {
            "A recording covers one screen: draw the box inside one screen.".to_string()
        }
    })?;
    let area = crop.map(|c| crate::recording::Area {
        crop: crate::media::shrink::Crop { x: c[0], y: c[1], w: c[2], h: c[3] },
        label: format!("{w}×{h}"),
    });
    // Close the overlay without bringing Lastshot's window back.
    PENDING.lock().take();
    if let Some(win) = app.get_webview_window(SNIP_LABEL) {
        let _ = win.close();
    }
    // Let the overlay leave the screen before the first frame.
    tokio::time::sleep(Duration::from_millis(250)).await;
    let started = crate::recording::start_with(&app, area).await;
    match &started {
        // Keep Lastshot on the taskbar but out of the picture.
        Ok(_) if restore_main => {
            if let Some(w) = app.get_webview_window("main") {
                // SW_MINIMIZE also un-hides the window.
                let _ = w.minimize();
            }
        }
        Ok(_) => {}
        Err(e) => {
            if restore_main {
                show_main(&app);
            }
            let _ = app.emit(EVT_ERROR, format!("Could not start recording: {e}"));
        }
    }
    started
}

#[tauri::command]
pub fn snip_cancel(app: AppHandle) {
    close_overlay(&app);
}

/// Receives the finished snip (`data:image/png;base64,...`), copies it and/or
/// saves it, then closes the overlay.
#[tauri::command]
pub async fn snip_finish(
    app: AppHandle,
    state: State<'_, AppState>,
    png: String,
    copy: bool,
    save: bool,
    jpg: Option<String>,
) -> Result<SnipDone, String> {
    let (save_setting, dir, copy_setting) = {
        let s = state.settings.read();
        (s.snip_save_to_folder, s.screenshots_dir(), s.screenshot_copy)
    };
    // Named after the app, in the app's folder (like clips).
    let (app_name, folder) = crate::commands::resolve_app_and_folder(&state, None);
    let dir = match folder {
        Some(f) => dir.join(f),
        None => dir,
    };
    // Test copies off screen never touch the user's clipboard.
    let copy = copy && copy_setting && !crate::startup::test_offscreen();
    // Not copying and not saving would lose the picture: save it then.
    let save = save || save_setting || !copy;
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<SnipDone, String> {
        use base64::Engine;
        let decode = |data: &str| -> Result<Vec<u8>, String> {
            let b64 = data.split_once(',').map(|(_, d)| d).unwrap_or(data);
            base64::engine::general_purpose::STANDARD
                .decode(b64.trim())
                .map_err(|e| format!("bad image data: {e}"))
        };
        let bytes = decode(&png)?;
        let mut path = None;
        if save {
            // JPG when the overlay sent one (Settings › Screenshots › Format).
            let (file_bytes, ext) = match jpg.as_deref() {
                Some(j) => (decode(j)?, "jpg"),
                None => (bytes.clone(), "png"),
            };
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let stem = crate::appname::file_stem(&app_name, None, chrono::Local::now());
            let mut p = dir.join(format!("{stem}.{ext}"));
            let mut n = 2;
            while p.exists() {
                p = dir.join(format!("{stem}_{n}.{ext}"));
                n += 1;
            }
            std::fs::write(&p, &file_bytes).map_err(|e| e.to_string())?;
            path = Some(p.to_string_lossy().to_string());
        }
        if copy {
            imp::copy_png(&bytes)?;
        }
        Ok(SnipDone { path, copied: copy })
    })
    .await
    .map_err(|e| e.to_string())?;

    close_overlay(&app);
    let done = result?;
    let _ = app.emit(EVT_SNIP_DONE, done.clone());
    Ok(done)
}

/// Opens the Screenshots folder.
#[tauri::command]
pub fn open_screenshots_folder(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = state.settings.read().screenshots_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

// ===========================================================================
//                        WINDOWS IMPLEMENTATION
// ===========================================================================

#[cfg(all(windows, not(feature = "headless-sim")))]
mod imp {
    use super::*;
    use windows::Win32::Foundation::{BOOL, HANDLE, HWND, LPARAM, POINT, RECT, TRUE};
    use windows::Win32::Graphics::Dwm::{
        DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
    };
    use windows::Win32::Graphics::Gdi::*;
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::CF_DIB;
    use windows::Win32::UI::WindowsAndMessaging::*;

    type Rect = (i32, i32, u32, u32);

    unsafe extern "system" fn add_monitor(_m: HMONITOR, _dc: HDC, r: *mut RECT, lparam: LPARAM) -> BOOL {
        let list = &mut *(lparam.0 as *mut Vec<MonRect>);
        let r = &*r;
        list.push(MonRect::new(r.left, r.top, r.right - r.left, r.bottom - r.top));
        TRUE
    }

    /// Every monitor on the desktop, physical pixels.
    pub fn monitors() -> Vec<MonRect> {
        let mut out: Vec<MonRect> = Vec::new();
        unsafe {
            let _ = EnumDisplayMonitors(None, None, Some(add_monitor), LPARAM(&mut out as *mut _ as isize));
        }
        out
    }

    /// Freezes the scope's screens (see `snip_geo::snip_area`).
    pub fn capture(scope: &str) -> Result<(SnipCapture, Rect), String> {
        unsafe {
            let mut pt = POINT::default();
            GetCursorPos(&mut pt).map_err(|e| e.to_string())?;
            let SnipArea { area, monitors: mons, home } =
                snip_area(&monitors(), scope, (pt.x, pt.y), chosen_monitor(scope)).ok_or("could not read the monitors")?;
            let (x, y, w, h) = (area.x, area.y, area.w, area.h);
            if w <= 0 || h <= 0 {
                return Err("empty monitor".into());
            }

            let bgra = grab(x, y, w, h)?;
            let windows = list_windows(RECT { left: x, top: y, right: x + w, bottom: y + h });

            // BGRA -> RGB for a compact PNG.
            let mut rgb = Vec::with_capacity((w * h * 3) as usize);
            for px in bgra.chunks_exact(4) {
                rgb.extend_from_slice(&[px[2], px[1], px[0]]);
            }
            let image = png_data_url(&rgb, w as u32, h as u32)?;
            Ok((
                SnipCapture { image, width: w as u32, height: h as u32, windows, start_mode: "shot".into(), monitors: mons, home },
                (x, y, w as u32, h as u32),
            ))
        }
    }

    /// The screen area as a small PNG data URL, at most `max_w` wide.
    pub fn snapshot(x: i32, y: i32, w: u32, h: u32, max_w: u32) -> Result<String, String> {
        let bgra = unsafe { grab(x, y, w as i32, h as i32)? };
        let mut rgba = image::RgbaImage::new(w, h);
        for (i, px) in bgra.chunks_exact(4).enumerate() {
            rgba.as_mut()[i * 4..i * 4 + 4].copy_from_slice(&[px[2], px[1], px[0], 255]);
        }
        let small = if w > max_w {
            let nh = (h as f64 * max_w as f64 / w as f64).round().max(1.0) as u32;
            image::imageops::resize(&rgba, max_w, nh, image::imageops::FilterType::Triangle)
        } else {
            rgba
        };
        let mut png = Vec::new();
        image::ImageEncoder::write_image(
            image::codecs::png::PngEncoder::new(&mut png),
            small.as_raw(),
            small.width(),
            small.height(),
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|e| format!("png encode: {e}"))?;
        use base64::Engine;
        Ok(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&png)))
    }

    unsafe fn grab(x: i32, y: i32, w: i32, h: i32) -> Result<Vec<u8>, String> {
        let screen = GetDC(None);
        if screen.is_invalid() {
            return Err("GetDC failed".into());
        }
        let mem = CreateCompatibleDC(screen);
        let bmp = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, bmp);
        let blit = BitBlt(mem, 0, 0, w, h, screen, x, y, ROP_CODE(SRCCOPY.0 | CAPTUREBLT.0));
        SelectObject(mem, old);

        let mut bi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut buf = vec![0u8; (w * h * 4) as usize];
        let lines = GetDIBits(
            mem,
            bmp,
            0,
            h as u32,
            Some(buf.as_mut_ptr() as *mut _),
            &mut bi,
            DIB_RGB_COLORS,
        );
        let _ = DeleteObject(bmp);
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        blit.map_err(|e| format!("BitBlt: {e}"))?;
        if lines == 0 {
            return Err("GetDIBits failed".into());
        }
        Ok(buf)
    }

    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let list = &mut *(lparam.0 as *mut Vec<HWND>);
        list.push(hwnd);
        TRUE
    }

    /// Visible, titled, uncloaked top-level windows in the area, front-most
    /// first, clipped to it. The desktop itself (Progman / WorkerW, which
    /// spans every monitor) is left out: a click there takes that monitor.
    unsafe fn list_windows(mon: RECT) -> Vec<WinRect> {
        let mut hwnds: Vec<HWND> = Vec::new();
        let _ = EnumWindows(Some(collect), LPARAM(&mut hwnds as *mut _ as isize));
        let mut out = Vec::new();
        for hwnd in hwnds {
            if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
                continue;
            }
            let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
            if ex & WS_EX_TOOLWINDOW.0 != 0 {
                continue;
            }
            let mut class = [0u16; 32];
            let n = GetClassNameW(hwnd, &mut class);
            let class = String::from_utf16_lossy(&class[..n.max(0) as usize]);
            if class == "Progman" || class == "WorkerW" {
                continue;
            }
            let mut cloaked: u32 = 0;
            let _ = DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                &mut cloaked as *mut _ as *mut _,
                std::mem::size_of::<u32>() as u32,
            );
            if cloaked != 0 {
                continue;
            }
            let len = GetWindowTextLengthW(hwnd);
            if len <= 0 {
                continue;
            }
            let mut title = vec![0u16; len as usize + 1];
            let n = GetWindowTextW(hwnd, &mut title);
            let title = String::from_utf16_lossy(&title[..n.max(0) as usize]);

            let mut r = RECT::default();
            if DwmGetWindowAttribute(
                hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                &mut r as *mut _ as *mut _,
                std::mem::size_of::<RECT>() as u32,
            )
            .is_err()
                && GetWindowRect(hwnd, &mut r).is_err()
            {
                continue;
            }
            let left = r.left.max(mon.left);
            let top = r.top.max(mon.top);
            let right = r.right.min(mon.right);
            let bottom = r.bottom.min(mon.bottom);
            if right - left < 40 || bottom - top < 30 {
                continue;
            }
            out.push(WinRect {
                x: left - mon.left,
                y: top - mon.top,
                w: right - left,
                h: bottom - top,
                title,
            });
        }
        out
    }

    /// Puts a PNG on the clipboard twice: as the "PNG" format (kept with
    /// transparency, read by browsers, Discord, Office) and as a classic DIB
    /// (read by everything else, e.g. Paint).
    pub fn copy_png(png: &[u8]) -> Result<(), String> {
        let img = image::load_from_memory_with_format(png, image::ImageFormat::Png)
            .map_err(|e| format!("png decode: {e}"))?
            .to_rgba8();
        let (w, h) = img.dimensions();

        let header = std::mem::size_of::<BITMAPINFOHEADER>();
        let mut dib = vec![0u8; header + (w * h * 4) as usize];
        let bih = BITMAPINFOHEADER {
            biSize: header as u32,
            biWidth: w as i32,
            biHeight: h as i32, // bottom-up, the most compatible layout
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            biSizeImage: w * h * 4,
            ..Default::default()
        };
        unsafe {
            std::ptr::copy_nonoverlapping(
                &bih as *const _ as *const u8,
                dib.as_mut_ptr(),
                header,
            );
        }
        let row = (w * 4) as usize;
        for y in 0..h as usize {
            let src = &img.as_raw()[y * row..(y + 1) * row];
            let dst_y = h as usize - 1 - y;
            let dst = &mut dib[header + dst_y * row..header + (dst_y + 1) * row];
            for (d, s) in dst.chunks_exact_mut(4).zip(src.chunks_exact(4)) {
                d[0] = s[2];
                d[1] = s[1];
                d[2] = s[0];
                d[3] = s[3];
            }
        }

        unsafe {
            OpenClipboard(None).map_err(|e| format!("OpenClipboard: {e}"))?;
            let r = (|| -> Result<(), String> {
                EmptyClipboard().map_err(|e| format!("EmptyClipboard: {e}"))?;
                put(CF_DIB.0 as u32, &dib)?;
                let png_fmt = RegisterClipboardFormatW(windows::core::w!("PNG"));
                if png_fmt != 0 {
                    put(png_fmt, png)?;
                }
                Ok(())
            })();
            let _ = CloseClipboard();
            r
        }
    }

    unsafe fn put(format: u32, data: &[u8]) -> Result<(), String> {
        let hmem = GlobalAlloc(GMEM_MOVEABLE, data.len()).map_err(|e| format!("GlobalAlloc: {e}"))?;
        let ptr = GlobalLock(hmem);
        if ptr.is_null() {
            return Err("GlobalLock returned null".into());
        }
        std::ptr::copy_nonoverlapping(data.as_ptr(), ptr as *mut u8, data.len());
        let _ = GlobalUnlock(hmem);
        SetClipboardData(format, HANDLE(hmem.0))
            .map_err(|e| format!("SetClipboardData: {e}"))?;
        Ok(())
    }
}

#[cfg(any(not(windows), feature = "headless-sim"))]
mod imp {
    use super::*;
    pub fn capture(_scope: &str) -> Result<(SnipCapture, (i32, i32, u32, u32)), String> {
        Err("snipping requires Windows".into())
    }
    pub fn snapshot(_x: i32, _y: i32, _w: u32, _h: u32, _max_w: u32) -> Result<String, String> {
        Err("requires Windows".into())
    }
    pub fn copy_png(_png: &[u8]) -> Result<(), String> {
        Err("snipping requires Windows".into())
    }
}
