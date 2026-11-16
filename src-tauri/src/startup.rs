//! Always on: Lastshot starts with Windows straight into the tray (no window
//! and no WebView unless a feature needs one), comes back after a crash or a
//! Windows Update restart, and never runs twice.
//!
//! - `--autostart` (the Run-key launch) starts in the tray. The main window
//!   (WebView) is made only when it is opened, or hidden at start when a
//!   feature that lives in the window is on (auto profiles, privacy pause,
//!   auto-save on game exit, adaptive eco).
//! - A small watchdog process (`--watchdog`, the same exe, no WebView, ~2 MB)
//!   starts Lastshot again if it crashes, waiting 2 s, 10 s, then 30 s; after
//!   three crashes in a row it gives up. A normal quit is never restarted.
//! - RegisterApplicationRestart: Windows starts Lastshot again after an
//!   update restart.
//! - Start-up times are written to `last_startup.json` (app data folder).

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tauri::{AppHandle, Manager};

pub const ARG_AUTOSTART: &str = "--autostart";
pub const ARG_WATCHDOG: &str = "--watchdog";
const ARG_RESTARTED: &str = "--restarted";
const ARG_CRASHES: &str = "--crashes";

static T0: OnceLock<Instant> = OnceLock::new();
static MARKS: Mutex<Vec<(String, u64)>> = Mutex::new(Vec::new());

fn args() -> Vec<String> {
    std::env::args().collect()
}

/// Started by Windows at sign-in (or after a crash / update restart).
pub fn is_autostart() -> bool {
    args().iter().any(|a| a == ARG_AUTOSTART)
}

pub fn is_test_instance() -> bool {
    std::env::var_os("LASTSHOT_TEST_INSTANCE").is_some()
}

/// Whether a feature that lives in the window must run while in the tray.
pub fn window_needed_in_background(s: &crate::settings::Settings) -> bool {
    s.auto_switch_profiles || s.privacy_pause_when_unfocused || s.autosave_on_game_exit || s.adaptive_eco
}

// ------------------------------------------------------------ main window

/// The main window, made from its config entry when it does not exist yet.
/// Must not be called from a synchronous command (WebView2 needs the event
/// loop): use [`show_main`] there.
pub fn ensure_main(app: &AppHandle, visible: bool) -> Option<tauri::WebviewWindow> {
    if let Some(w) = app.get_webview_window("main") {
        return Some(w);
    }
    let conf = app.config().app.windows.iter().find(|w| w.label == "main")?.clone();
    let mut conf = conf;
    conf.visible = visible;
    conf.create = true;
    let test = is_test_instance();
    if test {
        // Test copies never cover the user's screen or take the focus: made
        // hidden, moved far off screen, then shown without activation.
        conf.center = false;
        conf.x = Some(-24000.0);
        conf.y = Some(100.0);
        conf.focus = false;
        conf.visible = false;
        // No taskbar button for a window nobody can see.
        conf.skip_taskbar = true;
    } else if let Some(p) = crate::shell::main_place(app) {
        // Where it was last (on a screen that is still there).
        conf.center = false;
        conf.x = Some(p.x as f64);
        conf.y = Some(p.y as f64);
        conf.width = p.width.max(conf.min_width.unwrap_or(0.0));
        conf.height = p.height.max(conf.min_height.unwrap_or(0.0));
        conf.maximized = p.maximized;
    }
    let w = tauri::WebviewWindowBuilder::from_config(app, &conf).ok()?.build().ok()?;
    if test {
        // Off screen, so never a taskbar button or an Alt+Tab stop.
        crate::recording::hide_from_alt_tab(&w);
        let _ = w.set_position(tauri::PhysicalPosition::new(-24000, 100));
        if visible {
            let _ = w.show();
        }
    }
    crate::studio::allow_camera(&w);
    if let Some(state) = app.try_state::<crate::commands::AppState>() {
        crate::shell::apply_scale(&w, state.settings.read().ui_scale);
    }
    if let Some(state) = app.try_state::<crate::commands::AppState>() {
        if state.settings.read().always_on_top {
            let _ = w.set_always_on_top(true);
        }
    }
    mark("window_created");
    Some(w)
}

/// Shows (and makes, the first time) the main window.
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        crate::shell::bring_to_front(&w);
        return;
    }
    let h = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(w) = ensure_main(&h, true) {
            crate::shell::bring_to_front(&w);
        }
    });
}

// ------------------------------------------------------------ timings

/// Milliseconds since this process started (from the OS process start time,
/// so loading the exe is counted too).
fn since_start_ms() -> u64 {
    process_age_ms().unwrap_or_else(|| T0.get_or_init(Instant::now).elapsed().as_millis() as u64)
}

#[cfg(windows)]
fn process_age_ms() -> Option<u64> {
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::SystemInformation::GetSystemTimeAsFileTime;
    use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
    unsafe {
        let (mut c, mut e, mut k, mut u) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
        GetProcessTimes(GetCurrentProcess(), &mut c, &mut e, &mut k, &mut u).ok()?;
        let now = GetSystemTimeAsFileTime();
        let t = |f: FILETIME| ((f.dwHighDateTime as u64) << 32) | f.dwLowDateTime as u64;
        Some(t(now).saturating_sub(t(c)) / 10_000)
    }
}

#[cfg(not(windows))]
fn process_age_ms() -> Option<u64> {
    None
}

/// Records a start-up milestone ("tray", "hotkeys", "buffer", ...).
pub fn mark(name: &str) {
    let ms = since_start_ms();
    let mut m = MARKS.lock();
    if m.iter().any(|(n, _)| n == name) {
        return;
    }
    m.push((name.to_string(), ms));
    log::info!("[lastshot] start-up: {name} at {ms} ms");
    let json = serde_json::json!({
        "autostart": is_autostart(),
        "marks": m.iter().map(|(n, t)| serde_json::json!({ "name": n, "ms": t })).collect::<Vec<_>>(),
    });
    let _ = std::fs::write(crate::paths::app_file("last_startup.json"), json.to_string());
}

// ------------------------------------------------------------ restart

/// Windows starts Lastshot again (in the tray) after an update restart.
/// Not for test copies: they must never come back by themselves.
#[cfg(windows)]
pub fn register_restart() {
    if is_test_instance() {
        return;
    }
    use windows::core::HSTRING;
    use windows::Win32::System::Recovery::{RegisterApplicationRestart, REGISTER_APPLICATION_RESTART_FLAGS};
    let cmd = HSTRING::from(format!("{ARG_AUTOSTART} {ARG_RESTARTED}"));
    let _ = unsafe { RegisterApplicationRestart(&cmd, REGISTER_APPLICATION_RESTART_FLAGS(0)) };
}

#[cfg(not(windows))]
pub fn register_restart() {}

// ------------------------------------------------------------ watchdog

/// Exit codes that mean a crash (not a normal quit or End task).
pub fn is_crash(code: u32) -> bool {
    matches!(
        code,
        0xC000_0005 // access violation
            | 0xC000_0409 // fast fail (Rust abort / panic)
            | 0xC000_00FD // stack overflow
            | 0xC000_0374 // heap corruption
            | 0xC000_001D // illegal instruction
            | 0xC000_0094 // divide by zero
            | 0x8000_0003 // breakpoint
            | 0xC000_0602 // fail fast exception
            | 0xE06D_7363 // unhandled C++ exception
    )
}

/// Wait before starting again after crash number `n` (1-based); `None` =
/// give up.
pub fn backoff(n: u32) -> Option<Duration> {
    match n {
        1 => Some(Duration::from_secs(2)),
        2 => Some(Duration::from_secs(10)),
        3 => Some(Duration::from_secs(30)),
        _ => None,
    }
}

fn crashes_arg() -> u32 {
    let a = args();
    a.iter().position(|x| x == ARG_CRASHES).and_then(|i| a.get(i + 1)).and_then(|v| v.parse().ok()).unwrap_or(0)
}

/// Starts the watchdog for this process (not in debug builds).
#[cfg(windows)]
pub fn spawn_watchdog() {
    if cfg!(debug_assertions) && !is_test_instance() {
        return;
    }
    if std::env::var_os("LASTSHOT_NO_WATCHDOG").is_some() {
        return;
    }
    use std::os::windows::process::CommandExt;
    let Ok(exe) = std::env::current_exe() else { return };
    let pid = std::process::id();
    let _ = std::process::Command::new(exe)
        .args([ARG_WATCHDOG, &pid.to_string(), ARG_CRASHES, &crashes_arg().to_string()])
        // CREATE_NO_WINDOW | DETACHED_PROCESS: no console, never in front.
        .creation_flags(0x0800_0000 | 0x0000_0008)
        .spawn();
}

#[cfg(not(windows))]
pub fn spawn_watchdog() {}

/// When started as the watchdog: wait for Lastshot, start it again if it
/// crashed, then exit. Returns false when this is not a watchdog launch.
#[cfg(windows)]
pub fn run_watchdog_if_asked() -> bool {
    use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, WaitForSingleObject, INFINITE, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE};
    let a = args();
    let Some(i) = a.iter().position(|x| x == ARG_WATCHDOG) else { return false };
    let Some(pid) = a.get(i + 1).and_then(|p| p.parse::<u32>().ok()) else { return true };
    let crashes = crashes_arg();
    let started = Instant::now();
    let code = unsafe {
        let Ok(h) = OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return true };
        let mut code = 0u32;
        let ok = WaitForSingleObject(h, INFINITE) == WAIT_OBJECT_0 && GetExitCodeProcess(h, &mut code).is_ok();
        let _ = CloseHandle(h);
        if !ok {
            return true;
        }
        code
    };
    if !is_crash(code) {
        return true;
    }
    // A long healthy run starts the count again.
    let n = if started.elapsed() > Duration::from_secs(600) { 1 } else { crashes + 1 };
    let Some(wait) = backoff(n) else {
        log::warn!("[lastshot] watchdog: crashed {n} times in a row, not starting again");
        return true;
    };
    std::thread::sleep(wait);
    if let Ok(exe) = std::env::current_exe() {
        let _ = std::process::Command::new(exe).args([ARG_AUTOSTART, ARG_RESTARTED, ARG_CRASHES, &n.to_string()]).spawn();
    }
    true
}

#[cfg(not(windows))]
pub fn run_watchdog_if_asked() -> bool {
    false
}

/// Test copies only: crash on purpose, to test the watchdog.
#[tauri::command]
pub fn crash_for_test() {
    if is_test_instance() {
        std::process::abort();
    }
}

// ------------------------------------------------------------ save sound

/// The save chime (same two tones as the window's) as a WAV, for when Lastshot
/// runs in the tray without its window.
pub fn chime_wav() -> Vec<u8> {
    const RATE: u32 = 44_100;
    let n = (RATE as f32 * 0.25) as usize;
    let mut pcm = Vec::with_capacity(n);
    for i in 0..n {
        let t = i as f32 / RATE as f32;
        let env = |start: f32, peak: f32, end: f32, amp: f32| -> f32 {
            if t < start || t > end {
                0.0
            } else if t < peak {
                amp * (t - start) / (peak - start)
            } else {
                amp * (-(t - peak) / ((end - peak) / 5.0)).exp()
            }
        };
        let tick = if (t * 880.0).fract() < 0.5 { 1.0 } else { -1.0 } * env(0.0, 0.004, 0.07, 0.06);
        let ping = (t * 1318.5 * std::f32::consts::TAU).sin() * env(0.05, 0.06, 0.22, 0.05);
        pcm.push((((tick + ping) * 4.0).clamp(-1.0, 1.0) * i16::MAX as f32) as i16);
    }
    let data_len = (pcm.len() * 2) as u32;
    let mut w = Vec::with_capacity(44 + data_len as usize);
    w.extend_from_slice(b"RIFF");
    w.extend_from_slice(&(36 + data_len).to_le_bytes());
    w.extend_from_slice(b"WAVEfmt ");
    w.extend_from_slice(&16u32.to_le_bytes());
    w.extend_from_slice(&1u16.to_le_bytes()); // PCM
    w.extend_from_slice(&1u16.to_le_bytes()); // mono
    w.extend_from_slice(&RATE.to_le_bytes());
    w.extend_from_slice(&(RATE * 2).to_le_bytes());
    w.extend_from_slice(&2u16.to_le_bytes());
    w.extend_from_slice(&16u16.to_le_bytes());
    w.extend_from_slice(b"data");
    w.extend_from_slice(&data_len.to_le_bytes());
    for s in pcm {
        w.extend_from_slice(&s.to_le_bytes());
    }
    w
}

/// Plays the save chime when the window (which normally plays it) is not
/// open.
pub fn play_save_sound_if_no_window(app: &AppHandle) {
    if app.get_webview_window("main").is_some() {
        return;
    }
    let on = app.try_state::<crate::commands::AppState>().map(|s| s.settings.read().play_save_sound).unwrap_or(false);
    if !on {
        return;
    }
    #[cfg(windows)]
    {
        use windows::core::PCWSTR;
        use windows::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_MEMORY, SND_NODEFAULT};
        static WAV: OnceLock<Vec<u8>> = OnceLock::new();
        let wav = WAV.get_or_init(chime_wav);
        unsafe {
            let _ = PlaySoundW(PCWSTR(wav.as_ptr() as *const u16), None, SND_MEMORY | SND_ASYNC | SND_NODEFAULT);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_real_crashes_restart() {
        assert!(is_crash(0xC000_0409));
        assert!(is_crash(0xC000_0005));
        assert!(!is_crash(0)); // normal quit
        assert!(!is_crash(1)); // End task
        assert!(!is_crash(0xFFFF_FFFF)); // killed
    }

    #[test]
    fn backs_off_then_gives_up() {
        assert_eq!(backoff(1), Some(Duration::from_secs(2)));
        assert_eq!(backoff(3), Some(Duration::from_secs(30)));
        assert_eq!(backoff(4), None);
    }

    #[test]
    fn chime_is_a_valid_wav() {
        let w = chime_wav();
        assert_eq!(&w[0..4], b"RIFF");
        assert_eq!(&w[8..16], b"WAVEfmt ");
        let data = u32::from_le_bytes(w[40..44].try_into().unwrap()) as usize;
        assert_eq!(w.len(), 44 + data);
        assert!(w[44..].chunks(2).any(|s| i16::from_le_bytes([s[0], s[1]]).abs() > 1000));
    }
}
