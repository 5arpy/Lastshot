//! The Audio tab: a simple remote for Voicemeeter, plus "send this app to
//! that output" (per-app output device), remembered and set again whenever
//! the app starts.
//!
//! The routing itself is Voicemeeter's engine and Windows' audio policy, so
//! it keeps working with every Lastshot window closed.

pub mod app_output;
pub mod voicemeeter;

use std::collections::HashSet;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::commands::AppState;
use app_output::{AudioApp, RenderDevice};
use voicemeeter::{VmLevels, VmStatus};

/// "This app always plays on that output."
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppOutputRule {
    /// Exe file name, e.g. "Discord.exe".
    pub exe: String,
    /// Endpoint id as IMMDevice::GetId returns it.
    pub device_id: String,
    /// The device's name when it was picked (shown if it is unplugged).
    #[serde(default)]
    pub device_name: String,
}

/// Adds, replaces (Some) or removes (None) the rule for `exe`. Returns true
/// when the list changed.
pub fn upsert_rule(rules: &mut Vec<AppOutputRule>, exe: &str, device: Option<(&str, &str)>) -> bool {
    let before = rules.clone();
    rules.retain(|r| !r.exe.eq_ignore_ascii_case(exe));
    if let Some((id, name)) = device {
        rules.push(AppOutputRule { exe: exe.to_string(), device_id: id.to_string(), device_name: name.to_string() });
        rules.sort_by(|a, b| a.exe.to_lowercase().cmp(&b.exe.to_lowercase()));
    }
    *rules != before
}

/// Plain exe names only ("Discord.exe"), so a rule can never name a path.
pub fn valid_exe(exe: &str) -> bool {
    let e = exe.trim();
    !e.is_empty()
        && e.len() <= 260
        && e.to_ascii_lowercase().ends_with(".exe")
        && !e.contains(['\\', '/', ':', '"', '*', '?', '<', '>', '|'])
}

// ---------------------------------------------------------------------------
// Voicemeeter commands
// ---------------------------------------------------------------------------

async fn blocking<R: Send + 'static>(f: impl FnOnce() -> R + Send + 'static) -> Result<R, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn vm_status() -> Result<VmStatus, String> {
    blocking(voicemeeter::status).await
}

#[tauri::command]
pub async fn vm_levels() -> Result<VmLevels, String> {
    blocking(voicemeeter::levels).await
}

/// Sets one whitelisted parameter (see `voicemeeter::check_param`).
#[tauri::command]
pub async fn vm_set(param: String, value: serde_json::Value) -> Result<(), String> {
    blocking(move || voicemeeter::set(&param, &value)).await?
}

#[tauri::command]
pub async fn vm_launch() -> Result<(), String> {
    blocking(voicemeeter::launch).await?
}

// ---------------------------------------------------------------------------
// Per-app output commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_render_devices() -> Result<Vec<RenderDevice>, String> {
    blocking(app_output::list_render_devices).await
}

#[tauri::command]
pub async fn list_audio_apps() -> Result<Vec<AudioApp>, String> {
    blocking(app_output::list_audio_apps).await
}

/// Reads one process's own output (None = Windows default).
#[tauri::command]
pub async fn get_app_output(pid: u32) -> Result<Option<String>, String> {
    blocking(move || app_output::get_output(pid)).await?
}

/// Sends an app to an output (`device_id`), or back to Windows' default
/// (`None`). Give `exe` to change every running copy of that app and remember
/// the choice (`remember`, default true); or `pid` for one process.
#[tauri::command]
pub async fn set_app_output(
    app: AppHandle,
    state: State<'_, AppState>,
    exe: Option<String>,
    pid: Option<u32>,
    device_id: Option<String>,
    remember: Option<bool>,
) -> Result<u32, String> {
    let device_id = device_id.filter(|d| !d.trim().is_empty());
    let procs = blocking(app_output::processes).await?;
    let exe = match (&exe, pid) {
        (Some(e), _) => e.trim().to_string(),
        (None, Some(p)) => procs
            .iter()
            .find(|(q, _)| *q == p)
            .map(|(_, e)| e.clone())
            .ok_or("That app is not running")?,
        (None, None) => return Err("Pick an app".into()),
    };
    if !valid_exe(&exe) {
        return Err(format!("Not an app name: {exe}"));
    }
    let pids: Vec<u32> = match pid {
        Some(p) => vec![p],
        None => procs.iter().filter(|(_, e)| e.eq_ignore_ascii_case(&exe)).map(|(p, _)| *p).collect(),
    };
    let devices = blocking(app_output::list_render_devices).await?;
    let name = match &device_id {
        Some(id) => Some(
            devices
                .iter()
                .find(|d| &d.id == id)
                .map(|d| d.name.clone())
                .ok_or("That output is not connected")?,
        ),
        None => None,
    };
    let id2 = device_id.clone();
    let pids2 = pids.clone();
    let changed = blocking(move || {
        let mut n = 0u32;
        let mut last_err = None;
        for p in pids2 {
            match app_output::set_output(p, id2.as_deref()) {
                Ok(()) => n += 1,
                Err(e) => last_err = Some(e),
            }
        }
        if n == 0 {
            if let Some(e) = last_err {
                return Err(e);
            }
        }
        Ok(n)
    })
    .await??;
    if remember.unwrap_or(true) {
        let mut s = state.settings.read().clone();
        let dev = device_id.as_deref().zip(name.as_deref());
        if upsert_rule(&mut s.app_outputs, &exe, dev) {
            s.save()?;
            *state.settings.write() = s;
        }
        // Already applied to these processes.
        applied(&app).lock().extend(pids.iter().map(|p| (*p, exe.to_lowercase())));
    }
    Ok(changed)
}

// ---------------------------------------------------------------------------
// Re-apply remembered choices when an app starts
// ---------------------------------------------------------------------------

type Applied = parking_lot::Mutex<HashSet<(u32, String)>>;

fn applied(app: &AppHandle) -> &Applied {
    app.state::<Applied>().inner()
}

/// Every 3 s, while any app has a remembered output: one process snapshot
/// (no COM unless a new process of a listed app appeared).
pub fn start_watcher(app: &AppHandle) {
    app.manage::<Applied>(Default::default());
    let h = app.clone();
    std::thread::Builder::new()
        .name("app-output-watch".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_secs(3));
            let Some(state) = h.try_state::<AppState>() else { break };
            let rules = state.settings.read().app_outputs.clone();
            if rules.is_empty() {
                continue;
            }
            let procs = app_output::processes();
            let done = applied(&h);
            // Forget processes that ended.
            {
                let alive: HashSet<u32> = procs.iter().map(|(p, _)| *p).collect();
                done.lock().retain(|(p, _)| alive.contains(p));
            }
            for (pid, exe) in &procs {
                let Some(rule) = rules.iter().find(|r| r.exe.eq_ignore_ascii_case(exe)) else { continue };
                let key = (*pid, exe.to_lowercase());
                if done.lock().contains(&key) {
                    continue;
                }
                match app_output::set_output(*pid, Some(&rule.device_id)) {
                    Ok(()) => log::info!("[lastshot] {exe} ({pid}) sent to {}", rule.device_name),
                    Err(e) => log::debug!("[lastshot] {exe} ({pid}): {e}"),
                }
                // Once per process, even on error (no retry storm).
                done.lock().insert(key);
            }
        })
        .ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rules_are_one_per_app() {
        let mut r = Vec::new();
        assert!(upsert_rule(&mut r, "Discord.exe", Some(("id1", "AUX"))));
        assert!(upsert_rule(&mut r, "spotify.exe", Some(("id2", "VAIO3"))));
        assert!(!upsert_rule(&mut r, "Discord.exe", Some(("id1", "AUX"))));
        assert!(upsert_rule(&mut r, "discord.EXE", Some(("id3", "Input"))));
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].device_id, "id3");
        assert!(upsert_rule(&mut r, "DISCORD.exe", None));
        assert_eq!(r.len(), 1);
        assert!(!upsert_rule(&mut r, "nothing.exe", None));
    }

    #[test]
    fn only_plain_exe_names() {
        assert!(valid_exe("Discord.exe"));
        assert!(valid_exe("lastshot-tone.exe"));
        assert!(!valid_exe(r"C:\Windows\x.exe"));
        assert!(!valid_exe("x.dll"));
        assert!(!valid_exe(""));
        assert!(!valid_exe("a/b.exe"));
    }
}
