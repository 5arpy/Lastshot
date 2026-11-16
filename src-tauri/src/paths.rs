//! Where Lastshot keeps its small state files (settings, clip metadata, probe
//! cache): `%APPDATA%\Lastshot`. Lastshot reads nothing from other apps.
//!
//! Portable mode: with a file called `portable` (or `Lastshot.portable`) next
//! to the exe, everything Lastshot keeps, the window's browser data too, goes
//! into a `Lastshot data` folder next to the exe instead.

use std::path::{Path, PathBuf};

pub const APP_DIR_NAME: &str = "Lastshot";
pub const PORTABLE_MARKERS: [&str; 2] = ["portable", "Lastshot.portable"];
pub const PORTABLE_DATA: &str = "Lastshot data";

/// The data folder when `exe_dir` holds a portable marker.
pub fn portable_dir_for(exe_dir: &Path) -> Option<PathBuf> {
    PORTABLE_MARKERS
        .iter()
        .any(|m| exe_dir.join(m).is_file())
        .then(|| exe_dir.join(PORTABLE_DATA))
}

/// `Lastshot data` next to the exe in portable mode, else None.
pub fn portable_dir() -> Option<PathBuf> {
    static DIR: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
    DIR.get_or_init(|| {
        let exe = std::env::current_exe().ok()?;
        portable_dir_for(exe.parent()?)
    })
    .clone()
}

/// Portable mode: points WebView2 at `Lastshot data\WebView`. Call before any
/// window is made.
pub fn apply_portable_env() {
    if let Some(d) = portable_dir() {
        let _ = std::fs::create_dir_all(&d);
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", d.join("WebView"));
    }
}

fn base_dir() -> PathBuf {
    #[cfg(windows)]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return PathBuf::from(appdata);
        }
    }
    std::env::temp_dir()
}

/// `%APPDATA%\Lastshot`, or `Lastshot data` next to the exe in portable mode.
pub fn app_data_dir() -> PathBuf {
    portable_dir().unwrap_or_else(|| base_dir().join(APP_DIR_NAME))
}

pub fn app_file(name: &str) -> PathBuf {
    app_data_dir().join(name)
}

/// Temporary home for "Shrink & copy" files. They must outlive the paste (the
/// chat app reads the file when it uploads), so they are cleaned up on the
/// next launch once they are a day old.
pub fn share_temp_dir() -> PathBuf {
    std::env::temp_dir().join(APP_DIR_NAME).join("share")
}

pub fn cleanup_share_temp() {
    let Ok(entries) = std::fs::read_dir(share_temp_dir()) else {
        return;
    };
    let day = std::time::Duration::from_secs(24 * 3600);
    for e in entries.flatten() {
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .map(|age| age > day)
            .unwrap_or(false);
        if old {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

#[cfg(test)]
mod portable_tests {
    use super::*;

    #[test]
    fn portable_only_with_a_marker_file() {
        let d = std::env::temp_dir().join(format!("lastshot-portable-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        assert_eq!(portable_dir_for(&d), None);
        // A folder with the marker's name does not count.
        std::fs::create_dir_all(d.join("portable")).unwrap();
        assert_eq!(portable_dir_for(&d), None);
        std::fs::write(d.join("Lastshot.portable"), "").unwrap();
        assert_eq!(portable_dir_for(&d), Some(d.join("Lastshot data")));
        let _ = std::fs::remove_dir_all(&d);
    }
}
