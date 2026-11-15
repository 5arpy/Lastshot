//! Where Lastshot keeps its small state files (settings, clip metadata, probe
//! cache): `%APPDATA%\Lastshot`.
//!
//! Lastshot started as a fork of ClipFlow. On the first run, if there is no
//! Lastshot folder yet but a ClipFlow one exists, its files are copied over so
//! settings, favorites and tags carry across. The ClipFlow folder is left
//! untouched.

use std::path::PathBuf;
use std::sync::Once;

pub const APP_DIR_NAME: &str = "Lastshot";
const LEGACY_DIR_NAME: &str = "ClipFlow";
const MIGRATED_FILES: &[&str] = &["settings.json", "clip_meta.json", "probe_cache.json"];

fn base_dir() -> PathBuf {
    #[cfg(windows)]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return PathBuf::from(appdata);
        }
    }
    std::env::temp_dir()
}

/// `%APPDATA%\Lastshot`, migrated from `%APPDATA%\ClipFlow` once.
pub fn app_data_dir() -> PathBuf {
    static MIGRATE: Once = Once::new();
    let dir = base_dir().join(APP_DIR_NAME);
    MIGRATE.call_once(|| migrate_from_legacy(&dir));
    dir
}

pub fn app_file(name: &str) -> PathBuf {
    app_data_dir().join(name)
}

fn migrate_from_legacy(dir: &PathBuf) {
    if dir.join("settings.json").exists() {
        return;
    }
    let legacy = base_dir().join(LEGACY_DIR_NAME);
    if !legacy.join("settings.json").exists() {
        return;
    }
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    for name in MIGRATED_FILES {
        let from = legacy.join(name);
        if from.exists() {
            if let Err(e) = std::fs::copy(&from, dir.join(name)) {
                log::warn!("[lastshot] could not migrate {name} from ClipFlow: {e}");
            }
        }
    }
    log::info!("[lastshot] imported settings from {}", legacy.display());
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
