//! The Clips library as a real file explorer (the Rust half):
//!
//! - list every file in a folder (not only clips), and search names below a
//!   folder;
//! - copy or move files and folders like File Explorer: from anywhere into a
//!   clips folder, never overwriting (" (2)"), with folders, across drives,
//!   undoable;
//! - put deleted items back from the Recycle Bin (undo of a delete);
//! - "Open with…" and "Properties", Windows' own dialogs;
//! - native file drags out of any Lastshot window: a shell data object with
//!   CF_HDROP and real paths, so Discord, File Explorer, browsers and other
//!   Lastshot windows accept them;
//! - real paths for files and folders dropped into any Lastshot window. The
//!   windows take HTML drops (Tauri's own drop handler is off so in-page drag
//!   and drop works), and an HTML `File` carries no path; the page hands the
//!   dropped `File`s to `chrome.webview.postMessageWithAdditionalObjects`, and
//!   WebView2 gives this side each one's path.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::AppState;
use crate::library_ops::{free_path, within};

/// Sent to the window a drop happened in: `{ id, items: [{ path, dir }] }`.
pub const EVT_DROP_PATHS: &str = "lastshot://drop-paths";
/// What a page posts (followed by the request id) with the dropped files.
pub const DROP_MESSAGE: &str = "lastshot-drop:";

const MAX_LIST: usize = 50_000;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub dir: bool,
    pub size: u64,
    pub modified_ms: i64,
    pub hidden: bool,
    pub readonly: bool,
}

fn roots(state: &AppState) -> Vec<PathBuf> {
    let mut r = vec![state.output_dir()];
    r.extend(state.settings.read().scan_folders());
    r
}

fn norm(p: &Path) -> String {
    p.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_ascii_lowercase()
}

fn test_instance() -> bool {
    std::env::var("LASTSHOT_TEST_INSTANCE").as_deref() == Ok("1")
}

/// A reason a person understands, for a folder that cannot be read.
pub fn explain(e: &std::io::Error, path: &Path) -> String {
    use std::io::ErrorKind;
    let drive = path.components().next().map(|c| c.as_os_str().to_string_lossy().to_string()).unwrap_or_default();
    match e.kind() {
        ErrorKind::NotFound => {
            if !drive.is_empty() && !Path::new(&format!("{drive}\\")).exists() {
                format!("Drive {drive} is not connected. Plug it in, or remove the link to this folder.")
            } else {
                "This folder is not there any more: it was moved, renamed or deleted.".to_string()
            }
        }
        ErrorKind::PermissionDenied => "Windows does not allow Lastshot to read this folder.".to_string(),
        _ => format!("Could not read this folder: {e}"),
    }
}

fn entry_of(e: &std::fs::DirEntry) -> Option<FsEntry> {
    let md = e.metadata().ok()?;
    #[cfg(windows)]
    let (attrs, dir) = {
        use std::os::windows::fs::MetadataExt;
        let a = md.file_attributes();
        // Junctions and folder links are folders too.
        (a, a & 0x10 != 0)
    };
    #[cfg(not(windows))]
    let (attrs, dir) = (0u32, md.is_dir());
    let name = e.file_name().to_string_lossy().to_string();
    let modified_ms = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Some(FsEntry {
        path: e.path().to_string_lossy().to_string(),
        hidden: attrs & 0x6 != 0 || name.starts_with('$') || name.eq_ignore_ascii_case("desktop.ini") || name.eq_ignore_ascii_case("thumbs.db"),
        readonly: attrs & 0x1 != 0,
        size: if dir { 0 } else { md.len() },
        dir,
        modified_ms,
        name,
    })
}

/// Everything directly inside `dir` (hidden and system items only when asked).
pub fn list_dir(dir: &Path, show_hidden: bool) -> Result<Vec<FsEntry>, String> {
    let rd = std::fs::read_dir(dir).map_err(|e| explain(&e, dir))?;
    let mut out = Vec::new();
    for e in rd.flatten() {
        if out.len() >= MAX_LIST {
            break;
        }
        if let Some(x) = entry_of(&e) {
            if show_hidden || !x.hidden {
                out.push(x);
            }
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn fs_list_dir(path: String, show_hidden: Option<bool>) -> Result<Vec<FsEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || list_dir(Path::new(&path), show_hidden.unwrap_or(false)))
        .await
        .map_err(|e| e.to_string())?
}

/// Names containing every word of `query` (any case), below `roots`, at most
/// `limit` of them, folders included. Skips hidden items.
pub fn search(roots: &[PathBuf], query: &str, limit: usize) -> Vec<FsEntry> {
    let words: Vec<String> = query.split_whitespace().map(|w| w.to_lowercase()).collect();
    if words.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut stack: Vec<(PathBuf, u32)> = roots.iter().map(|r| (r.clone(), 0)).collect();
    let mut seen = std::collections::HashSet::new();
    let started = std::time::Instant::now();
    while let Some((dir, depth)) = stack.pop() {
        if out.len() >= limit || started.elapsed() > std::time::Duration::from_secs(4) {
            break;
        }
        if !seen.insert(norm(&dir)) {
            continue;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let Some(x) = entry_of(&e) else { continue };
            if x.hidden {
                continue;
            }
            if x.dir && depth < 12 {
                stack.push((PathBuf::from(&x.path), depth + 1));
            }
            let lower = x.name.to_lowercase();
            if words.iter().all(|w| lower.contains(w)) {
                out.push(x);
                if out.len() >= limit {
                    break;
                }
            }
        }
    }
    out
}

#[tauri::command]
pub async fn fs_search(roots: Vec<String>, query: String, limit: Option<u32>) -> Result<Vec<FsEntry>, String> {
    let roots: Vec<PathBuf> = roots.into_iter().map(PathBuf::from).collect();
    let limit = limit.unwrap_or(500).clamp(1, 5000) as usize;
    tauri::async_runtime::spawn_blocking(move || search(&roots, &query, limit))
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Copy / move
// ---------------------------------------------------------------------------

/// Where each source goes in `dest`: its own name, or " (2)" when taken (also
/// by an earlier source in the same batch). A move of something already in
/// `dest` is left out. Folders never go into themselves.
pub fn plan_targets(srcs: &[PathBuf], dest: &Path, moving: bool, exists: impl Fn(&Path) -> bool) -> Result<Vec<(PathBuf, PathBuf)>, String> {
    let mut taken: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out = Vec::new();
    for src in srcs {
        let name = src.file_name().ok_or("A drive cannot be copied or moved here")?.to_string_lossy().to_string();
        if norm(dest) == norm(src) || norm(dest).starts_with(&format!("{}\\", norm(src))) {
            return Err(format!("“{name}” cannot go into itself"));
        }
        if moving && src.parent().map(norm) == Some(norm(dest)) {
            continue;
        }
        let free = |p: &Path| !exists(p) && !taken.contains(&norm(p));
        let first = dest.join(&name);
        let target = if free(&first) {
            first
        } else {
            let (stem, ext) = match name.rsplit_once('.') {
                Some((s, e)) if !s.is_empty() && !src.is_dir() => (s.to_string(), format!(".{e}")),
                _ => (name.clone(), String::new()),
            };
            (2..10_000).map(|n| dest.join(format!("{stem} ({n}){ext}"))).find(|p| free(p)).ok_or("No free name")?
        };
        taken.insert(norm(&target));
        out.push((src.clone(), target));
    }
    Ok(out)
}

/// Copies or moves `pairs` with Windows' own file operation: folders,
/// other drives, a progress window for long copies, Ctrl+Z in File Explorer.
#[cfg(windows)]
fn shell_transfer(pairs: &[(PathBuf, PathBuf)], moving: bool) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{
        SHFileOperationW, FOF_ALLOWUNDO, FOF_MULTIDESTFILES, FOF_NOCONFIRMATION, FOF_NOCONFIRMMKDIR, FOF_NOERRORUI, FOF_SILENT, FO_COPY, FO_MOVE,
        SHFILEOPSTRUCTW,
    };
    if pairs.is_empty() {
        return Ok(());
    }
    let list = |f: &dyn Fn(&(PathBuf, PathBuf)) -> &PathBuf| {
        let mut v: Vec<u16> = Vec::new();
        for p in pairs {
            v.extend(f(p).to_string_lossy().replace('/', "\\").encode_utf16());
            v.push(0);
        }
        v.push(0);
        v
    };
    let from = list(&|p| &p.0);
    let to = list(&|p| &p.1);
    let mut flags = FOF_MULTIDESTFILES.0 | FOF_NOCONFIRMATION.0 | FOF_NOCONFIRMMKDIR.0 | FOF_NOERRORUI.0 | FOF_ALLOWUNDO.0;
    if test_instance() {
        flags |= FOF_SILENT.0;
    }
    let mut op = SHFILEOPSTRUCTW {
        wFunc: if moving { FO_MOVE } else { FO_COPY },
        pFrom: PCWSTR(from.as_ptr()),
        pTo: PCWSTR(to.as_ptr()),
        fFlags: flags as u16,
        ..Default::default()
    };
    let r = unsafe { SHFileOperationW(&mut op) };
    if op.fAnyOperationsAborted.as_bool() {
        return Err("Cancelled".into());
    }
    match r {
        0 => Ok(()),
        0x20 | 0x80 => Err("A file is in use by another app. Close it and try again.".into()),
        0x5 | 0x78 => Err("Windows did not allow it (access denied).".into()),
        0x70 => Err("There is not enough free space.".into()),
        0x7C | 0x402 => Err("A source file is not there any more.".into()),
        r => Err(format!("{} failed (code {r:#x})", if moving { "Moving" } else { "Copying" })),
    }
}

#[cfg(not(windows))]
fn shell_transfer(pairs: &[(PathBuf, PathBuf)], moving: bool) -> Result<(), String> {
    for (a, b) in pairs {
        if moving {
            std::fs::rename(a, b).map_err(|e| e.to_string())?;
        } else {
            std::fs::copy(a, b).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Copies (`mode` "copy") or moves ("move") files and folders from anywhere
/// into `dest`, which must be in the clips folders. Returns `[from, to]` for
/// each item that went somewhere (for undo). Stars and tags follow a move.
#[tauri::command]
pub async fn fs_transfer(state: State<'_, AppState>, paths: Vec<String>, dest: String, mode: String) -> Result<Vec<[String; 2]>, String> {
    let roots = roots(&state);
    let dest = PathBuf::from(&dest);
    if !within(&dest, &roots) {
        return Err(format!("{} is not in your clips folders", dest.display()));
    }
    let moving = mode == "move";
    let srcs: Vec<PathBuf> = paths.iter().map(PathBuf::from).filter(|p| p.exists()).collect();
    if srcs.is_empty() {
        return Err("Nothing to copy: the files are not there any more".into());
    }
    if moving {
        for s in &srcs {
            if roots.iter().any(|r| norm(r) == norm(s)) {
                return Err("A clips folder itself cannot be moved here".into());
            }
        }
    }
    let pairs = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<(PathBuf, PathBuf)>, String> {
        std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
        let pairs = plan_targets(&srcs, &dest, moving, |p| p.exists())?;
        shell_transfer(&pairs, moving)?;
        Ok(pairs)
    })
    .await
    .map_err(|e| e.to_string())??;
    let out: Vec<[String; 2]> = pairs.iter().map(|(a, b)| [a.to_string_lossy().to_string(), b.to_string_lossy().to_string()]).collect();
    if moving {
        let mut meta = state.clip_meta.lock();
        for [from, to] in &out {
            if Path::new(to).is_dir() {
                meta.migrate_prefix(from, to);
            } else {
                meta.migrate(from, to);
            }
        }
    }
    Ok(out)
}

/// Undo of a move: puts each `[from, to]` item (now at `to`, in the clips
/// folders) back at exactly `from`. An item whose old place is taken stays.
#[tauri::command]
pub async fn fs_move_back(state: State<'_, AppState>, pairs: Vec<[String; 2]>) -> Result<u32, String> {
    let roots = roots(&state);
    let back: Vec<(PathBuf, PathBuf)> = pairs
        .iter()
        .map(|[from, to]| (PathBuf::from(to), PathBuf::from(from)))
        .filter(|(now, old)| within(now, &roots) && now.exists() && !old.exists())
        .collect();
    if back.is_empty() {
        return Err("Nothing to put back: the items moved again or their old places are taken".into());
    }
    let n = back.len() as u32;
    let moved = back.clone();
    tauri::async_runtime::spawn_blocking(move || {
        for (_, old) in &back {
            if let Some(p) = old.parent() {
                let _ = std::fs::create_dir_all(p);
            }
        }
        shell_transfer(&back, true)
    })
    .await
    .map_err(|e| e.to_string())??;
    let mut meta = state.clip_meta.lock();
    for (now, old) in &moved {
        let (a, b) = (now.to_string_lossy(), old.to_string_lossy());
        if old.is_dir() {
            meta.migrate_prefix(&a, &b);
        } else {
            meta.migrate(&a, &b);
        }
    }
    Ok(n)
}

// ---------------------------------------------------------------------------
// Clipboard: files, like File Explorer's copy / cut / paste
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Default)]
pub struct ClipboardFiles {
    pub paths: Vec<String>,
    /// Cut (File Explorer's "Preferred DropEffect" is move).
    pub cut: bool,
}

/// Puts files and folders on the clipboard (CF_HDROP), marked as cut when
/// `cut`, so File Explorer, Discord and other apps paste them.
#[tauri::command]
pub fn fs_set_clipboard(paths: Vec<String>, cut: bool) -> Result<(), String> {
    let files: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    crate::commands::clipboard::copy_files(&files)?;
    #[cfg(all(windows, not(feature = "headless-sim")))]
    unsafe {
        use windows::core::w;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::DataExchange::{CloseClipboard, OpenClipboard, RegisterClipboardFormatW, SetClipboardData};
        use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
        let fmt = RegisterClipboardFormatW(w!("Preferred DropEffect"));
        if fmt != 0 && OpenClipboard(None).is_ok() {
            if let Ok(h) = GlobalAlloc(GMEM_MOVEABLE, 4) {
                let p = GlobalLock(h) as *mut u32;
                if !p.is_null() {
                    // DROPEFFECT_MOVE = 2, DROPEFFECT_COPY = 1.
                    *p = if cut { 2 } else { 1 };
                    let _ = GlobalUnlock(h);
                    let _ = SetClipboardData(fmt, HANDLE(h.0));
                }
            }
            let _ = CloseClipboard();
        }
    }
    #[cfg(any(not(windows), feature = "headless-sim"))]
    let _ = cut;
    Ok(())
}

/// Files and folders on the clipboard (copied in File Explorer or here).
#[tauri::command]
pub fn fs_clipboard_files() -> ClipboardFiles {
    #[cfg(all(windows, not(feature = "headless-sim")))]
    unsafe {
        use windows::core::w;
        use windows::Win32::Foundation::HGLOBAL;
        use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW};
        use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};
        use windows::Win32::System::Ole::CF_HDROP;
        use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
        let mut out = ClipboardFiles::default();
        if IsClipboardFormatAvailable(CF_HDROP.0 as u32).is_err() || OpenClipboard(None).is_err() {
            return out;
        }
        if let Ok(h) = GetClipboardData(CF_HDROP.0 as u32) {
            let drop = HDROP(h.0);
            let n = DragQueryFileW(drop, u32::MAX, None);
            for i in 0..n.min(10_000) {
                let len = DragQueryFileW(drop, i, None) as usize;
                let mut buf = vec![0u16; len + 1];
                DragQueryFileW(drop, i, Some(&mut buf));
                out.paths.push(String::from_utf16_lossy(&buf[..len]));
            }
        }
        let fmt = RegisterClipboardFormatW(w!("Preferred DropEffect"));
        if fmt != 0 {
            if let Ok(h) = GetClipboardData(fmt) {
                let g = HGLOBAL(h.0);
                let p = GlobalLock(g) as *const u32;
                if !p.is_null() {
                    out.cut = *p & 2 != 0;
                    let _ = GlobalUnlock(g);
                }
            }
        }
        let _ = CloseClipboard();
        out
    }
    #[cfg(any(not(windows), feature = "headless-sim"))]
    ClipboardFiles::default()
}

// ---------------------------------------------------------------------------
// Recycle Bin: put back (undo a delete)
// ---------------------------------------------------------------------------

/// What a Recycle Bin `$I` file says: the deleted item's full path and when.
pub fn parse_recycle_info(b: &[u8]) -> Option<(String, u64)> {
    let u64_at = |i: usize| b.get(i..i + 8).map(|s| u64::from_le_bytes(s.try_into().unwrap()));
    let version = u64_at(0)?;
    let when = u64_at(16)?;
    let (start, chars) = match version {
        1 => (24usize, 260usize),
        2 => (28usize, u32::from_le_bytes(b.get(24..28)?.try_into().ok()?) as usize),
        _ => return None,
    };
    let raw = b.get(start..start + chars * 2)?;
    let wide: Vec<u16> = raw.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).take_while(|&c| c != 0).collect();
    Some((String::from_utf16_lossy(&wide), when))
}

/// The newest Recycle Bin entry of `original` on its drive: (`$R` item, `$I` file).
fn find_recycled(original: &Path) -> Option<(PathBuf, PathBuf)> {
    let s = original.to_string_lossy();
    let drive = s.get(..3).filter(|d| d.ends_with(":\\"))?;
    let bin = PathBuf::from(format!("{drive}$Recycle.Bin"));
    let want = norm(original);
    let mut best: Option<(u64, PathBuf, PathBuf)> = None;
    for user in std::fs::read_dir(&bin).ok()?.flatten() {
        let Ok(items) = std::fs::read_dir(user.path()) else { continue };
        for it in items.flatten() {
            let name = it.file_name().to_string_lossy().to_string();
            if !name.starts_with("$I") {
                continue;
            }
            let Ok(bytes) = std::fs::read(it.path()) else { continue };
            let Some((path, when)) = parse_recycle_info(&bytes) else { continue };
            if norm(Path::new(&path)) != want {
                continue;
            }
            let r = it.path().with_file_name(format!("$R{}", &name[2..]));
            if r.exists() && best.as_ref().map(|b| when > b.0).unwrap_or(true) {
                best = Some((when, r, it.path()));
            }
        }
    }
    best.map(|(_, r, i)| (r, i))
}

/// Puts items deleted from `paths` back where they were (or next to it with
/// " (2)" when the name was taken since). Returns where each one landed.
#[tauri::command]
pub async fn fs_restore(paths: Vec<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        let mut missing = 0;
        for p in &paths {
            let original = PathBuf::from(p);
            let Some((r, i)) = find_recycled(&original) else {
                missing += 1;
                continue;
            };
            let parent = original.parent().map(Path::to_path_buf).unwrap_or_default();
            let _ = std::fs::create_dir_all(&parent);
            let name = original.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let to = free_path(&parent, &name);
            if std::fs::rename(&r, &to).is_ok() {
                let _ = std::fs::remove_file(&i);
                out.push(to.to_string_lossy().to_string());
            } else {
                missing += 1;
            }
        }
        if out.is_empty() && missing > 0 {
            return Err("Not in the Recycle Bin any more (emptied, or too big for it)".into());
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Windows dialogs
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn hwnd_of(w: &tauri::WebviewWindow) -> windows::Win32::Foundation::HWND {
    windows::Win32::Foundation::HWND(w.hwnd().map(|h| h.0).unwrap_or(std::ptr::null_mut()) as _)
}

/// Windows' "Open with" dialog for a file.
#[tauri::command]
pub fn fs_open_with(app: AppHandle, window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    if !Path::new(&path).is_file() {
        return Err("That file is not there any more".into());
    }
    #[cfg(windows)]
    {
        let h = hwnd_of(&window).0 as isize;
        app.run_on_main_thread(move || {
            use windows::core::HSTRING;
            use windows::Win32::Foundation::HWND;
            use windows::Win32::UI::Shell::{SHOpenWithDialog, OAIF_ALLOW_REGISTRATION, OAIF_EXEC, OPENASINFO};
            let file = HSTRING::from(path.as_str());
            let info = OPENASINFO { pcszFile: windows::core::PCWSTR(file.as_ptr()), pcszClass: windows::core::PCWSTR::null(), oaifInFlags: OAIF_ALLOW_REGISTRATION | OAIF_EXEC };
            unsafe {
                let _ = SHOpenWithDialog(HWND(h as _), &info);
            }
        })
        .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    let _ = (app, window);
    Ok(())
}

/// Windows' Properties window for a file or folder.
#[tauri::command]
pub fn fs_properties(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err("That item is not there any more".into());
    }
    #[cfg(windows)]
    unsafe {
        use windows::core::HSTRING;
        use windows::Win32::UI::Shell::{SHObjectProperties, SHOP_FILEPATH};
        let p = HSTRING::from(path.as_str());
        if !SHObjectProperties(hwnd_of(&window), SHOP_FILEPATH, &p, None).as_bool() {
            return Err("Windows could not show the properties".into());
        }
    }
    #[cfg(not(windows))]
    let _ = window;
    Ok(())
}

// ---------------------------------------------------------------------------
// Native drags out
// ---------------------------------------------------------------------------

/// Starts a native file drag of `paths` from the calling window (call from
/// `dragstart`, after `preventDefault`, while the button is held). Targets get
/// a shell data object: CF_HDROP with the real paths, like a drag from File
/// Explorer. Copy or link only: dropping on the desktop never moves a clip
/// out of the library by accident.
#[tauri::command]
pub fn start_file_drag(app: AppHandle, window: tauri::WebviewWindow, paths: Vec<String>) -> Result<(), String> {
    let files: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).filter(|p| p.exists()).collect();
    if files.is_empty() {
        return Err("Nothing to drag: the files are not there any more".into());
    }
    #[cfg(all(windows, not(feature = "headless-sim")))]
    {
        let h = hwnd_of(&window).0 as isize;
        app.run_on_main_thread(move || {
            if let Err(e) = unsafe { drag::run(h, &files) } {
                log::warn!("[explorer] drag out failed: {e}");
            }
        })
        .map_err(|e| e.to_string())?;
    }
    #[cfg(any(not(windows), feature = "headless-sim"))]
    let _ = (app, window, files);
    Ok(())
}

#[cfg(windows)]
pub mod drag {
    use std::path::PathBuf;

    use windows::core::HSTRING;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::IDataObject;
    use windows::Win32::System::Ole::{OleInitialize, IDropSource, DROPEFFECT_COPY, DROPEFFECT_LINK};
    use windows::Win32::UI::Shell::Common::ITEMIDLIST;
    use windows::Win32::UI::Shell::{ILCreateFromPathW, ILFree, SHCreateDataObject, SHDoDragDrop};

    /// A shell data object for files anywhere (absolute item ids under the
    /// desktop): CF_HDROP, shell ids and file names, like File Explorer's.
    ///
    /// # Safety
    /// COM calls: run on a thread where OLE may be initialised (STA).
    pub unsafe fn data_object(files: &[PathBuf]) -> windows::core::Result<IDataObject> {
        let _ = OleInitialize(None);
        let mut ids: Vec<*const ITEMIDLIST> = Vec::new();
        for f in files {
            let p = HSTRING::from(f.as_os_str());
            let id = ILCreateFromPathW(&p);
            if !id.is_null() {
                ids.push(id as *const _);
            }
        }
        let r = if ids.is_empty() {
            Err(windows::core::Error::from(windows::Win32::Foundation::E_INVALIDARG))
        } else {
            SHCreateDataObject::<_, IDataObject>(None, Some(&ids), None::<&IDataObject>)
        };
        for id in ids {
            ILFree(Some(id));
        }
        let data = r?;
        // The shell only renders CF_HDROP for items of one folder; set it
        // ourselves (Discord, browsers and most apps only read CF_HDROP).
        add_hdrop(&data, files)?;
        Ok(data)
    }

    fn hdrop_format() -> windows::Win32::System::Com::FORMATETC {
        use windows::Win32::System::Com::{DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL};
        use windows::Win32::System::Ole::CF_HDROP;
        FORMATETC { cfFormat: CF_HDROP.0, ptd: std::ptr::null_mut(), dwAspect: DVASPECT_CONTENT.0, lindex: -1, tymed: TYMED_HGLOBAL.0 as u32 }
    }

    unsafe fn add_hdrop(data: &IDataObject, files: &[PathBuf]) -> windows::core::Result<()> {
        use std::os::windows::ffi::OsStrExt;
        use windows::Win32::System::Com::{STGMEDIUM, STGMEDIUM_0, TYMED_HGLOBAL};
        use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT};
        use windows::Win32::UI::Shell::DROPFILES;
        let mut wide: Vec<u16> = Vec::new();
        for f in files {
            wide.extend(f.as_os_str().encode_wide());
            wide.push(0);
        }
        wide.push(0);
        let header = std::mem::size_of::<DROPFILES>();
        let total = header + wide.len() * 2;
        let h = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, total)?;
        let p = GlobalLock(h);
        if p.is_null() {
            return Err(windows::core::Error::from(windows::Win32::Foundation::E_OUTOFMEMORY));
        }
        let df = p as *mut DROPFILES;
        (*df).pFiles = header as u32;
        (*df).fWide = true.into();
        std::ptr::copy_nonoverlapping(wide.as_ptr(), (p as *mut u8).add(header) as *mut u16, wide.len());
        let _ = GlobalUnlock(h);
        let med = STGMEDIUM { tymed: TYMED_HGLOBAL.0 as u32, u: STGMEDIUM_0 { hGlobal: h }, pUnkForRelease: std::mem::ManuallyDrop::new(None) };
        // fRelease = true: the data object owns the memory from now on.
        data.SetData(&hdrop_format(), &med, true)
    }

    /// Runs a shell drag of `files` from window `hwnd` (copy or link only).
    ///
    /// # Safety
    /// Call on the UI thread that owns `hwnd` (the drag loop pumps its messages).
    pub unsafe fn run(hwnd: isize, files: &[PathBuf]) -> windows::core::Result<()> {
        use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
        // The page asks a moment after its drag began. If the button is
        // already up, a shell drag would drop at once wherever the pointer
        // is: do nothing instead.
        if GetAsyncKeyState(VK_LBUTTON.0 as i32) >= 0 && GetAsyncKeyState(VK_RBUTTON.0 as i32) >= 0 {
            return Ok(());
        }
        let data = data_object(files)?;
        let _ = SHDoDragDrop(HWND(hwnd as _), &data, None::<&IDropSource>, DROPEFFECT_COPY | DROPEFFECT_LINK)?;
        Ok(())
    }

    /// The paths a data object carries as CF_HDROP (what drop targets read).
    ///
    /// # Safety
    /// `data` must be a live data object; COM must be initialised on this thread.
    pub unsafe fn hdrop_paths(data: &IDataObject) -> windows::core::Result<Vec<String>> {
        use windows::Win32::System::Ole::ReleaseStgMedium;
        use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
        let mut med = data.GetData(&hdrop_format())?;
        let h = HDROP(med.u.hGlobal.0);
        let n = DragQueryFileW(h, u32::MAX, None);
        let mut out = Vec::new();
        for i in 0..n {
            let len = DragQueryFileW(h, i, None) as usize;
            let mut buf = vec![0u16; len + 1];
            DragQueryFileW(h, i, Some(&mut buf));
            out.push(String::from_utf16_lossy(&buf[..len]));
        }
        ReleaseStgMedium(&mut med);
        Ok(out)
    }
}

// ---------------------------------------------------------------------------
// Real paths of dropped files
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
struct DropItem {
    path: String,
    dir: bool,
}

#[derive(Clone, Serialize)]
struct DropPaths {
    id: String,
    items: Vec<DropItem>,
}

/// Lets a page learn the paths of files and folders dropped on it (see the
/// module notes). Safe to call more than once per webview.
pub fn attach_drop_paths(webview: &tauri::Webview) {
    use std::sync::Mutex;
    static DONE: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let label = webview.label().to_string();
    {
        let mut done = DONE.lock().unwrap_or_else(|e| e.into_inner());
        if done.contains(&label) {
            return;
        }
        done.push(label.clone());
    }
    #[cfg(windows)]
    {
        let app = webview.app_handle().clone();
        let lbl = label.clone();
        let r = webview.with_webview(move |wv| unsafe {
            use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs2};
            use webview2_com::WebMessageReceivedEventHandler;
            use windows_core_061::Interface;
            let Ok(core) = wv.controller().CoreWebView2() else { return };
            let app = app.clone();
            let lbl = lbl.clone();
            let handler = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut msg = windows_core_061::PWSTR::null();
                if args.TryGetWebMessageAsString(&mut msg).is_err() {
                    return Ok(());
                }
                let msg = webview2_com::take_pwstr(msg);
                let Some(id) = msg.strip_prefix(DROP_MESSAGE) else { return Ok(()) };
                let mut items = Vec::new();
                if let Ok(a2) = args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>() {
                    if let Ok(list) = a2.AdditionalObjects() {
                        let mut n = 0u32;
                        let _ = list.Count(&mut n);
                        for i in 0..n {
                            let Ok(obj) = list.GetValueAtIndex(i) else { continue };
                            let Ok(file) = obj.cast::<ICoreWebView2File>() else { continue };
                            let mut p = windows_core_061::PWSTR::null();
                            if file.Path(&mut p).is_ok() {
                                let path = webview2_com::take_pwstr(p);
                                if !path.is_empty() {
                                    items.push(DropItem { dir: Path::new(&path).is_dir(), path });
                                }
                            }
                        }
                    }
                }
                let _ = app.emit_to(tauri::EventTarget::webview_window(&lbl), EVT_DROP_PATHS, DropPaths { id: id.to_string(), items });
                Ok(())
            }));
            let mut token = 0i64;
            let _ = core.add_WebMessageReceived(&handler, &mut token);
        });
        if r.is_err() {
            DONE.lock().unwrap_or_else(|e| e.into_inner()).retain(|l| l != &label);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lastshot-fs-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn lists_files_and_folders_and_explains_errors() {
        let d = tmp("list");
        std::fs::write(d.join("a.png"), b"x").unwrap();
        std::fs::write(d.join("desktop.ini"), b"x").unwrap();
        std::fs::create_dir(d.join("sub")).unwrap();
        let mut l = list_dir(&d, false).unwrap();
        l.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(l.iter().map(|e| (e.name.as_str(), e.dir)).collect::<Vec<_>>(), vec![("a.png", false), ("sub", true)]);
        assert_eq!(l[0].size, 1);
        assert!(l[0].modified_ms > 0);
        assert_eq!(list_dir(&d, true).unwrap().len(), 3);
        let gone = list_dir(&d.join("nope"), false).unwrap_err();
        assert!(gone.contains("not there"), "{gone}");
        let unplugged = list_dir(Path::new("Q:\\no\\such"), false).unwrap_err();
        assert!(unplugged.contains("Drive Q:") || unplugged.contains("not there"), "{unplugged}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn search_finds_every_word_below_the_roots() {
        let d = tmp("search");
        std::fs::create_dir_all(d.join("Roblox").join("best")).unwrap();
        std::fs::write(d.join("Roblox").join("best").join("Epic Win 2026.mp4"), b"x").unwrap();
        std::fs::write(d.join("win.png"), b"x").unwrap();
        let r = search(std::slice::from_ref(&d), "epic WIN", 10);
        assert_eq!(r.len(), 1);
        assert!(r[0].path.ends_with("Epic Win 2026.mp4"));
        assert_eq!(search(std::slice::from_ref(&d), "win", 10).len(), 2);
        assert_eq!(search(std::slice::from_ref(&d), "win", 1).len(), 1);
        assert!(search(std::slice::from_ref(&d), "  ", 10).is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn targets_never_overwrite_and_never_go_into_themselves() {
        let dest = PathBuf::from("C:\\Clips");
        let taken = |p: &Path| p == Path::new("C:\\Clips\\a.mp4");
        let srcs = [PathBuf::from("D:\\x\\a.mp4"), PathBuf::from("E:\\y\\a.mp4"), PathBuf::from("D:\\x\\b.mp4")];
        let t = plan_targets(&srcs, &dest, false, taken).unwrap();
        let names: Vec<_> = t.iter().map(|(_, b)| b.to_string_lossy().to_string()).collect();
        assert_eq!(names, vec!["C:\\Clips\\a (2).mp4", "C:\\Clips\\a (3).mp4", "C:\\Clips\\b.mp4"]);
        // A move into the folder it is already in does nothing.
        assert!(plan_targets(&[PathBuf::from("C:\\Clips\\c.mp4")], &dest, true, |_| false).unwrap().is_empty());
        // A copy in place gets a new name.
        let same = plan_targets(&[PathBuf::from("C:\\Clips\\a.mp4")], &dest, false, taken).unwrap();
        assert_eq!(same[0].1, PathBuf::from("C:\\Clips\\a (2).mp4"));
        assert!(plan_targets(&[PathBuf::from("C:\\Clips")], Path::new("C:\\Clips\\sub"), true, |_| false).is_err());
    }

    #[test]
    fn copies_and_moves_folders_and_files() {
        let d = tmp("transfer");
        let src = d.join("src");
        std::fs::create_dir_all(src.join("inner")).unwrap();
        std::fs::write(src.join("inner").join("f.txt"), b"hi").unwrap();
        std::fs::write(d.join("one.mp4"), b"1").unwrap();
        let dest = d.join("dest");
        std::fs::create_dir_all(&dest).unwrap();
        let pairs = plan_targets(&[src.clone(), d.join("one.mp4")], &dest, false, |p| p.exists()).unwrap();
        shell_transfer(&pairs, false).unwrap();
        assert_eq!(std::fs::read(dest.join("src").join("inner").join("f.txt")).unwrap(), b"hi");
        assert!(src.exists() && dest.join("one.mp4").exists());
        let pairs = plan_targets(&[d.join("one.mp4")], &dest, true, |p| p.exists()).unwrap();
        assert_eq!(pairs[0].1, dest.join("one (2).mp4"));
        shell_transfer(&pairs, true).unwrap();
        assert!(!d.join("one.mp4").exists() && dest.join("one (2).mp4").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn reads_recycle_bin_records() {
        let path = "C:\\Clips\\Roblox\\clip.mp4";
        let wide: Vec<u16> = path.encode_utf16().chain([0]).collect();
        let mut v2 = Vec::new();
        v2.extend(2u64.to_le_bytes());
        v2.extend(123u64.to_le_bytes());
        v2.extend(999u64.to_le_bytes());
        v2.extend((wide.len() as u32).to_le_bytes());
        for c in &wide {
            v2.extend(c.to_le_bytes());
        }
        assert_eq!(parse_recycle_info(&v2), Some((path.to_string(), 999)));
        let mut v1 = Vec::new();
        v1.extend(1u64.to_le_bytes());
        v1.extend(123u64.to_le_bytes());
        v1.extend(7u64.to_le_bytes());
        let mut fixed = wide.clone();
        fixed.resize(260, 0);
        for c in &fixed {
            v1.extend(c.to_le_bytes());
        }
        assert_eq!(parse_recycle_info(&v1), Some((path.to_string(), 7)));
        assert_eq!(parse_recycle_info(&[1, 2, 3]), None);
    }

    #[cfg(windows)]
    #[test]
    fn drags_carry_real_paths_as_cf_hdrop() {
        let d = tmp("drag");
        let a = d.join("first clip.mp4");
        std::fs::create_dir_all(d.join("other")).unwrap();
        let b = d.join("other").join("shot.png");
        std::fs::write(&a, b"a").unwrap();
        std::fs::write(&b, b"b").unwrap();
        let paths = unsafe {
            let data = drag::data_object(&[a.clone(), b.clone()]).unwrap();
            drag::hdrop_paths(&data).unwrap()
        };
        let norm_all = |v: Vec<String>| v.into_iter().map(|s| s.to_lowercase()).collect::<Vec<_>>();
        assert_eq!(
            norm_all(paths),
            norm_all(vec![a.to_string_lossy().to_string(), b.to_string_lossy().to_string()])
        );
        let _ = std::fs::remove_dir_all(&d);
    }
}
