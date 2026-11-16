//! Lastshot — instant replay and snipping tool for Windows.
//! Based on ClipFlow by jaimitus and drexjgobgt (MIT).
//!
//! Tauri v2 application setup: tray icon, global shortcuts, the stats
//! heartbeat and the IPC surface.

pub mod appname;
pub mod audio_routing;
pub mod clipmeta;
pub mod files;
pub mod commands;
pub mod editor;
pub mod foreground;
pub mod hotkeys;
pub mod media;
pub mod paths;
pub mod popout;
pub mod power;
pub mod recording;
pub mod settings;
pub mod share;
pub mod snip;
pub mod studio;

use std::sync::Arc;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, WindowEvent};
use tauri_plugin_global_shortcut::ShortcutState;

use commands::{AppState, EVT_STATS};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info,lastshot=debug"),
    )
    .format_timestamp_millis()
    .init();

    let mut builder = tauri::Builder::default();
    // Automated tests set LASTSHOT_TEST_INSTANCE so a test copy runs on its
    // own instead of handing over to (and focusing) the user's running app.
    if std::env::var_os("LASTSHOT_TEST_INSTANCE").is_none() {
        builder = builder
        // Single instance: one buffer, one encoder session, one DXGI duplicator.
        // A second launch focuses the existing window instead of fighting over
        // the output (Desktop Duplication only allows one duplicator per output,
        // so instance #2 used to fail with a confusing capture error).
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(path) = files::video_arg(&argv) {
                files::request_open(app, path);
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }));
    }
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        // Optional "launch at Windows sign-in". Kept entirely native (Rust
        // calls only), so no extra JS surface or capability is needed.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    hotkeys::on_shortcut(app, shortcut, event.state());
                })
                .build(),
        )
        // Second instance ⇒ just surface the existing window; Lastshot is a
        // single-instance app by design (one buffer, one encoder session).
        .manage(AppState::new())
        .setup(|app| {
            let handle = app.handle().clone();
            // Studio's webcam preview runs in the main window.
            if let Some(w) = app.get_webview_window("main") {
                studio::allow_camera(&w);
            }

            // Old "Shrink & copy" files from previous sessions.
            std::thread::spawn(paths::cleanup_share_temp);

            build_tray(&handle)?;

            // Audio tab: remembered "this app plays on that output" choices
            // are set again whenever the app starts.
            audio_routing::start_watcher(&handle);

            if let Some(path) = files::video_arg(&std::env::args().collect::<Vec<_>>()) {
                files::request_open(&handle, path);
            }

            let (save_key, toggle_key, snip_key, record_key, autostart, cfg) = {
                let state = handle.state::<AppState>();
                let s = state.settings.read();
                (
                    s.hotkey_save.clone(),
                    s.hotkey_toggle.clone(),
                    s.hotkey_snip.clone(),
                    s.hotkey_record.clone(),
                    s.autostart_buffer,
                    // If auto-switch is on and the game already in the foreground
                    // maps to a profile, arm the buffer with that profile's
                    // capture values from frame zero.
                    s.active_profile()
                        .map(|p| s.to_profile_config(p))
                        .unwrap_or_else(|| s.to_recorder_config()),
                )
            };

            // Keep the Windows Run key in sync with the saved preference.
            // Never from a test copy: the Run key is shared with the user's
            // real install (same name), and a test profile has the option off.
            if std::env::var_os("LASTSHOT_TEST_INSTANCE").is_none() {
                use tauri_plugin_autostart::ManagerExt;
                let want = handle.state::<AppState>().settings.read().launch_at_startup;
                let autostart = handle.autolaunch();
                let is_on = autostart.is_enabled().unwrap_or(false);
                if want && !is_on {
                    let _ = autostart.enable();
                } else if !want && is_on {
                    let _ = autostart.disable();
                }
            }

            recording::sync_bar(&handle);
            studio::init(&handle);
            appname::start_tracker();

            if let Err(e) =
                hotkeys::register_all(&handle, &save_key, &toggle_key, &snip_key, &record_key)
            {
                log::warn!("[lastshot] hotkey registration: {e}");
                let h = handle.clone();
                let msg = e.clone();
                tauri::async_runtime::spawn(async move {
                    // Give the webview a beat to attach its listeners.
                    tokio::time::sleep(Duration::from_millis(900)).await;
                    let _ = h.emit(commands::EVT_ERROR, msg);
                });
            }

            // Pinned window: honour the saved always-on-top preference.
            if let Some(w) = handle.get_webview_window("main") {
                let on_top = handle
                    .state::<AppState>()
                    .settings
                    .read()
                    .always_on_top;
                if on_top {
                    let _ = w.set_always_on_top(true);
                }
            }

            // Widen the asset protocol to whatever output folder is configured.
            //
            // `tauri.conf.json` can only declare a static scope
            // ($VIDEO/Lastshot/**, $HOME/Videos/Lastshot/**), but Settings lets
            // the user point the library anywhere (e.g. D:\Clips). Without this
            // the gallery thumbnails still worked (they are data URLs from Rust)
            // while the trimmer's <video> silently refused to load — the classic
            // "NO PREVIEW STREAM" on a perfectly good clip.
            if let Some(state) = handle.try_state::<AppState>() {
                let s = state.settings.read();
                allow_asset_dir(&handle, &s.output_dir);
                for dir in &s.library_folders {
                    allow_asset_dir(&handle, dir);
                }
                if !s.recording_dir.is_empty() {
                    allow_asset_dir(&handle, &s.recording_dir);
                }
            }

            // Privacy mode starts gated when the deck or desktop is focused
            // (positively known), so the ring never accumulates desktop footage
            // before the UI's first 2 s foreground poll has a chance to run.
            if handle.state::<AppState>().settings.read().privacy_pause_when_unfocused {
                handle
                    .state::<AppState>()
                    .engine
                    .set_privacy_gate(commands::privacy_should_gate());
            }

            // Arm the buffer immediately so the very first Alt+C already has
            // history behind it.
            if autostart {
                let h = handle.clone();
                tauri::async_runtime::spawn(async move {
                    let state = h.state::<AppState>();
                    let engine = Arc::clone(&state.engine);
                    let result =
                        tauri::async_runtime::spawn_blocking(move || engine.start(cfg)).await;
                    match result {
                        Ok(Ok(stats)) => {
                            let _ = h.emit(commands::EVT_BUFFER_STATE, stats);
                        }
                        Ok(Err(e)) => {
                            let _ = h.emit(commands::EVT_ERROR, e.to_string());
                        }
                        Err(e) => {
                            let _ = h.emit(
                                commands::EVT_ERROR,
                                format!("autostart failed: {e}"),
                            );
                        }
                    }
                });
            }

            // Stats heartbeat: 1 Hz is enough for the deck's gauges and halves
            // the IPC / JSON / React work. While the deck is hidden (the normal
            // case during a match) nothing is emitted at all — a background
            // WebView render loop is exactly what makes a game lose frames.
            let h = handle.clone();
            tauri::async_runtime::spawn(async move {
                let mut ticker = tokio::time::interval(Duration::from_millis(1000));
                loop {
                    ticker.tick().await;
                    let Some(state) = h.try_state::<AppState>() else {
                        break;
                    };
                    let deck_visible = h
                        .get_webview_window("main")
                        .map(|w| {
                            w.is_visible().unwrap_or(false)
                                && !w.is_minimized().unwrap_or(false)
                        })
                        .unwrap_or(false);
                    if !deck_visible {
                        continue;
                    }
                    let stats = state.engine.stats();
                    if let Err(e) = h.emit(EVT_STATS, stats) {
                        // A single failed emit (webview reload/startup race)
                        // must not kill the heartbeat forever.
                        log::warn!("[lastshot] stats emit failed: {e}");
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            popout::on_event(window, event);
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == snip::SNIP_LABEL
                    || window.label() == recording::BAR_LABEL
                    || window.label() == recording::ANNOT_LABEL
                    || window.label() == studio::SCENE_LABEL {
                    return;
                }
                let minimize = window
                    .app_handle()
                    .try_state::<AppState>()
                    .map(|s| s.settings.read().minimize_to_tray)
                    .unwrap_or(true);
                if minimize && window.label() == "main" {
                    // Closing the window must never kill the buffer.
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::start_replay_buffer,
            commands::stop_replay_buffer,
            commands::get_engine_stats,
            commands::set_buffer_seconds,
            commands::save_instant_replay,
            commands::get_recorded_clips,
            commands::get_clip_thumbnail,
            commands::trim_clip,
            commands::split_clip,
            commands::delete_clip,
            commands::delete_clips,
            commands::delete_all_clips,
            commands::copy_clips_to_clipboard,
            commands::set_clips_favorite,
            commands::add_clips_tag,
            commands::remove_clips_tag,
            commands::rename_clip,
            commands::extract_png_frame,
            commands::save_png_snapshot,
            commands::copy_clip_to_clipboard,
            commands::reveal_clip_in_folder,
            commands::open_output_folder,
            commands::open_clip_external,
            commands::get_settings,
            commands::update_settings,
            commands::get_monitors,
            commands::get_audio_input_devices,
            commands::get_foreground_game,
            commands::get_profiles,
            commands::save_profile,
            commands::delete_profile,
            commands::set_profile_map,
            commands::apply_profile,
            commands::cleanup_old_clips,
            commands::set_clip_favorite,
            commands::set_clip_tags,
            commands::set_privacy_gate,
            commands::get_power_state,
            commands::open_releases_page,
            commands::hide_main_window,
            commands::quit_app,
            commands::simulate_device_loss,
            share::shrink_clip,
            share::export_clip,
            recording::start_recording,
            recording::stop_recording,
            recording::pause_recording,
            recording::get_bar_state,
            recording::set_mic_muted,
            recording::show_main_window,
            recording::discard_recording,
            recording::add_marker,
            recording::hide_bar,
            recording::show_bar,
            recording::set_bar_compact,
            recording::set_drawing,
            recording::set_drawing_passthrough,
            files::get_disk_info,
            files::move_clip_to_library,
            files::open_video_file,
            files::take_pending_open,
            share::start_clip_drag,
            snip::start_snip,
            snip::snip_get_capture,
            snip::snip_finish,
            snip::snip_record,
            editor::media_info,
            editor::allow_media,
            editor::render_project,
            commands::list_windows,
            recording::start_recording_source,
            recording::set_capture_source,
            studio::screen_snapshot,
            studio::sync_layers,
            studio::set_studio_layers,
            studio::get_studio_layers,
            studio::list_cameras,
            studio::get_preview_frame,
            snip::snip_cancel,
            snip::open_screenshots_folder,
            audio_routing::vm_status,
            audio_routing::vm_levels,
            audio_routing::vm_set,
            audio_routing::vm_launch,
            audio_routing::list_render_devices,
            audio_routing::list_audio_apps,
            audio_routing::get_app_output,
            audio_routing::set_app_output,
            popout::popout_open,
            popout::popout_close,
            popout::popout_list,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Lastshot")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app.try_state::<AppState>() {
                    state.engine.stop();
                }
            }
            if let tauri::RunEvent::Exit = event {
                audio_routing::voicemeeter::shutdown();
            }
        });
}

/// Adds `dir` to the `asset:` protocol scope so the webview can stream clips
/// from a user-chosen output folder.
///
/// `tauri.conf.json` only declares a static scope; this extends it at runtime
/// whenever the folder changes. Scoped to the single configured directory (not
/// the whole drive), and re-applied on every change rather than accumulating.
fn allow_asset_dir(app: &tauri::AppHandle, dir: &str) {
    if dir.trim().is_empty() {
        return;
    }
    let path = std::path::PathBuf::from(dir);
    if let Err(e) = app.asset_protocol_scope().allow_directory(&path, true) {
        log::warn!("[lastshot] could not widen asset scope to {dir}: {e}");
    }
}

/// Tray menu: everything you need mid-game without alt-tabbing.
fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let save_key = app
        .try_state::<AppState>()
        .map(|s| s.settings.read().hotkey_save.clone())
        .unwrap_or_else(|| "Alt+C".into());
    let save = MenuItem::with_id(app, "save", format!("Save replay\t{save_key}"), true, None::<&str>)?;
    let last30 = MenuItem::with_id(app, "save30", "Save last 30 s", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "Instant replay on / off", true, None::<&str>)?;
    let record_key = app
        .try_state::<AppState>()
        .map(|s| s.settings.read().hotkey_record.clone())
        .unwrap_or_else(|| "Alt+R".into());
    let record_item = MenuItem::with_id(
        app,
        "record",
        format!("Start / stop screen recording\t{record_key}"),
        true,
        None::<&str>,
    )?;
    let snip_key = app
        .try_state::<AppState>()
        .map(|s| s.settings.read().hotkey_snip.clone())
        .unwrap_or_else(|| "Alt+S".into());
    let snip_item = MenuItem::with_id(
        app,
        "snip",
        format!("Snip: screenshot\t{snip_key}"),
        true,
        None::<&str>,
    )?;
    let snip_rec_item =
        MenuItem::with_id(app, "snip_rec", "Snip: record an area", true, None::<&str>)?;
    let bar_item =
        MenuItem::with_id(app, "bar", "Show the control bar", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Open Lastshot", true, None::<&str>)?;
    let folder = MenuItem::with_id(app, "folder", "Open clips folder", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Lastshot", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;

    let capture = Submenu::with_id_and_items(
        app,
        "capture",
        "Capture",
        true,
        &[&save, &last30, &record_item, &snip_item, &snip_rec_item, &bar_item, &toggle],
    )?;
    let menu = Menu::with_items(app, &[&capture, &sep, &show, &folder, &sep, &quit])?;

    let mut builder = TrayIconBuilder::with_id("lastshot-tray")
        .menu(&menu)
        .tooltip("Lastshot — instant replay")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "save" => hotkeys::trigger_save(app.clone()),
            "save30" => {
                let h = app.clone();
                tauri::async_runtime::spawn(async move {
                    let Some(state) = h.try_state::<AppState>() else {
                        return;
                    };
                    // Privacy mode: the ring is empty while no game is focused.
                    if let Some(msg) = commands::privacy_blocked_message(&state, None) {
                        let _ = h.emit(commands::EVT_ERROR, msg);
                        return;
                    }
                    // Same routing + metadata + event as the hotkey and the
                    // deck, so a tray save shows up in the gallery immediately
                    // instead of requiring a manual Rescan.
                    let game_folder = commands::prepare_save(&state, None);
                    let engine = Arc::clone(&state.engine);
                    let written = tauri::async_runtime::spawn_blocking(move || {
                        engine.flush_to_disk(Some(30.0))
                    })
                    .await;
                    match written {
                        Ok(Ok(write)) => {
                            crate::hotkeys::publish_saved_clip(
                                &h,
                                &write,
                                game_folder,
                                "tray",
                                false,
                                false,
                            );
                        }
                        Ok(Err(e)) => {
                            let _ = h.emit(commands::EVT_ERROR, e.to_string());
                        }
                        Err(e) => {
                            let _ = h.emit(commands::EVT_ERROR, format!("flush task failed: {e}"));
                        }
                    }
                });
            }
            "toggle" => hotkeys::trigger_toggle(app.clone()),
            "snip" => snip::begin(app.clone()),
            "snip_rec" => snip::begin_with(app.clone(), false, "rec"),
            "bar" => recording::show_bar(app.clone()),
            "record" => recording::toggle(app.clone()),
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
            "folder" => {
                use tauri_plugin_opener::OpenerExt;
                if let Some(state) = app.try_state::<AppState>() {
                    let dir = state.settings.read().output_dir.clone();
                    let _ = std::fs::create_dir_all(&dir);
                    let _ = app.opener().open_path(dir, None::<&str>);
                }
            }
            "quit" => {
                if let Some(state) = app.try_state::<AppState>() {
                    state.engine.stop();
                }
                audio_routing::voicemeeter::shutdown();
                std::process::exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            match event {
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    ..
                }
                | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                } => {
                    let app = tray.app_handle();
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.unminimize();
                        let _ = w.set_focus();
                    }
                }
                _ => {}
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

/// Re-exported so `main.rs` stays a one-liner and integration tests can drive
/// the shortcut handler directly.
pub use tauri_plugin_global_shortcut::ShortcutState as GlobalShortcutState;
const _: fn(ShortcutState) -> bool = |s| matches!(s, ShortcutState::Pressed);
