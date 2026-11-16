//! Editor panel: timeline projects rendered to a new clip.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::AppState;
use crate::media::compose::{self, MediaInfo, Project};
use crate::media::library::ClipMetadata;
use crate::media::shrink::ShrinkResult;

pub const EVT_RENDER_PROGRESS: &str = "lastshot://render-progress";

/// What a file is (video / audio, length, size, frame rate). Also lets the
/// window play it.
#[tauri::command]
pub async fn media_info(app: AppHandle, path: String) -> Result<MediaInfo, String> {
    let p = PathBuf::from(&path);
    let _ = app.asset_protocol_scope().allow_file(&p);
    tauri::async_runtime::spawn_blocking(move || compose::media_info(&p).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

/// Lets the window show pictures (and play files) picked from anywhere.
#[tauri::command]
pub fn allow_media(app: AppHandle, paths: Vec<String>) {
    crate::editor_media::allow_paths(&app, &paths);
}

/// What `render_project` gives back: the new clip (save) or the shared file
/// (share, same shape as `shrink_clip`).
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum RenderOutput {
    Saved(ClipMetadata),
    Shared(ShrinkResult),
}

/// A file-name stem from the editor's suggestion: `<name>_edit_<stamp>`, or
/// `Lastshot_Edit_<stamp>` when nothing usable is left.
pub fn edit_stem(name: Option<&str>, stamp: &str) -> String {
    let clean: String = name
        .unwrap_or("")
        .chars()
        .map(|c| if c.is_control() || r#"<>:"/\|?*"#.contains(c) { '_' } else { c })
        .collect();
    let clean = clean.trim().trim_matches('.').trim();
    let clean: String = clean.chars().take(80).collect();
    let clean = clean.trim_end_matches(['.', ' ']);
    if clean.is_empty() || clean.chars().all(|c| c == '_') {
        format!("Lastshot_Edit_{stamp}")
    } else {
        format!("{clean}_edit_{stamp}")
    }
}

/// `dir/<stem>.mp4`, or `<stem>_2.mp4`, ... if taken.
fn unique(dir: &Path, stem: &str) -> PathBuf {
    let mut p = dir.join(format!("{stem}.mp4"));
    let mut n = 2;
    while p.exists() {
        p = dir.join(format!("{stem}_{n}.mp4"));
        n += 1;
    }
    p
}

/// Renders the timeline. Progress goes out as `lastshot://render-progress`
/// (0-1).
///
/// - `mode: "save"` (default): `<name>_edit_<time>.mp4` in the save folder,
///   added to Clips; returns the clip.
/// - `mode: "share"`: into the temp share folder, aiming at `targetMb` (or
///   the share size from Settings), copied to the clipboard; returns a
///   `ShrinkResult`.
#[tauri::command]
pub async fn render_project(
    app: AppHandle,
    state: State<'_, AppState>,
    project: Project,
    mode: Option<String>,
    name: Option<String>,
) -> Result<RenderOutput, String> {
    let share = match mode.as_deref().unwrap_or("save") {
        "save" => false,
        "share" => true,
        other => return Err(format!("unknown render mode {other}")),
    };
    let mut project = project;
    let dir = if share {
        if !project.target_mb.is_some_and(|mb| mb > 0.0) {
            project.target_mb = Some(state.settings.read().share_size_mb.clamp(1.0, 2000.0) as f64);
        }
        crate::paths::share_temp_dir()
    } else {
        state.output_dir()
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = chrono::Local::now().format("%Y-%m-%d_%H-%M-%S").to_string();
    let dest = unique(&dir, &edit_stem(name.as_deref(), &stamp));
    let h = app.clone();
    let out = dest.clone();
    let t0 = std::time::Instant::now();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut last = -1.0f32;
        compose::render(&project, &out, &mut |p| {
            if p - last >= 0.01 || p >= 1.0 {
                last = p;
                let _ = h.emit(EVT_RENDER_PROGRESS, p);
            }
        })
    })
    .await
    .map_err(|e| e.to_string())?;
    let r = match result {
        Ok(r) => r,
        Err(e) => {
            let _ = std::fs::remove_file(&dest);
            return Err(e.to_string());
        }
    };
    let file_name = dest.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    if share {
        crate::commands::clipboard::copy_files(std::slice::from_ref(&dest))?;
        return Ok(RenderOutput::Shared(ShrinkResult {
            path: r.path,
            file_name,
            size_bytes: r.size_bytes,
            duration_seconds: r.duration_seconds as f32,
            width: r.width,
            height: r.height,
            fps: r.fps,
            video_kbps: r.video_kbps,
            elapsed_ms: t0.elapsed().as_secs_f32() * 1000.0,
            attempts: 1,
        }));
    }
    let write = crate::media::recorder::ClipWriteResult {
        path: r.path.clone(),
        file_name,
        duration_seconds: r.duration_seconds as f32,
        size_bytes: r.size_bytes,
        flush_ms: t0.elapsed().as_secs_f32() * 1000.0,
        width: r.width,
        height: r.height,
        fps: r.fps,
        has_audio: crate::media::library::probe(&dest).map(|p| p.has_audio).unwrap_or(false),
    };
    Ok(RenderOutput::Saved(crate::hotkeys::publish_saved_clip(&app, &write, None, "editor", false, false)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stems_are_safe_file_names() {
        let s = "2026-11-16_10-00-00";
        assert_eq!(edit_stem(Some("Valorant 2026"), s), "Valorant 2026_edit_2026-11-16_10-00-00");
        assert_eq!(edit_stem(Some("a/b:c*?"), s), "a_b_c___edit_2026-11-16_10-00-00");
        assert_eq!(edit_stem(Some("  ..  "), s), "Lastshot_Edit_2026-11-16_10-00-00");
        assert_eq!(edit_stem(Some("<>"), s), "Lastshot_Edit_2026-11-16_10-00-00");
        assert_eq!(edit_stem(None, s), "Lastshot_Edit_2026-11-16_10-00-00");
        assert_eq!(edit_stem(Some(&"x".repeat(200)), s).len(), 80 + "_edit_".len() + s.len());
    }
}
