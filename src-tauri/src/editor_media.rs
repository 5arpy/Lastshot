//! Editor helpers: waveforms, filmstrip pictures, sound export, and the
//! paths of files dropped on the page.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::media::compose::{self, AudioItem};

/// Answer to a drop: `{ id, paths }` (to the window the files were dropped on).
pub const EVT_DROP_PATHS: &str = "lastshot://drop-paths";

#[derive(Debug, Clone, Serialize)]
pub struct Peaks {
    /// Buckets per second.
    pub rate: f64,
    /// Peak per bucket, 0-255 (linear).
    pub data: Vec<u8>,
}

type PeakKey = (PathBuf, u128, u64);

fn peak_cache() -> &'static Mutex<HashMap<PeakKey, Arc<Peaks>>> {
    static C: OnceLock<Mutex<HashMap<PeakKey, Arc<Peaks>>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Waveform of a file's sound (`data` is empty when it has none). Cached
/// by path, size and change time.
#[tauri::command]
pub async fn audio_peaks(path: String) -> Result<Peaks, String> {
    let p = PathBuf::from(&path);
    let meta = std::fs::metadata(&p).map_err(|e| format!("{path}: {e}"))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let key = (p.clone(), mtime, meta.len());
    if let Some(hit) = peak_cache().lock().get(&key) {
        return Ok((**hit).clone());
    }
    let (rate, data) = tauri::async_runtime::spawn_blocking(move || compose::audio_peaks(&p))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let peaks = Peaks { rate, data };
    let mut c = peak_cache().lock();
    if c.len() >= 48 {
        c.clear();
    }
    c.insert(key, Arc::new(peaks.clone()));
    Ok(peaks)
}

/// Frames at `times` (source seconds) as PNG data URLs `height` px tall;
/// "" for a time that could not be read.
#[tauri::command]
pub async fn video_thumbs(path: String, times: Vec<f64>, height: u32) -> Result<Vec<String>, String> {
    let p = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || compose::video_thumbs(&p, &times, height))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Sound formats `export_audio` can write on this PC.
#[tauri::command]
pub async fn audio_formats() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(compose::audio_formats).await.map_err(|e| e.to_string())
}

/// Mixes `items` like the render does (volume, fades, pan, EQ, gate) over
/// `duration` seconds and writes `dest` (.wav, .m4a or .mp3). Returns the path.
#[tauri::command]
pub async fn export_audio(items: Vec<AudioItem>, duration: f64, dest: String) -> Result<String, String> {
    let d = PathBuf::from(&dest);
    if !d.is_absolute() {
        return Err("Pick where to save the sound.".into());
    }
    if let Some(dir) = d.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let out = d.clone();
    tauri::async_runtime::spawn_blocking(move || compose::export_audio(&items, duration, &out, &mut |_| {}))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    Ok(d.to_string_lossy().to_string())
}

/// `{"lastshotDrop": "<id>"}` -> the id.
pub fn drop_id(message: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(message).ok()?;
    let id = v.as_object()?.get("lastshotDrop")?.as_str()?;
    (!id.is_empty() && id.len() <= 128).then(|| id.to_string())
}

#[derive(Debug, Clone, Serialize)]
struct DropPaths {
    id: String,
    paths: Vec<String>,
}

/// HTML drops carry no file paths, and Tauri's own drop handling is off so
/// that HTML drag and drop works. The page posts
/// `postMessageWithAdditionalObjects(JSON.stringify({lastshotDrop: id}), files)`;
/// WebView2 hands us the files, and we answer with their paths on
/// `lastshot://drop-paths` (also letting the page play them). Every other
/// message (Tauri's IPC among them) is left alone.
pub fn install_drop_bridge(win: &tauri::WebviewWindow) {
    #[cfg(windows)]
    {
        let w = win.clone();
        let r = win.with_webview(move |wv| unsafe {
            use webview2_com::Microsoft::Web::WebView2::Win32::{
                ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs2,
            };
            use webview2_com::{take_pwstr, WebMessageReceivedEventHandler};
            use windows_core_61::{Interface, PWSTR};
            let Ok(core) = wv.controller().CoreWebView2() else { return };
            let handler = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut raw = PWSTR::null();
                if args.TryGetWebMessageAsString(&mut raw).is_err() || raw.is_null() {
                    return Ok(());
                }
                let Some(id) = drop_id(&take_pwstr(raw)) else { return Ok(()) };
                let mut paths = Vec::new();
                if let Ok(objs) = args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>().and_then(|a| a.AdditionalObjects()) {
                    let mut n = 0u32;
                    let _ = objs.Count(&mut n);
                    for i in 0..n {
                        let Ok(file) = objs.GetValueAtIndex(i).and_then(|o| o.cast::<ICoreWebView2File>()) else {
                            continue;
                        };
                        let mut p = PWSTR::null();
                        if file.Path(&mut p).is_ok() && !p.is_null() {
                            let s = take_pwstr(p);
                            if !s.is_empty() {
                                paths.push(s);
                            }
                        }
                    }
                }
                send_drop(&w, id, paths);
                Ok(())
            }));
            let mut token = 0i64;
            if let Err(e) = core.add_WebMessageReceived(&handler, &mut token) {
                log::warn!("[lastshot] drop bridge: {e}");
            }
        });
        if let Err(e) = r {
            log::warn!("[lastshot] drop bridge not installed: {e}");
        }
    }
    #[cfg(not(windows))]
    let _ = win;
}

#[cfg(windows)]
fn send_drop(w: &tauri::WebviewWindow, id: String, paths: Vec<String>) {
    use tauri::{Emitter, EventTarget};
    allow_paths(w.app_handle(), &paths);
    let label = w.label().to_string();
    let _ = w.emit_to(EventTarget::webview_window(label), EVT_DROP_PATHS, DropPaths { id, paths });
}

/// Lets the page load these files through the asset protocol.
pub fn allow_paths(app: &AppHandle, paths: &[String]) {
    for p in paths {
        let _ = app.asset_protocol_scope().allow_file(PathBuf::from(p));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_our_drop_message_is_taken() {
        assert_eq!(drop_id(r#"{"lastshotDrop":"17-abc"}"#).as_deref(), Some("17-abc"));
        assert_eq!(drop_id(r#"{"cmd":"plugin:event|listen","callback":1}"#), None);
        assert_eq!(drop_id(r#"{"lastshotDrop":5}"#), None);
        assert_eq!(drop_id(r#"{"lastshotDrop":""}"#), None);
        assert_eq!(drop_id("not json"), None);
        assert_eq!(drop_id(r#"["lastshotDrop"]"#), None);
    }

    /// Writes a short tone to wav / m4a / mp3 in a temp folder (needs Media
    /// Foundation): `cargo test --lib editor_media -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn sound_export_on_this_pc() {
        let formats = compose::audio_formats();
        println!("audio formats on this PC: {formats:?}");
        let dir = std::env::temp_dir().join(format!("lastshot-audio-export-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // A tone file to mix from: 1 s of 440 Hz.
        let src = dir.join("tone.wav");
        let mut m = compose::Mix::new(1.0);
        for i in 0..m.frames() {
            let v = 0.3 * (2.0 * std::f32::consts::PI * 440.0 * i as f32 / 48_000.0).sin();
            m.samples[i * 2] = v;
            m.samples[i * 2 + 1] = v;
        }
        compose::write_wav(&m, &src).unwrap();
        let item: AudioItem = serde_json::from_value(serde_json::json!({
            "path": src, "start": 0.25, "duration": 0.75, "srcIn": 0, "volume": 1,
            "fadeIn": 0.1, "fadeOut": 0.1, "pan": 0.3, "eq": [3, 0, -3], "gate": -50
        }))
        .unwrap();
        for ext in ["wav", "m4a", "mp3"] {
            let out = dir.join(format!("out.{ext}"));
            let r = compose::export_audio(std::slice::from_ref(&item), 1.0, &out, &mut |_| {});
            let size = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
            println!("{ext}: {r:?}, {size} bytes");
            if formats.iter().any(|f| f == ext) {
                assert!(r.is_ok() && size > 0, "{ext}");
            } else {
                assert!(r.is_err());
            }
        }
        let peaks = compose::audio_peaks(&src).unwrap();
        println!("peaks: rate {} n {} max {:?}", peaks.0, peaks.1.len(), peaks.1.iter().max());
        assert_eq!(peaks.0, 100.0);
        assert!((99..=101).contains(&peaks.1.len()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn png_url(w: u32, h: u32, alpha: bool) -> String {
        use base64::Engine;
        let img = image::RgbaImage::from_fn(w, h, |x, y| {
            let a = if alpha && (x + y) % 7 == 0 { 0 } else { 255 };
            image::Rgba([(x * 255 / w) as u8, (y * 255 / h) as u8, 128, a])
        });
        let mut png = Vec::new();
        image::ImageEncoder::write_image(
            image::codecs::png::PngEncoder::new(&mut png),
            img.as_raw(),
            w,
            h,
            image::ExtendedColorType::Rgba8,
        )
        .unwrap();
        format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&png))
    }

    /// Renders small projects through Media Foundation (layers, turns,
    /// regions, sound), then reads them back (info, thumbs, peaks):
    /// `cargo test --lib editor_media -- --ignored --nocapture`.
    /// `LASTSHOT_RENDER_BENCH=1` adds a 5 s 1080p60 two-layer render.
    #[test]
    #[ignore]
    fn render_on_this_pc() {
        let dir = std::env::temp_dir().join(format!("lastshot-render-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let tone = dir.join("tone.wav");
        let mut m = compose::Mix::new(3.0);
        for i in 0..m.frames() {
            let v = 0.3 * (2.0 * std::f32::consts::PI * 330.0 * i as f32 / 48_000.0).sin();
            m.samples[i * 2] = v;
            m.samples[i * 2 + 1] = v;
        }
        compose::write_wav(&m, &tone).unwrap();
        let s = |p: &std::path::Path| p.to_string_lossy().to_string();

        // A: a still with sound.
        let a = dir.join("a.mp4");
        let job: compose::Project = serde_json::from_value(serde_json::json!({
            "width": 640, "height": 360, "fps": 30,
            "video": [{"png": png_url(320, 180, false), "start": 0, "duration": 2, "srcIn": 0, "z": 0}],
            "overlays": [], "regions": [],
            "audio": [{"path": s(&tone), "start": 0, "duration": 2, "srcIn": 0, "volume": 1, "fadeIn": 0, "fadeOut": 0, "pan": 0, "eq": [0,0,0], "gate": null}],
            "targetMb": null
        }))
        .unwrap();
        let r = compose::render(&job, &a, &mut |_| {}).unwrap();
        println!("A: {r:?}");
        let info = compose::media_info(&a).unwrap();
        println!("A info: {info:?}");
        assert_eq!((info.kind.as_str(), info.width, info.height, info.has_audio), ("video", 640, 360, true));
        assert!((info.fps.unwrap() - 30.0).abs() < 0.01);

        // B: A twice (plain, and cropped/turned/flipped/small on top), a
        // transparent still, blur and pixelate boxes, a gap at the end.
        let b = dir.join("b.mp4");
        let job: compose::Project = serde_json::from_value(serde_json::json!({
            "width": 640, "height": 360, "fps": 30,
            "video": [
                {"path": s(&a), "start": 0, "duration": 2, "srcIn": 0, "z": 0},
                {"path": s(&a), "start": 0.5, "duration": 1, "srcIn": 0.2, "z": 1, "crop": {"x":0.25,"y":0.25,"w":0.5,"h":0.5},
                 "rot90": 90, "flipH": true, "scale": 0.5, "cx": 0.75, "cy": 0.25, "fill": false},
                {"png": png_url(200, 100, true), "start": 0, "duration": 1.5, "srcIn": 0, "z": 2, "scale": 0.3, "cx": 0.2, "cy": 0.8}
            ],
            "overlays": [{"png": png_url(64, 32, false), "start": 0, "duration": 1, "x": 0.1, "y": 0.1, "opacity": 0.8}],
            "regions": [
                {"kind": "blur", "start": 0, "duration": 2, "x": 0.4, "y": 0.4, "w": 0.2, "h": 0.2, "strength": 8},
                {"kind": "pixelate", "start": 1, "duration": 1, "x": 0, "y": 0, "w": 0.3, "h": 0.3, "strength": 16}
            ],
            "audio": [{"path": s(&tone), "start": 0, "duration": 2.5, "srcIn": 0.5, "volume": 1.5, "fadeIn": 0.2, "fadeOut": 0.5, "pan": -0.4, "eq": [4,-2,3], "gate": -40}],
            "targetMb": null
        }))
        .unwrap();
        let r = compose::render(&job, &b, &mut |_| {}).unwrap();
        println!("B: {r:?}");
        assert!((r.duration_seconds - 2.5).abs() < 1e-6);
        let thumbs = compose::video_thumbs(&b, &[0.0, 0.5, 1.0, 2.2, 0.2, 9.0], 60).unwrap();
        for (i, t) in thumbs.iter().enumerate() {
            println!("thumb {i}: {} bytes", t.len());
        }
        assert!(thumbs[..5].iter().all(|t| t.starts_with("data:image/png;base64,")));
        // LASTSHOT_RENDER_KEEP=<dir>: save full-size frames of B to look at.
        if let Ok(keep) = std::env::var("LASTSHOT_RENDER_KEEP") {
            use base64::Engine;
            let keep = PathBuf::from(keep);
            std::fs::create_dir_all(&keep).unwrap();
            let frames = compose::video_thumbs(&b, &[0.25, 1.0, 1.25], 360).unwrap();
            for (i, f) in frames.iter().enumerate() {
                let bytes = base64::engine::general_purpose::STANDARD.decode(f.split_once(',').unwrap().1).unwrap();
                std::fs::write(keep.join(format!("b{i}.png")), bytes).unwrap();
            }
            std::fs::write(keep.join("a0.png"), {
                let f = compose::video_thumbs(&a, &[0.5], 360).unwrap().remove(0);
                base64::engine::general_purpose::STANDARD.decode(f.split_once(',').unwrap().1).unwrap()
            })
            .unwrap();
        }
        let (rate, peaks) = compose::audio_peaks(&b).unwrap();
        println!("B peaks: rate {rate}, {} values, max {:?}", peaks.len(), peaks.iter().max());
        assert!(peaks.len() > 200);
        // A file without sound: empty peaks.
        let silent = dir.join("silent.mp4");
        let job: compose::Project = serde_json::from_value(serde_json::json!({
            "width": 64, "height": 64, "fps": 10,
            "video": [{"png": png_url(64, 64, false), "start": 0, "duration": 0.5}]
        }))
        .unwrap();
        compose::render(&job, &silent, &mut |_| {}).unwrap();
        assert_eq!(compose::audio_peaks(&silent).unwrap(), (100.0, vec![]));

        if std::env::var("LASTSHOT_RENDER_BENCH").as_deref() == Ok("1") {
            let src = dir.join("hd.mp4");
            let job: compose::Project = serde_json::from_value(serde_json::json!({
                "width": 1920, "height": 1080, "fps": 60,
                "video": [{"png": png_url(1920, 1080, false), "start": 0, "duration": 5, "srcIn": 0, "z": 0}],
                "overlays": [], "regions": [], "audio": [], "targetMb": null
            }))
            .unwrap();
            let r = compose::render(&job, &src, &mut |_| {}).unwrap();
            println!("HD still (composited): {:.0} ms for 300 frames", r.elapsed_ms);
            for (label, second) in [("one plain layer (fast path)", false), ("two layers (PiP, turned)", true)] {
                let mut video = vec![serde_json::json!({"path": s(&src), "start": 0, "duration": 5, "srcIn": 0, "z": 0})];
                if second {
                    video.push(serde_json::json!({"path": s(&src), "start": 0, "duration": 5, "srcIn": 0, "z": 1,
                        "crop": {"x":0.1,"y":0.1,"w":0.8,"h":0.8}, "rot90": 180, "scale": 0.4, "cx": 0.75, "cy": 0.75}));
                }
                let job: compose::Project = serde_json::from_value(serde_json::json!({
                    "width": 1920, "height": 1080, "fps": 60, "video": video,
                    "overlays": [], "regions": [{"kind": "blur", "start": 0, "duration": 5, "x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2, "strength": 12}],
                    "audio": [], "targetMb": null
                }))
                .unwrap();
                let out = dir.join("bench.mp4");
                let r = compose::render(&job, &out, &mut |_| {}).unwrap();
                println!("HD 5 s 60 fps, {label}: {:.0} ms ({:.1} ms/frame)", r.elapsed_ms, r.elapsed_ms / 300.0);
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
