//! Picture and clip pop-outs that never keep the keyboard.
//!
//! A frame is built with WS_EX_NOACTIVATE, but a click inside its WebView2
//! still activates it: the click lands on the browser process's child
//! window, which takes the focus, and that activates our top-level window.
//! Keys then stopped going to the app being traced (Blender, a browser).
//!
//! The frame's top-level window is subclassed:
//! - WM_MOUSEACTIVATE answers MA_NOACTIVATE (the classic fix, for clicks that
//!   do reach it);
//! - when the frame is activated anyway, it hands the foreground back to the
//!   window that had it, once every mouse button is up (handing it back
//!   during a press would cancel the frame's own drag, resize or pan);
//! - while the frame's menu or a typed field is open (the page says so with
//!   `frame_keys`), it keeps the keyboard, and gives it back when they close.
//!
//! The window that had the foreground is known from WM_ACTIVATE (windows of
//! this thread, such as Lastshot's main window) or from a foreground
//! WinEvent (out of context, other processes only; no input hook).

#[cfg(windows)]
mod imp {
    use parking_lot::Mutex;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_MBUTTON, VK_RBUTTON, VK_XBUTTON1, VK_XBUTTON2};
    use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, KillTimer, PostMessageW,
        SetForegroundWindow, SetTimer, EVENT_SYSTEM_FOREGROUND, MA_NOACTIVATE, WA_INACTIVE, WINEVENT_OUTOFCONTEXT,
        WINEVENT_SKIPOWNPROCESS, WM_ACTIVATE, WM_APP, WM_MOUSEACTIVATE, WM_NCDESTROY, WM_TIMER,
    };

    const SUBCLASS_ID: usize = 0x4C53_514B; // "LSQK"
    const TIMER_ID: usize = 0x4C51;
    /// Posted by `set_keys(.., false)`: give the keyboard back now.
    const WM_HAND_BACK: u32 = WM_APP + 0x51;
    /// Posted by `set_keys(.., true)`: the menu needs the keyboard, also when
    /// the foreground was handed back before the page said so (a slow page).
    const WM_TAKE_KEYS: u32 = WM_APP + 0x52;

    /// The last foreground window of another process.
    static LAST_OTHER: AtomicIsize = AtomicIsize::new(0);
    static HOOKED: AtomicBool = AtomicBool::new(false);

    #[derive(Default, Clone, Copy)]
    struct State {
        /// The frame's menu or a typed field is open: keep the keyboard.
        keys: bool,
        /// Who had the foreground before the frame took it.
        prev: isize,
        /// Timer ticks since every mouse button went up.
        up: u8,
    }
    static FRAMES: Mutex<Option<HashMap<isize, State>>> = Mutex::new(None);

    fn with<R>(h: isize, f: impl FnOnce(&mut State) -> R) -> Option<R> {
        FRAMES.lock().as_mut()?.get_mut(&h).map(f)
    }

    unsafe extern "system" fn on_foreground(_: HWINEVENTHOOK, _event: u32, hwnd: HWND, _: i32, _: i32, _: u32, _: u32) {
        if !hwnd.is_invalid() {
            LAST_OTHER.store(hwnd.0 as isize, Ordering::Relaxed);
        }
    }

    fn buttons_down() -> bool {
        [VK_LBUTTON, VK_RBUTTON, VK_MBUTTON, VK_XBUTTON1, VK_XBUTTON2]
            .iter()
            .any(|k| unsafe { GetAsyncKeyState(k.0 as i32) } as u16 & 0x8000 != 0)
    }

    unsafe fn usable(h: isize) -> bool {
        let w = HWND(h as _);
        h != 0 && IsWindow(w).as_bool() && IsWindowVisible(w).as_bool() && !IsIconic(w).as_bool()
    }

    /// Gives the foreground back to the window that had it, if the frame
    /// still has it.
    unsafe fn hand_back(hwnd: HWND) {
        let h = hwnd.0 as isize;
        let Some(st) = with(h, |s| *s) else { return };
        if st.keys || GetForegroundWindow() != hwnd {
            return;
        }
        let to = if usable(st.prev) { st.prev } else { LAST_OTHER.load(Ordering::Relaxed) };
        if to != h && usable(to) {
            let _ = SetForegroundWindow(HWND(to as _));
        }
    }

    unsafe extern "system" fn proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, _data: usize) -> LRESULT {
        let h = hwnd.0 as isize;
        match msg {
            WM_MOUSEACTIVATE => {
                if with(h, |s| !s.keys).unwrap_or(false) {
                    return LRESULT(MA_NOACTIVATE as isize);
                }
            }
            WM_ACTIVATE if (wparam.0 & 0xFFFF) as u32 != WA_INACTIVE => {
                // lParam: the window losing activation when it is on this
                // thread (Lastshot's main window); else the WinEvent's.
                let other = lparam.0;
                let prev = if other != 0 && other != h { other } else { LAST_OTHER.load(Ordering::Relaxed) };
                if with(h, |s| {
                    s.prev = prev;
                    s.up = 0;
                    !s.keys
                })
                .unwrap_or(false)
                {
                    let _ = SetTimer(hwnd, TIMER_ID, 30, None);
                }
            }
            WM_TAKE_KEYS => {
                let _ = KillTimer(hwnd, TIMER_ID);
                if GetForegroundWindow() != hwnd {
                    // Allowed: the click that opened the menu was ours.
                    let _ = SetForegroundWindow(hwnd);
                }
                return LRESULT(0);
            }
            WM_HAND_BACK => {
                with(h, |s| s.up = 0);
                let _ = SetTimer(hwnd, TIMER_ID, 30, None);
                return LRESULT(0);
            }
            WM_TIMER if wparam.0 == TIMER_ID => {
                // Wait for the press to end (the frame's drag goes on), then
                // a moment more: a right-click's menu says so on release.
                let down = buttons_down();
                let up = with(h, |s| {
                    s.up = if down { 0 } else { s.up.saturating_add(1) };
                    s.up
                })
                .unwrap_or(u8::MAX);
                if up >= 3 {
                    let _ = KillTimer(hwnd, TIMER_ID);
                    hand_back(hwnd);
                }
                return LRESULT(0);
            }
            WM_NCDESTROY => {
                if let Some(m) = FRAMES.lock().as_mut() {
                    m.remove(&h);
                }
                let _ = RemoveWindowSubclass(hwnd, Some(proc), SUBCLASS_ID);
            }
            _ => {}
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }

    /// # Safety
    /// `h` is a top-level window of this process; call on its thread.
    pub unsafe fn install(h: isize) {
        FRAMES.lock().get_or_insert_with(HashMap::new).entry(h).or_default();
        let _ = SetWindowSubclass(HWND(h as _), Some(proc), SUBCLASS_ID, 0);
        if !HOOKED.swap(true, Ordering::AcqRel) {
            // Out of context: delivered through this thread's message loop.
            let hook = SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                None,
                Some(on_foreground),
                0,
                0,
                WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
            );
            if hook.is_invalid() {
                HOOKED.store(false, Ordering::Release);
            }
            // Until the first foreground change: what is in front now.
            let fg = GetForegroundWindow();
            let mut pid = 0u32;
            GetWindowThreadProcessId(fg, Some(&mut pid));
            if pid != std::process::id() {
                LAST_OTHER.store(fg.0 as isize, Ordering::Relaxed);
            }
        }
    }

    /// The page's menu or typed field opened (`on`) or closed.
    pub fn set_keys(h: isize, on: bool) {
        let changed = with(h, |s| std::mem::replace(&mut s.keys, on) != on).unwrap_or(false);
        if changed {
            unsafe {
                let _ = PostMessageW(HWND(h as _), if on { WM_TAKE_KEYS } else { WM_HAND_BACK }, WPARAM(0), LPARAM(0));
            }
        }
    }
}

/// Makes a picture or clip frame's window hand the keyboard back after a
/// click (see the module notes). Boards are left alone: they take keys.
pub fn install(win: &tauri::WebviewWindow) {
    #[cfg(windows)]
    if let Ok(hwnd) = win.hwnd() {
        let h = hwnd.0 as isize;
        // A subclass must be set on the window's own thread.
        let _ = win.run_on_main_thread(move || unsafe { imp::install(h) });
    }
    #[cfg(not(windows))]
    let _ = win;
}

/// The frame's page has a menu or a typed field open (`on`), or closed it.
pub fn set_keys(win: &tauri::WebviewWindow, on: bool) {
    #[cfg(windows)]
    if let Ok(hwnd) = win.hwnd() {
        imp::set_keys(hwnd.0 as isize, on);
    }
    #[cfg(not(windows))]
    let _ = (win, on);
}
