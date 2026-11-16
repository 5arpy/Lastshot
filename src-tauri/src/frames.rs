//! Pictures out of the viewer: "copy this frame" (as an image on the
//! clipboard) and "save this frame" (a lossless PNG in the Screenshots
//! folder).

use tauri::State;

use crate::commands::AppState;

const PNG_MAGIC: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// Decodes a `data:image/png;base64,…` URL (or bare base64) and checks it is
/// a PNG, so the webview can never write anything else.
pub fn decode_png(data: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let b64 = data.split_once(',').map(|(_, d)| d).unwrap_or(data);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("bad picture data: {e}"))?;
    if bytes.len() < 8 || bytes[..8] != PNG_MAGIC {
        return Err("that is not a PNG picture".into());
    }
    Ok(bytes)
}

/// A free file name `<stem>.png` (then `<stem>_2.png`, …) in `dir`.
pub fn free_png_path(dir: &std::path::Path, stem: &str) -> std::path::PathBuf {
    let stem = crate::commands::sanitize_file_stem(stem, "Lastshot frame");
    let mut p = dir.join(format!("{stem}.png"));
    let mut n = 2;
    while p.exists() {
        p = dir.join(format!("{stem}_{n}.png"));
        n += 1;
    }
    p
}

#[tauri::command]
pub async fn viewer_copy_png(png: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = decode_png(&png)?;
        crate::snip::copy_png(&bytes)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Saves into the Screenshots folder; returns the file's path.
#[tauri::command]
pub async fn viewer_save_png(state: State<'_, AppState>, png: String, name: String) -> Result<String, String> {
    let dir = state.settings.read().screenshots_dir();
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = decode_png(&png)?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = free_png_path(&dir, &name);
        std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
        Ok(path.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_png_data_is_accepted() {
        assert!(decode_png("data:image/png;base64,iVBORw0KGgoAAAA=").is_ok());
        assert!(decode_png("data:image/png;base64,R0lGODlh").is_err()); // GIF
        assert!(decode_png("not base64 !!").is_err());
    }

    #[test]
    fn free_names_never_overwrite() {
        let dir = std::env::temp_dir().join(format!("lastshot-frames-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = free_png_path(&dir, "shot:1");
        assert_eq!(a.file_name().unwrap(), "shot1.png");
        std::fs::write(&a, b"x").unwrap();
        let b = free_png_path(&dir, "shot:1");
        assert_eq!(b.file_name().unwrap(), "shot1_2.png");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
