//! Keeps the global shortcuts working.
//!
//! Each shortcut is registered on its own, so one taken combo never blocks
//! the others. A light background thread (one wake-up a second, nothing
//! else) then:
//! - retries every shortcut that is not ours every 3 s;
//! - every 10 s, and right after sleep / resume, unlocking the PC or an
//!   Explorer restart, checks that each shortcut is still ours and takes it
//!   back when Windows dropped it;
//! - after 15 s without a shortcut, shows one Windows notification (it never
//!   takes focus) and Settings shows a red badge with *Try again*.
//!
//! Who owns a taken shortcut cannot be found cheaply on Windows, so the
//! message never names an app.
//!
//! Test copies (`LASTSHOT_TEST_INSTANCE=1`) register no shortcuts at all, so
//! they can never take the user's Alt+C.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

pub const EVT: &str = "lastshot://hotkeys-status";
pub const RETRY_MS: u64 = 3_000;
pub const CHECK_MS: u64 = 10_000;
pub const NOTIFY_MS: u64 = 15_000;

/// One shortcut and how it is doing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyStatus {
    /// "save", "toggle", "snip" or "record".
    pub action: String,
    pub accel: String,
    pub ok: bool,
    pub error: Option<String>,
    #[serde(skip)]
    failing_since: Option<u64>,
    #[serde(skip)]
    last_try: u64,
    #[serde(skip)]
    notified: bool,
}

impl KeyStatus {
    pub fn new(action: &str, accel: &str) -> Self {
        Self {
            action: action.into(),
            accel: accel.into(),
            ok: false,
            error: None,
            failing_since: None,
            last_try: 0,
            notified: false,
        }
    }

    /// Stores the outcome of an attempt made at `now` (ms). True when what
    /// Settings shows changed.
    pub fn record(&mut self, now: u64, result: Result<(), String>) -> bool {
        self.last_try = now;
        match result {
            Ok(()) => {
                let changed = !self.ok;
                self.ok = true;
                self.error = None;
                self.failing_since = None;
                self.notified = false;
                changed
            }
            Err(e) => {
                let changed = self.ok || self.error.as_deref() != Some(e.as_str());
                self.ok = false;
                self.error = Some(e);
                self.failing_since.get_or_insert(now);
                changed
            }
        }
    }

    pub fn retry_due(&self, now: u64) -> bool {
        !self.ok && now.saturating_sub(self.last_try) >= RETRY_MS
    }

    /// True once per failure, when the shortcut has not been ours for 15 s.
    pub fn take_notify(&mut self, now: u64) -> bool {
        match self.failing_since {
            Some(t) if !self.ok && !self.notified && now.saturating_sub(t) >= NOTIFY_MS => {
                self.notified = true;
                true
            }
            _ => false,
        }
    }

    /// A new combo for this action (after a successful rebind).
    pub fn rebound(&mut self, accel: &str, now: u64) {
        self.accel = accel.into();
        self.record(now, Ok(()));
    }
}

/// The notification text, in plain words.
pub fn message(action: &str, accel: &str) -> String {
    let what = match action {
        "save" => "clips can't be saved with it",
        "record" => "recordings can't be started with it",
        "pause" => "recordings can't be paused with it",
        "snip" => "screenshots can't be taken with it",
        "mic" => "the microphone can't be muted with it",
        "frames" => "pop-out frames can't be made click-through with it",
        _ => "instant replay can't be turned on or off with it",
    };
    format!("{accel} is being used by another app; {what}. Change it in Settings.")
}

static KEYS: Mutex<Vec<KeyStatus>> = Mutex::new(Vec::new());
static SKIPPED: AtomicBool = AtomicBool::new(false);
/// One round at a time (the guard thread and *Try again*).
static PASS: Mutex<()> = Mutex::new(());
static T0: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

fn now_ms() -> u64 {
    T0.get_or_init(Instant::now).elapsed().as_millis() as u64
}

fn is_test_instance() -> bool {
    std::env::var("LASTSHOT_TEST_INSTANCE").as_deref() == Ok("1")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// True in test copies: no shortcuts are registered on purpose.
    pub skipped: bool,
    pub keys: Vec<KeyStatus>,
}

pub fn status() -> Status {
    Status { skipped: SKIPPED.load(Ordering::Acquire), keys: KEYS.lock().clone() }
}

#[tauri::command]
pub async fn get_hotkey_status() -> Status {
    status()
}

/// Settings' *Try again*: tries every shortcut now and returns the result.
#[tauri::command]
pub async fn retry_hotkeys(app: AppHandle) -> Status {
    if !SKIPPED.load(Ordering::Acquire) {
        let _ = tauri::async_runtime::spawn_blocking(move || pass(&app, true)).await;
    }
    status()
}

/// Called by `hotkeys::rebind` after the new combo is ours.
pub fn rebound(previous: &str, accel: &str) {
    let now = now_ms();
    if let Some(k) = KEYS.lock().iter_mut().find(|k| k.accel.eq_ignore_ascii_case(previous)) {
        k.rebound(accel, now);
    }
}

/// Adds, changes or (with an empty `accel`) removes one extra shortcut,
/// such as the mic-mute or the frames click-through key, so it is retried
/// and checked like the others. Test copies register nothing.
pub fn set(app: &AppHandle, action: &str, accel: &str) -> Result<(), String> {
    if is_test_instance() || SKIPPED.load(Ordering::Acquire) {
        return if accel.is_empty() { Ok(()) } else { crate::hotkeys::validate(accel).map(|_| ()) };
    }
    if !accel.is_empty() {
        crate::hotkeys::validate(accel)?;
    }
    let old = {
        let mut keys = KEYS.lock();
        let old = keys.iter().position(|k| k.action == action).map(|i| keys.remove(i).accel);
        if !accel.is_empty() {
            keys.push(KeyStatus::new(action, accel));
        }
        old
    };
    if let Some(old) = old.filter(|o| !o.eq_ignore_ascii_case(accel)) {
        if !KEYS.lock().iter().any(|k| k.accel.eq_ignore_ascii_case(&old)) {
            if let Ok(sc) = crate::hotkeys::parse(&old) {
                if app.global_shortcut().is_registered(sc) {
                    let _ = app.global_shortcut().unregister(sc);
                }
            }
        }
    }
    if accel.is_empty() {
        let _ = app.emit(EVT, status());
        return Ok(());
    }
    let r = attempt(app, accel);
    if let Some(k) = KEYS.lock().iter_mut().find(|k| k.action == action) {
        k.record(now_ms(), r.clone());
    }
    let _ = app.emit(EVT, status());
    r
}

/// Test copies: no shortcuts, no checks.
pub fn skip() {
    SKIPPED.store(true, Ordering::Release);
}

/// Registers every shortcut (each on its own) and starts the guard thread.
pub fn start(app: &AppHandle, keys: &[(&str, String)]) {
    if is_test_instance() {
        skip();
        return;
    }
    {
        // Keys added earlier with `set` (mic, frames) stay.
        let mut all = KEYS.lock();
        all.retain(|k| !keys.iter().any(|(a, _)| *a == k.action));
        all.extend(keys.iter().map(|(a, k)| KeyStatus::new(a, k)));
    }
    pass(app, true);
    let app = app.clone();
    let _ = std::thread::Builder::new().name("hotkey-guard".into()).spawn(move || run(app));
}

/// Tries `accel`: registers it when it is not ours, or takes it back when
/// Windows says it is free although we think we have it.
fn attempt(app: &AppHandle, accel: &str) -> Result<(), String> {
    let sc = crate::hotkeys::validate(accel)?;
    let gs = app.global_shortcut();
    if gs.is_registered(sc) {
        match os::probe_free(&sc) {
            Some(true) => gs.register(sc).map_err(|e| e.to_string()),
            _ => Ok(()),
        }
    } else {
        gs.register(sc).map_err(|e| {
            let e = e.to_string();
            if e.to_ascii_lowercase().contains("already") {
                "Another app is using it".to_string()
            } else {
                e
            }
        })
    }
}

/// One round: `all` checks every shortcut, otherwise only the due retries.
fn pass(app: &AppHandle, all: bool) {
    let _one = PASS.lock();
    let now = now_ms();
    let todo: Vec<(String, String)> = KEYS
        .lock()
        .iter()
        .filter(|k| all || k.retry_due(now))
        .map(|k| (k.action.clone(), k.accel.clone()))
        .collect();
    if todo.is_empty() {
        return;
    }
    let mut changed = false;
    let mut notes = Vec::new();
    for (action, accel) in todo {
        let r = attempt(app, &accel);
        let ok = r.is_ok();
        let current = {
            let mut keys = KEYS.lock();
            match keys.iter_mut().find(|k| k.action == action && k.accel == accel) {
                Some(k) => {
                    changed |= k.record(now_ms(), r);
                    true
                }
                None => false,
            }
        };
        // Rebound meanwhile: let go of the old combo if we just took it.
        if !current && ok && !KEYS.lock().iter().any(|k| k.accel == accel) {
            if let Ok(sc) = crate::hotkeys::parse(&accel) {
                let _ = app.global_shortcut().unregister(sc);
            }
        }
    }
    let now = now_ms();
    for k in KEYS.lock().iter_mut() {
        if k.take_notify(now) {
            notes.push(message(&k.action, &k.accel));
        }
    }
    if changed {
        let _ = app.emit(EVT, status());
    }
    for n in notes {
        log::warn!("[lastshot] {n}");
        use tauri_plugin_notification::NotificationExt;
        let _ = app.notification().builder().title("Lastshot shortcut").body(n).show();
    }
}

fn run(app: AppHandle) {
    let mut last_tick = now_ms();
    let mut last_check = last_tick;
    let mut unlocked = os::input_desktop_open();
    let mut shell = os::shell_window();
    loop {
        std::thread::sleep(Duration::from_secs(1));
        let now = now_ms();
        // A tick that took far longer than a second: the PC slept.
        let resumed = now.saturating_sub(last_tick) > 4_000;
        last_tick = now;
        let u = os::input_desktop_open();
        let just_unlocked = u && !unlocked;
        unlocked = u;
        let s = os::shell_window();
        let explorer_restarted = s != 0 && s != shell;
        shell = s;
        let all = resumed || just_unlocked || explorer_restarted || now.saturating_sub(last_check) >= CHECK_MS;
        if all {
            last_check = now;
        }
        pass(&app, all);
    }
}

#[cfg(windows)]
mod os {
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

    #[link(name = "user32")]
    extern "system" {
        fn RegisterHotKey(hwnd: isize, id: i32, mods: u32, vk: u32) -> i32;
        fn UnregisterHotKey(hwnd: isize, id: i32) -> i32;
        fn OpenInputDesktop(flags: u32, inherit: i32, access: u32) -> isize;
        fn CloseDesktop(h: isize) -> i32;
        fn GetShellWindow() -> isize;
    }
    const MOD_ALT: u32 = 1;
    const MOD_CONTROL: u32 = 2;
    const MOD_SHIFT: u32 = 4;
    const MOD_WIN: u32 = 8;
    const MOD_NOREPEAT: u32 = 0x4000;
    const PROBE_ID: i32 = 0xB00F;

    pub fn vk(code: &Code) -> Option<u32> {
        use Code::*;
        let letters = [KeyA, KeyB, KeyC, KeyD, KeyE, KeyF, KeyG, KeyH, KeyI, KeyJ, KeyK, KeyL, KeyM, KeyN, KeyO, KeyP, KeyQ, KeyR, KeyS, KeyT, KeyU, KeyV, KeyW, KeyX, KeyY, KeyZ];
        if let Some(i) = letters.iter().position(|c| c == code) {
            return Some(0x41 + i as u32);
        }
        let digits = [Digit0, Digit1, Digit2, Digit3, Digit4, Digit5, Digit6, Digit7, Digit8, Digit9];
        if let Some(i) = digits.iter().position(|c| c == code) {
            return Some(0x30 + i as u32);
        }
        let f = [F1, F2, F3, F4, F5, F6, F7, F8, F9, F10, F11, F12, F13, F14, F15, F16, F17, F18, F19, F20, F21, F22, F23, F24];
        if let Some(i) = f.iter().position(|c| c == code) {
            return Some(0x70 + i as u32);
        }
        Some(match code {
            Space => 0x20,
            PrintScreen => 0x2C,
            Insert => 0x2D,
            Delete => 0x2E,
            Home => 0x24,
            End => 0x23,
            PageUp => 0x21,
            PageDown => 0x22,
            Pause => 0x13,
            _ => return None,
        })
    }

    /// Some(true) when nobody holds the combo (so not us either), Some(false)
    /// when someone does, None when it cannot be checked.
    pub fn probe_free(sc: &Shortcut) -> Option<bool> {
        let key = vk(&sc.key)?;
        let mut mods = MOD_NOREPEAT;
        if sc.mods.contains(Modifiers::ALT) {
            mods |= MOD_ALT;
        }
        if sc.mods.contains(Modifiers::CONTROL) {
            mods |= MOD_CONTROL;
        }
        if sc.mods.contains(Modifiers::SHIFT) {
            mods |= MOD_SHIFT;
        }
        if sc.mods.intersects(Modifiers::SUPER | Modifiers::META) {
            mods |= MOD_WIN;
        }
        unsafe {
            if RegisterHotKey(0, PROBE_ID, mods, key) != 0 {
                UnregisterHotKey(0, PROBE_ID);
                Some(true)
            } else {
                Some(false)
            }
        }
    }

    /// False while the PC is locked (the sign-in screen has the input).
    pub fn input_desktop_open() -> bool {
        unsafe {
            let h = OpenInputDesktop(0, 0, 0x0100 /* DESKTOP_SWITCHDESKTOP */);
            if h == 0 {
                false
            } else {
                CloseDesktop(h);
                true
            }
        }
    }

    pub fn shell_window() -> isize {
        unsafe { GetShellWindow() }
    }
}

#[cfg(not(windows))]
mod os {
    pub fn probe_free(_: &tauri_plugin_global_shortcut::Shortcut) -> Option<bool> {
        None
    }
    pub fn input_desktop_open() -> bool {
        true
    }
    pub fn shell_window() -> isize {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retries_every_three_seconds_until_it_works() {
        let mut k = KeyStatus::new("save", "Alt+C");
        assert!(k.retry_due(0) || k.retry_due(RETRY_MS));
        assert!(k.record(1_000, Err("Another app is using it".into())));
        assert!(!k.retry_due(2_000));
        assert!(k.retry_due(4_000));
        // Same error again: nothing new to show.
        assert!(!k.record(4_000, Err("Another app is using it".into())));
        assert!(k.record(7_000, Ok(())));
        assert!(k.ok && k.error.is_none());
        assert!(!k.retry_due(100_000));
    }

    #[test]
    fn notifies_once_after_fifteen_seconds() {
        let mut k = KeyStatus::new("save", "Alt+C");
        k.record(0, Err("taken".into()));
        k.record(3_000, Err("taken".into()));
        assert!(!k.take_notify(14_999));
        assert!(k.take_notify(15_000));
        assert!(!k.take_notify(30_000), "only once");
        // Works again, then fails again: a new notice for the new failure.
        k.record(31_000, Ok(()));
        assert!(!k.take_notify(60_000));
        k.record(61_000, Err("taken".into()));
        assert!(!k.take_notify(70_000));
        assert!(k.take_notify(76_000));
    }

    #[test]
    fn rebind_clears_the_failure() {
        let mut k = KeyStatus::new("snip", "Alt+S");
        k.record(0, Err("taken".into()));
        k.rebound("Alt+Shift+S", 5_000);
        assert!(k.ok && k.accel == "Alt+Shift+S" && !k.take_notify(60_000));
    }

    #[test]
    fn plain_messages() {
        assert_eq!(
            message("save", "Alt+C"),
            "Alt+C is being used by another app; clips can't be saved with it. Change it in Settings."
        );
        assert!(message("record", "Alt+R").contains("recordings"));
    }

    #[cfg(windows)]
    #[test]
    fn maps_keys_for_the_os_check() {
        use tauri_plugin_global_shortcut::Code;
        assert_eq!(os::vk(&Code::KeyC), Some(0x43));
        assert_eq!(os::vk(&Code::Digit7), Some(0x37));
        assert_eq!(os::vk(&Code::F9), Some(0x78));
        assert_eq!(os::vk(&Code::Backslash), None);
    }

    /// The OS check tells free from taken. Uses Ctrl+Alt+Shift+F24, a key
    /// no keyboard has, held for a moment by another thread.
    #[cfg(windows)]
    #[test]
    fn os_check_sees_a_taken_combo() {
        let sc = crate::hotkeys::parse("Ctrl+Alt+Shift+F24").unwrap();
        assert_eq!(os::probe_free(&sc), Some(true));
        let (tx, rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
        let t = std::thread::spawn(move || {
            #[link(name = "user32")]
            extern "system" {
                fn RegisterHotKey(hwnd: isize, id: i32, mods: u32, vk: u32) -> i32;
                fn UnregisterHotKey(hwnd: isize, id: i32) -> i32;
            }
            let ok = unsafe { RegisterHotKey(0, 7, 1 | 2 | 4 | 0x4000, 0x87) } != 0;
            tx.send(ok).unwrap();
            let _ = done_rx.recv();
            unsafe { UnregisterHotKey(0, 7) };
        });
        assert!(rx.recv().unwrap(), "could not hold the test combo");
        assert_eq!(os::probe_free(&sc), Some(false));
        done_tx.send(()).unwrap();
        t.join().unwrap();
        assert_eq!(os::probe_free(&sc), Some(true));
    }
}
