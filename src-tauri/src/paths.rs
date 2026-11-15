//! Where Lastshot keeps its small state files (settings, clip metadata, probe
//! cache): `%APPDATA%\Lastshot`. Lastshot reads nothing from other apps.

use std::path::PathBuf;

pub const APP_DIR_NAME: &str = "Lastshot";

fn base_dir() -> PathBuf {
    #[cfg(windows)]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return PathBuf::from(appdata);
        }
    }
    std::env::temp_dir()
}

/// `%APPDATA%\Lastshot`.
pub fn app_data_dir() -> PathBuf {
    base_dir().join(APP_DIR_NAME)
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
