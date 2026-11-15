//! Editor panel: timeline projects rendered to a new clip.

use std::path::PathBuf;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::AppState;
use crate::media::compose::{self, MediaInfo, Project};
use crate::media::library::ClipMetadata;

pub const EVT_RENDER_PROGRESS: &str = "lastshot://render-progress";

/// What a file is (video / audio, length, size). Also lets the window play it.
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
    for p in paths {
        let _ = app.asset_protocol_scope().allow_file(PathBuf::from(p));
    }
}

/// Renders the timeline to `Lastshot_Edit_<time>.mp4` in the save folder and
/// adds it to Clips. Progress goes out as `lastshot://render-progress` (0-1).
#[tauri::command]
pub async fn render_project(
    app: AppHandle,
    state: State<'_, AppState>,
    project: Project,
) -> Result<ClipMetadata, String> {
    let dir = state.output_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = chrono::Local::now().format("%Y-%m-%d_%H-%M-%S");
    let mut dest = dir.join(format!("Lastshot_Edit_{stamp}.mp4"));
    let mut n = 2;
    while dest.exists() {
        dest = dir.join(format!("Lastshot_Edit_{stamp}_{n}.mp4"));
        n += 1;
    }
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
    let write = crate::media::recorder::ClipWriteResult {
        path: r.path.clone(),
        file_name: dest.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
        duration_seconds: r.duration_seconds as f32,
        size_bytes: r.size_bytes,
        flush_ms: t0.elapsed().as_secs_f32() * 1000.0,
        width: r.width,
        height: r.height,
        fps: r.fps,
        has_audio: crate::media::library::probe(&dest).map(|p| p.has_audio).unwrap_or(false),
    };
    Ok(crate::hotkeys::publish_saved_clip(&app, &write, None, "editor", false, false))
}
