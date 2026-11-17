//! Where a snip happens on a desktop of one or more monitors, and the
//! synthetic screen test copies snip instead of the real one.
//!
//! Everything here is plain geometry in physical desktop pixels, so the
//! multi-monitor rules are unit-tested over made-up layouts (never the real
//! screen).

use serde::{Deserialize, Serialize};

/// A monitor, a window or the snip area, physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct MonRect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl MonRect {
    pub const fn new(x: i32, y: i32, w: i32, h: i32) -> Self {
        Self { x, y, w, h }
    }
    pub fn right(&self) -> i32 {
        self.x + self.w
    }
    pub fn bottom(&self) -> i32 {
        self.y + self.h
    }
    pub fn contains(&self, p: (i32, i32)) -> bool {
        p.0 >= self.x && p.0 < self.right() && p.1 >= self.y && p.1 < self.bottom()
    }
    /// Squared distance from a point to the rectangle (0 inside).
    pub fn dist2(&self, p: (i32, i32)) -> i64 {
        let dx = (self.x - p.0).max(0).max(p.0 - (self.right() - 1)) as i64;
        let dy = (self.y - p.1).max(0).max(p.1 - (self.bottom() - 1)) as i64;
        dx * dx + dy * dy
    }
    pub fn union(&self, o: &MonRect) -> MonRect {
        let x = self.x.min(o.x);
        let y = self.y.min(o.y);
        MonRect::new(x, y, self.right().max(o.right()) - x, self.bottom().max(o.bottom()) - y)
    }
    /// `self` lies inside `o`, give or take `tol` pixels.
    pub fn inside(&self, o: &MonRect, tol: i32) -> bool {
        self.x >= o.x - tol && self.y >= o.y - tol && self.right() <= o.right() + tol && self.bottom() <= o.bottom() + tol
    }
    pub fn intersect(&self, o: &MonRect) -> Option<MonRect> {
        let x = self.x.max(o.x);
        let y = self.y.max(o.y);
        let r = self.right().min(o.right());
        let b = self.bottom().min(o.bottom());
        (r > x && b > y).then(|| MonRect::new(x, y, r - x, b - y))
    }
    pub fn moved(&self, dx: i32, dy: i32) -> MonRect {
        MonRect::new(self.x + dx, self.y + dy, self.w, self.h)
    }
}

/// What a snip freezes: the area on the desktop, the monitors in it
/// (relative to the area's corner) and the one the cursor was on.
#[derive(Debug, Clone, PartialEq)]
pub struct SnipArea {
    pub area: MonRect,
    pub monitors: Vec<MonRect>,
    pub home: usize,
}

/// The monitor under the point, else the nearest one.
pub fn monitor_at(monitors: &[MonRect], p: (i32, i32)) -> Option<usize> {
    if let Some(i) = monitors.iter().position(|m| m.contains(p)) {
        return Some(i);
    }
    (0..monitors.len()).min_by_key(|&i| monitors[i].dist2(p))
}

/// The snip area for a scope (Settings › Screenshots › Screens):
/// "all" (default) = every monitor at once, "cursor" = the one under the
/// mouse, "monitor:<n>" = `chosen` (falls back to the mouse's monitor when
/// that monitor is gone).
pub fn snip_area(monitors: &[MonRect], scope: &str, cursor: (i32, i32), chosen: Option<MonRect>) -> Option<SnipArea> {
    let monitors: Vec<MonRect> = monitors.iter().copied().filter(|m| m.w > 0 && m.h > 0).collect();
    let home = monitor_at(&monitors, cursor)?;
    let one = |m: MonRect| SnipArea { area: m, monitors: vec![MonRect::new(0, 0, m.w, m.h)], home: 0 };
    if scope == "cursor" {
        return Some(one(monitors[home]));
    }
    if scope.starts_with("monitor:") {
        return Some(one(chosen.unwrap_or(monitors[home])));
    }
    let area = monitors.iter().skip(1).fold(monitors[0], |a, m| a.union(m));
    Some(SnipArea { area, monitors: monitors.iter().map(|m| m.moved(-area.x, -area.y)).collect(), home })
}

/// An area recording's crop inside the recorded monitor, as fractions
/// (x, y, w, h). None = the whole monitor. Err when the box is not inside
/// that monitor (a recording covers one screen).
pub fn record_crop(region: MonRect, monitor: MonRect) -> Result<Option<[f32; 4]>, ()> {
    if region.w <= 0 || region.h <= 0 || monitor.w <= 0 || monitor.h <= 0 || !region.inside(&monitor, 2) {
        return Err(());
    }
    let r = region.intersect(&monitor).ok_or(())?;
    if r.w >= monitor.w - 2 && r.h >= monitor.h - 2 {
        return Ok(None);
    }
    let (mw, mh) = (monitor.w as f32, monitor.h as f32);
    Ok(Some([(r.x - monitor.x) as f32 / mw, (r.y - monitor.y) as f32 / mh, r.w as f32 / mw, r.h as f32 / mh]))
}

// ---------------------------------------------------------------- test screen

/// A made-up desktop for test copies (`LASTSHOT_TEST_SCREEN`, JSON):
/// `{"monitors":[[0,0,1920,1080],[1920,-200,1280,1024]],"cursor":[100,100],
/// "windows":[{"x":..,"y":..,"w":..,"h":..,"title":".."}]}` in desktop px.
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct TestScreen {
    pub monitors: Vec<[i32; 4]>,
    pub cursor: [i32; 2],
    pub windows: Vec<TestWindow>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TestWindow {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub title: String,
}

impl Default for TestScreen {
    fn default() -> Self {
        Self { monitors: vec![[0, 0, 1920, 1080]], cursor: [960, 540], windows: Vec::new() }
    }
}

impl TestScreen {
    pub fn parse(json: Option<&str>) -> TestScreen {
        json.and_then(|j| serde_json::from_str::<TestScreen>(j).ok()).filter(|t| !t.monitors.is_empty()).unwrap_or_default()
    }
    pub fn rects(&self) -> Vec<MonRect> {
        self.monitors.iter().map(|m| MonRect::new(m[0], m[1], m[2], m[3])).collect()
    }
}

/// The colour of a test monitor's pixel: one hue per monitor, in 100-px
/// squares of two shades (so a test can tell where a picture came from).
/// Outside every monitor: black.
pub fn test_pixel(monitors: &[MonRect], p: (i32, i32)) -> [u8; 3] {
    const HUES: [[u8; 3]; 4] = [[200, 50, 50], [50, 170, 70], [60, 90, 210], [200, 160, 40]];
    match monitors.iter().position(|m| m.contains(p)) {
        None => [0, 0, 0],
        Some(i) => {
            let m = monitors[i];
            let c = HUES[i % HUES.len()];
            let dark = (((p.0 - m.x) / 100) + ((p.1 - m.y) / 100)) % 2 == 1;
            if dark {
                [c[0] / 5 * 4, c[1] / 5 * 4, c[2] / 5 * 4]
            } else {
                c
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Left: 1920×1080 at 0,0 (primary). Right: 1280×1024 at 1920,-200 (higher up).
    const L: MonRect = MonRect::new(0, 0, 1920, 1080);
    const R: MonRect = MonRect::new(1920, -200, 1280, 1024);

    #[test]
    fn all_monitors_at_once_by_default() {
        let a = snip_area(&[L, R], "all", (100, 100), None).unwrap();
        assert_eq!(a.area, MonRect::new(0, -200, 3200, 1280));
        assert_eq!(a.monitors, vec![MonRect::new(0, 200, 1920, 1080), MonRect::new(1920, 0, 1280, 1024)]);
        assert_eq!(a.home, 0);
        // Unknown scopes are "all" too; the home follows the cursor.
        let b = snip_area(&[L, R], "", (2500, -100), None).unwrap();
        assert_eq!((b.area, b.home), (a.area, 1));
    }

    #[test]
    fn one_monitor_under_the_cursor_or_a_chosen_one() {
        let a = snip_area(&[L, R], "cursor", (2500, 0), None).unwrap();
        assert_eq!(a, SnipArea { area: R, monitors: vec![MonRect::new(0, 0, 1280, 1024)], home: 0 });
        // In the gap above the left monitor: the nearest one.
        assert_eq!(snip_area(&[L, R], "cursor", (100, -150), None).unwrap().area, L);
        let c = snip_area(&[L, R], "monitor:1", (100, 100), Some(R)).unwrap();
        assert_eq!(c.area, R);
        // The chosen monitor is gone: the cursor's.
        assert_eq!(snip_area(&[L, R], "monitor:3", (100, 100), None).unwrap().area, L);
        assert!(snip_area(&[], "all", (0, 0), None).is_none());
    }

    #[test]
    fn monitors_left_of_and_above_the_primary() {
        // Negative coordinates: the area starts at the top-left-most corner.
        let left = MonRect::new(-2560, -360, 2560, 1440);
        let a = snip_area(&[L, left], "all", (-100, 0), None).unwrap();
        assert_eq!(a.area, MonRect::new(-2560, -360, 4480, 1440));
        assert_eq!(a.monitors[0], MonRect::new(2560, 360, 1920, 1080));
        assert_eq!(a.home, 1);
    }

    #[test]
    fn an_area_recording_stays_on_one_screen() {
        assert_eq!(record_crop(MonRect::new(1920, -200, 1280, 1024), R), Ok(None));
        let c = record_crop(MonRect::new(2240, 56, 640, 512), R).unwrap().unwrap();
        assert!((c[0] - 0.25).abs() < 1e-6 && (c[1] - 0.25).abs() < 1e-6 && (c[2] - 0.5).abs() < 1e-6 && (c[3] - 0.5).abs() < 1e-6);
        // Across the seam, or on the other screen: no.
        assert_eq!(record_crop(MonRect::new(1800, 0, 400, 300), R), Err(()));
        assert_eq!(record_crop(MonRect::new(100, 100, 400, 300), R), Err(()));
        // A pixel or two over the edge is still this screen.
        assert_eq!(record_crop(MonRect::new(1919, -200, 1282, 1024), R), Ok(None));
    }

    #[test]
    fn the_test_screen_is_made_up_and_tells_monitors_apart() {
        let t = TestScreen::parse(Some(r#"{"monitors":[[0,0,1920,1080],[1920,-200,1280,1024]],"cursor":[2000,0]}"#));
        assert_eq!(t.rects(), vec![L, R]);
        assert_eq!(TestScreen::parse(Some("not json")).rects(), vec![L]);
        assert_eq!(TestScreen::parse(None).cursor, [960, 540]);
        let m = t.rects();
        assert_eq!(test_pixel(&m, (10, 10)), [200, 50, 50]);
        assert_eq!(test_pixel(&m, (150, 10)), [160, 40, 40]);
        assert_eq!(test_pixel(&m, (1930, -190)), [50, 170, 70]);
        assert_eq!(test_pixel(&m, (1930, -250)), [0, 0, 0]);
    }
}
