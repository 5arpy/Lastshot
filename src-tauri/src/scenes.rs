//! Studio scenes: a named set of "what to record" plus its layers (pictures,
//! text, webcam, clock, timer), switched with one click. Kept in
//! `studio_scenes.json` so they work without the window.
//!
//! Switching to a scene with the same source only swaps the layers (instant,
//! also while recording). A scene with another source changes the source
//! like *What to record* does (not while recording).

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::commands::AppState;
use crate::media::layers::LayerSpec;
use crate::media::CaptureSource;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Scene {
    pub id: String,
    pub name: String,
    /// None = keep whatever is being recorded.
    pub source: Option<CaptureSource>,
    pub layers: Vec<LayerSpec>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Scenes {
    pub active: Option<String>,
    pub scenes: Vec<Scene>,
}

impl Scenes {
    pub fn find(&self, id: &str) -> Option<&Scene> {
        self.scenes.iter().find(|s| s.id == id)
    }

    /// Drops scenes without an id, repeated ids and an active id that is gone.
    pub fn cleaned(mut self) -> Self {
        let mut seen = std::collections::HashSet::new();
        self.scenes.retain(|s| !s.id.is_empty() && seen.insert(s.id.clone()));
        if self.active.as_deref().map(|a| self.find(a).is_none()).unwrap_or(false) {
            self.active = None;
        }
        self
    }
}

fn file() -> std::path::PathBuf {
    crate::paths::app_file("studio_scenes.json")
}

pub fn load() -> Scenes {
    std::fs::read_to_string(file())
        .ok()
        .and_then(|r| serde_json::from_str::<Scenes>(&r).ok())
        .unwrap_or_default()
        .cleaned()
}

fn store(s: &Scenes) -> Result<(), String> {
    if let Some(d) = file().parent() {
        let _ = std::fs::create_dir_all(d);
    }
    std::fs::write(file(), serde_json::to_string_pretty(s).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_scenes() -> Scenes {
    load()
}

#[tauri::command]
pub fn save_scenes(scenes: Scenes) -> Result<Scenes, String> {
    let s = scenes.cleaned();
    store(&s)?;
    Ok(s)
}

/// Switches to a scene: its layers at once, then its source when it has one
/// that differs. Returns a message when the source could not change (while
/// recording); the layers changed anyway.
#[tauri::command]
pub async fn switch_scene(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<Option<String>, String> {
    let mut all = load();
    let scene = all.find(&id).cloned().ok_or("That scene no longer exists")?;
    crate::studio::set_studio_layers(app.clone(), state.clone(), scene.layers.clone())?;
    all.active = Some(id);
    store(&all)?;
    let mut note = None;
    if let Some(src) = scene.source {
        if let Err(e) = crate::recording::set_source(&app, src).await {
            note = Some(e);
        }
    }
    let _ = tauri::Emitter::emit(&app, "lastshot://settings-changed", ());
    Ok(note)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scenes_round_trip_and_clean_up() {
        let raw = r#"{"active":"gone","scenes":[
            {"id":"a","name":"Game","source":{"kind":"display"},"layers":[{"id":"t","kind":"text","text":"Hi"}]},
            {"id":"b","name":"Chat","source":{"kind":"window","hwnd":5,"exe":"Discord.exe","title":"Discord"}},
            {"id":"a","name":"Copy"},
            {"name":"No id"}
        ]}"#;
        let s: Scenes = serde_json::from_str::<Scenes>(raw).unwrap().cleaned();
        assert_eq!(s.scenes.len(), 2);
        assert_eq!(s.active, None);
        assert_eq!(s.find("a").unwrap().layers[0].text.as_deref(), Some("Hi"));
        assert!(matches!(s.find("b").unwrap().source, Some(CaptureSource::Window { .. })));
        let back: Scenes = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        assert_eq!(back, s);
    }
}
