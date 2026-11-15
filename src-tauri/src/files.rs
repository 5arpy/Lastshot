//! Files outside the recorder: disk space, moving clips into the Lastshot
//! folder, opening any video file (drag & drop, "Open with Lastshot").

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::AppState;
use crate::media::library::{self, ClipMetadata};

pub const EVT_OPEN_FILE: &str = "lastshot://open-file";

/// A video passed on the command line (Explorer "Open with Lastshot") before
/// the page was ready to receive events.
static PENDING_OPEN: parking_lot::Mutex<Option<String>> = parking_lot::Mutex::new(None);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskInfo {
    /// Drive root, e.g. `C:\`.
    pub root: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
}

fn drive_root(path: &str) -> String {
    let p = Path::new(path);
    p.ancestors()
        .last()
        .map(|r| r.to_string_lossy().to_string())
        .filter(|r| !r.is_empty())
        .unwrap_or_else(|| path.to_string())
}

#[cfg(windows)]
fn disk_space(path: &str) -> Option<(u64, u64)> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let mut probe = PathBuf::from(path);
    // The folder may not exist yet: ask about its closest existing parent.
    while !probe.exists() {
        probe = probe.parent()?.to_path_buf();
    }
    let wide: Vec<u16> = probe
        .to_string_lossy()
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let (mut free, mut total) = (0u64, 0u64);
    unsafe {
        GetDiskFreeSpaceExW(PCWSTR(wide.as_ptr()), Some(&mut free), Some(&mut total), None).ok()?;
    }
    Some((total, free))
}

#[cfg(not(windows))]
fn disk_space(_path: &str) -> Option<(u64, u64)> {
    None
}

/// Total and free space of every drive holding one of `paths` (one entry per
/// drive, in the order first seen).
#[tauri::command]
pub fn get_disk_info(paths: Vec<String>) -> Vec<DiskInfo> {
    let mut out: Vec<DiskInfo> = Vec::new();
    for p in paths {
        let root = drive_root(&p);
        if out.iter().any(|d| d.root.eq_ignore_ascii_case(&root)) {
            continue;
        }
        if let Some((total, free)) = disk_space(&p) {
            out.push(DiskInfo { root, total_bytes: total, free_bytes: free });
        }
    }
    out
}

fn unique_in(dir: &Path, file_name: &str) -> PathBuf {
    let p = Path::new(file_name);
    let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = p.extension().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "mp4".into());
    let mut dest = dir.join(file_name);
    let mut n = 2;
    while dest.exists() {
        dest = dir.join(format!("{stem}_{n}.{ext}"));
        n += 1;
    }
    dest
}

/// Moves a clip (e.g. from an extra library folder) into the save folder,
/// keeping its star and tags. Works across drives (copy, then delete).
#[tauri::command]
pub async fn move_clip_to_library(state: State<'_, AppState>, path: String) -> Result<String, String> {
    let out = state.output_dir();
    let source = PathBuf::from(&path);
    if source.parent().is_some_and(|p| p.starts_with(&out)) {
        return Err("This clip is already in the Lastshot folder".into());
    }
    let dest = tauri::async_runtime::spawn_blocking(move || -> Result<PathBuf, String> {
        std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        let name = source
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .ok_or("not a file")?;
        let dest = unique_in(&out, &name);
        if std::fs::rename(&source, &dest).is_err() {
            // Another drive: copy, check, then remove the original.
            let copied = std::fs::copy(&source, &dest).map_err(|e| e.to_string())?;
            let original = std::fs::metadata(&source).map(|m| m.len()).unwrap_or(0);
            if copied != original {
                let _ = std::fs::remove_file(&dest);
                return Err("the copy came out incomplete; the clip was left where it was".into());
            }
            std::fs::remove_file(&source).map_err(|e| e.to_string())?;
        }
        Ok(dest)
    })
    .await
    .map_err(|e| format!("move failed: {e}"))??;
    let dest_s = dest.to_string_lossy().to_string();
    state.clip_meta.lock().migrate(&path, &dest_s);
    Ok(dest_s)
}

/// Clip info for any video file, so it can be opened in the editor.
#[tauri::command]
pub async fn open_video_file(app: AppHandle, path: String) -> Result<ClipMetadata, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("file not found: {path}"));
    }
    let _ = app.asset_protocol_scope().allow_file(&p);
    tauri::async_runtime::spawn_blocking(move || -> Result<ClipMetadata, String> {
        let probe = library::probe(&p).map_err(|e| format!("Lastshot cannot open this file: {e}"))?;
        let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
        let created = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let file_name = p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        Ok(ClipMetadata {
            id: format!("file-{created}-{}", meta.len()),
            path: path.clone(),
            title: file_name.trim_end_matches(".mp4").replace('_', " "),
            file_name,
            duration_seconds: probe.duration_seconds,
            size_bytes: meta.len(),
            created_unix_ms: created,
            width: probe.width,
            height: probe.height,
            fps: probe.fps,
            has_audio: probe.has_audio,
            game: None,
            thumbnail: None,
            favorite: false,
            tags: Vec::new(),
            folder: p.parent().map(|d| d.to_string_lossy().to_string()),
        })
    })
    .await
    .map_err(|e| format!("open failed: {e}"))?
}

/// A video path among command-line arguments, if any.
pub fn video_arg(args: &[String]) -> Option<String> {
    args.iter()
        .skip(1)
        .find(|a| {
            let l = a.to_ascii_lowercase();
            (l.ends_with(".mp4") || l.ends_with(".mov") || l.ends_with(".m4v")) && Path::new(a).is_file()
        })
        .cloned()
}

/// Called at startup and when a second instance is launched with a file.
pub fn request_open(app: &AppHandle, path: String) {
    *PENDING_OPEN.lock() = Some(path.clone());
    let _ = app.emit(EVT_OPEN_FILE, path);
}

/// The page asks once it is ready (an event sent before that is lost).
#[tauri::command]
pub fn take_pending_open() -> Option<String> {
    PENDING_OPEN.lock().take()
}

/// Adds or removes "Open with Lastshot" on MP4 files in Explorer's right-click
/// menu (current user only; nothing is made the default player).
pub fn set_explorer_verb(enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const NO_WINDOW: u32 = 0x0800_0000;
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let key = r"HKCU\Software\Classes\SystemFileAssociations\.mp4\shell\Lastshot";
        let run = |args: &[&str]| -> Result<(), String> {
            let ok = std::process::Command::new("reg")
                .args(args)
                .creation_flags(NO_WINDOW)
                .status()
                .map_err(|e| e.to_string())?
                .success();
            if ok { Ok(()) } else { Err("Windows refused the change".into()) }
        };
        if enabled {
            run(&["add", key, "/ve", "/d", "Open with Lastshot", "/f"])?;
            run(&["add", key, "/v", "Icon", "/d", &exe.to_string_lossy(), "/f"])?;
            let cmd = format!("\"{}\" \"%1\"", exe.to_string_lossy());
            run(&["add", &format!(r"{key}\command"), "/ve", "/d", &cmd, "/f"])?;
        } else {
            // Missing already is fine.
            let _ = run(&["delete", key, "/f"]);
        }
    }
    #[cfg(not(windows))]
    let _ = enabled;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drive_root_of_windows_paths() {
        assert_eq!(drive_root(r"C:\Users\me\Videos\Lastshot"), r"C:\");
        assert_eq!(drive_root(r"D:\Clips"), r"D:\");
    }

    #[test]
    fn finds_a_video_argument() {
        let exe = std::env::current_exe().unwrap().to_string_lossy().to_string();
        assert_eq!(video_arg(&[exe.clone(), "--flag".into()]), None);
        assert_eq!(video_arg(&[exe, r"C:\nope\missing.mp4".into()]), None);
    }
}
