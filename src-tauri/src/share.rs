//! Sharing: shrink a clip under a size limit (optionally straight onto the
//! clipboard, ready to paste into Discord), and drag clips out of the app into
//! other programs. Everything stays on this PC.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::{clipboard, AppState};
use crate::media::shrink::{self, Crop, Segment, ShrinkResult, Target};

pub const EVT_SHRINK_PROGRESS: &str = "clipflow://shrink-progress";

#[derive(Clone, Serialize)]
struct ShrinkProgress {
    path: String,
    progress: f32,
}

/// Re-encodes a clip (or the `start..end` part of it) to fit the size limit
/// from Settings.
///
/// - `copy`: put the result on the clipboard as a file, ready to paste.
/// - `keep`: save it next to the original. Otherwise it goes to a temp folder
///   that is cleaned a day later, so quick shares do not clutter the library.
#[tauri::command]
pub async fn shrink_clip(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    start: Option<f32>,
    end: Option<f32>,
    copy: bool,
    keep: bool,
) -> Result<ShrinkResult, String> {
    let target_mb = state.settings.read().share_size_mb.clamp(1.0, 2000.0);
    let target_bytes = (target_mb as f64 * 1_000_000.0) as u64;
    let source = PathBuf::from(&path);
    let dir = if keep {
        source
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(crate::paths::share_temp_dir)
    } else {
        crate::paths::share_temp_dir()
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = shrink::output_path(&dir, &source, target_bytes);

    let h = app.clone();
    let p = path.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut last = -1.0f32;
        shrink::shrink_to_size(
            &source,
            &dest,
            target_bytes,
            start.unwrap_or(0.0),
            end,
            &mut |progress| {
                if progress - last >= 0.02 || progress >= 1.0 {
                    last = progress;
                    let _ = h.emit(
                        EVT_SHRINK_PROGRESS,
                        ShrinkProgress { path: p.clone(), progress },
                    );
                }
            },
        )
    })
    .await
    .map_err(|e| format!("shrink task failed: {e}"))?
    .map_err(|e| e.to_string())?;

    if copy {
        clipboard::copy_files(&[PathBuf::from(&result.path)])?;
    }
    Ok(result)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentArg {
    path: String,
    start: f32,
    end: Option<f32>,
}

/// `dir/<stem>.mp4`, or `<stem>_2.mp4`, ... if taken.
fn unique(dir: &std::path::Path, stem: &str) -> PathBuf {
    let mut p = dir.join(format!("{stem}.mp4"));
    let mut n = 2;
    while p.exists() {
        p = dir.join(format!("{stem}_{n}.mp4"));
        n += 1;
    }
    p
}

/// The clip editor's export: joins `segments` (parts of one clip, or several
/// clips) in order, optionally crops the picture, and re-encodes.
///
/// - `mode: "save"`: full quality, saved as a new clip (next to the original,
///   or in the clips folder when several clips are joined).
/// - `mode: "share"`: fits the size limit from Settings and goes to the temp
///   share folder; `copy` puts it on the clipboard.
///
/// Progress is reported on the shrink-progress channel under `progressKey`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn export_clip(
    app: AppHandle,
    state: State<'_, AppState>,
    segments: Vec<SegmentArg>,
    crop: Option<Crop>,
    mode: String,
    copy: bool,
    progress_key: Option<String>,
) -> Result<ShrinkResult, String> {
    let first = segments.first().ok_or("nothing to export")?;
    let first_path = PathBuf::from(&first.path);
    let key = progress_key.unwrap_or_else(|| first.path.clone());
    let joined = segments.iter().any(|s| s.path != first.path);
    let segs: Vec<Segment> = segments
        .iter()
        .map(|s| Segment { path: PathBuf::from(&s.path), start: s.start, end: s.end })
        .collect();

    let (target, dest) = match mode.as_str() {
        "share" => {
            let mb = state.settings.read().share_size_mb.clamp(1.0, 2000.0);
            let bytes = (mb as f64 * 1_000_000.0) as u64;
            let dir = crate::paths::share_temp_dir();
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            (Target::Size(bytes), shrink::output_path(&dir, &first_path, bytes))
        }
        "save" => {
            if joined {
                let dir = state.output_dir();
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                let stem = format!("Lastshot_{}_joined", chrono::Local::now().format("%Y-%m-%d_%H-%M-%S"));
                (Target::Quality, unique(&dir, &stem))
            } else {
                let dir = first_path
                    .parent()
                    .map(|p| p.to_path_buf())
                    .ok_or("clip has no folder")?;
                let stem = first_path
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| "clip".into());
                (Target::Quality, unique(&dir, &format!("{stem}_edit")))
            }
        }
        other => return Err(format!("unknown export mode {other}")),
    };

    let h = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut last = -1.0f32;
        shrink::export(&segs, crop, target, &dest, &mut |progress| {
            if progress - last >= 0.02 || progress >= 1.0 {
                last = progress;
                let _ = h.emit(EVT_SHRINK_PROGRESS, ShrinkProgress { path: key.clone(), progress });
            }
        })
    })
    .await
    .map_err(|e| format!("export task failed: {e}"))?
    .map_err(|e| e.to_string())?;

    if copy {
        clipboard::copy_files(&[PathBuf::from(&result.path)])?;
    }
    Ok(result)
}

/// Starts a native file drag for a clip (the first path), so they can be dropped into
/// Discord, a browser upload box, Explorer and so on. Call it from the
/// webview's `dragstart` (with `preventDefault`) while the button is held.
#[tauri::command]
pub fn start_clip_drag(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let files: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    if files.is_empty() || files.iter().any(|f| !f.exists()) {
        return Err("clip not found".into());
    }
    #[cfg(all(windows, not(feature = "headless-sim")))]
    {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        app.run_on_main_thread(move || {
            if let Err(e) = unsafe { drag::run(hwnd, &files) } {
                log::warn!("[lastshot] drag out failed: {e}");
            }
        })
        .map_err(|e| e.to_string())?;
    }
    #[cfg(any(not(windows), feature = "headless-sim"))]
    {
        let _ = (window, files);
    }
    Ok(())
}

#[cfg(all(windows, not(feature = "headless-sim")))]
mod drag {
    use std::path::PathBuf;

    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::IDataObject;
    use windows::Win32::System::Ole::{OleInitialize, IDropSource, DROPEFFECT_COPY};
    use windows::Win32::UI::Shell::{
        BHID_DataObject, IShellItem, SHCreateItemFromParsingName, SHDoDragDrop,
    };

    pub unsafe fn run(hwnd: isize, files: &[PathBuf]) -> windows::core::Result<()> {
        // The UI thread is already an OLE STA under WebView2; this is a no-op
        // then, and makes sure of it otherwise.
        let _ = OleInitialize(None);

        let path = HSTRING::from(files[0].as_os_str());
        let item: IShellItem = SHCreateItemFromParsingName(PCWSTR(path.as_ptr()), None)?;
        let data: IDataObject = item.BindToHandler(None, &BHID_DataObject)?;
        SHDoDragDrop(HWND(hwnd as _), &data, None::<&IDropSource>, DROPEFFECT_COPY)?;
        Ok(())
    }
}
