//! File-manager actions for the Clips library: folders, move, copy, rename,
//! delete to the Recycle Bin, and a watch on the clips folder so the library
//! updates when files change in File Explorer.
//!
//! Every path must be inside the save folder or one of the extra library
//! folders. Nothing is ever overwritten: a name that is taken gets " (2)".
//! Deleting always goes to the Recycle Bin.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::AppState;

/// Sent (debounced) when files or folders change under the save folder.
pub const EVT_LIBRARY_CHANGED: &str = "lastshot://library-changed";

fn roots(state: &AppState) -> Vec<PathBuf> {
    let mut r = vec![state.output_dir()];
    r.extend(state.settings.read().scan_folders());
    r
}

fn norm(p: &Path) -> String {
    p.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_ascii_lowercase()
}

/// Whether `p` is inside (or is) one of the roots. Rejects `..` parts.
pub fn within(p: &Path, roots: &[PathBuf]) -> bool {
    if p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return false;
    }
    let s = norm(p);
    roots.iter().any(|r| {
        let r = norm(r);
        !r.is_empty() && (s == r || s.starts_with(&format!("{r}\\")))
    })
}

fn check(p: &Path, roots: &[PathBuf]) -> Result<(), String> {
    if within(p, roots) {
        Ok(())
    } else {
        Err(format!("{} is not in your clips folders", p.display()))
    }
}

/// A file or folder name the user typed: no path characters, no trailing
/// dots or spaces, not empty.
pub fn clean_name(raw: &str) -> Result<String, String> {
    let s: String = raw
        .chars()
        .map(|c| if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control() { ' ' } else { c })
        .collect();
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let s = s.trim_end_matches(['.', ' ']).trim().to_string();
    if s.is_empty() || s == "." || s == ".." {
        return Err("Type a name".into());
    }
    if s.chars().count() > 120 {
        return Err("That name is too long".into());
    }
    Ok(s)
}

/// `dir\name`, or `dir\stem (2).ext` ... when the name is taken.
pub fn free_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    (2..10_000)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .unwrap_or(first)
}

fn move_one(src: &Path, dest_dir: &Path) -> Result<PathBuf, String> {
    let name = src.file_name().ok_or("no file name")?.to_string_lossy().to_string();
    if src.parent().map(norm) == Some(norm(dest_dir)) {
        return Ok(src.to_path_buf());
    }
    if src.is_dir() && within(dest_dir, &[src.to_path_buf()]) {
        return Err("A folder cannot go into itself".into());
    }
    let dest = free_path(dest_dir, &name);
    match std::fs::rename(src, &dest) {
        Ok(()) => Ok(dest),
        Err(_) if src.is_file() => {
            // Another drive: copy, then remove the original.
            std::fs::copy(src, &dest).map_err(|e| e.to_string())?;
            std::fs::remove_file(src).map_err(|e| e.to_string())?;
            Ok(dest)
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Subfolders of the save folder and the extra library folders (also empty
/// ones), up to three levels deep.
#[tauri::command]
pub async fn library_dirs(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let roots = roots(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        fn walk(dir: &Path, depth: u32, out: &mut Vec<String>) {
            if depth > 3 || out.len() > 5000 {
                return;
            }
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let Ok(ft) = e.file_type() else { continue };
                if ft.is_dir() && !ft.is_symlink() {
                    let p = e.path();
                    let name = e.file_name().to_string_lossy().to_string();
                    if name.starts_with('.') || name.starts_with('$') {
                        continue;
                    }
                    out.push(p.to_string_lossy().to_string());
                    walk(&p, depth + 1, out);
                }
            }
        }
        for r in &roots {
            walk(r, 1, &mut out);
        }
        out
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_clip_folder(state: State<'_, AppState>, parent: String, name: String) -> Result<String, String> {
    let parent = PathBuf::from(parent);
    check(&parent, &roots(&state))?;
    let name = clean_name(&name)?;
    let dest = free_path(&parent, &name);
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().to_string())
}

/// Moves clips (or folders) into a folder. Returns the new paths, in order.
#[tauri::command]
pub async fn move_clips(state: State<'_, AppState>, paths: Vec<String>, dest: String) -> Result<Vec<String>, String> {
    let roots = roots(&state);
    let dest = PathBuf::from(dest);
    check(&dest, &roots)?;
    for p in &paths {
        check(Path::new(p), &roots)?;
    }
    let moved = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<(String, String)>, String> {
        std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for p in paths {
            let to = move_one(Path::new(&p), &dest)?;
            out.push((p, to.to_string_lossy().to_string()));
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())??;
    let mut meta = state.clip_meta.lock();
    for (from, to) in &moved {
        meta.migrate(from, to);
    }
    Ok(moved.into_iter().map(|(_, to)| to).collect())
}

/// Copies clips into a folder (" (2)" when the name is taken).
#[tauri::command]
pub async fn copy_clips_to(state: State<'_, AppState>, paths: Vec<String>, dest: String) -> Result<Vec<String>, String> {
    let roots = roots(&state);
    let dest = PathBuf::from(dest);
    check(&dest, &roots)?;
    for p in &paths {
        check(Path::new(p), &roots)?;
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<String>, String> {
        std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for p in paths {
            let src = Path::new(&p);
            if !src.is_file() {
                continue;
            }
            let name = src.file_name().ok_or("no file name")?.to_string_lossy().to_string();
            let to = free_path(&dest, &name);
            std::fs::copy(src, &to).map_err(|e| e.to_string())?;
            out.push(to.to_string_lossy().to_string());
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Renames a clip (keeps its extension) or a folder. Never replaces another
/// file: a taken name is an error the user can fix.
#[tauri::command]
pub fn rename_library_item(state: State<'_, AppState>, path: String, new_name: String) -> Result<String, String> {
    let src = PathBuf::from(&path);
    check(&src, &roots(&state))?;
    let mut name = clean_name(&new_name)?;
    if src.is_file() {
        if let Some(ext) = src.extension().map(|e| e.to_string_lossy().to_string()) {
            if !name.to_ascii_lowercase().ends_with(&format!(".{}", ext.to_ascii_lowercase())) {
                name = format!("{name}.{ext}");
            }
        }
    }
    let dest = src.parent().ok_or("no parent folder")?.join(&name);
    if dest == src {
        return Ok(path);
    }
    // Same name in other letter case is fine (Windows names ignore case).
    if dest.exists() && norm(&dest) != norm(&src) {
        return Err(format!("There is already something called \"{name}\" here"));
    }
    std::fs::rename(&src, &dest).map_err(|e| e.to_string())?;
    let to = dest.to_string_lossy().to_string();
    let mut meta = state.clip_meta.lock();
    if src.is_dir() || dest.is_dir() {
        // Clips inside the folder keep their stars and tags.
        meta.migrate_prefix(&path, &to);
    } else {
        meta.migrate(&path, &to);
    }
    Ok(to)
}

/// Sends clips or folders to the Recycle Bin (never deletes for good).
#[tauri::command]
pub async fn recycle_items(state: State<'_, AppState>, paths: Vec<String>) -> Result<u32, String> {
    let roots = roots(&state);
    for p in &paths {
        let pb = Path::new(p);
        check(pb, &roots)?;
        if roots.iter().any(|r| norm(r) == norm(pb)) {
            return Err("The clips folder itself cannot be deleted here".into());
        }
    }
    let n = paths.len() as u32;
    tauri::async_runtime::spawn_blocking(move || recycle(&paths)).await.map_err(|e| e.to_string())??;
    Ok(n)
}

/// Moves files or folders to the Recycle Bin, quietly (no dialogs).
#[cfg(windows)]
pub fn recycle(paths: &[String]) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE, SHFILEOPSTRUCTW};
    let existing: Vec<&String> = paths.iter().filter(|p| Path::new(p).exists()).collect();
    if existing.is_empty() {
        return Ok(());
    }
    // Double-NUL-terminated list of full paths.
    let mut from: Vec<u16> = Vec::new();
    for p in existing {
        from.extend(p.replace('/', "\\").encode_utf16());
        from.push(0);
    }
    from.push(0);
    let mut op = SHFILEOPSTRUCTW {
        wFunc: FO_DELETE,
        pFrom: PCWSTR(from.as_ptr()),
        fFlags: (FOF_ALLOWUNDO.0 | FOF_NOCONFIRMATION.0 | FOF_NOERRORUI.0 | FOF_SILENT.0) as u16,
        ..Default::default()
    };
    let r = unsafe { SHFileOperationW(&mut op) };
    if r != 0 {
        return Err(format!("Could not move to the Recycle Bin (code {r:#x})"));
    }
    if op.fAnyOperationsAborted.as_bool() {
        return Err("Moving to the Recycle Bin was cancelled".into());
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn recycle(paths: &[String]) -> Result<(), String> {
    for p in paths {
        let _ = std::fs::remove_file(p);
    }
    Ok(())
}

/// Watches the save folder and every linked library folder (with their
/// subfolders) for new, removed or renamed files and folders, and tells every
/// window (debounced). Cheap: one change handle per folder and one wait for
/// all of them. Follows the folders as they are linked, unlinked, unplugged
/// and plugged back in.
#[cfg(windows)]
pub fn start_watch(app: &AppHandle) {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::{HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows::Win32::Storage::FileSystem::{
        FindCloseChangeNotification, FindFirstChangeNotificationW, FindNextChangeNotification, FILE_NOTIFY_CHANGE_DIR_NAME,
        FILE_NOTIFY_CHANGE_FILE_NAME,
    };
    use windows::Win32::System::Threading::WaitForMultipleObjects;
    let app = app.clone();
    let _ = std::thread::Builder::new().name("lastshot-libwatch".into()).spawn(move || {
        let mut watching: Vec<(String, HANDLE)> = Vec::new();
        let mut pending: Option<std::time::Instant> = None;
        let mut checked = std::time::Instant::now() - std::time::Duration::from_secs(10);
        loop {
            // Which folders to watch (again every 2 s: links change, drives come and go).
            if checked.elapsed() >= std::time::Duration::from_secs(2) {
                checked = std::time::Instant::now();
                let want: Vec<PathBuf> = match app.try_state::<AppState>() {
                    Some(state) => watch_roots(&roots(&state)),
                    None => Vec::new(),
                };
                let keys: Vec<String> = want.iter().map(|p| norm(p)).collect();
                watching.retain(|(k, h)| {
                    let keep = keys.contains(k) && Path::new(k).is_dir();
                    if !keep {
                        unsafe {
                            let _ = FindCloseChangeNotification(*h);
                        }
                    }
                    keep
                });
                for (dir, key) in want.iter().zip(keys) {
                    if watching.len() >= 60 || watching.iter().any(|(k, _)| k == &key) || !dir.is_dir() {
                        continue;
                    }
                    let h = unsafe {
                        FindFirstChangeNotificationW(&HSTRING::from(dir.as_os_str()), true, FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_DIR_NAME)
                    };
                    if let Ok(h) = h {
                        watching.push((key, h));
                    }
                }
            }
            if watching.is_empty() {
                std::thread::sleep(std::time::Duration::from_secs(2));
                continue;
            }
            let handles: Vec<HANDLE> = watching.iter().map(|(_, h)| *h).collect();
            let r = unsafe { WaitForMultipleObjects(&handles, false, 1000) };
            if r != WAIT_TIMEOUT {
                let i = r.0.wrapping_sub(WAIT_OBJECT_0.0) as usize;
                if i < watching.len() {
                    pending.get_or_insert_with(std::time::Instant::now);
                    if unsafe { FindNextChangeNotification(watching[i].1) }.is_err() {
                        // The folder went away (deleted, drive unplugged): drop it; the next check re-adds it.
                        let (_, h) = watching.remove(i);
                        unsafe {
                            let _ = FindCloseChangeNotification(h);
                        }
                    }
                } else {
                    // A handle went bad: start over.
                    for (_, h) in watching.drain(..) {
                        unsafe {
                            let _ = FindCloseChangeNotification(h);
                        }
                    }
                    std::thread::sleep(std::time::Duration::from_millis(500));
                }
            }
            // Debounce: a save or a big move makes many changes at once.
            if pending.map(|t| t.elapsed() >= std::time::Duration::from_millis(600)).unwrap_or(false) {
                pending = None;
                let _ = app.emit(EVT_LIBRARY_CHANGED, ());
            }
        }
    });
}

/// The folders to watch: no duplicates, and none inside another (a watch
/// covers its subfolders).
pub fn watch_roots(roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for r in roots {
        if norm(r).is_empty() || out.iter().any(|o| within(r, std::slice::from_ref(o))) {
            continue;
        }
        out.retain(|o| !within(o, std::slice::from_ref(r)));
        out.push(r.clone());
    }
    out
}

#[cfg(not(windows))]
pub fn start_watch(_app: &AppHandle) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lastshot-libops-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn paths_must_be_inside_the_clip_folders() {
        let roots = vec![PathBuf::from(r"C:\Videos\Lastshot"), PathBuf::from(r"D:\Clips")];
        assert!(within(Path::new(r"C:\Videos\Lastshot\Roblox\a.mp4"), &roots));
        assert!(within(Path::new(r"c:\videos\lastshot"), &roots));
        assert!(within(Path::new(r"D:\Clips\x.mp4"), &roots));
        assert!(!within(Path::new(r"C:\Videos\LastshotOther\a.mp4"), &roots));
        assert!(!within(Path::new(r"C:\Videos\Lastshot\..\secret.txt"), &roots));
        assert!(!within(Path::new(r"C:\Windows\a.mp4"), &roots));
    }

    #[test]
    fn watches_each_folder_once() {
        let r = watch_roots(&[PathBuf::from(r"C:\Clips"), PathBuf::from(r"C:\Clips\Roblox"), PathBuf::from(r"D:\Games"), PathBuf::from(r"d:\games\")]);
        assert_eq!(r, vec![PathBuf::from(r"C:\Clips"), PathBuf::from(r"D:\Games")]);
        let r = watch_roots(&[PathBuf::from(r"D:\Games\Sub"), PathBuf::from(r"D:\Games")]);
        assert_eq!(r, vec![PathBuf::from(r"D:\Games")]);
    }

    #[test]
    fn names_are_cleaned() {
        assert_eq!(clean_name("  Best  clips. ").unwrap(), "Best clips");
        assert_eq!(clean_name("a/b:c").unwrap(), "a b c");
        assert!(clean_name("..").is_err());
        assert!(clean_name("   ").is_err());
    }

    #[test]
    fn never_overwrites_and_moves_files() {
        let d = tmp("move");
        let a = d.join("Roblox");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(d.join("clip.mp4"), b"one").unwrap();
        std::fs::write(a.join("clip.mp4"), b"two").unwrap();
        assert_eq!(free_path(&a, "clip.mp4"), a.join("clip (2).mp4"));
        let moved = move_one(&d.join("clip.mp4"), &a).unwrap();
        assert_eq!(moved, a.join("clip (2).mp4"));
        assert_eq!(std::fs::read(a.join("clip.mp4")).unwrap(), b"two");
        assert_eq!(std::fs::read(&moved).unwrap(), b"one");
        // Into itself is refused.
        assert!(move_one(&a, &a.join("sub")).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }
}
