//! "Crop from screen" window capture support: where a window is on the
//! desktop and whether anything covers it.
//!
//! Cropping the window out of the duplicated desktop never calls into the app
//! (no hooks, no PrintWindow, no extra DWM session), so it cannot add input
//! lag. It only works while the window is fully on one monitor and nothing is
//! on top of it; the Automatic method switches to Graphics Capture otherwise.

use serde::{Deserialize, Serialize};

/// How a window source is captured.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum WindowMethod {
    /// Crop from the screen while the window is visible, Graphics Capture
    /// while it is covered, minimised or partly off screen.
    #[default]
    Auto,
    /// Always crop the window's area out of the screen picture.
    Crop,
    /// Always Windows.Graphics.Capture (works when covered).
    Capture,
}

/// Integer rectangle in desktop pixels (right/bottom exclusive).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct IRect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl IRect {
    pub fn width(&self) -> i32 {
        (self.right - self.left).max(0)
    }
    pub fn height(&self) -> i32 {
        (self.bottom - self.top).max(0)
    }
    pub fn is_empty(&self) -> bool {
        self.width() == 0 || self.height() == 0
    }
    pub fn intersects(&self, o: &IRect) -> bool {
        !self.is_empty() && !o.is_empty() && self.left < o.right && o.left < self.right && self.top < o.bottom && o.top < self.bottom
    }
    pub fn contains(&self, o: &IRect) -> bool {
        o.left >= self.left && o.top >= self.top && o.right <= self.right && o.bottom <= self.bottom
    }
}

/// The window can be cropped from the screen: it lies fully on the monitor
/// and none of the windows above it overlap it.
pub fn unobstructed(window: IRect, monitor: IRect, above: &[IRect]) -> bool {
    !window.is_empty() && monitor.contains(&window) && !above.iter().any(|r| r.intersects(&window))
}

/// Debounces the crop / capture choice: covering switches to capture at once
/// (so the covering window never ends up in the video), uncovering waits a
/// little so a passing tooltip or menu does not flip the method every frame.
#[derive(Debug, Default)]
pub struct MethodChooser {
    clear_for_ms: u64,
}

impl MethodChooser {
    pub const SETTLE_MS: u64 = 400;

    /// Returns true when the crop method should be used for this frame.
    pub fn crop(&mut self, visible: bool, elapsed_ms: u64) -> bool {
        if !visible {
            self.clear_for_ms = 0;
            return false;
        }
        self.clear_for_ms = self.clear_for_ms.saturating_add(elapsed_ms);
        self.clear_for_ms >= Self::SETTLE_MS
    }
}

#[cfg(windows)]
pub use imp::*;

#[cfg(windows)]
mod imp {
    use super::IRect;
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindow, GetWindowDisplayAffinity, GetWindowLongPtrW, IsIconic, IsWindow, IsWindowVisible, GWL_EXSTYLE,
        GW_HWNDPREV, WS_EX_TRANSPARENT,
    };

    /// The window's visible bounds (without the invisible resize border).
    pub fn window_rect(hwnd: HWND) -> Option<IRect> {
        unsafe {
            if !IsWindow(hwnd).as_bool() {
                return None;
            }
            let mut r = RECT::default();
            DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &mut r as *mut _ as *mut _, std::mem::size_of::<RECT>() as u32).ok()?;
            Some(IRect { left: r.left, top: r.top, right: r.right, bottom: r.bottom })
        }
    }

    pub fn is_minimised(hwnd: HWND) -> bool {
        unsafe { IsIconic(hwnd).as_bool() }
    }

    /// Rectangles of the visible windows above `hwnd` in the Z order that
    /// would show in a screen capture. Click-through overlays and windows
    /// hidden from capture are skipped. At most `limit` windows are walked.
    pub fn windows_above(hwnd: HWND, limit: usize) -> Vec<IRect> {
        let mut out = Vec::new();
        let mut cur = hwnd;
        for _ in 0..limit {
            let prev = match unsafe { GetWindow(cur, GW_HWNDPREV) } {
                Ok(h) if !h.is_invalid() => h,
                _ => break,
            };
            cur = prev;
            unsafe {
                if !IsWindowVisible(cur).as_bool() || IsIconic(cur).as_bool() {
                    continue;
                }
                let ex = GetWindowLongPtrW(cur, GWL_EXSTYLE) as u32;
                if ex & WS_EX_TRANSPARENT.0 != 0 {
                    continue;
                }
                let mut cloaked = 0u32;
                let _ = DwmGetWindowAttribute(cur, DWMWA_CLOAKED, &mut cloaked as *mut _ as *mut _, 4);
                if cloaked != 0 {
                    continue;
                }
                let mut affinity = 0u32;
                if GetWindowDisplayAffinity(cur, &mut affinity).is_ok() && affinity != 0 {
                    // WDA_MONITOR / WDA_EXCLUDEFROMCAPTURE: not in the capture.
                    continue;
                }
            }
            if let Some(r) = window_rect(cur) {
                out.push(r);
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(l: i32, t: i32, rr: i32, b: i32) -> IRect {
        IRect { left: l, top: t, right: rr, bottom: b }
    }

    #[test]
    fn visible_only_when_on_monitor_and_uncovered() {
        let mon = r(0, 0, 1920, 1080);
        let win = r(100, 100, 900, 700);
        assert!(unobstructed(win, mon, &[]));
        // A window elsewhere does not matter; touching edges do not overlap.
        assert!(unobstructed(win, mon, &[r(900, 100, 1200, 400), r(1000, 800, 1100, 900)]));
        // Anything overlapping, even one pixel, covers it.
        assert!(!unobstructed(win, mon, &[r(899, 699, 1000, 800)]));
        // Partly off this monitor.
        assert!(!unobstructed(r(1800, 100, 2100, 400), mon, &[]));
        // A second monitor to the left (negative coordinates).
        assert!(unobstructed(r(-1500, 10, -100, 900), r(-1920, 0, 0, 1080), &[]));
        assert!(!unobstructed(IRect::default(), mon, &[]));
    }

    #[test]
    fn chooser_switches_away_at_once_and_back_after_settling() {
        let mut c = MethodChooser::default();
        assert!(!c.crop(true, 16)); // not settled yet
        assert!(!c.crop(true, 200));
        assert!(c.crop(true, 200)); // 416 ms clear
        assert!(!c.crop(false, 16)); // covered: capture immediately
        assert!(!c.crop(true, 16));
    }
}
